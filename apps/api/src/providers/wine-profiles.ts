import type { TastingNoteGroup, WineCandidate, WineProfile } from "@wine-rec/contracts";
import { inferTasteVector, mapExternalTasteVector, scoreWineMatch } from "@wine-rec/core";
import { nanoid } from "nanoid";

import { appConfig } from "../config.js";
import {
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
  lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null>;
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

const VIVINO_DIRECT_MATCH_THRESHOLD = 0.38;
const MIN_CONFIDENCE_FOR_RULE_BASED_INFERENCE = 0.68;
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
      id: nanoid(),
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
): Promise<Response | null> {
  const maxRetries = appConfig.vivinoDirectMaxRetries;
  const baseBackoff = appConfig.vivinoDirectBackoffMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { headers });

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

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) {
      console.log("[vivino-direct] Provider is disabled, skipping");
      return null;
    }

    if (isAnonymousStyleListingCandidate(candidate)) {
      return null;
    }

    const queries = buildVivinoSearchQueries(candidate);
    console.log("[vivino-direct] Searching with %d query variant(s): %s", queries.length, queries.join(" || "));

    const hitsByWineId = new Map<number, { hit: SearchHit; score: number }>();
    for (const query of queries) {
      const hits = await this.searchByName(query);
      for (const hit of hits) {
        const score = scoreWineMatch(candidate, {
          producer: hit.wineryName,
          label: hit.wineName,
          vintage: hit.year,
          varietal: null,
          region: hit.regionAndCountry,
        });
        const existing = hitsByWineId.get(hit.wineId);
        if (!existing || score > existing.score) {
          hitsByWineId.set(hit.wineId, { hit, score });
        }
      }

      const bestSoFar = [...hitsByWineId.values()].reduce(
        (best, current) => (current.score > best ? current.score : best),
        0,
      );
      if (bestSoFar >= 0.72) {
        break;
      }
    }

    if (!hitsByWineId.size) {
      console.log("[vivino-direct] No results from browser search");
      return null;
    }

    // Step 2: Score all hits and pick the best match
    const scored = [...hitsByWineId.values()].map(({ hit, score }) => ({ hit, score }));
    scored.sort((a, b) => b.score - a.score);
    const { hit: bestHit, score: matchScore } = scored[0]!;
    console.log(
      "[vivino-direct] Best match (score=%s): %s %s",
      matchScore.toFixed(3),
      bestHit.wineryName,
      bestHit.wineName,
    );

    if (matchScore < VIVINO_DIRECT_MATCH_THRESHOLD) {
      console.log(
        "[vivino-direct] Best browser match below threshold (%s < %s), skipping",
        matchScore.toFixed(3),
        VIVINO_DIRECT_MATCH_THRESHOLD.toFixed(2),
      );
      return null;
    }

    // Step 3: Fetch aggregate rating metadata and taste data for the best match
    const [wineMeta, tastesData] = await Promise.all([
      this.fetchWineMeta(bestHit),
      this.fetchTastes(bestHit.wineId),
    ]);
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
    const hasDirectTaste = Boolean(
      tasteStructure &&
        (tasteStructure.acidity != null ||
          tasteStructure.sweetness != null ||
          tasteStructure.tannin != null ||
          tasteStructure.intensity != null),
    );

    return {
      provider: this.name,
      matchScore,
      profile: {
        id: nanoid(),
        displayName: [bestHit.wineryName, bestHit.wineName].filter(Boolean).join(" "),
        producer: bestHit.wineryName || candidate.producer,
        label: bestHit.wineName || candidate.label,
        vintage: bestHit.year ?? candidate.vintage,
        region: bestHit.regionAndCountry || candidate.region,
        varietal: candidate.varietal,
        provider: this.name,
        rating: wineMeta?.aggregateRating?.rating ?? bestHit.rating,
        ratingCount: wineMeta?.aggregateRating?.ratingCount ?? null,
        ratingSource: wineMeta?.aggregateRating?.ratingSource ?? null,
        imageUrl: normalizeExternalImageUrl(imageUrl) ?? null,
        provenanceLabel: hasDirectTaste ? "Direct" : "Mapped",
        taste: mapExternalTasteVector(
          {
            body: vivinoStructureToScale(tasteStructure?.intensity),
            acidity: vivinoStructureToScale(tasteStructure?.acidity),
            tannin: vivinoStructureToScale(tasteStructure?.tannin),
            sweetness: vivinoStructureToScale(tasteStructure?.sweetness),
          },
          hasDirectTaste ? "direct" : "mapped",
          hasDirectTaste ? 0.9 : 0.7,
        ),
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

  private async searchByName(query: string): Promise<SearchHit[]> {
    try {
      return await VivinoBrowser.getInstance().search(query);
    } catch (error) {
      if (error instanceof RetryableVivinoBrowserError) {
        throw new RetryableWineProfileLookupError(this.name, query, error);
      }
      throw error;
    }
  }

  private async fetchWineMeta(bestHit: SearchHit): Promise<{
    aggregateRating: {
      rating: number | null;
      ratingCount: number | null;
      ratingSource: VivinoRatingSource | null;
    } | null;
    imageUrl: string | null;
  } | null> {
    const reviewsMeta = await this.fetchReviewsMeta(bestHit.wineId);
    const hasAggregateFromReviews = Boolean(reviewsMeta?.aggregateRating);
    const hasUsableImage = Boolean(
      pickPreferredVivinoImageUrl(bestHit.imageUrl, reviewsMeta?.imageUrl),
    );
    if (hasAggregateFromReviews && hasUsableImage) {
      return reviewsMeta;
    }

    if (hasAggregateFromReviews) {
      const pageImageUrl = await this.fetchVintagePageImage(bestHit.vintagePageUrl);
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
      bestHit.vintagePageUrl,
    );
    if (!reviewsMeta) {
      return scrapedMeta;
    }

    return {
      aggregateRating: reviewsMeta.aggregateRating ?? scrapedMeta?.aggregateRating ?? null,
      imageUrl: reviewsMeta.imageUrl ?? scrapedMeta?.imageUrl ?? null,
    };
  }

  private async fetchVintagePageImage(vintagePageUrl: string): Promise<string | null> {
    const response = await vivinoFetch(vintagePageUrl, {
      ...this.headers,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    });
    if (!response) return null;

    try {
      return extractVivinoImageUrlFromHtml(await response.text());
    } catch {
      return null;
    }
  }

  private async fetchReviewsMeta(wineId: number): Promise<VivinoWineMeta | null> {
    const url = new URL(`https://www.vivino.com/api/wines/${wineId}/reviews`);
    url.searchParams.set("per_page", "1");
    url.searchParams.set("language", "en");

    const response = await vivinoFetch(url, this.headers);
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

  private async fetchTastes(wineId: number): Promise<VivinoTastesResponse | null> {
    const url = new URL(`https://www.vivino.com/api/wines/${wineId}/tastes`);
    const response = await vivinoFetch(url, this.headers);
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

    if (candidate.extractionConfidence < MIN_CONFIDENCE_FOR_RULE_BASED_INFERENCE) {
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
