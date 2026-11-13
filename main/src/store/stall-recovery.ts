/**
 * Operator reconciliation for a delivery that was rejected before the worker
 * ever started (for example the Nov 11 Preview photo job whose QStash delivery
 * got HTTP 401 and went to the DLQ with no retries).
 *
 * Such a delivery cannot record its own failure, so the job stays "processing"
 * until its 24h TTL. This plans an exact compare-and-set of that one job to
 * "failed". It refuses anything that shows the worker started, anything that
 * changed since the snapshot, and any terminal job. It never replays the
 * delivery, deletes the DLQ entry, deletes the Blob, or extends the TTL.
 */
export type StallSnapshot = {
  jobRaw: string | null;
  workers: Array<{ raw: string | null }>;
  candidateWork: Array<{ raw: string | null }>;
  leaseCount: number;
  recommendationCount: number;
  progressRaw: string | null;
};

export type DlqEvidence = {
  messageId: string;
  dlqId: string;
  url: string;
  body: string | undefined;
  responseStatus: number | undefined;
} | null;

export type StallRecoveryPlan =
  | { ok: true; expectedRaw: string; nextRaw: string; summary: string }
  | { ok: false; reason: string };

export const STALLED_DELIVERY_MESSAGE =
  "This analysis could not start because its background delivery was rejected. Please try again.";

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function planStalledDeliveryRecovery(input: {
  jobId: string;
  namespace: string;
  expectedMessageId: string;
  snapshot: StallSnapshot;
  dlq: DlqEvidence;
  now: string;
}): StallRecoveryPlan {
  const { snapshot, dlq } = input;
  const job = parse(snapshot.jobRaw);
  if (!job) return { ok: false, reason: "job record is missing or unreadable" };
  if (job.id !== input.jobId) return { ok: false, reason: "job id does not match" };
  if (job.status !== "queued" && job.status !== "processing") {
    return { ok: false, reason: `job is already ${String(job.status)}` };
  }
  if (snapshot.recommendationCount > 0) return { ok: false, reason: "job already has recommendations" };
  if (snapshot.leaseCount > 0) return { ok: false, reason: "a candidate lease exists, so a worker started" };
  const progress = parse(snapshot.progressRaw);
  if (progress && (Number(progress.completedCount ?? 0) > 0 || Number(progress.failedCount ?? 0) > 0)) {
    return { ok: false, reason: "candidate progress was recorded" };
  }

  const workerCount = Number(job.workerCount ?? 0);
  if (snapshot.workers.length !== workerCount) return { ok: false, reason: "worker snapshot is incomplete" };
  const messageIds = new Set<string>();
  if (typeof job.queueMessageId === "string") messageIds.add(job.queueMessageId);
  for (const entry of snapshot.workers) {
    const worker = parse(entry.raw);
    if (!worker) return { ok: false, reason: "a worker record is missing or unreadable" };
    if (worker.status !== "queued") return { ok: false, reason: `worker ${String(worker.index)} is ${String(worker.status)}` };
    if (typeof worker.queueMessageId === "string") messageIds.add(worker.queueMessageId);
  }
  for (const entry of snapshot.candidateWork) {
    const work = parse(entry.raw);
    if (!work) return { ok: false, reason: "a candidate record is missing or unreadable" };
    if (work.status !== "queued" || Number(work.attemptCount ?? 0) !== 0 || work.leaseOwner) {
      return { ok: false, reason: `candidate ${String(work.candidateId)} was started` };
    }
  }
  if (!messageIds.has(input.expectedMessageId)) {
    return { ok: false, reason: "the expected message id is not this job's queued delivery" };
  }

  if (!dlq) return { ok: false, reason: "the delivery is not in the dead-letter queue, so it may still retry" };
  if (dlq.messageId !== input.expectedMessageId) return { ok: false, reason: "dead-letter entry is for another message" };
  let body: Record<string, unknown> | null = null;
  try { body = dlq.body ? JSON.parse(dlq.body) : null; } catch { body = null; }
  if (!body || body.jobId !== input.jobId) return { ok: false, reason: "dead-letter body is for another job" };
  if ((body.deploymentNamespace ?? "") !== input.namespace) return { ok: false, reason: "dead-letter namespace does not match" };

  const next = { ...job, status: "failed", queueMessageId: null, errorMessage: STALLED_DELIVERY_MESSAGE, updatedAt: input.now };
  return {
    ok: true,
    expectedRaw: snapshot.jobRaw!,
    nextRaw: JSON.stringify(next),
    summary: `job ${input.jobId}: ${String(job.status)} -> failed; delivery ${input.expectedMessageId} (DLQ ${dlq.dlqId}, HTTP ${dlq.responseStatus ?? "?"}) left in place`,
  };
}

/**
 * KEYS[1] = job key. ARGV[1] = exact expected raw JSON, ARGV[2] = next raw JSON.
 * The next JSON is built in TypeScript, not re-encoded by cjson, so empty
 * arrays keep their shape. The remaining TTL is preserved, never extended.
 */
export const RECONCILE_STALLED_JOB_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "missing" end
if raw ~= ARGV[1] then return "changed" end
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  redis.call("SET", KEYS[1], ARGV[2], "PX", ttl)
else
  return "no-ttl"
end
return "applied"
`;
