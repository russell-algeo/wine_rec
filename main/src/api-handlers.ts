import { Client as QStashClient } from "@upstash/qstash";
import { put, del } from "@vercel/blob";
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
import { createWineProfileProviders } from "./providers/wine-profiles.js";
import {
  AnalysisCanceledError,
  AnalysisRetryableError,
  runCandidateAnalysis,
} from "./services/pipeline.js";
import { parseWineCandidates } from "./services/parser.js";
import { extractCandidatesFromUrl, extractSourceText } from "./services/source-extractor.js";
import { fetchUrlPreview } from "./services/url-preview.js";
import { createId } from "./id.js";

const coordinatorWorkerJobPayloadSchema = z.object({
  mode: z.literal("coordinator").default("coordinator"),
  jobId: z.string(),
  sourceType: sourceTypeSchema,
  sourceFilename: z.string(),
  mimeType: z.string().optional(),
  fileBlobUrl: z.string().url().optional(),
  fileBase64: z.string().optional(), // kept for backward compat with in-flight messages
  sourceUrl: z.string().url().optional(),
  recognizedText: z.string().optional(),
});

const jobWorkerJobPayloadSchema = z.object({
  mode: z.literal("worker"),
  jobId: z.string(),
  workerIndex: z.number().int().nonnegative(),
});

const workerJobPayloadSchema = z.union([
  jobWorkerJobPayloadSchema,
  coordinatorWorkerJobPayloadSchema,
]);

type CoordinatorWorkerJobPayload = z.infer<typeof coordinatorWorkerJobPayloadSchema>;
type JobWorkerJobPayload = z.infer<typeof jobWorkerJobPayloadSchema>;
export type WorkerJobPayload = z.infer<typeof workerJobPayloadSchema>;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

const SERVERLESS_WORKER_TIME_BUDGET_MS = parsePositiveIntegerEnv(
  "SERVERLESS_WORKER_TIME_BUDGET_MS",
  50_000,
);
const MAX_SERVERLESS_CONCURRENT_WORKERS = parsePositiveIntegerEnv(
  "SERVERLESS_WORKER_MAX_PARALLEL",
  10,
);
const SERVERLESS_WORKER_CANDIDATE_CONCURRENCY = 1;
const SERVERLESS_WORKER_INITIAL_JITTER_MAX_SECONDS = parsePositiveIntegerEnv(
  "SERVERLESS_WORKER_INITIAL_JITTER_MAX_SECONDS",
  3,
);
const SERVERLESS_WORKER_REQUEUE_DELAY_BASE_SECONDS = 2;
const SERVERLESS_WORKER_REQUEUE_DELAY_JITTER_SECONDS = 4;
const SERVERLESS_WORKER_RETRY_DELAY_EXPRESSION = "5 + min(20, retried * 5)";
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

function normalizeBaseUrl(input: string | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  const base = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
  return base.replace(/\/$/, "");
}

function requireBaseUrl(input: string | undefined, errorMessage: string): string {
  const baseUrl = normalizeBaseUrl(input);
  if (!baseUrl) {
    throw new Error(errorMessage);
  }

  return baseUrl;
}

function firstDefinedBaseUrl(...inputs: Array<string | undefined>): string | null {
  for (const input of inputs) {
    const baseUrl = normalizeBaseUrl(input);
    if (baseUrl) {
      return baseUrl;
    }
  }

  return null;
}

function buildRouteUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl}${endpoint}`;
}

function getCoordinatorBaseUrl(): string {
  return requireBaseUrl(
    firstDefinedBaseUrl(process.env.VERCEL_URL, process.env.WORKER_URL) ?? undefined,
    "VERCEL_URL or WORKER_URL is not configured",
  );
}

function getChunkWorkerBaseUrl(): string {
  return requireBaseUrl(
    firstDefinedBaseUrl(process.env.CHUNK_WORKER_BASE_URL, process.env.WORKER_URL, process.env.VERCEL_URL)
      ?? undefined,
    "CHUNK_WORKER_BASE_URL, WORKER_URL, or VERCEL_URL is not configured",
  );
}

function getFailureCallbackBaseUrl(mode: WorkerJobPayload["mode"]): string {
  return mode === "worker" ? getChunkWorkerBaseUrl() : getCoordinatorBaseUrl();
}

function getJobDestinationUrl(mode: WorkerJobPayload["mode"]): string {
  return mode === "worker"
    ? buildRouteUrl(getChunkWorkerBaseUrl(), "/api/chunk-worker")
    : buildRouteUrl(getCoordinatorBaseUrl(), "/api/coordinator");
}

function getAutomationBypassSecret(mode: WorkerJobPayload["mode"]): string | null {
  const primarySecret =
    mode === "worker"
      ? process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET
      : process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  return primarySecret?.trim() || process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;
}

async function publishWorkerJob(
  payload: WorkerJobPayload,
  options: {
    retries?: number;
    failureCallback?: string;
    retryDelay?: string;
    delaySeconds?: number;
    flowControl?: {
      key: string;
      parallelism: number;
    };
  } = {},
): Promise<{ messageId: string }> {
  const request = {
    url: getJobDestinationUrl(payload.mode),
    body: payload,
    retries: options.retries ?? 0,
    ...(options.retryDelay ? { retryDelay: options.retryDelay } : {}),
    ...(options.delaySeconds && options.delaySeconds > 0
      ? { delay: options.delaySeconds }
      : {}),
    ...(options.flowControl ? { flowControl: options.flowControl } : {}),
    ...(options.failureCallback ? { failureCallback: options.failureCallback } : {}),
  };
  const bypassSecret = getAutomationBypassSecret(payload.mode);
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
  const id = createId();
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType,
    sourceFilename: input.filename,
  });

  let fileBlobUrl: string | undefined;
  try {
    const blob = await put(`uploads/${id}`, input.buffer, {
      access: "public",
      contentType: mimeType,
    });
    fileBlobUrl = blob.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to store upload";
    await updateJob(id, { status: "failed", queueMessageId: null, errorMessage: message });
    throw error;
  }

  try {
    const { messageId } = await publishWorkerJob(
      {
        mode: "coordinator",
        jobId: id,
        sourceType,
        sourceFilename: input.filename,
        mimeType,
        fileBlobUrl,
      },
      getCoordinatorPublishOptions(),
    );
    await updateJob(id, { queueMessageId: messageId });
  } catch (error) {
    await del(fileBlobUrl).catch(() => undefined);
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

  const id = createId();
  const sourceType = inferUrlSourceType(url.toString());
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType,
    sourceFilename: url.toString(),
  });

  try {
    const { messageId } = await publishWorkerJob(
      {
        mode: "coordinator",
        jobId: id,
        sourceType,
        sourceFilename: url.toString(),
        sourceUrl: url.toString(),
      },
      getCoordinatorPublishOptions(),
    );
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

export async function createClientOcrAnalysis(input: {
  sourceFilename: string;
  recognizedText: string;
}): Promise<CreateAnalysisResponse> {
  const recognizedText = input.recognizedText.trim();
  if (!recognizedText) {
    throw new RequestError("Recognized text is required", 400);
  }

  const id = createId();
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType: "client-ocr-text",
    sourceFilename: input.sourceFilename.trim() || "iOS Vision OCR",
  });

  try {
    const { messageId } = await publishWorkerJob(
      {
        mode: "coordinator",
        jobId: id,
        sourceType: "client-ocr-text",
        sourceFilename: job.sourceFilename,
        recognizedText,
      },
      getCoordinatorPublishOptions(),
    );
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
  const store = await loadJobStore();
  const job = await store.getJob(id);
  return job ? analysisRunSchema.parse(job) : null;
}

export async function cancelAnalysis(id: string): Promise<AnalysisRun | null> {
  const {
    clearJobCandidateQueue,
    getJob,
    getJobState,
    listJobCandidateWork,
    listJobWorkers,
    updateJob,
    updateJobCandidateWork,
    updateJobWorker,
  } = await loadJobStore();
  const existing = await getJobState(id);

  if (!existing) {
    return null;
  }

  if (existing.status === "completed" || existing.status === "failed" || existing.status === "canceled") {
    return analysisRunSchema.parse(existing);
  }

  const workers = existing.workerCount > 0 ? await listJobWorkers(id, existing.workerCount) : [];
  const candidateWork = existing.candidates.length > 0 ? await listJobCandidateWork(id, existing.candidates) : [];

  await deleteQueuedMessage(existing.queueMessageId);
  await Promise.all(workers.map((worker) => deleteQueuedMessage(worker.queueMessageId)));
  await clearJobCandidateQueue(id);
  await Promise.all(
    workers.map((worker) =>
      updateJobWorker(id, worker.index, {
        status: "canceled",
        queueMessageId: null,
        errorMessage: STOPPED_ANALYSIS_MESSAGE,
      })),
  );
  await Promise.all(
    candidateWork
      .filter((record) => record.status !== "completed" && record.status !== "failed")
      .map((record) =>
        updateJobCandidateWork(id, record.candidateId, {
          status: "canceled",
          leaseOwner: null,
          leaseExpiresAt: null,
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
  const current = await jobStore.getJobState(jobId);

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

function getWorkerLeaseOwner(workerIndex: number): string {
  return `worker-${workerIndex}`;
}

function getInitialWorkerCount(candidateCount: number): number {
  return Math.min(Math.max(0, candidateCount), MAX_SERVERLESS_CONCURRENT_WORKERS);
}

function getWorkerFlowControl(jobId: string): {
  key: string;
  parallelism: number;
} {
  const sanitizedJobId = jobId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    key: `analysis.${sanitizedJobId}.worker`,
    parallelism: MAX_SERVERLESS_CONCURRENT_WORKERS,
  };
}

function getRandomizedDelaySeconds(baseSeconds: number, jitterRangeSeconds: number): number {
  const resolvedBase = Math.max(0, Math.floor(baseSeconds));
  const resolvedRange = Math.max(0, Math.floor(jitterRangeSeconds));
  if (resolvedRange === 0) {
    return resolvedBase;
  }

  return resolvedBase + Math.floor(Math.random() * (resolvedRange + 1));
}

function getInitialWorkerLaunchDelaySeconds(): number {
  return getRandomizedDelaySeconds(0, SERVERLESS_WORKER_INITIAL_JITTER_MAX_SECONDS);
}

function getWorkerRequeueDelaySeconds(): number {
  return getRandomizedDelaySeconds(
    SERVERLESS_WORKER_REQUEUE_DELAY_BASE_SECONDS,
    SERVERLESS_WORKER_REQUEUE_DELAY_JITTER_SECONDS,
  );
}

function getWorkerPublishOptions(
  jobId: string,
  delaySeconds = 0,
): {
  retries: number;
  failureCallback: string;
  retryDelay: string;
  delaySeconds?: number;
  flowControl: {
    key: string;
    parallelism: number;
  };
} {
  return {
    retries: 3,
    failureCallback: buildRouteUrl(getFailureCallbackBaseUrl("worker"), "/api/worker-failure"),
    retryDelay: SERVERLESS_WORKER_RETRY_DELAY_EXPRESSION,
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
    flowControl: getWorkerFlowControl(jobId),
  };
}

function getCoordinatorPublishOptions(): {
  retries: number;
  failureCallback: string;
} {
  return {
    retries: 1,
    failureCallback: buildRouteUrl(getFailureCallbackBaseUrl("coordinator"), "/api/worker-failure"),
  };
}

async function queueWorkerForQStashRetry(
  payload: JobWorkerJobPayload,
  store: JobStore,
): Promise<void> {
  await assertJobActive(payload.jobId, store);
  const currentWorker = await store.getJobWorker(payload.jobId, payload.workerIndex);
  if (!currentWorker || currentWorker.status === "completed" || currentWorker.status === "canceled") {
    return;
  }

  await store.updateJobWorker(payload.jobId, payload.workerIndex, {
    status: "queued",
    queueMessageId: currentWorker.queueMessageId,
    errorMessage: null,
  });
  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
  });
}

async function requeueWorkerJob(
  payload: JobWorkerJobPayload,
  store: JobStore,
  delaySeconds = getWorkerRequeueDelaySeconds(),
): Promise<void> {
  await assertJobActive(payload.jobId, store);
  const currentWorker = await store.getJobWorker(payload.jobId, payload.workerIndex);
  if (!currentWorker || currentWorker.status === "completed" || currentWorker.status === "canceled") {
    return;
  }

  const { messageId } = await publishWorkerJob(
    {
      mode: "worker",
      jobId: payload.jobId,
      workerIndex: payload.workerIndex,
    },
    getWorkerPublishOptions(payload.jobId, delaySeconds),
  );

  await store.updateJobWorker(payload.jobId, payload.workerIndex, {
    status: "queued",
    queueMessageId: messageId,
    errorMessage: null,
  });
  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
  });
}

async function syncJobFromCandidateWork(store: JobStore, jobId: string): Promise<void> {
  const job = await store.getJobState(jobId);
  if (!job || job.status === "canceled" || job.candidates.length === 0) {
    return;
  }

  const candidateWork = await store.listJobCandidateWork(jobId, job.candidates);
  if (candidateWork.length === 0) {
    return;
  }

  const failedCandidate = candidateWork.find((record) => record.status === "failed");
  const allCompleted =
    candidateWork.length === job.candidates.length &&
    candidateWork.every((record) => record.status === "completed");

  await store.updateJob(jobId, {
    status: failedCandidate ? "failed" : allCompleted ? "completed" : "processing",
    queueMessageId: failedCandidate || allCompleted ? null : job.queueMessageId,
    errorMessage: failedCandidate?.errorMessage ?? null,
  });
}

async function extractAndPersistJobState(
  payload: CoordinatorWorkerJobPayload,
  store: JobStore,
): Promise<{ extractedText: string; candidates: WineCandidate[] }> {
  let extractedText = "";
  let candidates: WineCandidate[];

  if (payload.recognizedText !== undefined) {
    extractedText = payload.recognizedText;
    candidates = parseWineCandidates(extractedText);
  } else if (payload.sourceUrl) {
    candidates = await extractCandidatesFromUrl(payload.sourceUrl);
  } else {
    let fileBuffer: Buffer | undefined;

    if (payload.fileBlobUrl) {
      const response = await fetch(payload.fileBlobUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch upload from blob storage: ${response.status}`);
      }
      fileBuffer = Buffer.from(await response.arrayBuffer());
    } else if (payload.fileBase64) {
      fileBuffer = Buffer.from(payload.fileBase64, "base64");
    }

    extractedText = await extractSourceText({
      sourceType: payload.sourceType,
      filename: payload.sourceFilename,
      mimeType: payload.mimeType ?? "text/uri-list",
      storagePath: "",
      ...(fileBuffer ? { fileBuffer } : {}),
    });
    candidates = parseWineCandidates(extractedText);
  }

  await assertJobActive(payload.jobId, store);

  await store.updateJob(payload.jobId, {
    extractedText,
    candidates,
    recommendations: [],
    workerCount: 0,
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

  let current = await store.getJobState(payload.jobId);
  if (!current) {
    return;
  }

  if (current.workerCount > 0) {
    await syncJobFromCandidateWork(store, payload.jobId);
    return;
  }

  let extractedText = current.extractedText;
  let candidates = current.candidates;

  if (!hasParsedJobState(current)) {
    ({ extractedText, candidates } = await extractAndPersistJobState(payload, store));
    current = await store.getJobState(payload.jobId);
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
      workerCount: 0,
    });
    return;
  }

  await store.createJobCandidateWork(payload.jobId, candidates);
  const workerCount = getInitialWorkerCount(candidates.length);
  const workerRecords = await store.createJobWorkers(payload.jobId, workerCount);
  const publishedWorkers: Array<{ workerIndex: number; messageId: string }> = [];

  try {
    for (const workerRecord of workerRecords) {
      await assertJobActive(payload.jobId, store);
      const { messageId } = await publishWorkerJob(
        {
          mode: "worker",
          jobId: payload.jobId,
          workerIndex: workerRecord.index,
        },
        getWorkerPublishOptions(payload.jobId, getInitialWorkerLaunchDelaySeconds()),
      );
      publishedWorkers.push({ workerIndex: workerRecord.index, messageId });
      await store.updateJobWorker(payload.jobId, workerRecord.index, {
        status: "queued",
        queueMessageId: messageId,
        errorMessage: null,
      });
    }
  } catch (error) {
    await Promise.all(publishedWorkers.map((worker) => deleteQueuedMessage(worker.messageId)));
    throw error;
  }

  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
    extractedText,
    candidates,
    recommendations: [],
    workerCount,
  });
}

