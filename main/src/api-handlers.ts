import { createHash } from "node:crypto";
import { scope, scopedAnalysisId, scopedFlowControlKey, previewDeploymentOrigin } from "./deployment-scope.js";
import { PreviewBudgetError, previewBudgetConfig, reservePreviewPublication } from "./preview-publish-budget.js";
import { ProviderAccessBlockedError } from "./providers/provider-access.js";
import { Client as QStashClient } from "@upstash/qstash";
import { del } from "@vercel/blob";
import { isPrivateUploadReference, readPrivateUpload, storeUpload, type StoredUpload } from "./services/upload-storage.js";
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
import { extractCandidatesFromUrl, extractSourceTextWithAlternates } from "./services/source-extractor.js";
import { annotatePriceConflicts } from "./services/price-conflicts.js";
import { fetchUrlPreview } from "./services/url-preview.js";
import { createId } from "./id.js";

const coordinatorWorkerJobPayloadSchema = z.object({
  mode: z.literal("coordinator").default("coordinator"),
  deploymentNamespace: z.string().optional(),
  jobId: z.string(),
  sourceType: sourceTypeSchema,
  sourceFilename: z.string(),
  mimeType: z.string().optional(),
  fileBlobUrl: z.string().url().optional(),
  privateBlobPathname: z.string().optional(),
  fileBase64: z.string().optional(), // kept for backward compat with in-flight messages
  sourceUrl: z.string().url().optional(),
  recognizedText: z.string().optional(),
}).superRefine((payload, ctx) => {
  if (payload.privateBlobPathname === undefined) return;
  const upload = payload.sourceType === "upload-image" || payload.sourceType === "upload-pdf";
  const mixed = payload.fileBlobUrl !== undefined || payload.fileBase64 !== undefined ||
    payload.sourceUrl !== undefined || payload.recognizedText !== undefined;
  if (!upload || mixed || !isPrivateUploadReference(payload.jobId, payload.privateBlobPathname)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid private upload reference", path: ["privateBlobPathname"] });
  }
});

