import type { Recommendation, SourceType, WineCandidate } from "@wine-rec/contracts";
import type { UserTastePreference } from "@wine-rec/contracts";
import { defaultPreference, rankMatch, scoreRecommendation } from "@wine-rec/core";

import { appConfig } from "../config.js";
import {
  createWineProfileProviders,
  RetryableWineProfileLookupError,
} from "../providers/wine-profiles.js";
import { parseWineCandidates } from "./parser.js";
import { extractSourceText } from "./source-extractor.js";

type AnalysisPipelineHooks = {
  shouldCancel?: () => Promise<boolean> | boolean;
  shouldYield?: () => Promise<boolean> | boolean;
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

export class AnalysisRetryableError extends Error {
  constructor(
    readonly candidateId: string,
    readonly cause: unknown,
  ) {
    super(`Analysis retry required while processing candidate ${candidateId}.`);
    this.name = "AnalysisRetryableError";
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
    let result: Awaited<ReturnType<typeof provider.lookup>>;
    try {
      result = await provider.lookup(candidate);
    } catch (error) {
      if (error instanceof RetryableWineProfileLookupError) {
        throw new AnalysisRetryableError(candidate.id, error);
      }
      throw error;
    }

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

function sortRecommendations(recommendations: Recommendation[]): void {
  recommendations.sort((left, right) => {
    if (right.fitScore !== left.fitScore) {
      return right.fitScore - left.fitScore;
    }
    return right.matchConfidence - left.matchConfidence;
  });
}

export async function runCandidateAnalysis(input: {
  candidates: WineCandidate[];
  existingRecommendations?: Recommendation[];
}, hooks: Pick<AnalysisPipelineHooks, "shouldCancel" | "shouldYield" | "onCandidateProcessed"> = {}, options: AnalysisPipelineOptions = {}): Promise<{
  recommendations: Recommendation[];
  didCompleteAll: boolean;
}> {
  const preference = defaultPreference();
  const providers = createWineProfileProviders();
  const existingRecommendations = input.existingRecommendations ?? [];
  const recommendationsByCandidateId = new Map(
    existingRecommendations.map((recommendation) => [recommendation.candidateId, recommendation]),
  );

  const shouldSerialize = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const configuredConcurrency = shouldSerialize
    ? options.candidateConcurrency ?? 1
    : options.candidateConcurrency ?? appConfig.analysisCandidateConcurrency;
  const desiredConcurrency = Math.min(
    Math.max(1, configuredConcurrency),
    Math.max(1, input.candidates.length),
  );

  let nextCandidateIndex = 0;
  let didYield = false;
  let fatalError: unknown = null;
  let progressChain = Promise.resolve();

  async function processCandidateQueue(): Promise<void> {
    while (true) {
      if (fatalError || didYield) {
        return;
      }

      if (await hooks.shouldCancel?.()) {
        fatalError ??= new AnalysisCanceledError();
        return;
      }

      const currentIndex = nextCandidateIndex;
      nextCandidateIndex += 1;

      if (currentIndex >= input.candidates.length) {
        return;
      }

      const candidate = input.candidates[currentIndex]!;
      if (recommendationsByCandidateId.has(candidate.id)) {
        continue;
      }

      if (await hooks.shouldYield?.()) {
        didYield = true;
        return;
      }

      let recommendation: Recommendation;
      try {
        recommendation = await buildCandidateRecommendation(candidate, preference, providers);
      } catch (error) {
        fatalError ??= error;
        return;
      }

      if (fatalError || didYield) {
        return;
      }

      if (await hooks.shouldCancel?.()) {
        fatalError ??= new AnalysisCanceledError();
        return;
      }

      recommendationsByCandidateId.set(candidate.id, recommendation);
      const snapshot = input.candidates
        .map((value) => recommendationsByCandidateId.get(value.id))
        .filter((value): value is Recommendation => value !== undefined);
      const completed = snapshot.length;

      progressChain = progressChain.then(async () => {
        if (await hooks.shouldCancel?.()) {
          fatalError ??= new AnalysisCanceledError();
          return;
        }

        await hooks.onCandidateProcessed?.({
          candidate,
          recommendation,
          completed,
          total: input.candidates.length,
          recommendations: [...snapshot],
        });
      });
    }
  }

  await Promise.all(
    Array.from({ length: desiredConcurrency }, () => processCandidateQueue()),
  );
  await progressChain;

  if (fatalError) {
    throw fatalError;
  }

  const recommendations = input.candidates
    .map((candidate) => recommendationsByCandidateId.get(candidate.id))
    .filter((value): value is Recommendation => value !== undefined);

  return {
    recommendations,
    didCompleteAll: recommendations.length === input.candidates.length,
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
  const { recommendations } = await runCandidateAnalysis(
    { candidates },
    hooks,
    options,
  );
  sortRecommendations(recommendations);

  return {
    extractedText,
    candidates,
    recommendations,
  };
}
