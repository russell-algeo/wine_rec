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
    ["wine-searcher", new WineSearcherProvider()],
    ["spoonacular-style", new SpoonacularStyleProvider()],
    ["rule-based", new RuleBasedInferenceProvider()],
  ]);

  return appConfig.providerOrder
    .map((name) => providerMap.get(name))
    .filter((provider): provider is WineProfileProvider => Boolean(provider));
}
