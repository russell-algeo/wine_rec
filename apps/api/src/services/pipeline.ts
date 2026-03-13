import type { Recommendation, SourceType, WineCandidate } from "@wine-rec/contracts";
import type { UserTastePreference } from "@wine-rec/contracts";
import { defaultPreference, rankMatch, scoreRecommendation } from "@wine-rec/core";

import { appConfig } from "../config.js";
import { createWineProfileProviders } from "../providers/wine-profiles.js";
import { parseWineCandidates } from "./parser.js";
import { extractSourceText } from "./source-extractor.js";

type AnalysisPipelineHooks = {
  shouldCancel?: () => Promise<boolean> | boolean;
  onCandidatesParsed?: (payload: {
    extractedText: string;
    candidates: WineCandidate[];
  }) => Promise<void> | void;
  onCandidateProcessed?: (payload: {
    candidate: WineCandidate;
    recommendation: Recommendation;
    completed: number;
    total: number;
    recommendations: Recommendation[];
  }) => Promise<void> | void;
};

type AnalysisPipelineOptions = {
  candidateConcurrency?: number;
};

export class AnalysisCanceledError extends Error {
  constructor() {
    super("Analysis stopped by user.");
    this.name = "AnalysisCanceledError";
  }
}

async function throwIfCanceled(
  shouldCancel: AnalysisPipelineHooks["shouldCancel"],
): Promise<void> {
  if (await shouldCancel?.()) {
    throw new AnalysisCanceledError();
  }
}

async function buildCandidateRecommendation(
  candidate: WineCandidate,
  preference: UserTastePreference,
  providers: ReturnType<typeof createWineProfileProviders>,
): Promise<Recommendation> {
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

  return {
    candidateId: candidate.id,
    fitScore: best?.fitScore ?? 0,
    matchConfidence: best?.matchConfidence ?? 0,
    profile: best?.profile ?? null,
    status: best?.status ?? "unmatched",
  };
}

export async function runAnalysisPipeline(input: {
  sourceType: SourceType;
  filename: string;
  mimeType: string;
  storagePath: string;
  sourceUrl?: string;
  fileBuffer?: Buffer;
}, hooks: AnalysisPipelineHooks = {}, options: AnalysisPipelineOptions = {}): Promise<{
  extractedText: string;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
}> {
  await throwIfCanceled(hooks.shouldCancel);
  const extractedText = await extractSourceText(input);
  await throwIfCanceled(hooks.shouldCancel);
  const candidates = parseWineCandidates(extractedText);
  await throwIfCanceled(hooks.shouldCancel);
  await hooks.onCandidatesParsed?.({
    extractedText,
    candidates,
  });
  await throwIfCanceled(hooks.shouldCancel);
  const preference = defaultPreference();
  const providers = createWineProfileProviders();
  const candidateConcurrency = Math.min(
    Math.max(1, options.candidateConcurrency ?? appConfig.analysisCandidateConcurrency),
    Math.max(1, candidates.length),
  );
  const recommendationsByIndex = new Array<Recommendation | undefined>(candidates.length);
  let nextCandidateIndex = 0;
  let completed = 0;
  let progressChain = Promise.resolve();
  let fatalError: unknown = null;

  async function processCandidateQueue(): Promise<void> {
    while (true) {
      if (fatalError) {
        return;
      }

      if (await hooks.shouldCancel?.()) {
        fatalError ??= new AnalysisCanceledError();
        return;
      }

      const currentIndex = nextCandidateIndex;
      nextCandidateIndex += 1;

      if (currentIndex >= candidates.length) {
        return;
      }

      const candidate = candidates[currentIndex]!;
      let recommendation: Recommendation;

      try {
        recommendation = await buildCandidateRecommendation(candidate, preference, providers);
      } catch (error) {
        fatalError ??= error;
        return;
      }

      if (fatalError) {
        return;
      }

      if (await hooks.shouldCancel?.()) {
        fatalError ??= new AnalysisCanceledError();
        return;
      }

      recommendationsByIndex[currentIndex] = recommendation;
      completed += 1;

      const snapshot = recommendationsByIndex.filter(
        (value): value is Recommendation => value !== undefined,
      );
      const completedCount = completed;

      progressChain = progressChain.then(async () => {
        if (await hooks.shouldCancel?.()) {
          fatalError ??= new AnalysisCanceledError();
          return;
        }

        await hooks.onCandidateProcessed?.({
          candidate,
          recommendation,
          completed: completedCount,
          total: candidates.length,
          recommendations: [...snapshot],
        });
      });
    }
  }

  await Promise.all(
    Array.from({ length: candidateConcurrency }, () => processCandidateQueue()),
  );
  await progressChain;

  if (fatalError) {
    throw fatalError;
  }

  const recommendations = recommendationsByIndex.filter(
    (value): value is Recommendation => value !== undefined,
  );

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
