import { ProviderAccessBlockedError, assertProviderResponseAllowed, type ProviderRequestGuard } from "./provider-access.js";
import type { TastingNoteGroup, WineCandidate, WineProfile } from "@wine-rec/contracts";
import { inferStyleKey, inferTasteVector, mapExternalTasteVector, scoreWineMatch } from "@wine-rec/core";

import { appConfig } from "../config.js";
import { createId } from "../id.js";
import { readVivinoMatch, rememberVivinoMatch } from "./vivino-match-cache.js";
import { buildVivinoIdentityQueries, hasColourConflict, producersWithCuvee, scoreVivinoIdentityDetail } from "./vivino-match.js";
import { compareVintageEvidence, compareGrapeEvidence } from "./wine-identity-evidence.js";
import {
  paceVivinoRequest,
  pickPreferredVivinoImageUrl,
  RetryableVivinoBrowserError,
  VivinoBrowser,
  type SearchHit,
  type VivinoRatingSource,
} from "./vivino-browser.js";

export interface CandidateProfileResult {
  provider: string;
  profile: WineProfile;
  matchScore: number;
}

export interface WineProfileProvider {
  name: string;
  isEnabled: boolean;
  detail: string;
  lookup(candidate: WineCandidate, context?: { beforeRequest?: ProviderRequestGuard }): Promise<CandidateProfileResult | null>;
}

export class RetryableWineProfileLookupError extends Error {
  constructor(
    readonly provider: string,
    readonly candidateQuery: string,
    readonly cause: unknown,
  ) {
    super(`Retryable ${provider} lookup failure for ${candidateQuery}`);
    this.name = "RetryableWineProfileLookupError";
  }
}

type RawExternalProfile = {
  displayName?: string | undefined;
  producer?: string | undefined;
  label?: string | undefined;
  vintage?: number | undefined;
  region?: string | undefined;
  varietal?: string | undefined;
  rating?: number | undefined;
  ratingCount?: number | undefined;
  ratingSource?: VivinoRatingSource | undefined;
  imageUrl?: string | undefined;
  body?: number | undefined;
  acidity?: number | undefined;
  tannin?: number | undefined;
  sweetness?: number | undefined;
  sourceUrl?: string | undefined;
  tastingNotes?: string | undefined;
  tasteReviewCount?: number | undefined;
  tastingNoteGroups?: TastingNoteGroup[] | undefined;
  retailPrice?: number | null | undefined;
};

// Wine-level identity thresholds (see vivino-match.ts), tuned on the dev
// half of the shared wine-list corpus. Below MIN the wine is not shown as a
// Vivino match at all, because a wrong wine's notes are worse than none.
const VIVINO_MIN_IDENTITY = 0.6;
const VIVINO_CONFIDENT_IDENTITY = 0.75;
// Extra catalogue searches when Vivino ignores the "wines you can't buy" switch.
const VIVINO_NON_BUYABLE_RETRIES = 2;
const VIVINO_DECISIVE_IDENTITY = 0.85;

/** Map identity onto rankMatch's scale: confident identity counts as matched (>= 0.82). */
export function vivinoIdentityToMatchScore(identity: number): number {
  if (identity >= VIVINO_CONFIDENT_IDENTITY) {
    return Math.min(1, 0.82 + (identity - VIVINO_CONFIDENT_IDENTITY) * 0.72);
  }
  return Math.max(0, 0.65 + (identity - VIVINO_MIN_IDENTITY) * (0.16 / (VIVINO_CONFIDENT_IDENTITY - VIVINO_MIN_IDENTITY)));
}
const MIN_CONFIDENCE_FOR_RULE_BASED_INFERENCE = 0.68;
// Rows without a grape name (e.g. "Monica di Sardegna", "Lisboa ... Tinto") get lower
// extraction confidence, so they were never scored. When the wine's own text names a
// recognised region, style or colour, that evidence is enough to rule out OCR noise.
const MIN_CONFIDENCE_WITH_STYLE_EVIDENCE = 0.55;
const styleListingLabels = new Set(["chilled red", "red", "white", "orange", "rose", "rosé", "sparkling"]);
const searchNoiseTokens = new Set([
  "bottle",
  "bottles",
  "by",
  "carafe",
  "glass",
  "glasses",
  "list",
  "menu",
  "price",
  "section",
  "wine",
  "wines",
]);

