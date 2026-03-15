import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recommendation, WineCandidate } from "@wine-rec/contracts";

const {
  createJobChunksMock,
  publishJSONMock,
  deleteMessageMock,
  createOcrProviderMock,
  createWineProfileProvidersMock,
  fetchUrlPreviewMock,
  runCandidateAnalysisMock,
  parseWineCandidatesMock,
  extractSourceTextMock,
  getJobMock,
  getJobChunkMock,
  listJobChunksMock,
  updateJobChunkMock,
  updateJobChunkRecommendationsMock,
  updateJobMock,
} = vi.hoisted(() => ({
  createJobChunksMock: vi.fn(),
  publishJSONMock: vi.fn(),
  deleteMessageMock: vi.fn(),
  createOcrProviderMock: vi.fn(),
  createWineProfileProvidersMock: vi.fn(),
  fetchUrlPreviewMock: vi.fn(),
  runCandidateAnalysisMock: vi.fn(),
  parseWineCandidatesMock: vi.fn(),
  extractSourceTextMock: vi.fn(),
  getJobMock: vi.fn(),
  getJobChunkMock: vi.fn(),
  listJobChunksMock: vi.fn(),
  updateJobChunkMock: vi.fn(),
  updateJobChunkRecommendationsMock: vi.fn(),
  updateJobMock: vi.fn(),
}));

vi.mock("@upstash/qstash", () => ({
  Client: class {
    publishJSON = publishJSONMock;

    messages = {
      delete: deleteMessageMock,
    };
  },
}));

vi.mock("./providers/ocr.js", () => ({
  createOcrProvider: createOcrProviderMock,
}));

vi.mock("./providers/wine-profiles.js", () => ({
  createWineProfileProviders: createWineProfileProvidersMock,
}));

vi.mock("./services/pipeline.js", () => ({
  AnalysisCanceledError: class AnalysisCanceledError extends Error {
    constructor() {
      super("Analysis stopped by user.");
      this.name = "AnalysisCanceledError";
    }
  },
  AnalysisRetryableError: class AnalysisRetryableError extends Error {
    constructor(readonly candidateId: string, readonly cause: unknown) {
      super(`Analysis retry required while processing candidate ${candidateId}.`);
      this.name = "AnalysisRetryableError";
    }
  },
  runCandidateAnalysis: runCandidateAnalysisMock,
}));

vi.mock("./services/parser.js", () => ({
  parseWineCandidates: parseWineCandidatesMock,
}));

vi.mock("./services/source-extractor.js", () => ({
  extractSourceText: extractSourceTextMock,
}));

vi.mock("./services/url-preview.js", () => ({
  fetchUrlPreview: fetchUrlPreviewMock,
}));

vi.mock("./store/job-store.js", () => ({
  createJob: vi.fn(),
  createJobChunks: createJobChunksMock,
  getJob: getJobMock,
  getJobChunk: getJobChunkMock,
  listJobChunks: listJobChunksMock,
  updateJob: updateJobMock,
  updateJobChunk: updateJobChunkMock,
  updateJobChunkRecommendations: updateJobChunkRecommendationsMock,
}));

import { AnalysisRetryableError } from "./services/pipeline.js";
import { processWorkerJob } from "./api-handlers.js";

const originalQstashToken = process.env.QSTASH_TOKEN;
const originalQstashUrl = process.env.QSTASH_URL;
const originalWorkerUrl = process.env.WORKER_URL;

function buildCandidate(id: string): WineCandidate {
  return {
    id,
    rawText: `Wine ${id}`,
    price: "$20",
    menuTab: null,
    menuSection: null,
    lineNumber: 0,
    producer: "Producer",
    label: `Label ${id}`,
    vintage: null,
    color: "red",
    varietal: null,
    region: null,
    notes: null,
    extractionConfidence: 0.9,
  };
}

function buildRecommendation(candidateId: string): Recommendation {
  return {
    candidateId,
    fitScore: 75,
    matchConfidence: 0.4,
    profile: null,
    status: "unmatched",
  };
}

function buildJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "analysis-1",
    sourceType: "url-html" as const,
    sourceFilename: "https://example.com/menu",
    status: "processing" as const,
    queueMessageId: null,
    errorMessage: null,
    extractedText: "Wine list",
    candidates: [buildCandidate("candidate-1"), buildCandidate("candidate-2")],
    recommendations: [],
    chunkCount: 1,
    createdAt: "2026-03-14T18:23:57.685Z",
    updatedAt: "2026-03-14T18:25:00.000Z",
    ...overrides,
  };
}

function buildChunk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: "analysis-1",
    index: 0,
    status: "queued" as const,
    queueMessageId: "msg-current",
    errorMessage: null,
    candidateIds: ["candidate-1", "candidate-2"],
    recommendations: [],
    createdAt: "2026-03-14T18:24:02.218Z",
    updatedAt: "2026-03-14T18:24:30.000Z",
    ...overrides,
  };
}

