import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { cancelAnalysis, createUrlAnalysis, getAnalysisRun } from "../apps/api/src/api-handlers.ts";

const sourceUrl = process.env.BENCHMARK_URL?.trim();
const label = process.env.BENCHMARK_LABEL?.trim() || "benchmark";
const workerUrl = process.env.WORKER_URL?.trim();
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const pollIntervalMs = Number(process.env.BENCHMARK_POLL_MS ?? "1000");
const timeoutSeconds = Number(process.env.BENCHMARK_TIMEOUT_SECONDS ?? "180");
const cancelOnTimeout = (process.env.BENCHMARK_CANCEL_ON_TIMEOUT ?? "true").toLowerCase() === "true";
const outDir = process.env.BENCHMARK_OUT_DIR?.trim() || path.resolve(process.cwd(), "tmp/benchmarks");

if (!sourceUrl) {
  throw new Error("BENCHMARK_URL is required");
}

if (!workerUrl) {
  throw new Error("WORKER_URL is required");
}

if (!bypassSecret) {
  throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampSlug(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toSafeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "benchmark";
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const startedAt = Date.now();
  const created = await createUrlAnalysis({ url: sourceUrl });
  const analysisId = created.analysisId;

  let latest = await getAnalysisRun(analysisId);
  let timedOut = false;

  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    latest = await getAnalysisRun(analysisId);
    if (latest && ["completed", "failed", "canceled"].includes(latest.status)) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  if (!latest || !["completed", "failed", "canceled"].includes(latest.status)) {
    timedOut = true;
    if (cancelOnTimeout) {
      latest = await cancelAnalysis(analysisId);
    }
  }

  const finishedAt = Date.now();
  const createdAtMs = parseIsoMs(latest?.createdAt);
  const updatedAtMs = parseIsoMs(latest?.updatedAt);

  const result = {
    label,
    workerUrl,
    sourceUrl,
    analysisId,
    status: latest?.status ?? "missing",
    timedOut,
    canceledOnTimeout: timedOut && cancelOnTimeout,
    wallClockMs: finishedAt - startedAt,
    serverDurationMs:
      createdAtMs !== null && updatedAtMs !== null
        ? updatedAtMs - createdAtMs
        : null,
    candidateCount: latest?.candidates.length ?? 0,
    recommendationCount: latest?.recommendations.length ?? 0,
    matchedCount:
      latest?.recommendations.filter((recommendation) => recommendation.status === "matched").length ?? 0,
    lowConfidenceCount:
      latest?.recommendations.filter((recommendation) => recommendation.status === "low-confidence").length ?? 0,
    unmatchedCount:
      latest?.recommendations.filter((recommendation) => recommendation.status === "unmatched").length ?? 0,
    createdAt: latest?.createdAt ?? null,
    updatedAt: latest?.updatedAt ?? null,
    errorMessage: latest?.errorMessage ?? null,
  };

  const safeLabel = toSafeLabel(label);
  const timestampSlug = toTimestampSlug();
  const resultPath = path.join(outDir, `${safeLabel}-${timestampSlug}.result.json`);
  const analysisPath = path.join(outDir, `${safeLabel}-${timestampSlug}.analysis.json`);

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(analysisPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(result, null, 2));
  console.error(`Saved benchmark result to ${resultPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
