import type { AnalysisRun, Recommendation, WineCandidate } from "@wine-rec/contracts";

import { redis } from "./redis-client.js";

const JOB_TTL_SECONDS = 60 * 60 * 24;

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
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type JobChunkRecord = {
  jobId: string;
  index: number;
  status: AnalysisRun["status"];
  queueMessageId: string | null;
  errorMessage: string | null;
  candidateIds: string[];
  recommendations: Recommendation[];
  createdAt: string;
  updatedAt: string;
};

function getJobKey(jobId: string): string {
  return `job:${jobId}`;
}

function getJobChunkKey(jobId: string, chunkIndex: number): string {
  return `job:${jobId}:chunk:${chunkIndex}`;
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
    chunkCount: 0,
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

  if (record.chunkCount <= 0) {
    return record;
  }

  const chunks = await listJobChunks(jobId, record.chunkCount);
  const recommendationsByCandidateId = new Map<string, Recommendation>();

  for (const chunk of chunks) {
    for (const recommendation of chunk.recommendations) {
      recommendationsByCandidateId.set(recommendation.candidateId, recommendation);
    }
  }

  const recommendations = record.candidates.length > 0
    ? record.candidates
      .map((candidate) => recommendationsByCandidateId.get(candidate.id))
      .filter((recommendation): recommendation is Recommendation => recommendation !== undefined)
    : Array.from(recommendationsByCandidateId.values());

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

export async function createJobChunks(
  jobId: string,
  candidateChunks: WineCandidate[][],
): Promise<JobChunkRecord[]> {
  const now = new Date().toISOString();
  const chunkRecords = candidateChunks.map((chunkCandidates, index) => ({
    jobId,
    index,
    status: "queued" as const,
    queueMessageId: null,
    errorMessage: null,
    candidateIds: chunkCandidates.map((candidate) => candidate.id),
    recommendations: [],
    createdAt: now,
    updatedAt: now,
  }));

  await Promise.all(
    chunkRecords.map((chunkRecord) => setJson(getJobChunkKey(jobId, chunkRecord.index), chunkRecord)),
  );
  await updateJob(jobId, { chunkCount: chunkRecords.length });

  return chunkRecords;
}

export async function getJobChunk(
  jobId: string,
  chunkIndex: number,
): Promise<JobChunkRecord | null> {
  return getJson<JobChunkRecord>(getJobChunkKey(jobId, chunkIndex));
}

export async function listJobChunks(
  jobId: string,
  chunkCount?: number,
): Promise<JobChunkRecord[]> {
  const resolvedChunkCount = chunkCount ?? (await getStoredJob(jobId))?.chunkCount ?? 0;
  if (resolvedChunkCount <= 0) {
    return [];
  }

  const chunks = await Promise.all(
    Array.from({ length: resolvedChunkCount }, (_, index) => getJobChunk(jobId, index)),
  );

  return chunks
    .filter((chunk): chunk is JobChunkRecord => chunk !== null)
    .sort((left, right) => left.index - right.index);
}

export async function updateJobChunk(
  jobId: string,
  chunkIndex: number,
  updates: Partial<JobChunkRecord>,
): Promise<void> {
  const existing = await getJobChunk(jobId, chunkIndex);
  if (!existing) {
    return;
  }

  const updated: JobChunkRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await setJson(getJobChunkKey(jobId, chunkIndex), updated);
}

export async function updateJobChunkRecommendations(
  jobId: string,
  chunkIndex: number,
  recommendations: Recommendation[],
): Promise<void> {
  await updateJobChunk(jobId, chunkIndex, { recommendations });
}
