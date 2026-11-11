import { ProviderAccessBlockedError } from "./providers/provider-access.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recommendation, WineCandidate } from "@wine-rec/contracts";

type MockJob = {
  id: string;
  sourceType: "url-html" | "client-ocr-text" | "upload-image" | "upload-pdf";
  sourceFilename: string;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  queueMessageId: string | null;
  errorMessage: string | null;
  extractedText: string | null;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
  workerCount: number;
  createdAt: string;
  updatedAt: string;
};

type MockWorker = {
  jobId: string;
  index: number;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  queueMessageId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type MockCandidateWork = {
  jobId: string;
  candidateId: string;
  index: number;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  recommendation: Recommendation | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const {
  publishJSONMock,
  deleteMessageMock,
  createOcrProviderMock,
  createWineProfileProvidersMock,
  fetchUrlPreviewMock,
  runCandidateAnalysisMock,
  parseWineCandidatesMock,
  extractCandidatesFromUrlMock,
  extractSourceTextMock,
  storeState,
  resetStoreState,
  createJobMock,
  getJobMock,
  getJobStateMock,
  updateJobMock,
  createJobWorkersMock,
  getJobWorkerMock,
  listJobWorkersMock,
  updateJobWorkerMock,
  createJobCandidateWorkMock,
  getJobCandidateWorkMock,
  listJobCandidateWorkMock,
  findJobCandidateWorkByLeaseOwnerMock,
  updateJobCandidateWorkMock,
  claimNextJobCandidateMock,
  completeJobCandidateMock,
  requeueJobCandidateMock,
  failJobCandidateMock,
  hasQueuedJobCandidatesMock,
  clearJobCandidateStateMock,
  clearJobCandidateQueueMock,
} = vi.hoisted(() => {
  const state: {
    job: MockJob | null;
    workers: Map<number, MockWorker>;
    candidateWork: Map<string, MockCandidateWork>;
  } = {
    job: null,
    workers: new Map(),
    candidateWork: new Map(),
  };

  const resetStoreState = (): void => {
    state.job = null;
    state.workers = new Map();
    state.candidateWork = new Map();
  };

  const createJobMock = vi.fn();
  const getJobMock = vi.fn(async () => (state.job ? clone(state.job) : null));
  const getJobStateMock = vi.fn(async () => (state.job ? clone(state.job) : null));
  const updateJobMock = vi.fn(async (_jobId: string, updates: Partial<MockJob>) => {
    if (!state.job || ["failed", "canceled", "completed"].includes(state.job.status)) {
      return;
    }

    state.job = {
      ...state.job,
      ...updates,
    };
  });

  const createJobWorkersMock = vi.fn(async (jobId: string, workerCount: number) => {
    const now = "2026-03-15T00:00:00.000Z";
    const workers = Array.from({ length: workerCount }, (_, index) => ({
      jobId,
      index,
      status: "queued" as const,
      queueMessageId: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }));

    state.workers = new Map(workers.map((worker) => [worker.index, worker]));
    if (state.job) {
      state.job = {
        ...state.job,
        workerCount,
      };
    }

    return clone(workers);
  });

  const getJobWorkerMock = vi.fn(async (_jobId: string, workerIndex: number) => {
    const worker = state.workers.get(workerIndex);
    return worker ? clone(worker) : null;
  });

  const listJobWorkersMock = vi.fn(async () => (
    Array.from(state.workers.values())
      .sort((left, right) => left.index - right.index)
      .map((worker) => clone(worker))
  ));

  const updateJobWorkerMock = vi.fn(
    async (_jobId: string, workerIndex: number, updates: Partial<MockWorker>) => {
      const worker = state.workers.get(workerIndex);
      if (!worker) {
        return;
      }

      state.workers.set(workerIndex, {
        ...worker,
        ...updates,
      });
    },
  );

  const createJobCandidateWorkMock = vi.fn(async (jobId: string, candidates: WineCandidate[]) => {
    const now = "2026-03-15T00:00:00.000Z";
    const records = candidates.map((candidate, index) => ({
      jobId,
      candidateId: candidate.id,
      index,
      status: "queued" as const,
      recommendation: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }));

    state.candidateWork = new Map(records.map((record) => [record.candidateId, record]));
    return clone(records);
  });

  const getJobCandidateWorkMock = vi.fn(async (_jobId: string, candidateId: string) => {
    const record = state.candidateWork.get(candidateId);
    return record ? clone(record) : null;
  });

  const listJobCandidateWorkMock = vi.fn(async (_jobId: string, candidates?: Array<{ id: string }>) => {
    const candidateIds = (candidates ?? state.job?.candidates ?? []).map((candidate) => candidate.id);
    return candidateIds
      .map((candidateId) => state.candidateWork.get(candidateId))
      .filter((record): record is MockCandidateWork => record !== undefined)
      .sort((left, right) => left.index - right.index)
      .map((record) => clone(record));
  });

  const findJobCandidateWorkByLeaseOwnerMock = vi.fn(
    async (_jobId: string, leaseOwner: string, candidates?: Array<{ id: string }>) => {
      const candidateIds = (candidates ?? state.job?.candidates ?? []).map((candidate) => candidate.id);
      const record = candidateIds
        .map((candidateId) => state.candidateWork.get(candidateId))
        .find((value) => value?.leaseOwner === leaseOwner && value.status === "processing");

      return record ? clone(record) : null;
    },
  );

  const updateJobCandidateWorkMock = vi.fn(
    async (_jobId: string, candidateId: string, updates: Partial<MockCandidateWork>) => {
      const record = state.candidateWork.get(candidateId);
      if (!record) {
        return;
      }

      state.candidateWork.set(candidateId, {
        ...record,
        ...updates,
      });
    },
  );

  const claimNextJobCandidateMock = vi.fn();

  const completeJobCandidateMock = vi.fn(
    async (_jobId: string, candidateId: string, leaseOwner: string, recommendation: Recommendation) => {
      const record = state.candidateWork.get(candidateId);
      if (!record || record.leaseOwner !== leaseOwner) {
        return {
          updated: false,
          progressTracked: false,
          jobStatus: null,
        };
      }

      state.candidateWork.set(candidateId, {
        ...record,
        status: "completed",
        recommendation,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorMessage: null,
      });

      let jobStatus: MockJob["status"] = "processing";
      if (state.job) {
        const records = Array.from(state.candidateWork.values());
        const failedCount = records.filter((value) => value.status === "failed").length;
        const completedCount = records.filter((value) => value.status === "completed").length;
        jobStatus = failedCount > 0
          ? "failed"
          : completedCount === state.job.candidates.length
            ? "completed"
            : "processing";
        state.job = {
          ...state.job,
          status: jobStatus,
        };
      }

      return {
        updated: true,
        progressTracked: true,
        jobStatus,
      };
    },
  );

  const requeueJobCandidateMock = vi.fn();

  const failJobCandidateMock = vi.fn(
    async (_jobId: string, candidateId: string, leaseOwner: string, errorMessage: string) => {
      const record = state.candidateWork.get(candidateId);
      if (!record || record.leaseOwner !== leaseOwner) {
        return {
          updated: false,
          progressTracked: false,
          jobStatus: null,
        };
      }

      state.candidateWork.set(candidateId, {
        ...record,
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorMessage,
      });
      if (state.job) {
        state.job = {
          ...state.job,
          status: "failed",
          errorMessage,
        };
      }
      return {
        updated: true,
        progressTracked: true,
        jobStatus: "failed",
      };
    },
  );

  const hasQueuedJobCandidatesMock = vi.fn(
    async () => Array.from(state.candidateWork.values()).some((record) => record.status === "queued"),
  );

  const clearJobCandidateStateMock = vi.fn();
  const clearJobCandidateQueueMock = vi.fn();

  return {
    publishJSONMock: vi.fn(),
    deleteMessageMock: vi.fn(),
    createOcrProviderMock: vi.fn(),
    createWineProfileProvidersMock: vi.fn(),
    fetchUrlPreviewMock: vi.fn(),
    runCandidateAnalysisMock: vi.fn(),
    parseWineCandidatesMock: vi.fn(),
    extractCandidatesFromUrlMock: vi.fn(),
    extractSourceTextMock: vi.fn(),
    storeState: state,
    resetStoreState,
    createJobMock,
    getJobMock,
    getJobStateMock,
    updateJobMock,
    createJobWorkersMock,
    getJobWorkerMock,
    listJobWorkersMock,
    updateJobWorkerMock,
    createJobCandidateWorkMock,
    getJobCandidateWorkMock,
    listJobCandidateWorkMock,
    findJobCandidateWorkByLeaseOwnerMock,
    updateJobCandidateWorkMock,
    claimNextJobCandidateMock,
    completeJobCandidateMock,
    requeueJobCandidateMock,
    failJobCandidateMock,
    hasQueuedJobCandidatesMock,
    clearJobCandidateStateMock,
    clearJobCandidateQueueMock,
  };
});

const { blobPutMock, blobGetMock, blobDelMock } = vi.hoisted(() => ({ blobPutMock: vi.fn(), blobGetMock: vi.fn(), blobDelMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: blobPutMock, get: blobGetMock, del: blobDelMock }));

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
  extractCandidatesFromUrl: extractCandidatesFromUrlMock,
  extractSourceText: extractSourceTextMock,
}));

