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
} from "@wine-rec/contracts";

import { createOcrProvider } from "./providers/ocr.js";
import { VivinoBrowser } from "./providers/vivino-browser.js";
import { createWineProfileProviders } from "./providers/wine-profiles.js";
import { runAnalysisPipeline } from "./services/pipeline.js";
import { fetchUrlPreview } from "./services/url-preview.js";

const workerJobPayloadSchema = z.object({
  jobId: z.string(),
  sourceType: sourceTypeSchema,
  sourceFilename: z.string(),
  mimeType: z.string().optional(),
  fileBase64: z.string().optional(),
  sourceUrl: z.string().url().optional(),
});

export type WorkerJobPayload = z.infer<typeof workerJobPayloadSchema>;

export class RequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "RequestError";
  }
}

class JobCanceledError extends Error {
  constructor(readonly jobId: string) {
    super(`Analysis ${jobId} was canceled`);
    this.name = "JobCanceledError";
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
  return getQStashClient().publishJSON({
    url: getWorkerUrl(),
    body: payload,
    retries: 0,
  });
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
  const { getJob, updateJob } = await loadJobStore();
  const existing = await getJob(id);

  if (!existing) {
    return null;
  }

  if (existing.status === "completed" || existing.status === "failed" || existing.status === "canceled") {
    return analysisRunSchema.parse(existing);
  }

  if (existing.queueMessageId) {
    await getQStashClient().messages.delete(existing.queueMessageId).catch(() => undefined);
  }

  await updateJob(id, {
    status: "canceled",
    queueMessageId: null,
    errorMessage: "Analysis stopped. Start a new scan when you're ready.",
  });

  const canceled = await getJob(id);
  return canceled ? analysisRunSchema.parse(canceled) : null;
}

export function parseWorkerJobPayload(input: unknown): WorkerJobPayload {
  return workerJobPayloadSchema.parse(input);
}

async function assertJobActive(jobId: string): Promise<void> {
  const { getJob } = await loadJobStore();
  const current = await getJob(jobId);

  if (!current || current.status === "canceled") {
    throw new JobCanceledError(jobId);
  }
}

export async function processWorkerJob(input: unknown): Promise<void> {
  const payload = parseWorkerJobPayload(input);
  const {
    getJob,
    updateJob,
    updateJobRecommendations,
  } = await loadJobStore();
  const existing = await getJob(payload.jobId);

  if (!existing) {
    return;
  }

  if (existing.status === "canceled") {
    return;
  }

  try {
    await updateJob(payload.jobId, {
      status: "processing",
      queueMessageId: null,
      errorMessage: null,
      extractedText: null,
      candidates: [],
      recommendations: [],
    });

    await assertJobActive(payload.jobId);

    const result = await runAnalysisPipeline(
      {
        sourceType: payload.sourceType,
        filename: payload.sourceFilename,
        mimeType: payload.mimeType ?? "text/uri-list",
        storagePath: "",
        ...(payload.sourceUrl ? { sourceUrl: payload.sourceUrl } : {}),
        ...(payload.fileBase64
          ? { fileBuffer: Buffer.from(payload.fileBase64, "base64") }
          : {}),
      },
      {
        onCandidatesParsed: async ({ extractedText, candidates }) => {
          await assertJobActive(payload.jobId);
          await updateJob(payload.jobId, {
            extractedText,
            candidates,
            recommendations: [],
          });
        },
        onCandidateProcessed: async ({ recommendations }) => {
          await assertJobActive(payload.jobId);
          await updateJobRecommendations(payload.jobId, recommendations);
        },
      },
    );

    await assertJobActive(payload.jobId);
    await updateJob(payload.jobId, {
      status: "completed",
      errorMessage: null,
      extractedText: result.extractedText,
      candidates: result.candidates,
      recommendations: result.recommendations,
    });
  } catch (error) {
    if (error instanceof JobCanceledError) {
      return;
    }

    const current = await getJob(payload.jobId);
    if (current?.status === "canceled") {
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown worker error";
    await updateJob(payload.jobId, {
      status: "failed",
      queueMessageId: null,
      errorMessage: message,
    });
  } finally {
    await VivinoBrowser.getInstance().close();
  }
}