const jobWorkerJobPayloadSchema = z.object({
  mode: z.literal("worker"),
  deploymentNamespace: z.string().optional(),
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

  return new QStashClient({ token, ...(baseUrl ? { baseUrl } : {}),
    // retry:false still sends twice in QStash SDK 2.10.1. Explicit zero is
    // necessary; an ambiguous publish must never be retried by this client.
    ...(scope.namespace ? { retry: { retries: 0 } } : {}),
  });
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
  if (scope.namespace) return previewDeploymentOrigin(process.env.VERCEL_URL);
  return requireBaseUrl(
    firstDefinedBaseUrl(process.env.VERCEL_URL, process.env.WORKER_URL) ?? undefined,
    "VERCEL_URL or WORKER_URL is not configured",
  );
}

function getChunkWorkerBaseUrl(): string {
  if (scope.namespace) return previewDeploymentOrigin(scope.role === "worker" ? process.env.VERCEL_URL : process.env.CHUNK_WORKER_BASE_URL);
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
  const destination = getJobDestinationUrl(payload.mode);
  await reservePreviewPublication(payload);
  const request = {
    url: destination,
    body: { ...payload, ...(scope.namespace ? { deploymentNamespace: scope.namespace } : {}) },
    retries: scope.namespace ? 0 : options.retries ?? 0,
    ...(scope.namespace ? { deduplicationId: createHash("sha256")
      .update(JSON.stringify([scope.namespace, payload.mode, payload.jobId])).digest("hex") } : {}),
    ...(!scope.namespace && options.retryDelay ? { retryDelay: options.retryDelay } : {}),
    ...(options.delaySeconds && options.delaySeconds > 0
      ? { delay: options.delaySeconds }
      : {}),
    ...(options.flowControl ? { flowControl: options.flowControl } : {}),
    ...(!scope.namespace && options.failureCallback ? { failureCallback: options.failureCallback } : {}),
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

/**
 * Best-effort exact-message deletion for a publication that settled after the
 * job became terminal. Returns true when the job is terminal (or missing).
 */
async function deleteIfJobTerminal(jobId: string, messageId: string, store: JobStore): Promise<boolean> {
  const current = await store.getJobState(jobId).catch(() => undefined);
  if (current === undefined) return false;
  if (current && !isTerminalStatus(current.status)) return false;
  await deleteQueuedMessage(messageId);
  return true;
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
  previewBudgetConfig(); // Fail before job or Blob creation if the gate is absent.
  const ocrProvider = createOcrProvider();

  if (!ocrProvider.isEnabled) {
    throw new RequestError(buildDisabledOcrUploadMessage(ocrProvider.detail), 503);
  }

  const sourceType = uploadSourceSchema.parse({
    sourceType: inferSourceType(input.mimeType),
  }).sourceType;
  const mimeType = inferMimeType(input.filename, input.mimeType);
  const id = scopedAnalysisId(createId());
  const { createJob, updateJob } = await loadJobStore();
  const job = await createJob({
    id,
    sourceType,
    sourceFilename: input.filename,
  });

  let storedUpload: StoredUpload;
  try {
    storedUpload = await storeUpload(id, input.buffer, mimeType);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to store upload";
    await updateJob(id, { status: "failed", queueMessageId: null, errorMessage: message });
    throw error;
  }

  let messageId: string;
  try {
    ({ messageId } = await publishWorkerJob(
      {
        mode: "coordinator",
        jobId: id,
        sourceType,
        sourceFilename: input.filename,
        mimeType,
        ...storedUpload,
      },
      getCoordinatorPublishOptions(),
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to enqueue analysis";
    // A publish error can be ambiguous. Only remove the new source after the
    // durable job state is terminal, so an accepted or retried delivery stops.
    // If this write fails, retain the source rather than strand an in-flight job.
    await updateJob(id, {
      status: "failed",
      queueMessageId: null,
      errorMessage: message,
    });
    await del(storedUpload.privateBlobPathname ?? storedUpload.fileBlobUrl).catch(() => undefined);
    throw error;
  }

  try {
    await updateJob(id, { queueMessageId: messageId });
  } catch {
    // QStash already accepted the job. Tracking failure must not delete its
    // input, mark it failed, or tell the caller to submit a duplicate upload.
    console.warn("[uploads] Queue accepted; message tracking write failed", id);
  }

  return toCreateAnalysisResponse(analysisRunSchema.parse(job));
}

export async function createUrlAnalysis(input: { url: string }): Promise<CreateAnalysisResponse> {
  previewBudgetConfig();
  let url: URL;

  try {
    url = assertHttpUrl(input.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL";
    throw new RequestError(message, 400);
  }

  const id = scopedAnalysisId(createId());
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
  previewBudgetConfig();
  const recognizedText = input.recognizedText.trim();
  if (!recognizedText) {
    throw new RequestError("Recognized text is required", 400);
  }

  const id = scopedAnalysisId(createId());
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

const CANCEL_TERMINAL_WRITE_ATTEMPTS = 3;
const CANCEL_CLEANUP_BUDGET_MS = 2_000;

export class CancellationUnconfirmedError extends Error {
  constructor(readonly analysisId: string, readonly cause?: unknown) {
    super("Stop could not be confirmed. The analysis may still be running.");
    this.name = "CancellationUnconfirmedError";
  }
}

function isTerminalStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

async function withinBudget(work: Promise<unknown>, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Terminal-first cancellation. The authoritative `canceled` job state is
 * persisted and re-read before any cleanup, so every worker/candidate Lua
 * transition (which refuses terminal jobs) stops accepting work from that
 * point on. Cleanup is best effort and bounded; a competing terminal result
 * (completed/failed) that wins the race is preserved and returned.
 */
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

  if (isTerminalStatus(existing.status)) {
    return analysisRunSchema.parse(await getJob(id) ?? existing);
  }

  let terminal: typeof existing | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < CANCEL_TERMINAL_WRITE_ATTEMPTS && !terminal; attempt += 1) {
    try {
      await updateJob(id, {
        status: "canceled",
        queueMessageId: null,
        errorMessage: STOPPED_ANALYSIS_MESSAGE,
      });
    } catch (error) {
      // The write may still have applied (ambiguous response); reconcile by reading back.
      lastError = error;
    }
    try {
      const current = await getJobState(id);
      if (!current) return null;
      if (isTerminalStatus(current.status)) terminal = current;
    } catch (error) {
      lastError = error;
    }
  }

  if (!terminal) {
    throw new CancellationUnconfirmedError(id, lastError);
  }

  if (terminal.status === "canceled") {
    const deadline = Date.now() + CANCEL_CLEANUP_BUDGET_MS;
    const cleanup = (async () => {
      const workers = existing.workerCount > 0 ? await listJobWorkers(id, existing.workerCount) : [];
      const candidateWork = existing.candidates.length > 0 ? await listJobCandidateWork(id, existing.candidates) : [];
      await Promise.allSettled([
        deleteQueuedMessage(existing.queueMessageId),
        ...workers.map((worker) => deleteQueuedMessage(worker.queueMessageId)),
        clearJobCandidateQueue(id),
        ...workers
          .filter((worker) => worker.status !== "completed" && worker.status !== "canceled")
          .map((worker) =>
            updateJobWorker(id, worker.index, {
              status: "canceled",
              queueMessageId: null,
              errorMessage: STOPPED_ANALYSIS_MESSAGE,
            })),
        ...candidateWork
          .filter((record) => record.status !== "completed" && record.status !== "failed" && record.status !== "canceled")
          .map((record) =>
            updateJobCandidateWork(id, record.candidateId, {
              status: "canceled",
              leaseOwner: null,
              leaseExpiresAt: null,
              errorMessage: STOPPED_ANALYSIS_MESSAGE,
            })),
      ]);
    })();
    await withinBudget(cleanup, deadline);
  }

  try {
    const hydrated = await getJob(id);
    return analysisRunSchema.parse(hydrated ?? terminal);
  } catch {
    return analysisRunSchema.parse(terminal);
  }
}

export function parseWorkerJobPayload(input: unknown): WorkerJobPayload {
  const payload = workerJobPayloadSchema.parse(input);
  if ((payload.deploymentNamespace ?? "") !== scope.namespace) {
    throw new z.ZodError([{ code: "custom", path: ["deploymentNamespace"], message: "Worker namespace does not match deployment" }]);
  }
  return payload;
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
  return Math.min(Math.max(0, candidateCount), scope.namespace ? 1 : MAX_SERVERLESS_CONCURRENT_WORKERS);
}

function getWorkerFlowControl(jobId: string): {
  key: string;
  parallelism: number;
} {
  const sanitizedJobId = jobId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    key: scopedFlowControlKey(`analysis.${sanitizedJobId}.worker`),
    parallelism: scope.namespace ? 1 : MAX_SERVERLESS_CONCURRENT_WORKERS,
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
  if (scope.namespace) throw new PreviewBudgetError("Preview smoke test stopped at the worker time limit; no handoff published");
  await assertJobActive(payload.jobId, store);
  const currentWorker = await store.getJobWorker(payload.jobId, payload.workerIndex);
  if (!currentWorker || currentWorker.status === "completed" || currentWorker.status === "canceled") {
    return;
  }
  // A cancellation may have landed while the worker record was being read.
  await assertJobActive(payload.jobId, store);

  const { messageId } = await publishWorkerJob(
    {
      mode: "worker",
      jobId: payload.jobId,
      workerIndex: payload.workerIndex,
    },
    getWorkerPublishOptions(payload.jobId, delaySeconds),
  );
  if (await deleteIfJobTerminal(payload.jobId, messageId, store)) {
    return;
  }

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

    if (payload.privateBlobPathname !== undefined) {
      fileBuffer = await readPrivateUpload(payload.jobId, payload.privateBlobPathname);
    } else if (payload.fileBlobUrl) {
      const response = await fetch(payload.fileBlobUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch upload from blob storage: ${response.status}`);
      }
      fileBuffer = Buffer.from(await response.arrayBuffer());
    } else if (payload.fileBase64) {
      fileBuffer = Buffer.from(payload.fileBase64, "base64");
    }

    const extracted = await extractSourceTextWithAlternates({
      sourceType: payload.sourceType,
      filename: payload.sourceFilename,
      mimeType: payload.mimeType ?? "text/uri-list",
      storagePath: "",
      ...(fileBuffer ? { fileBuffer } : {}),
    });
    extractedText = extracted.text;
    candidates = annotatePriceConflicts(parseWineCandidates(extractedText), extracted.alternates);
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
    // A cancellation that settled while the last publication was in flight
    // must not leave that delivery queued.
    await assertJobActive(payload.jobId, store);
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

async function stopJobForProviderBlock(jobId: string, store: JobStore, error: ProviderAccessBlockedError): Promise<void> {
  // Persist terminal state before asynchronous cleanup. Atomic store guards
  // prevent late workers, completions, or redeliveries from reviving this job.
  let persisted = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await store.updateJob(jobId, { status: "failed", queueMessageId: null, errorMessage: error.message });
      persisted = true;
      break;
    } catch {
      // Retry only this idempotent Redis write, never provider work. An uncertain
      // first write is safe: subsequent writes preserve any terminal job state.
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  if (!persisted) {
    // ACK this delivery rather than cause QStash to recreate provider work. This
    // is NOT a durable/global stop: other invocations may still reclaim leases.
    // Operator recovery is required; do not automatically restart provider work.
    console.error("[provider-access] Job stop unconfirmed after 3 persistence attempts; operator recovery required", jobId);
    return;
  }
  try {
    const job = await store.getJobState(jobId);
    if (!job || job.status !== "failed") return; // Preserve a prior cancel/complete.
    await store.clearJobCandidateQueue(jobId);
    const workers = await store.listJobWorkers(jobId, job.workerCount);
    const candidates = await store.listJobCandidateWork(jobId, job.candidates);
    await Promise.all(workers.filter(worker => !["completed", "canceled"].includes(worker.status)).map(worker =>
      store.updateJobWorker(jobId, worker.index, { status: "failed", queueMessageId: null, errorMessage: error.message })));
    await Promise.all(candidates.filter(candidate => !["completed", "canceled"].includes(candidate.status)).map(candidate =>
      store.updateJobCandidateWork(jobId, candidate.candidateId, {
        status: "failed", leaseOwner: null, leaseExpiresAt: null, errorMessage: error.message,
      })));
    await Promise.all(workers.map(worker => deleteQueuedMessage(worker.queueMessageId)));
  } catch {
    // The terminal state is already durable. Cleanup failure must not turn the
    // acknowledged provider block into another queue retry/provider attempt.
    console.warn("[provider-access] Terminal job cleanup incomplete", jobId);
  }
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
    if (error instanceof ProviderAccessBlockedError) {
      await stopJobForProviderBlock(payload.jobId, store, error);
      return; // ACK this delivery. Access denial must not become a QStash retry.
    }

    if (scope.namespace) {
      // Zero delivery retries/callbacks means errors must become visible terminal
      // states here. A crash or failed Redis write still needs operator recovery;
      // never manufacture another publication to hide a bounded-test failure.
      await store.updateJob(payload.jobId, {
        status: "failed", queueMessageId: null,
        errorMessage: error instanceof Error ? error.message : "Preview smoke test failed",
      });
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
    payload = parseWorkerJobPayload(decoded);
  } catch {
    return;
  }

  const store = await loadJobStore();
  const job = await store.getJobState(payload.jobId);
  if (!job || job.status === "canceled" || job.status === "completed" || job.status === "failed") {
    return;
  }
  if (scope.namespace) {
    await store.updateJob(payload.jobId, { status: "failed", queueMessageId: null,
      errorMessage: "Preview smoke test stopped after a delivery failure; no retry published" });
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
