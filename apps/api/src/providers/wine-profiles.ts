import type { ProviderSettings, WineCandidate, WineProfile } from "@wine-rec/contracts";
import { inferTasteVector, mapExternalTasteVector, normalizeTasteValue, scoreWineMatch } from "@wine-rec/core";
import { nanoid } from "nanoid";

import { appConfig } from "../config.js";

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

type RawExternalProfile = {
  displayName?: string | undefined;
  producer?: string | undefined;
  label?: string | undefined;
  vintage?: number | undefined;
  region?: string | undefined;
  varietal?: string | undefined;
  rating?: number | undefined;
  body?: number | undefined;
  acidity?: number | undefined;
  tannin?: number | undefined;
  sweetness?: number | undefined;
  sourceUrl?: string | undefined;
  tastingNotes?: string | undefined;
};

type ApifyVivinoItem = {
  name?: string;
  winery?: string;
  vintage?: number | string | null;
  region?: string;
  country?: string;
  grape_varieties?: string[];
  average_rating?: number | string | null;
  vivino_url?: string;
  taste_profile?: {
    body?: number | string | null;
    acidity?: number | string | null;
    tannins?: number | string | null;
    sweetness?: number | string | null;
  } | null;
};

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
      provenanceLabel:
        mode === "direct" ? "Direct" : mode === "mapped" ? "Mapped" : "Inferred",
      taste,
      tastingNotes: external.tastingNotes ?? null,
      fetchedAt: new Date().toISOString(),
    },
  };
}