vi.mock("./services/url-preview.js", () => ({
  fetchUrlPreview: fetchUrlPreviewMock,
}));

vi.mock("./store/job-store.js", () => ({
  createJob: createJobMock,
  getJob: getJobMock,
  getJobState: getJobStateMock,
  updateJob: updateJobMock,
  createJobWorkers: createJobWorkersMock,
  getJobWorker: getJobWorkerMock,
  listJobWorkers: listJobWorkersMock,
  updateJobWorker: updateJobWorkerMock,
  createJobCandidateWork: createJobCandidateWorkMock,
  getJobCandidateWork: getJobCandidateWorkMock,
  listJobCandidateWork: listJobCandidateWorkMock,
  findJobCandidateWorkByLeaseOwner: findJobCandidateWorkByLeaseOwnerMock,
  updateJobCandidateWork: updateJobCandidateWorkMock,
  claimNextJobCandidate: claimNextJobCandidateMock,
  completeJobCandidate: completeJobCandidateMock,
  requeueJobCandidate: requeueJobCandidateMock,
  failJobCandidate: failJobCandidateMock,
  hasQueuedJobCandidates: hasQueuedJobCandidatesMock,
  clearJobCandidateState: clearJobCandidateStateMock,
  clearJobCandidateQueue: clearJobCandidateQueueMock,
}));

