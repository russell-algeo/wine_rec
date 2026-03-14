import { Client as QStashClient } from "@upstash/qstash";
import { nanoid } from "nanoid";
import { z } from "zod";

import {
  analysisRunSchema,
  createAnalysisResponseSchema,
  providerHealthSchema,
  sourceTypeSchema,
  type AnalysisRun,
  type CreateAnalysisResponse,
  type ProviderHealth,
  type Recommendation,
  type WineCandidate,
} from "@wine-rec/contracts";

import { createOcrProvider } from "./providers/ocr.js";
import { VivinoBrowser } from "./providers/vivino-browser.js";
import { createWineProfileProviders } from "./providers/wine-profiles.js";
import { runCandidateAnalysis } from "./services/pipeline.js";
import { parseWineCandidates } from "./services/parser.js";
import { extractSourceText } from "./services/source-extractor.js";
import { fetchUrlPreview } from "./services/url-preview.js";

const coordinatorWorkerJobPayloadSchema = z.object({
  mode: z.literal("coordinator").default("coordinator"),
  jobId: z.string(),
  sourceType: sourceTypeSchema,
  sourceFilename: z.string(),
  mimeType: z.string().optional(),
  fileBase64: z.string().optional(),
  sourceUrl: z.string().url().optional(),
});

const chunkWorkerJobPayloadSchema = z.object({
  mode: z.literal("chunk"),
  jobId: z.string(),
  chunkIndex: z.number().int().nonnegative(),
});

const workerJobPayloadSchema = z.union([
  chunkWorkerJobPayloadSchema,
  coordinatorWorkerJobPayloadSchema,
]);

type CoordinatorWorkerJobPayload = z.infer<typeof coordinatorWorkerJobPayloadSchema>;
type ChunkWorkerJobPayload = z.infer<typeof chunkWorkerJobPayloadSchema>;
export type WorkerJobPayload = z.infer<typeof workerJobPayloadSchema>;

// Leave enough headroom for slow Vivino searches, browser recovery, and the
// follow-up QStash publish before Vercel's 60-second Hobby timeout.
const SERVERLESS_WORKER_TIME_BUDGET_MS = 25_000;
const SERVERLESS_WORKER_CHUNK_COUNT = 5;
const STOPPED_ANALYSIS_MESSAGE = "Analysis stopped. Start a new scan when you're ready.";

export class RequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "RequestError";
  }
}

class JobInactiveError extends Error {
  constructor(readonly jobId: string, readonly status: AnalysisRun["status"] | "missing") {
    super(`Analysis ${jobId} is no longer active (${status})`);
    this.name = "JobInactiveError";
  }
}

const uploadSourceSchema = z.object({
  sourceType: sourceTypeSchema,
});

function inferSourceType(mimeType: string | undefined): "upload-image" | "upload-pdf" {
  return mimeType === "application/pdf" ? "upload-pdf" : "upload-image";
}

function inferMimeType(filename: string, mimeType: string | undefined): string {
  if (mimeType) {
    return mimeType;
  }

  if (filename.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }

  return "image/jpeg";
}

function buildDisabledOcrUploadMessage(detail: string): string {
  return `Image and PDF uploads require OCR. ${detail} Use a wine-list URL instead or configure an available OCR provider.`;
}

function inferUrlSourceType(input: string): "url-html" | "url-pdf" {
  const url = new URL(input);
  return url.pathname.toLowerCase().endsWith(".pdf") ? "url-pdf" : "url-html";
}

export function assertHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  return url;
}

function getQStashClient(): QStashClient {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error("QSTASH_TOKEN is not configured");
  }

  const baseUrl = process.env.QSTASH_URL;

  return new QStashClient(baseUrl ? { token, baseUrl } : { token });
}

async function loadJobStore() {
  return import("./store/job-store.js");
}

type JobStore = Awaited<ReturnType<typeof loadJobStore>>;

function getWorkerUrl(): string {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    const base = vercelUrl.startsWith("http") ? vercelUrl : `https://${vercelUrl}`;
    return `${base.replace(/\/$/, "")}/api/worker`;
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    throw new Error("WORKER_URL is not configured");
  }

  const normalized = workerUrl.replace(/\/$/, "");
  return normalized.endsWith("/api/worker") ? normalized : `${normalized}/api/worker`;
}