function isAnonymousStyleListingCandidate(candidate: WineCandidate): boolean {
  const label = candidate.label?.trim().toLowerCase() ?? "";
  return !candidate.producer && Boolean(candidate.region) && styleListingLabels.has(label);
}

function buildProfile(
  provider: string,
  candidate: WineCandidate,
  external: RawExternalProfile,
  mode: "direct" | "mapped" | "inferred",
  confidence: number,
): CandidateProfileResult {
  const matchScore = scoreWineMatch(candidate, {
    producer: external.producer ?? candidate.producer,
    label: external.label ?? external.displayName ?? candidate.label,
    vintage: external.vintage ?? candidate.vintage,
    varietal: external.varietal ?? candidate.varietal,
    region: external.region ?? candidate.region,
  });

  const taste =
    mode === "inferred"
      ? inferTasteVector(candidate, {
          varietal: external.varietal ?? candidate.varietal,
          label: external.label ?? external.displayName ?? candidate.label,
          region: external.region ?? candidate.region,
        })
      : mapExternalTasteVector(
          {
            body: external.body,
            acidity: external.acidity,
            tannin: external.tannin,
            sweetness: external.sweetness,
          },
          mode,
          confidence,
        );

  return {
    provider,
    matchScore,
    profile: {
      id: createId(),
      displayName:
        external.displayName ??
        candidate.rawText ??
        [external.producer ?? candidate.producer, external.label ?? candidate.label]
          .filter(Boolean)
          .join(" "),
      producer: external.producer ?? candidate.producer,
      label: external.label ?? candidate.label,
      vintage: external.vintage ?? candidate.vintage,
      region: external.region ?? candidate.region,
      varietal: external.varietal ?? candidate.varietal,
      provider,
      rating: external.rating ?? null,
      ratingCount: external.ratingCount ?? null,
      ratingSource: external.ratingSource ?? null,
      imageUrl: normalizeExternalImageUrl(external.imageUrl) ?? null,
      provenanceLabel:
        mode === "direct" ? "Direct" : mode === "mapped" ? "Mapped" : "Inferred",
      taste,
      tasteReviewCount: external.tasteReviewCount ?? null,
      tastingNotes: external.tastingNotes ?? null,
      ...(external.tastingNoteGroups ? { tastingNoteGroups: external.tastingNoteGroups } : {}),
      retailPrice: external.retailPrice ?? null,
      fetchedAt: new Date().toISOString(),
    },
  };
}

function normalizeExternalImageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

