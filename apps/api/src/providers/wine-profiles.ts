import type { WineCandidate, WineProfile } from "@wine-rec/contracts";
import { inferTasteVector, mapExternalTasteVector, scoreWineMatch } from "@wine-rec/core";
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
      fetchedAt: new Date().toISOString(),
    },
  };
}

class ApifyVivinoProvider implements WineProfileProvider {
  name = "apify-vivino";
  isEnabled = appConfig.enableUnofficialVivino && Boolean(
    appConfig.apifyVivinoEndpoint || (appConfig.apifyToken && appConfig.apifyVivinoActorId),
  );
  detail = this.isEnabled
    ? "Experimental Apify-backed Vivino lookup is enabled."
    : "Missing Apify configuration or unofficial provider disabled.";

  async lookup(candidate: WineCandidate): Promise<CandidateProfileResult | null> {
    if (!this.isEnabled) return null;

    const query = [candidate.producer, candidate.label, candidate.vintage].filter(Boolean).join(" ");
    const payload = appConfig.apifyVivinoEndpoint
      ? await fetch(appConfig.apifyVivinoEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, candidate }),
        }).then((response) => response.json())
      : await fetch(
          `https://api.apify.com/v2/acts/${appConfig.apifyVivinoActorId}/run-sync-get-dataset-items?token=${appConfig.apifyToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          },
        ).then((response) => response.json());

    const item = Array.isArray(payload) ? payload[0] : payload?.items?.[0] ?? payload;
    if (!item) return null;

    return buildProfile(
      this.name,
      candidate,
      {
        displayName: item.name ?? item.title,
        producer: item.winery ?? item.producer,
        label: item.label ?? item.name ?? item.title,
        vintage: Number(item.vintage) || candidate.vintage || undefined,
        region: item.region,
        varietal: item.grape ?? item.varietal,
        rating: Number(item.rating) || undefined,
        body: Number(item.body) || undefined,
        acidity: Number(item.acidity) || undefined,
        tannin: Number(item.tannins ?? item.tannin) || undefined,
        sweetness: Number(item.sweetness) || undefined,
        sourceUrl: item.url,
      },
      item.body || item.acidity || item.tannins || item.sweetness ? "direct" : "mapped",
      item.body || item.acidity || item.tannins || item.sweetness ? 0.92 : 0.7,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Vivino Direct – hits the public explore API without Apify          */
/* ------------------------------------------------------------------ */

/** Map a Vivino taste-structure value (≈ 0–1 float) to our 1–10 int scale. */
function vivinoTasteToScale(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  // Vivino reports structure values on a roughly 0–1 scale
  return Math.max(1, Math.min(10, Math.round(value * 10)));
}

/** Fetch with retry on HTTP 429 using exponential backoff (pattern from aptash/vivino-api). */
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
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) return null;
      return response;
    } catch {
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
        flavor?: Array<{
          group?: string;
          stats?: { score?: number };
          primary_keywords?: Array<{ name?: string }>;
        }>;
      };
      style?: { varietal_name?: string; body?: number };
    };
    statistics?: {
      wine_ratings_average?: number;
      ratings_count?: number;
    };
  };
}

/** Shape returned by Vivino's /api/wines/{id}/tastes endpoint (from gugarosa/viviner). */
interface VivinoTastesResponse {
  tastes?: {
    structure?: {
      acidity?: number;
      sweetness?: number;
      tannin?: number;
      intensity?: number;
      fizziness?: number;
    };
    flavor?: Array<{
      group?: string;
      stats?: { score?: number };
      primary_keywords?: Array<{ name?: string }>;
    }>;
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
    if (!this.isEnabled) return null;

    const query = [candidate.producer, candidate.label, candidate.vintage]
      .filter(Boolean)
      .join(" ");

    const url = new URL("https://www.vivino.com/api/explore/explore");
    url.searchParams.set("q", query);
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", "5");
    url.searchParams.set("currency_code", "USD");

    // Add optional country filter (pattern from Piltxi/Vivino-Crawler & gugarosa/viviner)
    for (const code of appConfig.vivinoDirectCountryCodes) {
      url.searchParams.append("country_codes[]", code);
    }

    const response = await vivinoFetch(url, this.headers);
    if (!response) return null;

    let payload: { explore_vintage?: { matches?: VivinoExploreMatch[] } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return null;
    }

    const matches = payload?.explore_vintage?.matches;
    if (!matches?.length) return null;

    // Pick first match (best relevance from Vivino's ranking)
    const item = matches[0]!;
    const wine = item.vintage?.wine;
    const stats = item.vintage?.statistics;
    let taste = wine?.taste?.structure;

    if (!wine) return null;

    // Optionally fetch richer taste data from /api/wines/{id}/tastes (pattern from gugarosa/viviner)
    if (appConfig.vivinoDirectFetchTastes && wine.id && !taste) {
      const tastesUrl = `https://www.vivino.com/api/wines/${wine.id}/tastes`;
      const tastesResponse = await vivinoFetch(new URL(tastesUrl), this.headers);
      if (tastesResponse) {
        try {
          const tastesPayload = (await tastesResponse.json()) as VivinoTastesResponse;
          if (tastesPayload?.tastes?.structure) {
            taste = tastesPayload.tastes.structure;
          }
        } catch {
          // ignore – fall back to explore data
        }
      }
    }

    const hasDirectTaste = Boolean(
      taste &&
        (taste.acidity != null ||
          taste.sweetness != null ||
          taste.tannin != null ||
          taste.intensity != null),
    );

    return buildProfile(
      this.name,
      candidate,
      {
        displayName: wine.name ?? undefined,
        producer: wine.winery?.name ?? undefined,
        label: wine.name ?? undefined,
        vintage: item.vintage?.year ?? candidate.vintage ?? undefined,
        region: wine.region?.name ?? undefined,
        varietal: wine.style?.varietal_name ?? candidate.varietal ?? undefined,
        rating: stats?.wine_ratings_average ?? undefined,
        body: vivinoTasteToScale(wine.style?.body ?? taste?.intensity),
        acidity: vivinoTasteToScale(taste?.acidity),
        tannin: vivinoTasteToScale(taste?.tannin),
        sweetness: vivinoTasteToScale(taste?.sweetness),
      },
      hasDirectTaste ? "direct" : "mapped",
      hasDirectTaste ? 0.9 : 0.7,
    );
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
      body: normalized.includes("full-bodied") ? 8 : normalized.includes("medium-bodied") ? 6 : 4,
      acidity: normalized.includes("crisp") || normalized.includes("zesty") ? 8 : 5,
      tannin: normalized.includes("tannin") || normalized.includes("structured") ? 6 : 2,
      sweetness:
        normalized.includes("dry") || normalized.includes("bone dry")
          ? 1
          : normalized.includes("off-dry")
            ? 4
            : 2,
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
    return buildProfile(this.name, candidate, {}, "inferred", 0.45);
  }
}

export function createWineProfileProviders(): WineProfileProvider[] {
  const providerMap = new Map<string, WineProfileProvider>([
    ["apify-vivino", new ApifyVivinoProvider()],
    ["vivino-direct", new VivinoDirectProvider()],
    ["wine-searcher", new WineSearcherProvider()],
    ["spoonacular-style", new SpoonacularStyleProvider()],
    ["rule-based", new RuleBasedInferenceProvider()],
  ]);

  return appConfig.providerOrder
    .map((name) => providerMap.get(name))
    .filter((provider): provider is WineProfileProvider => Boolean(provider));
}
