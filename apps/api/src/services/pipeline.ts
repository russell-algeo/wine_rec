import type { Recommendation, SourceType, WineCandidate } from "@wine-rec/contracts";
import { rankMatch, scoreRecommendation } from "@wine-rec/core";

import { createWineProfileProviders } from "../providers/wine-profiles.js";
import { parseWineCandidates } from "./parser.js";
import { getPreferences, getProviderSettings } from "./repository.js";
import { extractSourceText } from "./source-extractor.js";

export async function runAnalysisPipeline(input: {
  sourceType: SourceType;
  filename: string;
  mimeType: string;
  storagePath: string;
  sourceUrl?: string;
}): Promise<{
  extractedText: string;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
}> {
  const extractedText = await extractSourceText(input);
  const candidates = parseWineCandidates(extractedText);
  const preference = await getPreferences();
  const providerSettings = await getProviderSettings();
  const providers = createWineProfileProviders(providerSettings);

  const recommendations: Recommendation[] = [];

  for (const candidate of candidates) {
    let best:
      | {
          fitScore: number;
          matchConfidence: number;
          profile: Recommendation["profile"];
          status: Recommendation["status"];
        }
      | null = null;

    for (const provider of providers) {
      if (!provider.isEnabled) continue;
      const result = await provider.lookup(candidate);
      if (!result) continue;

      const status = rankMatch(result.matchScore);
      const fitScore = scoreRecommendation(preference, result.profile.taste);
      if (!best || result.matchScore > best.matchConfidence) {
        best = {
          fitScore,
          matchConfidence: result.matchScore,
          profile: result.profile,
          status,
        };
      }

      if (status === "matched") {
        break;
      }
    }

    recommendations.push({
      candidateId: candidate.id,
      fitScore: best?.fitScore ?? 0,
      matchConfidence: best?.matchConfidence ?? 0,
      profile: best?.profile ?? null,
      status: best?.status ?? "unmatched",
    });
  }

  recommendations.sort((left, right) => {
    if (right.fitScore !== left.fitScore) {
      return right.fitScore - left.fitScore;
    }
    return right.matchConfidence - left.matchConfidence;
  });

  return {
    extractedText,
    candidates,
    recommendations,
  };
}
