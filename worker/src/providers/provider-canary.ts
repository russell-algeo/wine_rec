import type { WineCandidate } from "@wine-rec/contracts";
import { scoreWineMatch } from "@wine-rec/core";
import { z } from "zod";

import { appConfig } from "../config.js";
import { searchVivinoExploreWithCurl } from "./vivino-explore-curl.js";
import { buildVivinoSearchQueries } from "./wine-profiles.js";
import { RetryableVivinoBrowserError, VivinoBrowser } from "./vivino-browser.js";

const MAX_CANARY_CANDIDATES = 5;
const MAX_CANARY_COOLDOWN_MS = 15_000;
const DIRECT_HIT_THRESHOLD = 0.38;

export const providerCanaryRequestSchema = z.object({
  mode: z.enum(["dry-run", "live"]).default("dry-run"),
  candidates: z.array(z.object({
    id: z.string().trim().min(1),
    rawText: z.string().trim().min(1),
    price: z.string().nullable().default(null),
    menuTab: z.string().nullable().default(null),
    menuSection: z.string().nullable().default(null),
    lineNumber: z.number().int().nonnegative().default(0),
    producer: z.string().nullable().default(null),
    label: z.string().nullable().default(null),
    vintage: z.number().int().min(1900).max(2100).nullable().default(null),
    color: z.string().nullable().default(null),
    varietal: z.string().nullable().default(null),
    region: z.string().nullable().default(null),
    notes: z.string().nullable().optional(),
    extractionConfidence: z.number().min(0).max(1).default(1),
  })).min(1).max(MAX_CANARY_CANDIDATES),
});

export type ProviderCanaryRequest = z.infer<typeof providerCanaryRequestSchema>;

export type ProviderCanaryBodyClass =
  | "ok"
  | "cloudfront-waf"
  | "aws-waf-challenge"
  | "rate-limited"
  | "zero-results"
  | "network-error"
  | "unknown-error";

export type ProviderCanaryCandidateResult = {
  candidateId: string;
  query: string | null;
  status: "planned" | "ok" | "blocked" | "error" | "no-query";
  bodyClass: ProviderCanaryBodyClass | "not-fetched";
  recordCount: number;
  directHit: {
    accepted: boolean;
    matchScore: number | null;
    providerWineId: string | null;
    matchedName: string | null;
  };
};

export type ProviderCanaryStopReason = "completed" | "blocked" | "provider-error";

export type ProviderCanaryResult = {
  provider: "vivino-direct";
  mode: "dry-run" | "live";
  candidateLimit: number;
  recommendationQualityEvaluated: false;
  safety: {
    execution: "serial";
    cooldownMs: number;
    stopOnFirstBlockOrError: true;
  };
  summary: {
    candidateCount: number;
    attemptedCandidateCount: number;
    plannedQueryCount: number;
    fetchedQueryCount: number;
    okCount: number;
    blockedCount: number;
    directHitCount: number;
    acceptedDirectHits: Array<{
      candidateId: string;
      matchScore: number;
      providerWineId: string;
      matchedName: string;
    }>;
    stopReason: ProviderCanaryStopReason;
  };
  candidates: ProviderCanaryCandidateResult[];
};

export function classifyProviderCanaryBody(input: {
  statusCode?: number | null;
  body?: string | null;
  errorMessage?: string | null;
  recordCount?: number | null;
}): ProviderCanaryBodyClass {
  const statusCode = input.statusCode ?? null;
  const haystack = [input.body, input.errorMessage].filter(Boolean).join("\n").toLowerCase();

  if (statusCode === 429 || /\brate limit|too many requests/.test(haystack)) {
    return "rate-limited";
  }
  if (statusCode === 403 || /cloudfront|request blocked|distribution is configured to block access/.test(haystack)) {
    return "cloudfront-waf";
  }
  if (/aws.?waf|captcha|challenge/.test(haystack)) {
    return "aws-waf-challenge";
  }
  if (/network|econn|enotfound|timed out|timeout/.test(haystack)) {
    return "network-error";
  }
  if ((input.recordCount ?? 0) === 0 && /zero result|no wines|no result/.test(haystack)) {
    return "zero-results";
  }
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    return "ok";
  }
  return "unknown-error";
}

function firstQuery(candidate: WineCandidate): string | null {
  return buildVivinoSearchQueries(candidate)[0] ?? null;
}

function plannedResult(candidate: WineCandidate): ProviderCanaryCandidateResult {
  return {
    candidateId: candidate.id,
    query: firstQuery(candidate),
    status: firstQuery(candidate) ? "planned" : "no-query",
    bodyClass: "not-fetched",
    recordCount: 0,
    directHit: {
      accepted: false,
      matchScore: null,
      providerWineId: null,
      matchedName: null,
    },
  };
}

