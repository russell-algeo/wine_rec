import type { Recommendation, WineCandidate } from "@wine-rec/contracts";
import { rankMatch, scoreRecommendation } from "@wine-rec/core";

import { appConfig } from "../config.js";
import { createOcrProvider } from "../providers/ocr.js";
import { createWineProfileProviders } from "../providers/wine-profiles.js";
import { parseWineCandidates } from "./parser.js";
import { getPreferences } from "./repository.js";

export async function runAnalysisPipeline(input: {
  filename: string;
  mimeType: string;
  storagePath: string;
}): Promise<{
  extractedText: string;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
}> {
  const ocrProvider = createOcrProvider();
  const extractedText = await ocrProvider.extractText(input);
  const candidates = parseWineCandidates(extractedText);
  const preference = await getPreferences();
  const providers = createWineProfileProviders();

  const recommendations: Recommendation[] = [];

  let isFirstCandidate = true;
  for (const candidate of candidates) {
    // Rate-limit delay between candidates to avoid Vivino 429s
    if (!isFirstCandidate && appConfig.vivinoDirectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, appConfig.vivinoDirectDelayMs));
    }
    isFirstCandidate = false;
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
