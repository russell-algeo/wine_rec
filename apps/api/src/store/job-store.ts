import type { AnalysisRun, Recommendation, WineCandidate } from "@wine-rec/contracts";

import { redis } from "./redis-client.js";

const JOB_TTL_SECONDS = 60 * 60 * 24;

export const JOB_CANDIDATE_LEASE_DURATION_MS = 75_000;

type CandidateIdentity = Pick<WineCandidate, "id">;

export type JobRecord = {
  id: string;
  sourceType: AnalysisRun["sourceType"];
  sourceFilename: string;
  status: AnalysisRun["status"];
  queueMessageId: string | null;
  errorMessage: string | null;
  extractedText: string | null;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
  workerCount: number;
  createdAt: string;
  updatedAt: string;
};

export type JobWorkerRecord = {
  jobId: string;
  index: number;
  status: AnalysisRun["status"];
  queueMessageId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobCandidateWorkRecord = {
  jobId: string;
  candidateId: string;
  index: number;
  status: AnalysisRun["status"];
  recommendation: Recommendation | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function getJobKey(jobId: string): string {
  return `job:${jobId}`;
}

function getJobWorkerKey(jobId: string, workerIndex: number): string {
  return `job:${jobId}:worker:${workerIndex}`;
}

function getJobCandidateWorkKey(jobId: string, candidateId: string): string {
  return `job:${jobId}:candidate:${candidateId}`;
}

function getJobCandidateQueueKey(jobId: string): string {
  return `job:${jobId}:candidate-queue`;
}

function getJobCandidateLeaseKey(jobId: string): string {
  return `job:${jobId}:candidate-leases`;
}

function getJobRecommendationsKey(jobId: string): string {
  return `job:${jobId}:recommendations`;
}

async function setJson(key: string, value: unknown): Promise<void> {
  await redis.set(key, JSON.stringify(value), { ex: JOB_TTL_SECONDS });
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get<string>(key);
  if (!raw) {
    return null;
  }

  return typeof raw === "string" ? JSON.parse(raw) as T : raw as unknown as T;
}

async function getStoredJob(jobId: string): Promise<JobRecord | null> {
  return getJson<JobRecord>(getJobKey(jobId));
}

async function getJobRecommendations(jobId: string): Promise<Recommendation[]> {
  const items = await redis.lrange(getJobRecommendationsKey(jobId), 0, -1);
  return items.map((item) =>
    typeof item === "string" ? (JSON.parse(item) as Recommendation) : (item as unknown as Recommendation),
  );
}

export async function appendJobRecommendation(jobId: string, recommendation: Recommendation): Promise<void> {
  await redis.rpush(getJobRecommendationsKey(jobId), JSON.stringify(recommendation));
  await redis.expire(getJobRecommendationsKey(jobId), JOB_TTL_SECONDS);
}

const claimNextJobCandidateScript = redis.createScript<string | false>(`
local queueKey = KEYS[1]
local leaseKey = KEYS[2]
local candidateKeyPrefix = ARGV[1]
local leaseOwner = ARGV[2]
local nowMs = tonumber(ARGV[3])
local leaseDurationMs = tonumber(ARGV[4])
local nowIso = ARGV[5]
local ttlSeconds = tonumber(ARGV[6])

local function claim(candidateId)
  local candidateKey = candidateKeyPrefix .. candidateId
  local raw = redis.call("GET", candidateKey)
  if not raw then
    redis.call("ZREM", leaseKey, candidateId)
    return nil
  end

  local record = cjson.decode(raw)
  if record.status == "completed" or record.status == "failed" or record.status == "canceled" then
    redis.call("ZREM", leaseKey, candidateId)
    return nil
  end

  local leaseExpiresMs = nowMs + leaseDurationMs
  record.status = "processing"
  record.leaseOwner = leaseOwner
  record.leaseExpiresAt = tostring(leaseExpiresMs)
  record.errorMessage = cjson.null
  record.attemptCount = (record.attemptCount or 0) + 1
  record.updatedAt = nowIso

  redis.call("SET", candidateKey, cjson.encode(record), "EX", ttlSeconds)
  redis.call("ZADD", leaseKey, leaseExpiresMs, candidateId)
  redis.call("EXPIRE", leaseKey, ttlSeconds)

  return candidateId
end

local leasedCandidateIds = redis.call("ZRANGE", leaseKey, 0, -1)
for index = 1, #leasedCandidateIds do
  local candidateId = leasedCandidateIds[index]
  local raw = redis.call("GET", candidateKeyPrefix .. candidateId)
  if raw then
    local record = cjson.decode(raw)
    if type(record.leaseOwner) == "string" and record.leaseOwner == leaseOwner and record.status == "processing" then
      return claim(candidateId)
    end
  else
    redis.call("ZREM", leaseKey, candidateId)
  end
end

while true do
  local candidateId = nil
  local expired = redis.call("ZRANGEBYSCORE", leaseKey, "-inf", nowMs, "LIMIT", 0, 1)
  if #expired > 0 then
    candidateId = expired[1]
  else
    candidateId = redis.call("LPOP", queueKey)
  end

  if not candidateId then
    return false
  end

  local claimed = claim(candidateId)
  if claimed then
    return claimed
  end
end
`);

const completeJobCandidateScript = redis.createScript<number>(`
local leaseKey = KEYS[1]
local candidateKey = KEYS[2]
local leaseOwner = ARGV[1]
local recommendationJson = ARGV[2]
local nowIso = ARGV[3]
local ttlSeconds = tonumber(ARGV[4])

local raw = redis.call("GET", candidateKey)
if not raw then
  return 0
end

local record = cjson.decode(raw)
if type(record.leaseOwner) ~= "string" or record.leaseOwner ~= leaseOwner then
  return 0
end

record.status = "completed"
record.recommendation = cjson.decode(recommendationJson)
record.leaseOwner = cjson.null
record.leaseExpiresAt = cjson.null
record.errorMessage = cjson.null
record.updatedAt = nowIso

redis.call("SET", candidateKey, cjson.encode(record), "EX", ttlSeconds)
redis.call("ZREM", leaseKey, record.candidateId)
redis.call("EXPIRE", leaseKey, ttlSeconds)

return 1
`);

const requeueJobCandidateScript = redis.createScript<number>(`
local queueKey = KEYS[1]
local leaseKey = KEYS[2]
local candidateKey = KEYS[3]
local leaseOwner = ARGV[1]
local errorMessage = ARGV[2]
local nowIso = ARGV[3]
local ttlSeconds = tonumber(ARGV[4])

local raw = redis.call("GET", candidateKey)
if not raw then
  return 0
end

local record = cjson.decode(raw)
if type(record.leaseOwner) ~= "string" or record.leaseOwner ~= leaseOwner then
  return 0
end

record.status = "queued"
record.leaseOwner = cjson.null
record.leaseExpiresAt = cjson.null
record.errorMessage = errorMessage ~= "" and errorMessage or cjson.null
record.updatedAt = nowIso

redis.call("SET", candidateKey, cjson.encode(record), "EX", ttlSeconds)
redis.call("ZREM", leaseKey, record.candidateId)
redis.call("RPUSH", queueKey, record.candidateId)
redis.call("EXPIRE", queueKey, ttlSeconds)
redis.call("EXPIRE", leaseKey, ttlSeconds)

return 1
`);

const failJobCandidateScript = redis.createScript<number>(`
local leaseKey = KEYS[1]
local candidateKey = KEYS[2]
local leaseOwner = ARGV[1]
local errorMessage = ARGV[2]
local nowIso = ARGV[3]
local ttlSeconds = tonumber(ARGV[4])

local raw = redis.call("GET", candidateKey)
if not raw then
  return 0
end

local record = cjson.decode(raw)
if type(record.leaseOwner) ~= "string" or record.leaseOwner ~= leaseOwner then
  return 0
end

record.status = "failed"
record.leaseOwner = cjson.null
record.leaseExpiresAt = cjson.null
record.errorMessage = errorMessage
record.updatedAt = nowIso

redis.call("SET", candidateKey, cjson.encode(record), "EX", ttlSeconds)
redis.call("ZREM", leaseKey, record.candidateId)
redis.call("EXPIRE", leaseKey, ttlSeconds)

return 1
`);

export async function createJob(input: {
  id: string;
  sourceType: AnalysisRun["sourceType"];
  sourceFilename: string;
}): Promise<JobRecord> {
  const now = new Date().toISOString();
  const record: JobRecord = {
    id: input.id,
    sourceType: input.sourceType,
    sourceFilename: input.sourceFilename,
    status: "queued",
    queueMessageId: null,
    errorMessage: null,
    extractedText: null,
    candidates: [],
    recommendations: [],
    workerCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await setJson(getJobKey(input.id), record);
  return record;
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const record = await getStoredJob(jobId);
  if (!record) {
    return null;
  }

  const recommendations = await getJobRecommendations(jobId);

  return {
    ...record,
    recommendations,
  };
}

export async function updateJob(jobId: string, updates: Partial<JobRecord>): Promise<void> {
  const existing = await getStoredJob(jobId);
  if (!existing) {
    return;
  }

  const updated: JobRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await setJson(getJobKey(jobId), updated);
}

export async function updateJobStatus(
  jobId: string,
  status: JobRecord["status"],
  updates: Partial<JobRecord> = {},
): Promise<void> {
  await updateJob(jobId, {
    ...updates,
    status,
  });
}

export async function updateJobRecommendations(
  jobId: string,
  recommendations: Recommendation[],
): Promise<void> {
  await updateJob(jobId, { recommendations });
}

export async function createJobWorkers(
  jobId: string,
  workerCount: number,
): Promise<JobWorkerRecord[]> {
  const now = new Date().toISOString();
  const records = Array.from({ length: Math.max(0, workerCount) }, (_, index) => ({
    jobId,
    index,
    status: "queued" as const,
    queueMessageId: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  }));

  await Promise.all(records.map((record) => setJson(getJobWorkerKey(jobId, record.index), record)));
  await updateJob(jobId, { workerCount: records.length });

  return records;
}

export async function getJobWorker(
  jobId: string,
  workerIndex: number,
): Promise<JobWorkerRecord | null> {
  return getJson<JobWorkerRecord>(getJobWorkerKey(jobId, workerIndex));
}

export async function listJobWorkers(
  jobId: string,
  workerCount?: number,
): Promise<JobWorkerRecord[]> {
  const resolvedWorkerCount = workerCount ?? (await getStoredJob(jobId))?.workerCount ?? 0;
  if (resolvedWorkerCount <= 0) {
    return [];
  }

  const workers = await Promise.all(
    Array.from({ length: resolvedWorkerCount }, (_, index) => getJobWorker(jobId, index)),
  );

  return workers
    .filter((worker): worker is JobWorkerRecord => worker !== null)
    .sort((left, right) => left.index - right.index);
}

export async function updateJobWorker(
  jobId: string,
  workerIndex: number,
  updates: Partial<JobWorkerRecord>,
): Promise<void> {
  const existing = await getJobWorker(jobId, workerIndex);
  if (!existing) {
    return;
  }

  const updated: JobWorkerRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await setJson(getJobWorkerKey(jobId, workerIndex), updated);
}

export async function createJobCandidateWork(
  jobId: string,
  candidates: WineCandidate[],
): Promise<JobCandidateWorkRecord[]> {
  const now = new Date().toISOString();
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

  const queueKey = getJobCandidateQueueKey(jobId);
  const leaseKey = getJobCandidateLeaseKey(jobId);

  await redis.del(queueKey, leaseKey, getJobRecommendationsKey(jobId));
  await Promise.all(records.map((record) => setJson(getJobCandidateWorkKey(jobId, record.candidateId), record)));

  if (records.length > 0) {
    await redis.rpush(queueKey, ...records.map((record) => record.candidateId));
    await redis.expire(queueKey, JOB_TTL_SECONDS);
  }

  return records;
}

export async function getJobCandidateWork(
  jobId: string,
  candidateId: string,
): Promise<JobCandidateWorkRecord | null> {
  return getJson<JobCandidateWorkRecord>(getJobCandidateWorkKey(jobId, candidateId));
}

export async function listJobCandidateWork(
  jobId: string,
  candidates?: CandidateIdentity[],
): Promise<JobCandidateWorkRecord[]> {
  const resolvedCandidates = candidates ?? (await getStoredJob(jobId))?.candidates ?? [];
  if (resolvedCandidates.length === 0) {
    return [];
  }

  const records = await Promise.all(
    resolvedCandidates.map((candidate) => getJobCandidateWork(jobId, candidate.id)),
  );

  return records
    .filter((record): record is JobCandidateWorkRecord => record !== null)
    .sort((left, right) => left.index - right.index);
}

export async function findJobCandidateWorkByLeaseOwner(
  jobId: string,
  leaseOwner: string,
  candidates?: CandidateIdentity[],
): Promise<JobCandidateWorkRecord | null> {
  const records = await listJobCandidateWork(jobId, candidates);
  return records.find((record) => record.status === "processing" && record.leaseOwner === leaseOwner) ?? null;
}

export async function updateJobCandidateWork(
  jobId: string,
  candidateId: string,
  updates: Partial<JobCandidateWorkRecord>,
): Promise<void> {
  const existing = await getJobCandidateWork(jobId, candidateId);
  if (!existing) {
    return;
  }

  const updated: JobCandidateWorkRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await setJson(getJobCandidateWorkKey(jobId, candidateId), updated);
}

export async function claimNextJobCandidate(
  jobId: string,
  leaseOwner: string,
  leaseDurationMs = JOB_CANDIDATE_LEASE_DURATION_MS,
): Promise<JobCandidateWorkRecord | null> {
  const now = new Date();
  const candidateId = await claimNextJobCandidateScript.exec(
    [
      getJobCandidateQueueKey(jobId),
      getJobCandidateLeaseKey(jobId),
    ],
    [
      `${getJobCandidateWorkKey(jobId, "")}`,
      leaseOwner,
      String(now.getTime()),
      String(leaseDurationMs),
      now.toISOString(),
      String(JOB_TTL_SECONDS),
    ],
  );

  if (!candidateId) {
    return null;
  }

  return getJobCandidateWork(jobId, candidateId);
}

export async function completeJobCandidate(
  jobId: string,
  candidateId: string,
  leaseOwner: string,
  recommendation: Recommendation,
): Promise<boolean> {
  const result = await completeJobCandidateScript.exec(
    [
      getJobCandidateLeaseKey(jobId),
      getJobCandidateWorkKey(jobId, candidateId),
    ],
    [
      leaseOwner,
      JSON.stringify(recommendation),
      new Date().toISOString(),
      String(JOB_TTL_SECONDS),
    ],
  );

  return result === 1;
}

export async function requeueJobCandidate(
  jobId: string,
  candidateId: string,
  leaseOwner: string,
  errorMessage: string | null = null,
): Promise<boolean> {
  const result = await requeueJobCandidateScript.exec(
    [
      getJobCandidateQueueKey(jobId),
      getJobCandidateLeaseKey(jobId),
      getJobCandidateWorkKey(jobId, candidateId),
    ],
    [
      leaseOwner,
      errorMessage ?? "",
      new Date().toISOString(),
      String(JOB_TTL_SECONDS),
    ],
  );

  return result === 1;
}

export async function failJobCandidate(
  jobId: string,
  candidateId: string,
  leaseOwner: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await failJobCandidateScript.exec(
    [
      getJobCandidateLeaseKey(jobId),
      getJobCandidateWorkKey(jobId, candidateId),
    ],
    [
      leaseOwner,
      errorMessage,
      new Date().toISOString(),
      String(JOB_TTL_SECONDS),
    ],
  );

  return result === 1;
}

export async function hasQueuedJobCandidates(jobId: string): Promise<boolean> {
  return (await redis.llen(getJobCandidateQueueKey(jobId))) > 0;
}

export async function clearJobCandidateState(jobId: string): Promise<void> {
  await redis.del(getJobCandidateQueueKey(jobId), getJobCandidateLeaseKey(jobId), getJobRecommendationsKey(jobId));
}

export async function clearJobCandidateQueue(jobId: string): Promise<void> {
  await redis.del(getJobCandidateQueueKey(jobId), getJobCandidateLeaseKey(jobId));
}