function getJobCandidate(job: AnalysisRun, candidateId: string): WineCandidate | null {
  return job.candidates.find((candidate) => candidate.id === candidateId) ?? null;
}

async function processJobWorker(payload: JobWorkerJobPayload, store: JobStore): Promise<void> {
  const job = await store.getJobState(payload.jobId);
  if (!job || !hasParsedJobState(job)) {
    return;
  }

  const worker = await store.getJobWorker(payload.jobId, payload.workerIndex);
  if (!worker || worker.status === "completed" || worker.status === "canceled") {
    await syncJobFromCandidateWork(store, payload.jobId);
    return;
  }

  await store.updateJobWorker(payload.jobId, payload.workerIndex, {
    status: "processing",
    errorMessage: null,
  });
  await store.updateJob(payload.jobId, {
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
  });

  const invocationStartedAt = Date.now();
  const leaseOwner = getWorkerLeaseOwner(payload.workerIndex);
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

  while (Date.now() - invocationStartedAt < SERVERLESS_WORKER_TIME_BUDGET_MS) {
    await assertJobActive(payload.jobId, store);

    const claimedCandidate = await store.claimNextJobCandidate(payload.jobId, leaseOwner);
    if (!claimedCandidate) {
      break;
    }

    const candidate = getJobCandidate(job, claimedCandidate.candidateId);
    if (!candidate) {
      const failed = await store.failJobCandidate(
        payload.jobId,
        claimedCandidate.candidateId,
        leaseOwner,
        `Candidate ${claimedCandidate.candidateId} is missing from analysis state.`,
      );
      if (!failed.progressTracked) {
        await syncJobFromCandidateWork(store, payload.jobId);
      }
      if (failed.updated && failed.jobStatus === "failed") {
        await store.updateJobWorker(payload.jobId, payload.workerIndex, {
          status: "failed",
          queueMessageId: null,
          errorMessage: `Candidate ${claimedCandidate.candidateId} is missing from analysis state.`,
        });
        return;
      }
      continue;
    }

    const { recommendations } = await runCandidateAnalysis(
      {
        candidates: [candidate],
      },
      {
        shouldCancel: shouldStop,
      },
      {
        candidateConcurrency: SERVERLESS_WORKER_CANDIDATE_CONCURRENCY,
      },
    );

    await assertJobActive(payload.jobId, store);
    const recommendation = recommendations[0];
    if (!recommendation) {
      throw new Error(`Candidate ${candidate.id} finished without a recommendation.`);
    }

    const completed = await store.completeJobCandidate(
      payload.jobId,
      candidate.id,
      leaseOwner,
      recommendation,
    );
    if (!completed.updated) {
      await syncJobFromCandidateWork(store, payload.jobId);
      return;
    }
    if (!completed.progressTracked) {
      await syncJobFromCandidateWork(store, payload.jobId);
    }
    if (completed.jobStatus === "failed" || completed.jobStatus === "canceled") {
      return;
    }
    if (completed.jobStatus === "completed") {
      await store.updateJobWorker(payload.jobId, payload.workerIndex, {
        status: "completed",
        queueMessageId: null,
        errorMessage: null,
      });
      return;
    }
  }

  const currentJob = await store.getJobState(payload.jobId);
  if (!currentJob || currentJob.status === "canceled" || currentJob.status === "failed") {
    return;
  }
  if (currentJob.status === "completed") {
    await store.updateJobWorker(payload.jobId, payload.workerIndex, {
      status: "completed",
      queueMessageId: null,
      errorMessage: null,
    });
    return;
  }

  if (await store.hasQueuedJobCandidates(payload.jobId)) {
    await requeueWorkerJob(payload, store);
    return;
  }

  await store.updateJobWorker(payload.jobId, payload.workerIndex, {
    status: "completed",
    queueMessageId: null,
    errorMessage: null,
  });
  await syncJobFromCandidateWork(store, payload.jobId);
}