import { AnalysisRetryableError } from "./services/pipeline.js";
import {
  createUploadAnalysis,
  parseWorkerJobPayload,
  createClientOcrAnalysis,
  createUrlAnalysis,
  processWorkerFailure,
  processWorkerJob,
} from "./api-handlers.js";

const originalQstashToken = process.env.QSTASH_TOKEN;
const originalQstashUrl = process.env.QSTASH_URL;
const originalWorkerUrl = process.env.WORKER_URL;
const originalVercelUrl = process.env.VERCEL_URL;
const originalChunkWorkerBaseUrl = process.env.CHUNK_WORKER_BASE_URL;
const originalVercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const originalChunkWorkerBypassSecret = process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET;

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

function buildJob(overrides: Partial<MockJob> = {}): MockJob {
  return {
    id: "analysis-1",
    sourceType: "url-html",
    sourceFilename: "https://example.com/menu",
    status: "processing",
    queueMessageId: null,
    errorMessage: null,
    extractedText: "Wine list",
    candidates: [buildCandidate("candidate-1"), buildCandidate("candidate-2")],
    recommendations: [],
    workerCount: 1,
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function buildWorker(overrides: Partial<MockWorker> = {}): MockWorker {
  return {
    jobId: "analysis-1",
    index: 0,
    status: "queued",
    queueMessageId: "msg-current",
    errorMessage: null,
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function buildCandidateWork(
  candidateId: string,
  index: number,
  overrides: Partial<MockCandidateWork> = {},
): MockCandidateWork {
  return {
    jobId: "analysis-1",
    candidateId,
    index,
    status: "queued",
    recommendation: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    errorMessage: null,
    createdAt: "2026-03-15T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function seedJobState(job: MockJob, workers: MockWorker[], candidateWork: MockCandidateWork[]): void {
  storeState.job = clone(job);
  storeState.workers = new Map(workers.map((worker) => [worker.index, clone(worker)]));
  storeState.candidateWork = new Map(candidateWork.map((record) => [record.candidateId, clone(record)]));
}

describe("serverless worker orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetStoreState();
    vi.stubEnv("BLOB_UPLOAD_ACCESS", undefined);
    blobPutMock.mockReset();
    blobGetMock.mockReset();
    blobDelMock.mockReset().mockResolvedValue(undefined);

    process.env.QSTASH_TOKEN = "test-token";
    process.env.QSTASH_URL = "https://qstash.example.com";
    process.env.WORKER_URL = "https://wine-rec.example.com";
    delete process.env.VERCEL_URL;
    delete process.env.CHUNK_WORKER_BASE_URL;
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET;

    createJobMock.mockImplementation(async ({ id, sourceType, sourceFilename }: {
      id: string;
      sourceType: MockJob["sourceType"];
      sourceFilename: string;
    }) => {
      const job = buildJob({
        id,
        sourceType,
        sourceFilename,
        status: "queued",
        queueMessageId: null,
        errorMessage: null,
        extractedText: null,
        candidates: [],
        recommendations: [],
        workerCount: 0,
      });
      storeState.job = clone(job);
      return clone(job);
    });

    createOcrProviderMock.mockReturnValue({
      name: "mock",
      isEnabled: true,
      detail: "test",
      extractText: vi.fn(),
    });
    createWineProfileProvidersMock.mockReturnValue([]);
    deleteMessageMock.mockResolvedValue(undefined);
    hasQueuedJobCandidatesMock.mockImplementation(
      async () => Array.from(storeState.candidateWork.values()).some((record) => record.status === "queued"),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

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

    if (originalVercelUrl === undefined) {
      delete process.env.VERCEL_URL;
    } else {
      process.env.VERCEL_URL = originalVercelUrl;
    }

    if (originalChunkWorkerBaseUrl === undefined) {
      delete process.env.CHUNK_WORKER_BASE_URL;
    } else {
      process.env.CHUNK_WORKER_BASE_URL = originalChunkWorkerBaseUrl;
    }

    if (originalVercelAutomationBypassSecret === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = originalVercelAutomationBypassSecret;
    }

    if (originalChunkWorkerBypassSecret === undefined) {
      delete process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET = originalChunkWorkerBypassSecret;
    }
  });

  it("publishes up to 10 generic worker slots after parsing candidates", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => buildCandidate(`candidate-${index + 1}`));
    seedJobState(
      buildJob({
        extractedText: null,
        candidates: [],
        recommendations: [],
        workerCount: 0,
      }),
      [],
      [],
    );

    extractCandidatesFromUrlMock.mockResolvedValue(candidates);
    publishJSONMock.mockImplementation(async ({ body }: { body: { workerIndex: number } }) => ({
      messageId: `msg-${body.workerIndex}`,
    }));
    vi.spyOn(Math, "random").mockReturnValue(0);

    await processWorkerJob({
      mode: "coordinator",
      jobId: "analysis-1",
      sourceType: "url-html",
      sourceFilename: "https://example.com/menu",
      sourceUrl: "https://example.com/menu",
    });

    expect(createJobCandidateWorkMock).toHaveBeenCalledWith("analysis-1", candidates);
    expect(createJobWorkersMock).toHaveBeenCalledWith("analysis-1", 10);
    expect(publishJSONMock).toHaveBeenCalledTimes(10);
    expect(publishJSONMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://wine-rec.example.com/api/chunk-worker",
        body: {
          mode: "worker",
          jobId: "analysis-1",
          workerIndex: 0,
        },
        retries: 3,
        retryDelay: "5 + min(20, retried * 5)",
        failureCallback: "https://wine-rec.example.com/api/worker-failure",
        flowControl: {
          key: "analysis.analysis-1.worker",
          parallelism: 10,
        },
      }),
    );
  });

  it("publishes worker slots to the dedicated chunk-worker deployment when configured", async () => {
    const candidates = [buildCandidate("candidate-1")];
    seedJobState(
      buildJob({
        extractedText: null,
        candidates: [],
        recommendations: [],
        workerCount: 0,
      }),
      [],
      [],
    );

    process.env.VERCEL_URL = "main.wine-rec.example.com";
    process.env.CHUNK_WORKER_BASE_URL = "https://chunk-worker.example.com";
    process.env.CHUNK_WORKER_VERCEL_AUTOMATION_BYPASS_SECRET = "worker-bypass";

    extractCandidatesFromUrlMock.mockResolvedValue(candidates);
    publishJSONMock.mockResolvedValue({ messageId: "msg-0" });
    vi.spyOn(Math, "random").mockReturnValue(0);

    await processWorkerJob({
      mode: "coordinator",
      jobId: "analysis-1",
      sourceType: "url-html",
      sourceFilename: "https://example.com/menu",
      sourceUrl: "https://example.com/menu",
    });

    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chunk-worker.example.com/api/chunk-worker",
        failureCallback: "https://chunk-worker.example.com/api/worker-failure",
        headers: {
          "x-vercel-protection-bypass": "worker-bypass",
        },
      }),
    );
  });

  it("publishes coordinator jobs to the main deployment and keeps worker routing separate", async () => {
    process.env.VERCEL_URL = "main.wine-rec.example.com";
    process.env.CHUNK_WORKER_BASE_URL = "https://chunk-worker.example.com";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "main-bypass";
    publishJSONMock.mockResolvedValue({ messageId: "msg-coordinator" });

    const created = await createUrlAnalysis({
      url: "https://example.com/menu",
    });

    expect(created.status).toBe("queued");
    expect(created.analysisId).toEqual(expect.any(String));
    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://main.wine-rec.example.com/api/coordinator",
        body: expect.objectContaining({
          mode: "coordinator",
          sourceUrl: "https://example.com/menu",
        }),
        failureCallback: "https://main.wine-rec.example.com/api/worker-failure",
        headers: {
          "x-vercel-protection-bypass": "main-bypass",
        },
      }),
    );
  });

  it("publishes client OCR text as a coordinator job", async () => {
    process.env.VERCEL_URL = "main.wine-rec.example.com";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "main-bypass";
    publishJSONMock.mockResolvedValue({ messageId: "msg-client-ocr" });

    const created = await createClientOcrAnalysis({
      sourceFilename: "camera-menu.jpg",
      recognizedText: "Domaine Test Pinot Noir 2022",
    });

    expect(created.status).toBe("queued");
    expect(created.analysisId).toEqual(expect.any(String));
    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "client-ocr-text",
        sourceFilename: "camera-menu.jpg",
      }),
    );
    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://main.wine-rec.example.com/api/coordinator",
        body: expect.objectContaining({
          mode: "coordinator",
          sourceType: "client-ocr-text",
          sourceFilename: "camera-menu.jpg",
          recognizedText: "Domaine Test Pinot Noir 2022",
        }),
        failureCallback: "https://main.wine-rec.example.com/api/worker-failure",
        headers: {
          "x-vercel-protection-bypass": "main-bypass",
        },
      }),
    );
  });

  it("parses client OCR text in the coordinator before launching workers", async () => {
    const candidates = [buildCandidate("candidate-1")];
    seedJobState(
      buildJob({
        sourceType: "client-ocr-text",
        sourceFilename: "camera-menu.jpg",
        extractedText: null,
        candidates: [],
        recommendations: [],
        workerCount: 0,
      }),
      [],
      [],
    );

    parseWineCandidatesMock.mockReturnValue(candidates);
    publishJSONMock.mockResolvedValue({ messageId: "msg-0" });
    vi.spyOn(Math, "random").mockReturnValue(0);

    await processWorkerJob({
      mode: "coordinator",
      jobId: "analysis-1",
      sourceType: "client-ocr-text",
      sourceFilename: "camera-menu.jpg",
      recognizedText: "Domaine Test Pinot Noir 2022",
    });

    expect(parseWineCandidatesMock).toHaveBeenCalledWith("Domaine Test Pinot Noir 2022");
    expect(extractSourceTextMock).not.toHaveBeenCalled();
    expect(extractCandidatesFromUrlMock).not.toHaveBeenCalled();
    expect(updateJobMock).toHaveBeenCalledWith(
      "analysis-1",
      expect.objectContaining({
        extractedText: "Domaine Test Pinot Noir 2022",
        candidates,
      }),
    );
    expect(createJobCandidateWorkMock).toHaveBeenCalledWith("analysis-1", candidates);
  });

  it("keeps claiming candidates until the worker drains available work", async () => {
    const candidateOne = buildCandidate("candidate-1");
    const candidateTwo = buildCandidate("candidate-2");
    seedJobState(
      buildJob({
        candidates: [candidateOne, candidateTwo],
        workerCount: 1,
      }),
      [buildWorker()],
      [
        buildCandidateWork(candidateOne.id, 0),
        buildCandidateWork(candidateTwo.id, 1),
      ],
    );

    claimNextJobCandidateMock
      .mockImplementationOnce(async () => {
        const record: MockCandidateWork = {
          ...storeState.candidateWork.get(candidateOne.id)!,
          status: "processing",
          leaseOwner: "worker-0",
          attemptCount: 1,
        };
        storeState.candidateWork.set(candidateOne.id, record);
        return clone(record);
      })
      .mockImplementationOnce(async () => {
        const record: MockCandidateWork = {
          ...storeState.candidateWork.get(candidateTwo.id)!,
          status: "processing",
          leaseOwner: "worker-0",
          attemptCount: 1,
        };
        storeState.candidateWork.set(candidateTwo.id, record);
        return clone(record);
      })
      .mockResolvedValueOnce(null);
    runCandidateAnalysisMock.mockImplementation(async ({ candidates }: { candidates: WineCandidate[] }) => ({
      recommendations: [buildRecommendation(candidates[0]!.id)],
      didCompleteAll: true,
    }));

    await processWorkerJob({
      mode: "worker",
      jobId: "analysis-1",
      workerIndex: 0,
    });

    expect(runCandidateAnalysisMock).toHaveBeenCalledTimes(2);
    expect(completeJobCandidateMock).toHaveBeenNthCalledWith(
      1,
      "analysis-1",
      "candidate-1",
      "worker-0",
      buildRecommendation("candidate-1"),
    );
    expect(completeJobCandidateMock).toHaveBeenNthCalledWith(
      2,
      "analysis-1",
      "candidate-2",
      "worker-0",
      buildRecommendation("candidate-2"),
    );
    expect(updateJobWorkerMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "completed",
        queueMessageId: null,
      }),
    );
    expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it("requeues the same worker slot when it hits the 50-second yield budget", async () => {
    const candidateOne = buildCandidate("candidate-1");
    const candidateTwo = buildCandidate("candidate-2");
    seedJobState(
      buildJob({
        candidates: [candidateOne, candidateTwo],
        workerCount: 1,
      }),
      [buildWorker()],
      [
        buildCandidateWork(candidateOne.id, 0),
        buildCandidateWork(candidateTwo.id, 1),
      ],
    );

    claimNextJobCandidateMock.mockImplementationOnce(async () => {
      const record: MockCandidateWork = {
        ...storeState.candidateWork.get(candidateOne.id)!,
        status: "processing",
        leaseOwner: "worker-0",
        attemptCount: 1,
      };
      storeState.candidateWork.set(candidateOne.id, record);
      return clone(record);
    });
    runCandidateAnalysisMock.mockResolvedValue({
      recommendations: [buildRecommendation(candidateOne.id)],
      didCompleteAll: true,
    });
    publishJSONMock.mockResolvedValue({ messageId: "msg-next" });
    hasQueuedJobCandidatesMock.mockResolvedValue(true);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(50_001);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await processWorkerJob({
      mode: "worker",
      jobId: "analysis-1",
      workerIndex: 0,
    });

    expect(publishJSONMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          mode: "worker",
          jobId: "analysis-1",
          workerIndex: 0,
        },
        delay: 4,
        retries: 3,
        retryDelay: "5 + min(20, retried * 5)",
        flowControl: {
          key: "analysis.analysis-1.worker",
          parallelism: 10,
        },
      }),
    );
    expect(updateJobWorkerMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "queued",
        queueMessageId: "msg-next",
      }),
    );
  });

  it("lets QStash retry retryable candidate failures and keeps the leased candidate in place", async () => {
    const candidateOne = buildCandidate("candidate-1");
    seedJobState(
      buildJob({
        candidates: [candidateOne],
        workerCount: 1,
      }),
      [buildWorker()],
      [
        buildCandidateWork(candidateOne.id, 0),
      ],
    );

    claimNextJobCandidateMock.mockImplementationOnce(async () => {
      const record: MockCandidateWork = {
        ...storeState.candidateWork.get(candidateOne.id)!,
        status: "processing",
        leaseOwner: "worker-0",
        attemptCount: 1,
      };
      storeState.candidateWork.set(candidateOne.id, record);
      return clone(record);
    });
    runCandidateAnalysisMock.mockRejectedValue(
      new AnalysisRetryableError(candidateOne.id, new Error("Chromium disconnected")),
    );

    await expect(
      processWorkerJob({
        mode: "worker",
        jobId: "analysis-1",
        workerIndex: 0,
      }),
    ).rejects.toBeInstanceOf(AnalysisRetryableError);

    expect(updateJobCandidateWorkMock).toHaveBeenCalledWith(
      "analysis-1",
      "candidate-1",
      expect.objectContaining({
        errorMessage: "Analysis retry required while processing candidate candidate-1.",
      }),
    );
    expect(updateJobWorkerMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "queued",
        queueMessageId: "msg-current",
      }),
    );
    expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it("fails the leased candidate when QStash exhausts worker retries", async () => {
    const candidateOne = buildCandidate("candidate-1");
    const leasedCandidate = buildCandidateWork(candidateOne.id, 0, {
      status: "processing",
      leaseOwner: "worker-0",
      attemptCount: 4,
      errorMessage: "Analysis retry required while processing candidate candidate-1.",
    });
    seedJobState(
      buildJob({
        candidates: [candidateOne],
        workerCount: 1,
      }),
      [buildWorker()],
      [leasedCandidate],
    );

    await processWorkerFailure(
      Buffer.from(
        JSON.stringify({
          mode: "worker",
          jobId: "analysis-1",
          workerIndex: 0,
        }),
        "utf8",
      ).toString("base64"),
    );

    expect(failJobCandidateMock).toHaveBeenCalledWith(
      "analysis-1",
      "candidate-1",
      "worker-0",
      "Analysis retry required while processing candidate candidate-1.",
    );
    expect(updateJobWorkerMock).toHaveBeenLastCalledWith(
      "analysis-1",
      0,
      expect.objectContaining({
        status: "failed",
        queueMessageId: null,
      }),
    );
  });
  it("acknowledges a provider block, terminates all work, and ignores redelivery without requeue", async () => {
    const one = buildCandidate("candidate-1"), two = buildCandidate("candidate-2");
    seedJobState(buildJob({ candidates: [one, two], workerCount: 2 }),
      [buildWorker(), buildWorker({ index: 1, queueMessageId: "msg-second" })],
      [buildCandidateWork(one.id, 0), buildCandidateWork(two.id, 1)]);
    claimNextJobCandidateMock.mockResolvedValueOnce(buildCandidateWork(one.id, 0, { status: "processing", leaseOwner: "worker-0" }));
    const blocked = new ProviderAccessBlockedError(); runCandidateAnalysisMock.mockRejectedValue(blocked);
    await expect(processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).resolves.toBeUndefined();
    expect(storeState.job).toMatchObject({ status: "failed", errorMessage: blocked.message });
    expect([...storeState.workers.values()].every(worker => worker.status === "failed")).toBe(true);
    expect([...storeState.candidateWork.values()].every(work => work.status === "failed" && work.leaseOwner === null)).toBe(true);
    expect(clearJobCandidateQueueMock).toHaveBeenCalledWith("analysis-1");
    expect(deleteMessageMock).toHaveBeenCalledWith("msg-current"); expect(deleteMessageMock).toHaveBeenCalledWith("msg-second");
    expect(publishJSONMock).not.toHaveBeenCalled();
    await processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 });
    await processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 1 });
    await processWorkerFailure(Buffer.from(JSON.stringify({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).toString("base64"));
    expect(runCandidateAnalysisMock).toHaveBeenCalledTimes(1); expect(publishJSONMock).not.toHaveBeenCalled();
    expect(storeState.job).toMatchObject({ status: "failed", errorMessage: blocked.message });
  });

  it("preserves cancellation that wins the race with an access block", async () => {
    const one = buildCandidate("candidate-1");
    seedJobState(buildJob({ candidates: [one] }), [buildWorker()], [buildCandidateWork(one.id, 0)]);
    claimNextJobCandidateMock.mockResolvedValueOnce(buildCandidateWork(one.id, 0, { status: "processing", leaseOwner: "worker-0" }));
    runCandidateAnalysisMock.mockImplementation(async () => {
      storeState.job!.status = "canceled"; throw new ProviderAccessBlockedError();
    });
    await expect(processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).resolves.toBeUndefined();
    expect(storeState.job!.status).toBe("canceled"); expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it("acknowledges the durable block even if queue cleanup fails", async () => {
    const one = buildCandidate("candidate-1");
    seedJobState(buildJob({ candidates: [one] }), [buildWorker()], [buildCandidateWork(one.id, 0)]);
    claimNextJobCandidateMock.mockResolvedValueOnce(buildCandidateWork(one.id, 0, { status: "processing", leaseOwner: "worker-0" }));
    runCandidateAnalysisMock.mockRejectedValue(new ProviderAccessBlockedError());
    clearJobCandidateQueueMock.mockRejectedValueOnce(new Error("Synthetic cleanup failure"));
    await expect(processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).resolves.toBeUndefined();
    await processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 });
    expect(storeState.job!.status).toBe("failed");
    expect(runCandidateAnalysisMock).toHaveBeenCalledTimes(1); expect(publishJSONMock).not.toHaveBeenCalled();
  });

  it.each(["transient", "uncertain-write", "exhausted"])("contains a %s terminal-state persistence failure without retrying provider work", async failureMode => {
    const one = buildCandidate("candidate-1");
    seedJobState(buildJob({ candidates: [one] }), [buildWorker()], [buildCandidateWork(one.id, 0)]);
    claimNextJobCandidateMock.mockResolvedValueOnce(buildCandidateWork(one.id, 0, { status: "processing", leaseOwner: "worker-0" }));
    const persist = updateJobMock.getMockImplementation()!;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    runCandidateAnalysisMock.mockImplementationOnce(async () => {
      if (failureMode === "exhausted") {
        updateJobMock.mockRejectedValueOnce(new Error("Synthetic persistence failure"))
          .mockRejectedValueOnce(new Error("Synthetic persistence failure"))
          .mockRejectedValueOnce(new Error("Synthetic persistence failure"));
      } else {
        updateJobMock.mockImplementationOnce(async (jobId, updates) => {
          if (failureMode === "uncertain-write") await persist(jobId, updates);
          throw new Error("Synthetic uncertain response or transient failure");
        });
      }
      throw new ProviderAccessBlockedError();
    });
    await expect(processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).resolves.toBeUndefined();
    const terminalWrites = updateJobMock.mock.calls.filter(([, updates]) => updates.status === "failed");
    expect(terminalWrites).toHaveLength(failureMode === "exhausted" ? 3 : 2);
    expect(runCandidateAnalysisMock).toHaveBeenCalledTimes(1); expect(publishJSONMock).not.toHaveBeenCalled();
    if (failureMode === "exhausted") {
      expect(storeState.job!.status).not.toBe("failed");
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Job stop unconfirmed"), "analysis-1");
    } else {
      expect(storeState.job!.status).toBe("failed");
      await processWorkerJob({ mode: "worker", jobId: "analysis-1", workerIndex: 0 });
      expect(runCandidateAnalysisMock).toHaveBeenCalledTimes(1);
    }
  });

  it("queues only a private pathname after a private upload", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    blobPutMock.mockImplementation(async (pathname: string) => ({ pathname, url: "https://example.invalid/not-for-queue" }));
    publishJSONMock.mockResolvedValue({ messageId: "msg-private" });
    const result = await createUploadAnalysis({ buffer: Buffer.from("private fixture"), filename: "fixture.png", mimeType: "image/png" });
    const body = publishJSONMock.mock.calls[0]![0].body;
    expect(body).toMatchObject({ jobId: result.analysisId, privateBlobPathname: `uploads/${result.analysisId}` });
    expect(body).not.toHaveProperty("fileBlobUrl");
    expect(body).not.toHaveProperty("fileBase64");
    expect(blobPutMock).toHaveBeenCalledWith(`uploads/${result.analysisId}`, Buffer.from("private fixture"), { access: "private", contentType: "image/png", addRandomSuffix: false });
  });

  it("preserves public upload defaults and the legacy queue URL", async () => {
    blobPutMock.mockResolvedValue({ pathname: "uploads/legacy-random", url: "https://example.invalid/legacy" });
    publishJSONMock.mockResolvedValue({ messageId: "msg-public" });
    await createUploadAnalysis({ buffer: Buffer.from("public fixture"), filename: "fixture.png" });
    expect(publishJSONMock.mock.calls[0]![0].body.fileBlobUrl).toBe("https://example.invalid/legacy");
    expect(publishJSONMock.mock.calls[0]![0].body).not.toHaveProperty("privateBlobPathname");
  });

  it("cleans up only the newly stored private object when enqueue fails", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    blobPutMock.mockImplementation(async (pathname: string) => ({ pathname, url: "https://example.invalid/not-for-queue" }));
    publishJSONMock.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(createUploadAnalysis({ buffer: Buffer.from("fixture"), filename: "fixture.png" })).rejects.toThrow("queue unavailable");
    expect(blobDelMock).toHaveBeenCalledTimes(1);
    expect(blobDelMock).toHaveBeenCalledWith(`uploads/${storeState.job!.id}`);
    expect(storeState.job?.status).toBe("failed");
  });

  it("fails an upload without publishing or cleanup when private storage itself fails", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    blobPutMock.mockRejectedValueOnce(new Error("private store unavailable"));
    await expect(createUploadAnalysis({ buffer: Buffer.from("fixture"), filename: "fixture.png" })).rejects.toThrow("private store unavailable");
    expect(publishJSONMock).not.toHaveBeenCalled();
    expect(blobDelMock).not.toHaveBeenCalled();
    expect(storeState.job?.status).toBe("failed");
  });

  it.each(["public", "private"])("processes an in-flight private upload while current new-upload mode is %s", async mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode);
    seedJobState(buildJob({ sourceType: "upload-image", sourceFilename: "fixture.png", extractedText: null, candidates: [], workerCount: 0 }), [], []);
    blobGetMock.mockResolvedValueOnce({ statusCode: 200, stream: new Response("private fixture").body });
    extractSourceTextMock.mockResolvedValueOnce("empty fixture");
    parseWineCandidatesMock.mockReturnValueOnce([]);
    const fetchMock = vi.fn(() => Promise.reject(new Error("unexpected public fetch")));
    vi.stubGlobal("fetch", fetchMock);
    await processWorkerJob({ jobId: "analysis-1", sourceType: "upload-image", sourceFilename: "fixture.png", privateBlobPathname: "uploads/analysis-1" });
    expect(blobGetMock).toHaveBeenCalledWith("uploads/analysis-1", { access: "private" });
    expect(extractSourceTextMock).toHaveBeenCalledWith(expect.objectContaining({ fileBuffer: Buffer.from("private fixture") }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeState.job?.status).toBe("completed");
  });

  it("keeps queued legacy public uploads readable after private mode activation", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    seedJobState(buildJob({ sourceType: "upload-image", sourceFilename: "fixture.png", extractedText: null, candidates: [], workerCount: 0 }), [], []);
    const fetchMock = vi.fn().mockResolvedValue(new Response("legacy fixture"));
    vi.stubGlobal("fetch", fetchMock);
    extractSourceTextMock.mockResolvedValueOnce("empty fixture");
    parseWineCandidatesMock.mockReturnValueOnce([]);
    await processWorkerJob({ jobId: "analysis-1", sourceType: "upload-image", sourceFilename: "fixture.png", fileBlobUrl: "https://example.invalid/legacy" });
    expect(fetchMock).toHaveBeenCalledWith("https://example.invalid/legacy");
    expect(blobGetMock).not.toHaveBeenCalled();
    expect(extractSourceTextMock).toHaveBeenCalledWith(expect.objectContaining({ fileBuffer: Buffer.from("legacy fixture") }));
  });

  it.each([
    { privateBlobPathname: "uploads/other-job" },
    { privateBlobPathname: "https://example.invalid/private" },
    { privateBlobPathname: "uploads/analysis-1", fileBlobUrl: "https://example.invalid/public" },
    { privateBlobPathname: "uploads/analysis-1", fileBase64: "" },
    { privateBlobPathname: "uploads/analysis-1", recognizedText: "" },
    { privateBlobPathname: "uploads/analysis-1", sourceUrl: "https://example.invalid/menu" },
    { privateBlobPathname: "uploads/analysis-1", sourceType: "url-html" },
    { privateBlobPathname: "uploads/analysis-1", jobId: "../analysis-1" },
  ])("rejects unsafe private coordinator payload %# before processing", async override => {
    const payload = { jobId: "analysis-1", sourceType: "upload-image", sourceFilename: "fixture.png", ...override };
    expect(() => parseWorkerJobPayload(payload)).toThrow();
    await expect(processWorkerJob(payload)).rejects.toThrow();
    expect(blobGetMock).not.toHaveBeenCalled();
    expect(extractSourceTextMock).not.toHaveBeenCalled();
  });

  it.each(["public", "private"])("preserves an accepted %s upload if saving its queue message ID fails", async mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode);
    blobPutMock.mockImplementation(async (pathname: string) => ({ pathname, url: "https://example.invalid/not-for-queue" }));
    publishJSONMock.mockResolvedValueOnce({ messageId: "msg-accepted" });
    updateJobMock.mockRejectedValueOnce(new Error("Redis tracking unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await createUploadAnalysis({ buffer: Buffer.from("fixture"), filename: "fixture.png" });
    expect(result).toEqual({ analysisId: storeState.job!.id, status: "queued" });
    expect(publishJSONMock).toHaveBeenCalledTimes(1);
    expect(blobDelMock).not.toHaveBeenCalled();
    expect(storeState.job?.status).toBe("queued");
    expect(updateJobMock).toHaveBeenCalledTimes(1);
    expect(updateJobMock).toHaveBeenCalledWith(result.analysisId, { queueMessageId: "msg-accepted" });
    expect(warning).toHaveBeenCalledWith("[uploads] Queue accepted; message tracking write failed", result.analysisId);
  });

  it.each(["public", "private"])("retains an uncertain-publish %s upload when terminal-state persistence also fails", async mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode);
    blobPutMock.mockImplementation(async (pathname: string) => ({ pathname, url: "https://example.invalid/not-for-queue" }));
    publishJSONMock.mockRejectedValueOnce(new Error("publish outcome unknown"));
    updateJobMock.mockRejectedValueOnce(new Error("terminal state unavailable"));
    await expect(createUploadAnalysis({ buffer: Buffer.from("fixture"), filename: "fixture.png" })).rejects.toThrow("terminal state unavailable");
    expect(blobDelMock).not.toHaveBeenCalled();
    expect(storeState.job?.status).toBe("queued");
  });

  it("keeps legacy Production payloads but rejects a Preview namespace", () => {
    expect(parseWorkerJobPayload({ mode: "worker", jobId: "analysis-1", workerIndex: 0 })).toMatchObject({ mode: "worker" });
    expect(() => parseWorkerJobPayload({ mode: "worker", jobId: "analysis-1", workerIndex: 0, deploymentNamespace: "preview:qa" })).toThrow("namespace");
  });

});