function parseNumericValue(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scaleVivinoTaste(value: number | string | null | undefined): number | undefined {
  const parsed = parseNumericValue(value);
  if (parsed === undefined) return undefined;
  return normalizeTasteValue(parsed);
}

function normalizeApifyVivinoPayload(payload: unknown): ApifyVivinoItem[] {
  if (Array.isArray(payload)) {
    return payload as ApifyVivinoItem[];
  }

  if (payload && typeof payload === "object" && "items" in payload) {
    const items = (payload as { items?: unknown }).items;
    return Array.isArray(items) ? (items as ApifyVivinoItem[]) : [];
  }

  return payload ? [payload as ApifyVivinoItem] : [];
}

class ApifyVivinoProvider implements WineProfileProvider {
  name = "apify-vivino";
  isEnabled: boolean;
  detail: string;

  constructor(runtimeEnabled: boolean) {
    const hasConfig = Boolean(
      appConfig.apifyVivinoEndpoint || (appConfig.apifyToken && appConfig.apifyVivinoActorId),
    );

    this.isEnabled = appConfig.enableUnofficialVivino && runtimeEnabled && hasConfig;
    this.detail = this.isEnabled
      ? "Experimental Apify-backed Vivino lookup is enabled."
      : !appConfig.enableUnofficialVivino
        ? "Disabled by ENABLE_UNOFFICIAL_VIVINO."
        : !runtimeEnabled
          ? "Disabled in provider controls."
          : "Missing Apify configuration.";
  }

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) return null;

    const query = [candidate.producer, candidate.label, candidate.vintage].filter(Boolean).join(" ");
    const response = appConfig.apifyVivinoEndpoint
      ? await fetch(appConfig.apifyVivinoEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wineNames: [query], candidate }),
        })
      : await fetch(
          `https://api.apify.com/v2/acts/${appConfig.apifyVivinoActorId}/run-sync-get-dataset-items?clean=true`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${appConfig.apifyToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ wineNames: [query] }),
          },
        );

    if (!response.ok) {
      throw new Error(`Apify Vivino request failed with ${response.status}`);
    }

    const items = normalizeApifyVivinoPayload(await response.json());
    const item = items[0];
    if (!item) return null;

    const vivinoTaste = item.taste_profile;
    const body = scaleVivinoTaste(vivinoTaste?.body);
    const acidity = scaleVivinoTaste(vivinoTaste?.acidity);
    const tannin = scaleVivinoTaste(vivinoTaste?.tannins);
    const sweetness = scaleVivinoTaste(vivinoTaste?.sweetness);
    const hasDirectTaste = [body, acidity, tannin, sweetness].some((value) => value !== undefined);
    const region = [item.region, item.country].filter(Boolean).join(", ") || undefined;
    const grapeVariety = item.grape_varieties?.find(Boolean);

    return buildProfile(
      this.name,
      candidate,
      {
        displayName: [item.winery, item.name, item.vintage].filter(Boolean).join(" "),
        producer: item.winery,
        label: item.name,
        vintage: parseNumericValue(item.vintage) ?? candidate.vintage ?? undefined,
        region,
        varietal: grapeVariety,
        rating: parseNumericValue(item.average_rating),
        body,
        acidity,
        tannin,
        sweetness,
        sourceUrl: item.vivino_url,
      },
      hasDirectTaste ? "direct" : "mapped",
      hasDirectTaste ? 0.92 : 0.7,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Vivino Direct – hits the public explore + taste APIs directly      */
/* ------------------------------------------------------------------ */

/** Map a Vivino structure value (≈ 0–1 float) to our 1–5 int scale. */
function vivinoStructureToScale(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  // Vivino reports structure values on a roughly 0–1 scale
  return Math.max(1, Math.min(5, Math.round(value * 5)));
}

type VivinoFlavorGroup = {
  group?: string;
  stats?: { score?: number };
  primary_keywords?: Array<{ name?: string }>;
};

/** Distill Vivino flavor groups into a tasting-notes string. */
function extractTastingNotes(flavor: VivinoFlavorGroup[] | undefined): string | null {
  if (!flavor?.length) return null;

  const keywords = flavor
    .slice()
    .sort((a, b) => (b.stats?.score ?? 0) - (a.stats?.score ?? 0))
    .slice(0, 3)
    .flatMap((group) =>
      (group.primary_keywords ?? [])
        .map((kw) => kw.name)
        .filter((name): name is string => Boolean(name)),
    );

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

interface VivinoExploreMatch {
  vintage?: {
    id?: number;
    year?: number;
    wine?: {
      id?: number;
      name?: string;
      region?: { name?: string; country?: { name?: string } };
      winery?: { name?: string };
      taste?: {
        structure?: {
          acidity?: number;
          sweetness?: number;
          tannin?: number;
          intensity?: number;
          fizziness?: number;
        };
        flavor?: VivinoFlavorGroup[];
      };
      style?: { varietal_name?: string; body?: number };
    };
    statistics?: {
      wine_ratings_average?: number;
      ratings_count?: number;
    };
  };
}

interface VivinoTastesResponse {
  tastes?: {
    structure?: {
      acidity?: number;
      sweetness?: number;
      tannin?: number;
      intensity?: number;
      fizziness?: number;
    };
    flavor?: VivinoFlavorGroup[];
  };
}

class VivinoDirectProvider implements WineProfileProvider {
  name = "vivino-direct";
  isEnabled = appConfig.enableVivinoDirect;
  detail = this.isEnabled
    ? "Direct Vivino explore-API lookup is enabled."
    : "Direct Vivino provider is disabled (ENABLE_VIVINO_DIRECT=false).";

  private readonly headers = {
    "User-Agent": appConfig.vivinoDirectUserAgent,
    Accept: "application/json",
  };

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) {
      console.log("[vivino-direct] Provider is disabled, skipping");
      return null;
    }

    console.log("[vivino-direct] Looking up candidate: %s", [candidate.producer, candidate.label, candidate.vintage].filter(Boolean).join(" "));

    // Step 1: Call explore endpoint for candidate matches
    const exploreMatches = await this.fetchExplore(candidate);
    if (!exploreMatches?.length) {
      console.log("[vivino-direct] No explore matches found for candidate");
      return null;
    }
    console.log("[vivino-direct] Got %d explore matches", exploreMatches.length);

    // Step 2: Score all explore results and pick best match
    const scored = exploreMatches.map((match) => ({
      match,
      score: scoreWineMatch(candidate, {
        producer: match.vintage?.wine?.winery?.name ?? null,
        label: match.vintage?.wine?.name ?? null,
        vintage: match.vintage?.year ?? null,
        varietal: match.vintage?.wine?.style?.varietal_name ?? null,
        region: match.vintage?.wine?.region?.name ?? null,
      }),
    }));
    scored.sort((a, b) => b.score - a.score);
    const { match: selectedMatch, score: matchScore } = scored[0]!;

    const wine = selectedMatch.vintage?.wine;
    if (!wine) return null;

    // Log selected wine's full explore details for comparison
    console.log(
      "[vivino-direct] Selected wine from explore (score=%s):",
      matchScore.toFixed(3),
      JSON.stringify(selectedMatch, null, 2),
    );

    // Step 3: Always fetch the taste endpoint for the selected wine
    const tastesData = wine.id ? await this.fetchTastes(wine.id) : null;

    // Log taste endpoint response for side-by-side comparison
    console.log(
      "[vivino-direct] Taste endpoint response for wine id=%s:",
      wine.id,
      JSON.stringify(tastesData, null, 2),
    );

    // Step 4: Use taste endpoint data for structure; fall back to explore data
    const tasteStructure = tastesData?.tastes?.structure ?? wine.taste?.structure;
    const flavorData = tastesData?.tastes?.flavor ?? wine.taste?.flavor;

    const stats = selectedMatch.vintage?.statistics;
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
        displayName: wine.name ?? candidate.rawText ?? "",
        producer: wine.winery?.name ?? candidate.producer,
        label: wine.name ?? candidate.label,
        vintage: selectedMatch.vintage?.year ?? candidate.vintage,
        region: wine.region?.name ?? candidate.region,
        varietal: wine.style?.varietal_name ?? candidate.varietal,
        provider: this.name,
        rating: stats?.wine_ratings_average ?? null,
        provenanceLabel: hasDirectTaste ? "Direct" : "Mapped",
        taste: mapExternalTasteVector(
          {
            body: vivinoStructureToScale(wine.style?.body ?? tasteStructure?.intensity),
            acidity: vivinoStructureToScale(tasteStructure?.acidity),
            tannin: vivinoStructureToScale(tasteStructure?.tannin),
            sweetness: vivinoStructureToScale(tasteStructure?.sweetness),
          },
          hasDirectTaste ? "direct" : "mapped",
          hasDirectTaste ? 0.9 : 0.7,
        ),
        tastingNotes: extractTastingNotes(flavorData),
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  private async fetchExplore(candidate: WineCandidate): Promise<VivinoExploreMatch[] | null> {
    const query = [candidate.producer, candidate.label, candidate.vintage]
      .filter(Boolean)
      .join(" ");

    console.log("[vivino-direct] Explore query: %s", query);

    const url = new URL("https://www.vivino.com/api/explore/explore");
    url.searchParams.set("q", query);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "5");
    url.searchParams.set("currency_code", "USD");

    for (const code of appConfig.vivinoDirectCountryCodes) {
      url.searchParams.append("country_codes[]", code);
    }

    const response = await vivinoFetch(url, this.headers);
    if (!response) {
      console.log("[vivino-direct] Explore fetch returned null (request failed)");
      return null;
    }

    try {
      const payload = (await response.json()) as {
        explore_vintage?: { matches?: VivinoExploreMatch[] };
      };
      const matches = payload?.explore_vintage?.matches ?? null;
      console.log("[vivino-direct] Explore returned %d matches", matches?.length ?? 0);
      return matches;
    } catch (error) {
      console.log("[vivino-direct] Failed to parse explore response: %s", error instanceof Error ? error.message : error);
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

class WineSearcherProvider implements WineProfileProvider {
  name = "wine-searcher";
  isEnabled = Boolean(appConfig.wineSearcherEndpoint);
  detail = this.isEnabled
    ? "Custom Wine-Searcher endpoint is configured."
    : "No WINE_SEARCHER_ENDPOINT configured; provider is disabled by default.";

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) return null;
    const query = [candidate.producer, candidate.label, candidate.vintage].filter(Boolean).join(" ");
    const url = new URL(appConfig.wineSearcherEndpoint);
    url.searchParams.set("query", query);
    if (appConfig.wineSearcherApiKey) {
      url.searchParams.set("apiKey", appConfig.wineSearcherApiKey);
    }

    const payload = await fetch(url).then((response) => response.json());
    const item = Array.isArray(payload) ? payload[0] : payload?.items?.[0] ?? payload;
    if (!item) return null;

    return buildProfile(
      this.name,
      candidate,
      {
        displayName: item.name ?? item.wineName,
        producer: item.producer ?? item.winery,
        label: item.label ?? item.name,
        vintage: Number(item.vintage) || candidate.vintage || undefined,
        region: item.region,
        varietal: item.varietal ?? item.grape,
        rating: Number(item.rating) || undefined,
      },
      "mapped",
      0.68,
    );
  }
}

function inferDescriptionTaste(description: string) {
  const normalized = description.toLowerCase();
  return mapExternalTasteVector(
    {
      body: normalized.includes("full-bodied") ? 4 : normalized.includes("medium-bodied") ? 3 : 2,
      acidity: normalized.includes("crisp") || normalized.includes("zesty") ? 4 : 3,
      tannin: normalized.includes("tannin") || normalized.includes("structured") ? 3 : 1,
      sweetness:
        normalized.includes("dry") || normalized.includes("bone dry")
          ? 1
          : normalized.includes("off-dry")
            ? 2
            : 1,
    },
    "mapped",
    0.58,
  );
}

class SpoonacularStyleProvider implements WineProfileProvider {
  name = "spoonacular-style";
  isEnabled = Boolean(appConfig.spoonacularApiKey);
  detail = this.isEnabled
    ? "Configured with Spoonacular wine description lookups."
    : "Missing SPOONACULAR_API_KEY; provider is disabled.";

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) return null;
    const wine = candidate.varietal ?? candidate.label ?? candidate.rawText;
    const url = new URL("https://api.spoonacular.com/food/wine/description");
    url.searchParams.set("apiKey", appConfig.spoonacularApiKey);
    url.searchParams.set("wine", wine);

    const payload = (await fetch(url).then((response) => response.json())) as {
      wineDescription?: string;
    };

    if (!payload.wineDescription) return null;

    const mapped = inferDescriptionTaste(payload.wineDescription);
    return {
      provider: this.name,
      matchScore: scoreWineMatch(candidate, {
        label: candidate.label,
        varietal: candidate.varietal,
      }),
      profile: {
        id: nanoid(),
        displayName: wine,
        producer: candidate.producer,
        label: candidate.label ?? wine,
        vintage: candidate.vintage,
        region: candidate.region,
        varietal: candidate.varietal,
        provider: this.name,
        rating: null,
        provenanceLabel: "Mapped",
        taste: mapped,
        tastingNotes: null,
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}

class RuleBasedInferenceProvider implements WineProfileProvider {
  name = "rule-based";
  isEnabled = true;
  detail = "Always available local inference from extracted wine metadata.";

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    const result = buildProfile(this.name, candidate, {}, "inferred", 0.45);
    return {
      ...result,
      matchScore: 0.05,
    };
  }
}

export function createWineProfileProviders(
  settings: ProviderSettings = {
    apifyVivinoEnabled: appConfig.enableUnofficialVivino,
  },
): WineProfileProvider[] {
  const providerMap = new Map<string, WineProfileProvider>([
    ["vivino-direct", new VivinoDirectProvider()],
    ["apify-vivino", new ApifyVivinoProvider(settings.apifyVivinoEnabled)],
    ["wine-searcher", new WineSearcherProvider()],
    ["spoonacular-style", new SpoonacularStyleProvider()],
    ["rule-based", new RuleBasedInferenceProvider()],
  ]);

  return appConfig.providerOrder
    .map((name) => providerMap.get(name))
    .filter((provider): provider is WineProfileProvider => Boolean(provider));
}