export async function processWorkerJob(input: unknown): Promise<void> {
  const payload = parseWorkerJobPayload(input);
  const store = await loadJobStore();
  const existing = await store.getJobState(payload.jobId);

  if (!existing) {
    return;
  }

  if (existing.status === "canceled" || existing.status === "completed" || existing.status === "failed") {
    return;
  }

  try {
    if (payload.mode === "worker") {
      await processJobWorker(payload, store);
    } else {
      await processCoordinatorJob(payload, store);
    }
  } catch (error) {
    if (error instanceof JobInactiveError) {
      return;
    }

    if (payload.mode === "worker") {
      if (error instanceof AnalysisCanceledError) {
        return;
      }
      if (error instanceof AnalysisRetryableError) {
        await store.updateJobCandidateWork(payload.jobId, error.candidateId, {
          errorMessage: error.message,
        });
        await queueWorkerForQStashRetry(payload, store);
        throw error;
      }
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown worker error";
    const current = await store.getJobState(payload.jobId);
    if (!current || current.status === "canceled") {
      return;
    }

    await store.updateJob(payload.jobId, {
      status: "failed",
      queueMessageId: null,
      errorMessage: message,
    });
  }
}

export async function processWorkerFailure(sourceBody: string): Promise<void> {
  let payload: WorkerJobPayload;
  try {
    const decoded = JSON.parse(Buffer.from(sourceBody, "base64").toString("utf8"));
    payload = workerJobPayloadSchema.parse(decoded);
  } catch {
    return;
  }

  const store = await loadJobStore();
  const job = await store.getJobState(payload.jobId);
  if (!job || job.status === "canceled" || job.status === "completed") {
    return;
  }

  if (payload.mode === "coordinator") {
    await store.updateJob(payload.jobId, {
      status: "failed",
      queueMessageId: null,
      errorMessage: "Analysis failed to start after multiple attempts. Please try again.",
    });
    return;
  }

  const worker = await store.getJobWorker(payload.jobId, payload.workerIndex);
  if (!worker || worker.status === "completed" || worker.status === "canceled") {
    return;
  }

  const leaseOwner = getWorkerLeaseOwner(payload.workerIndex);
  const claimedCandidate = await store.findJobCandidateWorkByLeaseOwner(
    payload.jobId,
    leaseOwner,
    job.candidates,
  );

  let failureStatus: AnalysisRun["status"] | null = null;
  if (claimedCandidate) {
    const failed = await store.failJobCandidate(
      payload.jobId,
      claimedCandidate.candidateId,
      leaseOwner,
      claimedCandidate.errorMessage ?? "Analysis failed after exhausting all retry attempts.",
    );
    failureStatus = failed.jobStatus;
    if (!failed.progressTracked) {
      await syncJobFromCandidateWork(store, payload.jobId);
    }
  }
  if (!claimedCandidate) {
    await syncJobFromCandidateWork(store, payload.jobId);
  }

  if (failureStatus === "failed") {
    await store.updateJobWorker(payload.jobId, payload.workerIndex, {
      status: "failed",
      queueMessageId: null,
      errorMessage: claimedCandidate?.errorMessage ?? "Analysis failed after exhausting all retry attempts.",
    });
    return;
  }

  const updatedJob = await store.getJobState(payload.jobId);
  if (!updatedJob || updatedJob.status === "canceled") {
    return;
  }

  if (updatedJob.status === "failed") {
    await store.updateJobWorker(payload.jobId, payload.workerIndex, {
      status: "failed",
      queueMessageId: null,
      errorMessage: claimedCandidate?.errorMessage ?? "Analysis failed after exhausting all retry attempts.",
    });
    return;
  }

  if (await store.hasQueuedJobCandidates(payload.jobId)) {
    await requeueWorkerJob(payload, store, 0);
    return;
  }

  await store.updateJobWorker(payload.jobId, payload.workerIndex, {
    status: "completed",
    queueMessageId: null,
    errorMessage: null,
  });
}