describe("serverless worker orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    process.env.QSTASH_TOKEN = "test-token";
    process.env.QSTASH_URL = "https://qstash.example.com";
    process.env.WORKER_URL = "https://wine-rec.example.com";

    createOcrProviderMock.mockReturnValue({
      name: "mock",
      isEnabled: true,
      detail: "test",
      extractText: vi.fn(),
    });
    createWineProfileProvidersMock.mockReturnValue([]);
    deleteMessageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalQstashToken === undefined) {
      delete process.env.QSTASH_TOKEN;
    } else {
      process.env.QSTASH_TOKEN = originalQstashToken;
    }

    if (originalQstashUrl === undefined) {
      delete process.env.QSTASH_URL;
    } else {
      process.env.QSTASH_URL = originalQstashUrl;
    }

    if (originalWorkerUrl === undefined) {
      delete process.env.WORKER_URL;
    } else {
      process.env.WORKER_URL = originalWorkerUrl;
    }
  });

  it("splits coordinator work into 4-wine chunks and caps active chunk fan-out", async () => {
    const candidates = [
      buildCandidate("candidate-1"),
      buildCandidate("candidate-2"),
      buildCandidate("candidate-3"),
      buildCandidate("candidate-4"),
      buildCandidate("candidate-5"),
    ];
    const initialJob = buildJob({
      extractedText: null,
      candidates: [],
      recommendations: [],
      chunkCount: 0,
    });
    const parsedJob = buildJob({
      extractedText: "Wine list",
      candidates,
      recommendations: [],
      chunkCount: 0,
    });

    getJobMock
      .mockResolvedValueOnce(initialJob)
      .mockResolvedValueOnce(initialJob)
      .mockResolvedValueOnce(initialJob)
      .mockResolvedValueOnce(initialJob)
      .mockResolvedValueOnce(parsedJob)
      .mockResolvedValueOnce(parsedJob)
      .mockResolvedValueOnce(parsedJob)
      .mockResolvedValueOnce(parsedJob);
    extractSourceTextMock.mockResolvedValue("Wine list");
    parseWineCandidatesMock.mockReturnValue(candidates);
    createJobChunksMock.mockResolvedValue([
      { index: 0, candidateIds: ["candidate-1", "candidate-2", "candidate-3", "candidate-4"] },
      { index: 1, candidateIds: ["candidate-5"] },
    ]);
    publishJSONMock
      .mockResolvedValueOnce({ messageId: "msg-0" })
      .mockResolvedValueOnce({ messageId: "msg-1" });
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);

    await processWorkerJob({
      mode: "coordinator",
      jobId: "analysis-1",
      sourceType: "url-html",
      sourceFilename: "https://example.com/menu",
      sourceUrl: "https://example.com/menu",
    });

    expect(createJobChunksMock).toHaveBeenCalledWith("analysis-1", [
      [candidates[0], candidates[1], candidates[2], candidates[3]],
      [candidates[4]],
    ]);
    expect(publishJSONMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: {
          mode: "chunk",
          jobId: "analysis-1",
          chunkIndex: 0,
        },
        retries: 3,
        retryDelay: "5 + min(20, retried * 5)",
        failureCallback: "https://wine-rec.example.com/api/worker-failure",
        flowControl: {
          key: "analysis.analysis-1.chunk",
          parallelism: 10,
        },
      }),
    );
    expect(publishJSONMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        delay: 2,
      }),
    );
    expect(publishJSONMock).toHaveBeenCalledTimes(2);
  });

  it("re-queues a chunk when the 50-second worker budget is exhausted", async () => {
    const job = buildJob();
    const chunk = buildChunk({
      status: "processing",
    });
    const yieldedRecommendations = [buildRecommendation("candidate-1")];

    getJobMock.mockResolvedValue(job);
    getJobChunkMock.mockResolvedValue(chunk);
    runCandidateAnalysisMock.mockResolvedValue({
      recommendations: yieldedRecommendations,
      didCompleteAll: false,
    });
    publishJSONMock.mockResolvedValue({ messageId: "msg-requeue" });
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await processWorkerJob({
      mode: "chunk",
      jobId: "analysis-1",
      chunkIndex: 0,
    });

    expect(runCandidateAnalysisMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shouldYield: expect.any(Function),
      }),
      expect.objectContaining({
        candidateConcurrency: 1,
      }),
    );
    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          mode: "chunk",
          jobId: "analysis-1",
          chunkIndex: 0,
        },
        delay: 4,
        retries: 3,
        retryDelay: "5 + min(20, retried * 5)",
        flowControl: {
          key: "analysis.analysis-1.chunk",
          parallelism: 10,
        },
      }),
    );
    expect(updateJobChunkMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "queued",
        queueMessageId: "msg-requeue",
        recommendations: yieldedRecommendations,
      }),
    );
  });

  it("lets QStash retry retryable chunk errors instead of manually re-publishing them", async () => {
    const job = buildJob();
    const chunk = buildChunk({
      status: "processing",
    });

    getJobMock.mockResolvedValue(job);
    getJobChunkMock.mockResolvedValue(chunk);
    runCandidateAnalysisMock.mockRejectedValue(
      new AnalysisRetryableError("candidate-1", new Error("Chromium disconnected")),
    );

    await expect(
      processWorkerJob({
        mode: "chunk",
        jobId: "analysis-1",
        chunkIndex: 0,
      }),
    ).rejects.toBeInstanceOf(AnalysisRetryableError);

    expect(publishJSONMock).not.toHaveBeenCalled();
    expect(updateJobChunkMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "queued",
        queueMessageId: "msg-current",
        errorMessage: null,
      }),
    );
  });
});
