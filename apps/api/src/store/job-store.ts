import type { AnalysisRun, Recommendation, WineCandidate } from "@wine-rec/contracts";

import { redis } from "./redis-client.js";

const JOB_TTL_SECONDS = 60 * 60 * 24;

export type JobRecord = {
  id: string;
  sourceType: AnalysisRun["sourceType"];
  sourceFilename: string;
  status: AnalysisRun["status"];
  errorMessage: string | null;
  extractedText: string | null;
  candidates: WineCandidate[];
  recommendations: Recommendation[];
  createdAt: string;
  updatedAt: string;
};

function getJobKey(jobId: string): string {
  return `job:${jobId}`;
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
    errorMessage: null,
    extractedText: null,
    candidates: [],
    recommendations: [],
    createdAt: now,
    updatedAt: now,
  };

  await redis.set(getJobKey(input.id), JSON.stringify(record), { ex: JOB_TTL_SECONDS });
  return record;
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const raw = await redis.get<string>(getJobKey(jobId));
  if (!raw) {
    return null;
  }

  return typeof raw === "string" ? JSON.parse(raw) as JobRecord : raw as unknown as JobRecord;
}

export async function updateJob(jobId: string, updates: Partial<JobRecord>): Promise<void> {
  const existing = await getJob(jobId);
  if (!existing) {
    return;
  }

  const updated: JobRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await redis.set(getJobKey(jobId), JSON.stringify(updated), { ex: JOB_TTL_SECONDS });
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