async function publishWorkerJob(payload: WorkerJobPayload): Promise<{ messageId: string }> {
  const request = {
    url: getWorkerUrl(),
    body: payload,
    retries: 0,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const response = bypassSecret
    ? await getQStashClient().publishJSON({
        ...request,
        headers: {
          "x-vercel-protection-bypass": bypassSecret,
        },
      })
    : await getQStashClient().publishJSON(request);

  if (!("messageId" in response)) {
    throw new Error("QStash publish did not return a message id");
  }

  return { messageId: response.messageId };
}

async function deleteQueuedMessage(messageId: string | null | undefined): Promise<void> {
  if (!messageId) {
    return;
  }

  await getQStashClient().messages.delete(messageId).catch(() => undefined);
}

function toCreateAnalysisResponse(job: AnalysisRun): CreateAnalysisResponse {
  return createAnalysisResponseSchema.parse({
    analysisId: job.id,
    status: job.status,
  });
}

export async function getProviderHealth(): Promise<ProviderHealth[]> {
  const ocrProvider = createOcrProvider();
  const providers = [
    {
      name: ocrProvider.name,
      availability: ocrProvider.isEnabled ? "enabled" : "disabled",
      enabled: ocrProvider.isEnabled,
      detail: ocrProvider.detail,
    },
    ...createWineProfileProviders().map((provider) => ({
      name: provider.name,
      availability: provider.isEnabled ? "enabled" : "disabled",
      enabled: provider.isEnabled,
      detail: provider.detail,
    })),
  ];

  return z.array(providerHealthSchema).parse(providers);
}

export async function getPreview(urlInput: string): Promise<{ title: string | null; domain: string }> {
  let parsed: URL;

  try {
    parsed = assertHttpUrl(urlInput);
  } catch {
    throw new RequestError("Invalid URL", 400);
  }

  try {
    return await fetchUrlPreview(parsed.href);
  } catch {
    return {
      title: null,
      domain: parsed.hostname,
    };
  }
}

export async function createUploadAnalysis(input: {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}): Promise<CreateAnalysisResponse> {
  const ocrProvider = createOcrProvider();

  if (!ocrProvider.isEnabled) {
    throw new RequestError(buildDisabledOcrUploadMessage(ocrProvider.detail), 503);
  }

  const sourceType = uploadSourceSchema.parse({
    sourceType: inferSourceType(input.mimeType),
  }).sourceType;
  const mimeType = inferMimeType(input.filename, input.mimeType);
  const id = nanoid();
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType,
    sourceFilename: input.filename,
  });

  try {
    const { messageId } = await publishWorkerJob({
      mode: "coordinator",
      jobId: id,
      sourceType,
      sourceFilename: input.filename,
      mimeType,
      fileBase64: input.buffer.toString("base64"),
    });
    await updateJob(id, { queueMessageId: messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue analysis";
    await updateJob(id, {
      status: "failed",
      queueMessageId: null,
      errorMessage: message,
    });
    throw error;
  }

  return toCreateAnalysisResponse(analysisRunSchema.parse(job));
}

export async function createUrlAnalysis(input: { url: string }): Promise<CreateAnalysisResponse> {
  let url: URL;

  try {
    url = assertHttpUrl(input.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL";
    throw new RequestError(message, 400);
  }

  const id = nanoid();
  const sourceType = inferUrlSourceType(url.toString());
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType,
    sourceFilename: url.toString(),
  });

  try {
    const { messageId } = await publishWorkerJob({
      mode: "coordinator",
      jobId: id,
      sourceType,
      sourceFilename: url.toString(),
      sourceUrl: url.toString(),
    });
    await updateJob(id, { queueMessageId: messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue analysis";
    await updateJob(id, {
      status: "failed",
      queueMessageId: null,
      errorMessage: message,
    });
    throw error;
  }

  return toCreateAnalysisResponse(analysisRunSchema.parse(job));
}

export async function getAnalysisRun(id: string): Promise<AnalysisRun | null> {
  const { getJob } = await loadJobStore();
  const job = await getJob(id);
  return job ? analysisRunSchema.parse(job) : null;
}

export async function cancelAnalysis(id: string): Promise<AnalysisRun | null> {
  const { getJob, listJobChunks, updateJob, updateJobChunk } = await loadJobStore();
  const existing = await getJob(id);

  if (!existing) {
    return null;
  }

  if (existing.status === "completed" || existing.status === "failed" || existing.status === "canceled") {
    return analysisRunSchema.parse(existing);
  }

  const chunks = existing.chunkCount > 0 ? await listJobChunks(id, existing.chunkCount) : [];

  await deleteQueuedMessage(existing.queueMessageId);
  await Promise.all(chunks.map((chunk) => deleteQueuedMessage(chunk.queueMessageId)));
  await Promise.all(
    chunks.map((chunk) =>
      updateJobChunk(id, chunk.index, {
        status: "canceled",
        queueMessageId: null,
        errorMessage: STOPPED_ANALYSIS_MESSAGE,
      })),
  );

  await updateJob(id, {
    status: "canceled",
    queueMessageId: null,
    errorMessage: STOPPED_ANALYSIS_MESSAGE,
  });

  const canceled = await getJob(id);
  return canceled ? analysisRunSchema.parse(canceled) : null;
}

export function parseWorkerJobPayload(input: unknown): WorkerJobPayload {
  return workerJobPayloadSchema.parse(input);
}

async function assertJobActive(jobId: string, store?: JobStore): Promise<void> {
  const jobStore = store ?? await loadJobStore();
  const current = await jobStore.getJob(jobId);

  if (!current) {
    throw new JobInactiveError(jobId, "missing");
  }

  if (current.status === "canceled" || current.status === "completed" || current.status === "failed") {
    throw new JobInactiveError(jobId, current.status);
  }
}

function hasParsedJobState(job: {
  extractedText: string | null;
}): boolean {
  return job.extractedText !== null;
}

function splitCandidatesIntoChunks(
  candidates: WineCandidate[],
  desiredChunkCount: number,
): WineCandidate[][] {
  if (candidates.length === 0) {
    return [];
  }

  const chunkCount = Math.min(desiredChunkCount, candidates.length);
  const baseChunkSize = Math.floor(candidates.length / chunkCount);
  const remainder = candidates.length % chunkCount;
  const chunks: WineCandidate[][] = [];
  let nextStartIndex = 0;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const chunkSize = baseChunkSize + (chunkIndex < remainder ? 1 : 0);
    const chunk = candidates.slice(nextStartIndex, nextStartIndex + chunkSize);
    nextStartIndex += chunkSize;
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

async function syncJobFromChunks(store: JobStore, jobId: string): Promise<void> {
  const job = await store.getJob(jobId);
  if (!job || job.status === "canceled" || job.chunkCount <= 0) {
    return;
  }

  const chunks = await store.listJobChunks(jobId, job.chunkCount);
  if (chunks.length === 0) {
    return;
  }

  const failedChunk = chunks.find((chunk) => chunk.status === "failed");
  const allCompleted = chunks.length === job.chunkCount && chunks.every((chunk) => chunk.status === "completed");

  await store.updateJob(jobId, {
    status: failedChunk ? "failed" : allCompleted ? "completed" : "processing",
    queueMessageId: null,
    errorMessage: failedChunk?.errorMessage ?? null,
    recommendations: job.recommendations,
  });
}

async function extractAndPersistJobState(
  payload: CoordinatorWorkerJobPayload,
  store: JobStore,
): Promise<{ extractedText: string; candidates: WineCandidate[] }> {
  const extractedText = await extractSourceText({
    sourceType: payload.sourceType,
    filename: payload.sourceFilename,
    mimeType: payload.mimeType ?? "text/uri-list",
    storagePath: "",
    ...(payload.sourceUrl ? { sourceUrl: payload.sourceUrl } : {}),
    ...(payload.fileBase64
      ? { fileBuffer: Buffer.from(payload.fileBase64, "base64") }
      : {}),
  });
  await assertJobActive(payload.jobId, store);

  const candidates = parseWineCandidates(extractedText);
  await store.updateJob(payload.jobId, {
    extractedText,
    candidates,
    recommendations: [],
    chunkCount: 0,
  });

  return { extractedText, candidates };
}

async function processCoordinatorJob(
  payload: CoordinatorWorkerJobPayload,
  store: JobStore,
): Promise<void> {
  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
  });
  await assertJobActive(payload.jobId, store);

  let current = await store.getJob(payload.jobId);
  if (!current) {
    return;
  }

  if (current.chunkCount > 0) {
    await syncJobFromChunks(store, payload.jobId);
    return;
  }

  let extractedText = current.extractedText;
  let candidates = current.candidates;

  if (!hasParsedJobState(current)) {
    ({ extractedText, candidates } = await extractAndPersistJobState(payload, store));
    current = await store.getJob(payload.jobId);
    if (!current) {
      return;
    }
  }

  if (candidates.length === 0) {
    await store.updateJob(payload.jobId, {
      status: "completed",
      queueMessageId: null,
      errorMessage: null,
      extractedText,
      candidates,
      recommendations: [],
      chunkCount: 0,
    });
    return;
  }

  const candidateChunks = splitCandidatesIntoChunks(candidates, SERVERLESS_WORKER_CHUNK_COUNT);
  const chunkRecords = await store.createJobChunks(payload.jobId, candidateChunks);
  const publishedChunks: Array<{ chunkIndex: number; messageId: string }> = [];

  try {
    for (const chunkRecord of chunkRecords) {
      await assertJobActive(payload.jobId, store);
      const { messageId } = await publishWorkerJob({
        mode: "chunk",
        jobId: payload.jobId,
        chunkIndex: chunkRecord.index,
      });
      publishedChunks.push({ chunkIndex: chunkRecord.index, messageId });
      await store.updateJobChunk(payload.jobId, chunkRecord.index, {
        status: "queued",
        queueMessageId: messageId,
        errorMessage: null,
      });
    }
  } catch (error) {
    await Promise.all(publishedChunks.map((chunk) => deleteQueuedMessage(chunk.messageId)));
    throw error;
  }

  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
    extractedText,
    candidates,
    recommendations: [],
    chunkCount: chunkRecords.length,
  });
}

