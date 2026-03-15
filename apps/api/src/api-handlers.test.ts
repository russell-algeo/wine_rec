import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recommendation, WineCandidate } from "@wine-rec/contracts";

type MockJob = {
  id: string;
  sourceType: "url-html";
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
  extractSourceTextMock,
  storeState,
  resetStoreState,
  createJobMock,
  getJobMock,
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
  const updateJobMock = vi.fn(async (_jobId: string, updates: Partial<MockJob>) => {
    if (!state.job) {
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
        return false;
      }

      state.candidateWork.set(candidateId, {
        ...record,
        status: "completed",
        recommendation,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorMessage: null,
      });
      return true;
    },
  );

  const requeueJobCandidateMock = vi.fn();

  const failJobCandidateMock = vi.fn(
    async (_jobId: string, candidateId: string, leaseOwner: string, errorMessage: string) => {
      const record = state.candidateWork.get(candidateId);
      if (!record || record.leaseOwner !== leaseOwner) {
        return false;
      }

      state.candidateWork.set(candidateId, {
        ...record,
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorMessage,
      });
      return true;
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
    extractSourceTextMock: vi.fn(),
    storeState: state,
    resetStoreState,
    createJobMock,
    getJobMock,
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
  createJob: createJobMock,
  getJob: getJobMock,
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
import { processWorkerFailure, processWorkerJob } from "./api-handlers.js";

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
    hasQueuedJobCandidatesMock.mockImplementation(
      async () => Array.from(storeState.candidateWork.values()).some((record) => record.status === "queued"),
    );
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

    extractSourceTextMock.mockResolvedValue("Wine list");
    parseWineCandidatesMock.mockReturnValue(candidates);
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
});