export function normalizeVivinoTasteReviewCount(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/* ------------------------------------------------------------------ */
/*  Vivino Direct – browser search + public taste API                  */
/* ------------------------------------------------------------------ */

function cleanVivinoQueryFragment(value: string | null | undefined): string {
  const rawTokens = (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’'“”"]/g, " ")
    .replace(/[^A-Za-z0-9\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const cleaned = rawTokens.filter((token) => {
    const lower = token.toLowerCase();
    if (searchNoiseTokens.has(lower)) return false;
    if (/^\d{1,3}(?:\.\d{2})?$/.test(lower)) return false;
    if (/^\d+(?:l|ml)$/.test(lower)) return false;
    if (lower.length <= 1) return false;
    if (lower.length <= 2 && /^[a-z]+$/i.test(lower)) return false;
    return /[A-Za-z]/.test(lower);
  });

  return [...new Set(cleaned.map((token) => token.toLowerCase()))].join(" ").trim();
}

function extractNoteSearchHint(notes: string | null | undefined): string {
  const cleaned = cleanVivinoQueryFragment(notes);
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .slice(0, 5)
    .join(" ");
}

function buildQuery(parts: Array<string | number | null | undefined>): string | null {
  const query = parts
    .map((part) => (typeof part === "number" ? String(part) : cleanVivinoQueryFragment(part)))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return query.split(/\s+/).length >= 2 ? query : null;
}

export function buildVivinoSearchQueries(candidate: WineCandidate): string[] {
  const noteHint = extractNoteSearchHint(candidate.notes);
  const queries = [
    buildQuery([candidate.producer, candidate.label, candidate.region, candidate.vintage]),
    buildQuery([candidate.rawText, candidate.region, candidate.vintage]),
    buildQuery([candidate.producer, candidate.label, noteHint]),
    buildQuery([candidate.label, candidate.region, noteHint, candidate.vintage]),
    buildQuery([candidate.rawText, noteHint]),
  ].filter((query): query is string => Boolean(query));

  return [...new Set(queries)].slice(0, 4);
}

/** Map a Vivino structure value to our 1–5 int scale. */
function vivinoStructureToScale(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  // Vivino taste endpoint returns values on a ~1–5 scale
  return Math.max(1, Math.min(5, Math.round(value)));
}

type VivinoFlavorGroup = {
  group?: string;
  stats?: { score?: number };
  color?: string | null;
  primary_keywords?: Array<{ name?: string; image?: string | null }>;
};

type VivinoStatistics = {
  ratings_average?: number | null;
  ratings_count?: number | null;
};

type VivinoReviewImage = {
  location?: string | null;
  variations?: {
    large?: string | null;
    medium?: string | null;
    medium_square?: string | null;
    small_square?: string | null;
  } | null;
};

type VivinoReview = {
  vintage?: {
    statistics?: VivinoStatistics | null;
    image?: VivinoReviewImage | null;
    wine?: {
      id?: number | null;
    } | null;
  } | null;
};

interface VivinoReviewsResponse {
  reviews?: VivinoReview[];
}

type VivinoWineMeta = {
  aggregateRating: {
    rating: number | null;
    ratingCount: number | null;
    ratingSource: VivinoRatingSource | null;
  } | null;
  imageUrl: string | null;
};

function normalizeVivinoFlavorGroupKey(value: string | null | undefined): string {
  const normalized = (value ?? "other")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "other";
}

function formatVivinoFlavorGroupLabel(value: string | null | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  const labelOverrides: Record<string, string> = {
    non_oak: "Ageing",
    microbio: "Yeasty",
    earth: "Earthy",
    oak: "Oaky",
    citrus_fruit: "Citrus",
  };
  const overriddenLabel = labelOverrides[raw];
  if (overriddenLabel) {
    return overriddenLabel;
  }

  const normalized = raw.replace(/[_-]+/g, " ");
  if (!normalized) return "Other";

  return normalized
    .split(/\s+/)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeVivinoKeyword(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeVivinoFlavorColor(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : null;
}

function normalizeVivinoAggregateRating(
  stats: VivinoStatistics | null | undefined,
  ratingSource: VivinoRatingSource,
): {
  rating: number;
  ratingCount: number;
  ratingSource: VivinoRatingSource;
} | null {
  const rating = stats?.ratings_average;
  const ratingCount = stats?.ratings_count;
  if (
    rating == null ||
    !Number.isFinite(rating) ||
    rating <= 0 ||
    ratingCount == null ||
    !Number.isFinite(ratingCount) ||
    ratingCount <= 0
  ) {
    return null;
  }

  return {
    rating,
    ratingCount: Math.round(ratingCount),
    ratingSource,
  };
}

function extractVivinoWineMetaFromReviews(
  wineId: number,
  response: VivinoReviewsResponse | null | undefined,
): VivinoWineMeta | null {
  const review = response?.reviews?.find((entry) => {
    const reviewWineId = entry.vintage?.wine?.id;
    return reviewWineId == null || reviewWineId === wineId;
  });
  if (!review?.vintage) return null;

  const aggregateRating = normalizeVivinoAggregateRating(
    review.vintage.statistics,
    "wine",
  );
  const imageUrl = pickPreferredVivinoImageUrl(
    review.vintage.image?.variations?.large,
    review.vintage.image?.variations?.medium,
    review.vintage.image?.location,
    review.vintage.image?.variations?.medium_square,
    review.vintage.image?.variations?.small_square,
  );

  if (!aggregateRating && !imageUrl) {
    return null;
  }

  return {
    aggregateRating,
    imageUrl,
  };
}

function extractVivinoImageCandidatesFromAttribute(value: string | null | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .reverse();
}

export function extractVivinoImageUrlFromHtml(html: string): string | null {
  if (!html) return null;

  const pictureBlock =
    html.match(/<picture[^>]*wineLabel-module__picture[\s\S]*?<\/picture>/i)?.[0] ?? html;
  const attributeMatches = Array.from(
    pictureBlock.matchAll(/\b(?:src|srcset)=["']([^"']+)["']/gi),
  );
  const attributeCandidates = attributeMatches.flatMap((match) =>
    extractVivinoImageCandidatesFromAttribute(match[1]),
  );
  if (attributeCandidates.length > 0) {
    return pickPreferredVivinoImageUrl(...attributeCandidates);
  }

  const directCandidates = Array.from(
    pictureBlock.matchAll(/(?:https?:)?\/\/images\.vivino\.com\/thumbs\/[^"'?\s>]+(?:\?[^"'\s>]*)?/gi),
    (match) => match[0],
  );
  return pickPreferredVivinoImageUrl(...directCandidates);
}

export function extractTastingNoteGroups(
  flavor: VivinoFlavorGroup[] | undefined,
): TastingNoteGroup[] | undefined {
  if (!flavor?.length) return undefined;

  const groups = flavor
    .map((group): TastingNoteGroup | null => {
      const keywords: string[] = [];
      const keywordImageUrls: Array<string | null> = [];
      const keywordIndexes = new Map<string, number>();
      let imageUrl: string | null = null;

      for (const keyword of group.primary_keywords ?? []) {
        const normalized = normalizeVivinoKeyword(keyword.name);
        if (!normalized) continue;

        const dedupeKey = normalized.toLowerCase();
        const normalizedImageUrl = normalizeExternalImageUrl(keyword.image) ?? null;
        const existingIndex = keywordIndexes.get(dedupeKey);

        if (existingIndex != null) {
          if (!keywordImageUrls[existingIndex] && normalizedImageUrl) {
            keywordImageUrls[existingIndex] = normalizedImageUrl;
          }
          if (!imageUrl && normalizedImageUrl) {
            imageUrl = normalizedImageUrl;
          }
          continue;
        }

        if (!imageUrl && normalizedImageUrl) {
          imageUrl = normalizedImageUrl;
        }

        keywordIndexes.set(dedupeKey, keywords.length);
        keywords.push(normalized);
        keywordImageUrls.push(normalizedImageUrl);
      }

      if (keywords.length === 0) return null;

      return {
        key: normalizeVivinoFlavorGroupKey(group.group),
        label: formatVivinoFlavorGroupLabel(group.group),
        score:
          group.stats?.score != null && Number.isFinite(group.stats.score) && group.stats.score >= 0
            ? group.stats.score
            : null,
        noteCount: keywords.length,
        keywords,
        keywordImageUrls,
        color: normalizeVivinoFlavorColor(group.color),
        imageUrl,
      } satisfies TastingNoteGroup;
    })
    .filter((group): group is TastingNoteGroup => group !== null)
    .sort((left, right) => {
      const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
      if (scoreDelta !== 0) return scoreDelta;

      const noteDelta = right.noteCount - left.noteCount;
      if (noteDelta !== 0) return noteDelta;

      return left.label.localeCompare(right.label);
    })
    .slice(0, 3);

  return groups.length > 0 ? groups : undefined;
}

/** Distill Vivino flavor groups into a tasting-notes string. */
function extractTastingNotes(flavor: VivinoFlavorGroup[] | undefined): string | null {
  const groups = extractTastingNoteGroups(flavor);
  const keywords = groups?.flatMap((group) => group.keywords) ?? [];
  return keywords.length > 0 ? keywords.join(", ") : null;
}

/** Fetch with retry on HTTP 429 using exponential backoff. */
async function vivinoFetch(
  url: URL | string,
  headers: Record<string, string>,
  beforeRequest?: ProviderRequestGuard,
): Promise<Response | null> {
  const maxRetries = appConfig.vivinoDirectMaxRetries;
  const baseBackoff = appConfig.vivinoDirectBackoffMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await beforeRequest?.();
    await paceVivinoRequest();
    try {
      const response = await fetch(url, { headers });
      await assertProviderResponseAllowed(response, beforeRequest?.onAccessBlocked);

      if (response.status === 429 && attempt < maxRetries) {
        const delay = baseBackoff * 2 ** attempt;
        console.log("[vivino-direct] 429 rate-limited on %s, retrying in %dms (attempt %d/%d)", url.toString(), delay, attempt + 1, maxRetries);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        console.log("[vivino-direct] HTTP %d from %s", response.status, url.toString());
        return null;
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderAccessBlockedError) throw error;
      console.log("[vivino-direct] Network error fetching %s: %s", url.toString(), error instanceof Error ? error.message : error);
      if (attempt < maxRetries) {
        const delay = baseBackoff * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return null;
    }
  }
  return null;
}

interface VivinoTastesResponse {
  tastes?: {
    structure?: {
      acidity?: number;
      sweetness?: number;
      tannin?: number;
      intensity?: number;
      fizziness?: number;
      user_structure_count?: number | null;
      calculated_structure_count?: number | null;
    };
    flavor?: VivinoFlavorGroup[];
  };
}

class VivinoDirectProvider implements WineProfileProvider {
  name = "vivino-direct";
  isEnabled = appConfig.enableVivinoDirect;
  detail = this.isEnabled
    ? "Direct Vivino browser search is enabled."
    : "Direct Vivino provider is disabled (ENABLE_VIVINO_DIRECT=false).";

  private readonly headers = {
    "User-Agent": appConfig.vivinoDirectUserAgent,
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  private blocked: ProviderAccessBlockedError | null = null;

  async lookup(candidate: WineCandidate, context: { beforeRequest?: ProviderRequestGuard } = {}): Promise<CandidateProfileResult | null> {
    const guard: ProviderRequestGuard = async () => {
      if (this.blocked) throw this.blocked;
      await context.beforeRequest?.();
      if (this.blocked) throw this.blocked;
    };
    guard.onAccessBlocked = error => { this.blocked ??= error; };
    try {
      await guard();
      if (this.isEnabled && !isAnonymousStyleListingCandidate(candidate)) {
        const remembered = await readVivinoMatch<CandidateProfileResult>(candidate);
        if (remembered?.profile) {
          console.log("[vivino-direct] Reusing remembered match: %s", remembered.profile.displayName);
          return { ...remembered, profile: { ...remembered.profile, id: createId() } };
        }
      }
      const result = await this.lookupCandidate(candidate, guard);
      if (result) await rememberVivinoMatch(candidate, result);
      return result;
    } catch (error) {
      if (error instanceof ProviderAccessBlockedError) this.blocked = error;
      throw error;
    }
  }

  private async lookupCandidate(candidate: WineCandidate, beforeRequest: ProviderRequestGuard): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) {
      console.log("[vivino-direct] Provider is disabled, skipping");
      return null;
    }

    if (isAnonymousStyleListingCandidate(candidate)) {
      return null;
    }

    const queries = buildVivinoIdentityQueries(candidate);
    console.log("[vivino-direct] Searching with %d query variant(s): %s", queries.length, queries.join(" || "));

    // Score every hit at wine level, then prefer the menu's vintage among
    // hits for the same wine. A different shop vintage is still the same wine:
    // Vivino's taste structure and flavour notes are per wine.
    const hitsByWineId = new Map<number, { hit: SearchHit; identity: number; withoutProducer: boolean; cuveeTokens: string[]; vintage: ReturnType<typeof compareVintageEvidence> }>();
    const vintageRank = { exact: 3, unconstrained: 2, unknown: 1, conflict: 0 } as const;
    // Vivino's default search lists wines sold in our market, ranked well.
    // Wines nobody sells here (older or allocated bottles) only appear when
    // asked for. Each query is tried in the shop listing first, then in the
    // whole catalogue if no clear match has turned up yet.
    const plan = queries.flatMap(query => appConfig.vivinoIncludeNonBuyable
      ? [{ query, includeNonBuyable: false }, { query, includeNonBuyable: true }]
      : [{ query, includeNonBuyable: false }]);
    // The clock starts once the first search is back, so a cold browser start
    // doesn't eat the budget for the searches that follow.
    let clockStartedAt: number | null = null;
    const outOfTime = () => clockStartedAt !== null && Date.now() - clockStartedAt > appConfig.vivinoLookupBudgetMs;
    const bestIdentity = () => Math.max(0, ...[...hitsByWineId.values()].map(({ identity }) => identity));
    let searches = 0;
    const pendingCuveeOnly = () => [...hitsByWineId.values()].some(entry =>
      entry.withoutProducer && entry.identity >= VIVINO_CONFIDENT_IDENTITY);
    // Vivino honours "include wines you can't buy" only some of the time and
    // otherwise serves the shop listing again. When the catalogue search comes
    // back identical to the shop search for the same query, ask again (a
    // couple of times) so the result doesn't depend on that coin flip.
    const shopResults = new Map<string, string>();
    const hitIdsKey = (hits: SearchHit[]) => hits.map(hit => hit.wineId).sort((a, b) => a - b).join(",");
    for (const { query, includeNonBuyable } of plan) {
      if (bestIdentity() >= VIVINO_DECISIVE_IDENTITY) break;
      // A good cuvée-only match is settled by one check below, not more searching.
      if (pendingCuveeOnly()) break;
      if (includeNonBuyable && bestIdentity() >= VIVINO_CONFIDENT_IDENTITY) continue;
      if (searches > 0 && (outOfTime() || searches >= appConfig.vivinoLookupMaxSearches)) {
        console.log("[vivino-direct] Search budget reached after %d search(es)", searches);
        break;
      }
      searches += 1;
      await beforeRequest();
      let hits = await this.searchByName(query, beforeRequest, includeNonBuyable);
      clockStartedAt ??= Date.now();
      if (!includeNonBuyable) {
        shopResults.set(query, hitIdsKey(hits));
      } else {
        for (let retry = 0; retry < VIVINO_NON_BUYABLE_RETRIES && shopResults.get(query) === hitIdsKey(hits) && !outOfTime(); retry += 1) {
          console.log("[vivino-direct] Catalogue search for %j matched the shop listing, asking again", query);
          await beforeRequest();
          hits = await this.searchByName(query, beforeRequest, true);
        }
      }
      for (const hit of hits) {
        if (compareGrapeEvidence(candidate, hit) === "conflict" || hasColourConflict(candidate, hit)) continue;
        const { score: identity, withoutProducer, cuveeTokens } = scoreVivinoIdentityDetail(candidate, hit);
        const vintage = compareVintageEvidence(candidate, hit);
        const existing = hitsByWineId.get(hit.wineId);
        if (!existing || vintageRank[vintage] > vintageRank[existing.vintage]
            || (vintage === existing.vintage && identity > existing.identity)) {
          const keepExisting = existing && existing.identity > identity;
          hitsByWineId.set(hit.wineId, {
            hit,
            identity: keepExisting ? existing.identity : identity,
            withoutProducer: keepExisting ? existing.withoutProducer : withoutProducer,
            cuveeTokens: keepExisting ? existing.cuveeTokens : cuveeTokens,
            vintage,
          });
        }
      }
    }

    if (!hitsByWineId.size) {
      console.log("[vivino-direct] No results from browser search");
      return null;
    }

    // Step 2: pick the best wine; exact vintage breaks near-ties.
    const scored = [...hitsByWineId.values()]
      .map(entry => ({ ...entry, rank: entry.identity + (entry.vintage === "exact" ? 0.02 : 0) }))
      .sort((a, b) => b.rank - a.rank || a.hit.wineId - b.hit.wineId);
    const { hit: bestHit, identity, vintage: bestVintage, withoutProducer, cuveeTokens } = scored[0]!;
    // A match made on the cuvée name alone must be the only producer that
    // makes that cuvée. One extra search for the cuvée words checks it.
    if (withoutProducer && identity >= VIVINO_MIN_IDENTITY) {
      if (outOfTime()) {
        console.log("[vivino-direct] No time left to check a cuvée-only match, skipping");
        return null;
      }
      await beforeRequest();
      const cuveeHits = await this.searchByName(cuveeTokens.join(" "), beforeRequest, appConfig.vivinoIncludeNonBuyable);
      const producers = producersWithCuvee([...cuveeHits, ...scored.map(entry => entry.hit)], cuveeTokens);
      if (producers.size > 1) {
        console.log("[vivino-direct] Cuvée-only match is shared by %d producers, skipping", producers.size);
        return null;
      }
    }
    // When Vivino only lists another vintage, show the wine without that
    // vintage rather than claim the menu's bottle is a different year.
    const sameVintage = bestVintage === "exact";
    const displayWineName = sameVintage ? bestHit.wineName
      : bestHit.wineName.replace(/\s+(?:(?:19|20)\d{2}|N\.?V\.?)\s*$/i, "").trim();
    const matchScore = vivinoIdentityToMatchScore(identity);
    console.log(
      "[vivino-direct] Best match (identity=%s, score=%s): %s %s",
      identity.toFixed(3),
      matchScore.toFixed(3),
      bestHit.wineryName,
      bestHit.wineName,
    );

    if (identity < VIVINO_MIN_IDENTITY) {
      console.log(
        "[vivino-direct] Best browser match below threshold (%s < %s), skipping",
        identity.toFixed(3),
        VIVINO_MIN_IDENTITY.toFixed(2),
      );
      return null;
    }

    // Step 3: Fetch aggregate rating metadata and taste data for the best match
    // Sequential enrichment prevents a detected block on one endpoint from
    // racing a newly started request to another endpoint.
    const wineMeta = await this.fetchWineMeta(bestHit, beforeRequest);
    const tastesData = await this.fetchTastes(bestHit.wineId, beforeRequest);
    console.log(
      "[vivino-direct] Aggregate rating for wine %d:",
      bestHit.wineId,
      JSON.stringify(wineMeta?.aggregateRating ?? null, null, 2),
    );
    console.log(
      "[vivino-direct] Taste data for wine %d:",
      bestHit.wineId,
      JSON.stringify(tastesData, null, 2),
    );

    const tasteStructure = tastesData?.tastes?.structure;
    const flavorData = tastesData?.tastes?.flavor;
    const tastingNoteGroups = extractTastingNoteGroups(flavorData);
    const imageUrl = pickPreferredVivinoImageUrl(
      bestHit.imageUrl,
      wineMeta?.imageUrl,
    );
    const taste = mapExternalTasteVector({
      body: vivinoStructureToScale(tasteStructure?.intensity),
      acidity: vivinoStructureToScale(tasteStructure?.acidity),
      tannin: vivinoStructureToScale(tasteStructure?.tannin),
      sweetness: vivinoStructureToScale(tasteStructure?.sweetness),
    }, "direct", 0.9);
    const observedCount = taste.observedDimensions?.length ?? 0;

    return {
      provider: this.name,
      matchScore,
      profile: {
        id: createId(),
        displayName: [bestHit.wineryName, displayWineName].filter(Boolean).join(" "),
        producer: bestHit.wineryName || candidate.producer,
        label: displayWineName || candidate.label,
        vintage: sameVintage ? bestHit.year : candidate.vintage,
        region: bestHit.regionAndCountry || candidate.region,
        varietal: candidate.varietal,
        provider: this.name,
        rating: wineMeta?.aggregateRating?.rating ?? bestHit.rating,
        ratingCount: wineMeta?.aggregateRating?.ratingCount ?? null,
        ratingSource: wineMeta?.aggregateRating?.ratingSource ?? null,
        imageUrl: normalizeExternalImageUrl(imageUrl) ?? null,
        provenanceLabel: observedCount === 4 ? "Direct" : observedCount > 0 ? `Partial taste data (${observedCount}/4)` : "Taste data unavailable",
        taste,
        tasteReviewCount: normalizeVivinoTasteReviewCount(
          tasteStructure?.user_structure_count,
        ),
        tastingNotes: extractTastingNotes(flavorData),
        ...(tastingNoteGroups ? { tastingNoteGroups } : {}),
        retailPrice: bestHit.retailPrice ?? null,
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  private async searchByName(query: string, beforeRequest: ProviderRequestGuard, includeNonBuyable = false): Promise<SearchHit[]> {
    try {
      return await VivinoBrowser.getInstance().search(query, beforeRequest, { includeNonBuyable });
    } catch (error) {
      if (error instanceof RetryableVivinoBrowserError) {
        throw new RetryableWineProfileLookupError(this.name, query, error);
      }
      throw error;
    }
  }

  private async fetchWineMeta(bestHit: SearchHit, beforeRequest: ProviderRequestGuard): Promise<{
    aggregateRating: {
      rating: number | null;
      ratingCount: number | null;
      ratingSource: VivinoRatingSource | null;
    } | null;
    imageUrl: string | null;
  } | null> {
    const reviewsMeta = await this.fetchReviewsMeta(bestHit.wineId, beforeRequest);
    const hasAggregateFromReviews = Boolean(reviewsMeta?.aggregateRating);
    const hasUsableImage = Boolean(
      pickPreferredVivinoImageUrl(bestHit.imageUrl, reviewsMeta?.imageUrl),
    );
    if (hasAggregateFromReviews && hasUsableImage) {
      return reviewsMeta;
    }

    if (hasAggregateFromReviews) {
      const pageImageUrl = await this.fetchVintagePageImage(bestHit.vintagePageUrl, beforeRequest);
      return {
        aggregateRating: reviewsMeta?.aggregateRating ?? null,
        imageUrl: pickPreferredVivinoImageUrl(
          bestHit.imageUrl,
          reviewsMeta?.imageUrl,
          pageImageUrl,
        ),
      };
    }

    const scrapedMeta = await VivinoBrowser.getInstance().fetchVintagePageMeta(
      bestHit.vintagePageUrl, beforeRequest,
    );
    if (!reviewsMeta) {
      return scrapedMeta;
    }

    return {
      aggregateRating: reviewsMeta.aggregateRating ?? scrapedMeta?.aggregateRating ?? null,
      imageUrl: reviewsMeta.imageUrl ?? scrapedMeta?.imageUrl ?? null,
    };
  }

  private async fetchVintagePageImage(vintagePageUrl: string, beforeRequest: ProviderRequestGuard): Promise<string | null> {
    const response = await vivinoFetch(vintagePageUrl, {
      ...this.headers,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }, beforeRequest);
    if (!response) return null;

    try {
      return extractVivinoImageUrlFromHtml(await response.text());
    } catch {
      return null;
    }
  }

  private async fetchReviewsMeta(wineId: number, beforeRequest: ProviderRequestGuard): Promise<VivinoWineMeta | null> {
    const url = new URL(`https://www.vivino.com/api/wines/${wineId}/reviews`);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("language", "en");

    const response = await vivinoFetch(url, this.headers, beforeRequest);
    if (!response) return null;

    try {
      return extractVivinoWineMetaFromReviews(
        wineId,
        (await response.json()) as VivinoReviewsResponse,
      );
    } catch {
      return null;
    }
  }

  private async fetchTastes(wineId: number, beforeRequest: ProviderRequestGuard): Promise<VivinoTastesResponse | null> {
    const url = new URL(`https://www.vivino.com/api/wines/${wineId}/tastes`);
    const response = await vivinoFetch(url, this.headers, beforeRequest);
    if (!response) return null;

    try {
      return (await response.json()) as VivinoTastesResponse;
    } catch {
      return null;
    }
  }
}

class RuleBasedInferenceProvider implements WineProfileProvider {
  name = "rule-based";
  isEnabled = true;
  detail = "Always available local inference from extracted wine metadata.";

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (isAnonymousStyleListingCandidate(candidate)) {
      return null;
    }

    if (
      candidate.extractionConfidence < MIN_CONFIDENCE_FOR_RULE_BASED_INFERENCE &&
      (candidate.extractionConfidence < MIN_CONFIDENCE_WITH_STYLE_EVIDENCE || !inferStyleKey(candidate).specific)
    ) {
      return null;
    }

    const result = buildProfile(this.name, candidate, {}, "inferred", 0.45);
    return {
      ...result,
      matchScore: 0.05,
    };
  }
}

export function createWineProfileProviders(): WineProfileProvider[] {
  const providerMap = new Map<string, WineProfileProvider>([
    ["vivino-direct", new VivinoDirectProvider()],
    ["rule-based", new RuleBasedInferenceProvider()],
  ]);

  return appConfig.providerOrder
    .map((name) => providerMap.get(name))
    .filter((provider): provider is WineProfileProvider => Boolean(provider));
}