function getChunkCandidates(job: AnalysisRun, chunkCandidateIds: string[]): WineCandidate[] {
  const candidatesById = new Map(job.candidates.map((candidate) => [candidate.id, candidate]));
  return chunkCandidateIds
    .map((candidateId) => candidatesById.get(candidateId))
    .filter((candidate): candidate is WineCandidate => candidate !== undefined);
}

async function processChunkJob(payload: ChunkWorkerJobPayload, store: JobStore): Promise<void> {
  const job = await store.getJob(payload.jobId);
  if (!job || !hasParsedJobState(job)) {
    return;
  }

  const chunk = await store.getJobChunk(payload.jobId, payload.chunkIndex);
  if (!chunk || chunk.status === "completed" || chunk.status === "canceled") {
    await syncJobFromChunks(store, payload.jobId);
    return;
  }

  const chunkCandidates = getChunkCandidates(job, chunk.candidateIds);
  if (chunkCandidates.length === 0) {
    await store.updateJobChunk(payload.jobId, payload.chunkIndex, {
      status: "completed",
      queueMessageId: null,
      errorMessage: null,
      recommendations: [],
    });
    await syncJobFromChunks(store, payload.jobId);
    return;
  }

  await store.updateJobChunk(payload.jobId, payload.chunkIndex, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
  });

  let processedThisInvocation = 0;
  const invocationStartedAt = Date.now();

  const shouldStop = async (): Promise<boolean> => {
    try {
      await assertJobActive(payload.jobId, store);
      return false;
    } catch (error) {
      if (error instanceof JobInactiveError) {
        return true;
      }
      throw error;
    }
  };

  const { recommendations, didCompleteAll } = await runCandidateAnalysis(
    {
      candidates: chunkCandidates,
      existingRecommendations: chunk.recommendations,
    },
    {
      shouldCancel: shouldStop,
      shouldYield: () =>
        processedThisInvocation > 0 &&
        Date.now() - invocationStartedAt >= SERVERLESS_WORKER_TIME_BUDGET_MS,
      onCandidateProcessed: async ({ recommendations: latestRecommendations }) => {
        await assertJobActive(payload.jobId, store);
        processedThisInvocation += 1;
        await store.updateJobChunkRecommendations(payload.jobId, payload.chunkIndex, latestRecommendations);
      },
    },
    {
      candidateConcurrency: 1,
    },
  );

  await assertJobActive(payload.jobId, store);

  if (didCompleteAll) {
    await store.updateJobChunk(payload.jobId, payload.chunkIndex, {
      status: "completed",
      queueMessageId: null,
      errorMessage: null,
      recommendations,
    });
    await syncJobFromChunks(store, payload.jobId);
    return;
  }

  const { messageId } = await publishWorkerJob({
    mode: "chunk",
    jobId: payload.jobId,
    chunkIndex: payload.chunkIndex,
  });
  await store.updateJobChunk(payload.jobId, payload.chunkIndex, {
    status: "queued",
    queueMessageId: messageId,
    errorMessage: null,
    recommendations,
  });
  await syncJobFromChunks(store, payload.jobId);
}

export async function processWorkerJob(input: unknown): Promise<void> {
  const payload = parseWorkerJobPayload(input);
  const store = await loadJobStore();
  const existing = await store.getJob(payload.jobId);

  if (!existing) {
    return;
  }

  if (existing.status === "canceled" || existing.status === "completed" || existing.status === "failed") {
    return;
  }

  try {
    if (payload.mode === "chunk") {
      await processChunkJob(payload, store);
    } else {
      await processCoordinatorJob(payload, store);
    }
  } catch (error) {
    if (error instanceof JobInactiveError) {
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown worker error";
    if (payload.mode === "chunk") {
      await store.updateJobChunk(payload.jobId, payload.chunkIndex, {
        status: "failed",
        queueMessageId: null,
        errorMessage: message,
      });
      await syncJobFromChunks(store, payload.jobId);
    } else {
      const current = await store.getJob(payload.jobId);
      if (!current || current.status === "canceled") {
        return;
      }

      await store.updateJob(payload.jobId, {
        status: "failed",
        queueMessageId: null,
        errorMessage: message,
      });
    }
  } finally {
    await VivinoBrowser.getInstance().close();
  }
}