async function liveResult(candidate: WineCandidate): Promise<ProviderCanaryCandidateResult> {
  const query = firstQuery(candidate);
  if (!query) {
    return plannedResult(candidate);
  }

  try {
    const hits = appConfig.vivinoDirectSearchTransport === "curl-explore"
      ? await searchVivinoExploreWithCurl(query)
      : await VivinoBrowser.getInstance().search(query);
    const scored = hits
      .map((hit) => ({
        hit,
        score: scoreWineMatch(candidate, {
          producer: hit.wineryName,
          label: hit.wineName,
          vintage: hit.year,
          varietal: null,
          region: hit.regionAndCountry,
        }),
      }))
      .sort((left, right) => right.score - left.score);
    const best = scored[0] ?? null;
    const accepted = Boolean(best && best.score >= DIRECT_HIT_THRESHOLD);

    return {
      candidateId: candidate.id,
      query,
      status: "ok",
      bodyClass: classifyProviderCanaryBody({ statusCode: 200, recordCount: hits.length }),
      recordCount: hits.length,
      directHit: {
        accepted,
        matchScore: best?.score ?? null,
        providerWineId: best ? String(best.hit.wineId) : null,
        matchedName: best
          ? [best.hit.wineryName, best.hit.wineName].filter(Boolean).join(" ")
          : null,
      },
    };
  } catch (error) {
    const message = error instanceof RetryableVivinoBrowserError
      ? error.reason
      : error instanceof Error
        ? error.message
        : String(error);
    const bodyClass = classifyProviderCanaryBody({ errorMessage: message });
    return {
      candidateId: candidate.id,
      query,
      status: bodyClass === "cloudfront-waf" || bodyClass === "aws-waf-challenge" ? "blocked" : "error",
      bodyClass,
      recordCount: 0,
      directHit: {
        accepted: false,
        matchScore: null,
        providerWineId: null,
        matchedName: null,
      },
    };
  }
}

function readConfiguredCooldownMs(): number {
  const raw = process.env.WINE_REC_PROVIDER_CANARY_COOLDOWN_MS?.trim();
  if (!raw) return 0;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;

  return Math.min(parsed, MAX_CANARY_COOLDOWN_MS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function liveResults(candidates: WineCandidate[], cooldownMs: number): Promise<{
  results: ProviderCanaryCandidateResult[];
  stopReason: ProviderCanaryStopReason;
}> {
  const results: ProviderCanaryCandidateResult[] = [];

  for (const candidate of candidates) {
    const result = await liveResult(candidate);
    results.push(result);

    if (result.status === "blocked") {
      return { results, stopReason: "blocked" };
    }
    if (result.status === "error") {
      return { results, stopReason: "provider-error" };
    }
    if (cooldownMs > 0 && results.length < candidates.length) {
      await wait(cooldownMs);
    }
  }

  return { results, stopReason: "completed" };
}

function acceptedDirectHits(results: ProviderCanaryCandidateResult[]): ProviderCanaryResult["summary"]["acceptedDirectHits"] {
  return results
    .filter((result) => (
      result.directHit.accepted &&
      result.directHit.matchScore !== null &&
      result.directHit.providerWineId !== null &&
      result.directHit.matchedName !== null
    ))
    .map((result) => ({
      candidateId: result.candidateId,
      matchScore: result.directHit.matchScore as number,
      providerWineId: result.directHit.providerWineId as string,
      matchedName: result.directHit.matchedName as string,
    }));
}

export async function runProviderCanary(input: ProviderCanaryRequest): Promise<ProviderCanaryResult> {
  const parsed = providerCanaryRequestSchema.parse(input);
  const candidates = parsed.candidates.slice(0, MAX_CANARY_CANDIDATES);
  const cooldownMs = parsed.mode === "live" ? readConfiguredCooldownMs() : 0;
  const { results, stopReason } = parsed.mode === "live"
    ? await liveResults(candidates, cooldownMs)
    : { results: candidates.map(plannedResult), stopReason: "completed" as const };
  const directHits = acceptedDirectHits(results);

  return {
    provider: "vivino-direct",
    mode: parsed.mode,
    candidateLimit: MAX_CANARY_CANDIDATES,
    recommendationQualityEvaluated: false,
    safety: {
      execution: "serial",
      cooldownMs,
      stopOnFirstBlockOrError: true,
    },
    summary: {
      candidateCount: candidates.length,
      attemptedCandidateCount: results.length,
      plannedQueryCount: results.filter((result) => result.query).length,
      fetchedQueryCount: results.filter((result) => result.status !== "planned" && result.status !== "no-query").length,
      okCount: results.filter((result) => result.status === "ok").length,
      blockedCount: results.filter((result) => result.status === "blocked").length,
      directHitCount: directHits.length,
      acceptedDirectHits: directHits,
      stopReason,
    },
    candidates: results,
  };
}
