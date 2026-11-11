import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const job = { id: "same-job", sourceType: "upload-image", sourceFilename: "synthetic.png", status: "queued", queueMessageId: null, errorMessage: null, extractedText: "synthetic", candidates: [] as unknown[], recommendations: [], workerCount: 0, createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z" };
  return { job, publish: vi.fn(), blob: vi.fn(), remove: vi.fn(), getJobState: vi.fn(), updateJob: vi.fn(), createJob: vi.fn(), createJobCandidateWork: vi.fn(), createJobWorkers: vi.fn(), updateJobWorker: vi.fn(), getJobWorker: vi.fn(), claimNextJobCandidate: vi.fn(), hasQueuedJobCandidates: vi.fn(), runCandidateAnalysis: vi.fn() };
});
vi.mock("@upstash/qstash", () => ({ Client: class { publishJSON = mocks.publish; messages = { delete: mocks.remove }; } }));
vi.mock("./store/redis-client.js", () => ({ redis: { eval: vi.fn().mockResolvedValue(1) } }));
vi.mock("@vercel/blob", () => ({ del: mocks.remove }));
vi.mock("./services/pipeline.js", () => ({ runCandidateAnalysis: mocks.runCandidateAnalysis, AnalysisCanceledError: class extends Error {}, AnalysisRetryableError: class extends Error {} }));
vi.mock("./providers/ocr.js", () => ({ createOcrProvider: () => ({ isEnabled: true }) }));
vi.mock("./services/upload-storage.js", () => ({ storeUpload: mocks.blob, isPrivateUploadReference: () => true, readPrivateUpload: vi.fn() }));
vi.mock("./store/job-store.js", () => ({ getJobState: mocks.getJobState, updateJob: mocks.updateJob, createJob: mocks.createJob, createJobCandidateWork: mocks.createJobCandidateWork, createJobWorkers: mocks.createJobWorkers, updateJobWorker: mocks.updateJobWorker, getJobWorker: mocks.getJobWorker, claimNextJobCandidate: mocks.claimNextJobCandidate, hasQueuedJobCandidates: mocks.hasQueuedJobCandidates }));
let api: typeof import("./api-handlers.js");
beforeAll(async () => {
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("WINE_REC_NAMESPACE", "preview:qa"); vi.stubEnv("WINE_REC_PREVIEW_ROLE", "app");
  vi.stubEnv("VERCEL_URL", "wine-abc123def-team.vercel.app"); vi.stubEnv("CHUNK_WORKER_BASE_URL", "https://wine-worker-def456abc-team.vercel.app");
  vi.stubEnv("QSTASH_TOKEN", "synthetic"); vi.stubEnv("WINE_REC_ISOLATED", "true");
  vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", "6"); vi.stubEnv("WINE_REC_PREVIEW_EXPIRES_AT", new Date(Date.now() + 3600000).toISOString());
  api = await import("./api-handlers.js");
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.job.candidates = []; mocks.job.workerCount = 0;
  mocks.getJobState.mockResolvedValue(mocks.job);
  mocks.createJob.mockImplementation(async (input: object) => ({ ...mocks.job, ...input }));
  // Enforce the hosted QStash contract rather than accepting every mocked key.
  mocks.publish.mockImplementation(async (request: { flowControl?: { key: string } }) => {
    if (request.flowControl && !/^[A-Za-z0-9._-]+$/.test(request.flowControl.key)) {
      throw new Error("flowControlKey must be alphanumeric, hyphen, underscore, or period");
    }
    return { messageId: "synthetic-message" };
  });
  mocks.blob.mockImplementation(async (id: string) => ({ privateBlobPathname: `uploads/${id}` }));
  mocks.createJobWorkers.mockResolvedValue([{ index: 0 }]);
  mocks.getJobWorker.mockResolvedValue({ index: 0, status: "queued" });
  mocks.claimNextJobCandidate.mockResolvedValue(null);
  mocks.hasQueuedJobCandidates.mockResolvedValue(true);
});
afterAll(() => vi.unstubAllEnvs());
describe("Preview queue scope", () => {
  it.each([undefined, "", "preview:other", "production"])("rejects a coordinator or worker namespace mismatch before any store/blob/queue action: %s", namespace => {
    for (const mode of ["coordinator", "worker"]) {
      expect(() => api.parseWorkerJobPayload({ mode, jobId: "same-job", workerIndex: 0, sourceType: "upload-image", sourceFilename: "synthetic.png", ...(namespace === undefined ? {} : { deploymentNamespace: namespace }) })).toThrow("namespace");
    }
    expect(mocks.getJobState).not.toHaveBeenCalled(); expect(mocks.blob).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects a foreign worker invocation without reading the shared database", async () => {
    await expect(api.processWorkerJob({ mode: "worker", jobId: "same-job", workerIndex: 0, deploymentNamespace: "preview:other" })).rejects.toThrow("namespace");
    expect(mocks.getJobState).not.toHaveBeenCalled();
  });
  it.each([undefined, "preview:other"])("ignores a mismatched failure callback before touching records: %s", async namespace => {
    const sourceBody = Buffer.from(JSON.stringify({ mode: "worker", jobId: "same-job", workerIndex: 0, ...(namespace ? { deploymentNamespace: namespace } : {}) })).toString("base64");
    await api.processWorkerFailure(sourceBody);
    expect(mocks.getJobState).not.toHaveBeenCalled(); expect(mocks.updateJob).not.toHaveBeenCalled();
  });
  it("stamps Preview coordinator payload and creates a distinguishable source/job ID", async () => {
    const result = await api.createUploadAnalysis({ buffer: Buffer.from("synthetic"), filename: "synthetic.png", mimeType: "image/png" });
    expect(result.analysisId).toMatch(/^pv_qa_[A-Za-z0-9_-]+$/);
    expect(mocks.publish).toHaveBeenCalledOnce();
    const request = mocks.publish.mock.calls[0]![0];
    expect(request.url).toBe("https://wine-abc123def-team.vercel.app/api/coordinator");
    expect(request.body).toMatchObject({ deploymentNamespace: "preview:qa", jobId: result.analysisId, privateBlobPathname: `uploads/${result.analysisId}` });
    expect(request.failureCallback).toBeUndefined();
    expect(request.retries).toBe(0);
  });
  it("stamps chunk worker scope and separates flow control and failure URLs", async () => {
    mocks.job.candidates = [{ id: "candidate", rawText: "synthetic" }];
    await api.processWorkerJob({ mode: "coordinator", deploymentNamespace: "preview:qa", jobId: "same-job", sourceType: "upload-image", sourceFilename: "synthetic.png" });
    const request = mocks.publish.mock.calls[0]![0];
    expect(request.url).toBe("https://wine-worker-def456abc-team.vercel.app/api/chunk-worker");
    expect(request.body).toMatchObject({ deploymentNamespace: "preview:qa", mode: "worker", jobId: "same-job", workerIndex: 0 });
    expect(request.flowControl.key).toBe("preview.qa.analysis.same-job.worker");
    expect(mocks.updateJob).not.toHaveBeenCalledWith("same-job", expect.objectContaining({ status: "failed" }));
    expect(request.failureCallback).toBeUndefined();
    expect(request.retries).toBe(0);
    expect(request.flowControl.parallelism).toBe(1);
    expect(mocks.createJobWorkers).toHaveBeenCalledWith("same-job", 1);
  });
  it("stops at the time/handoff boundary without another publication", async () => {
    mocks.job.candidates = [{ id: "candidate", rawText: "synthetic" }];
    await api.processWorkerJob({ mode: "worker", deploymentNamespace: "preview:qa", jobId: "same-job", workerIndex: 0 });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateJob).toHaveBeenCalledWith("same-job", expect.objectContaining({ status: "failed", errorMessage: expect.stringContaining("no handoff") }));
  });
  it("ACKs worker errors only after terminal state and does not queue a retry", async () => {
    mocks.job.candidates = [{ id: "candidate", rawText: "synthetic" }];
    mocks.claimNextJobCandidate.mockResolvedValue({ candidateId: "candidate" });
    mocks.runCandidateAnalysis.mockRejectedValue(new Error("synthetic worker failure"));
    await expect(api.processWorkerJob({ mode: "worker", deploymentNamespace: "preview:qa", jobId: "same-job", workerIndex: 0 })).resolves.toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateJob).toHaveBeenCalledWith("same-job", expect.objectContaining({ status: "failed", errorMessage: "synthetic worker failure" }));
  });
  it("a legacy same-namespace failure callback cannot restart work", async () => {
    await api.processWorkerFailure(Buffer.from(JSON.stringify({ mode: "worker", deploymentNamespace: "preview:qa", jobId: "same-job", workerIndex: 0 })).toString("base64"));
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.updateJob).toHaveBeenCalledWith("same-job", expect.objectContaining({ status: "failed", errorMessage: expect.stringContaining("no retry") }));
  });

});
