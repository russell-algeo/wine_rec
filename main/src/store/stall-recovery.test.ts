import { describe, expect, it } from "vitest";
import { planStalledDeliveryRecovery, type StallSnapshot } from "./stall-recovery.js";

const ns = "preview:shared";
const jobRaw = JSON.stringify({ id: "pv_shared_abc", status: "processing", queueMessageId: null, errorMessage: null, candidates: [], recommendations: [], workerCount: 1 });
const worker = (overrides: Record<string, unknown> = {}) => ({ raw: JSON.stringify({ index: 0, status: "queued", queueMessageId: "msg_1", ...overrides }) });
const work = (overrides: Record<string, unknown> = {}) => ({ raw: JSON.stringify({ candidateId: "c1", status: "queued", attemptCount: 0, leaseOwner: null, ...overrides }) });
const snapshot = (overrides: Partial<StallSnapshot> = {}): StallSnapshot => ({
  jobRaw, workers: [worker()], candidateWork: [work()], leaseCount: 0, recommendationCount: 0, progressRaw: null, ...overrides,
});
const dlq = (overrides: Record<string, unknown> = {}) => ({
  messageId: "msg_1", dlqId: "dlq_1", url: "https://worker/api/chunk-worker", responseStatus: 401,
  body: JSON.stringify({ mode: "worker", jobId: "pv_shared_abc", workerIndex: 0, deploymentNamespace: ns }), ...overrides,
});
const plan = (s = snapshot(), d: ReturnType<typeof dlq> | null = dlq()) =>
  planStalledDeliveryRecovery({ jobId: "pv_shared_abc", namespace: ns, expectedMessageId: "msg_1", snapshot: s, dlq: d, now: "2026-11-13T00:00:00Z" });

describe("stalled-delivery reconciliation plan", () => {
  it("plans an exact never-started job to failed, preserving every other field", () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expectedRaw).toBe(jobRaw);
    const next = JSON.parse(result.nextRaw);
    expect(next).toMatchObject({ status: "failed", queueMessageId: null, candidates: [], recommendations: [] });
    expect(Array.isArray(next.candidates)).toBe(true);
  });

  it.each([
    ["terminal job", snapshot({ jobRaw: jobRaw.replace("processing", "failed") }), dlq(), /already failed/],
    ["started worker", snapshot({ workers: [worker({ status: "processing" })] }), dlq(), /worker 0 is processing/],
    ["claimed candidate", snapshot({ candidateWork: [work({ attemptCount: 1 })] }), dlq(), /was started/],
    ["leased candidate", snapshot({ leaseCount: 1 }), dlq(), /lease/],
    ["recommendations", snapshot({ recommendationCount: 1 }), dlq(), /recommendations/],
    ["progress", snapshot({ progressRaw: JSON.stringify({ completedCount: 1 }) }), dlq(), /progress/],
    ["missing worker record", snapshot({ workers: [] }), dlq(), /incomplete/],
    ["not in DLQ", snapshot(), null, /may still retry/],
    ["other message in DLQ", snapshot(), dlq({ messageId: "msg_2" }), /another message/],
    ["other job in DLQ body", snapshot(), dlq({ body: JSON.stringify({ jobId: "x", deploymentNamespace: ns }) }), /another job/],
    ["other namespace", snapshot(), dlq({ body: JSON.stringify({ jobId: "pv_shared_abc" }) }), /namespace/],
    ["missing job", snapshot({ jobRaw: null }), dlq(), /missing/],
  ])("refuses a %s", (_name, s, d, reason) => {
    const result = plan(s, d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("refuses when the expected message is not this job's delivery", () => {
    const result = planStalledDeliveryRecovery({ jobId: "pv_shared_abc", namespace: ns, expectedMessageId: "msg_9", snapshot: snapshot(), dlq: dlq({ messageId: "msg_9" }), now: "x" });
    expect(result.ok).toBe(false);
  });
});
