import type { AnalysisRun, AnalysisStatus, Recommendation, UserTastePreference } from "@wine-rec/contracts";
import { nanoid } from "nanoid";

import { defaultPreference } from "@wine-rec/core";

import { sqlite } from "../db/client.js";
import { bootstrapDatabase } from "../db/bootstrap.js";

bootstrapDatabase();

type AnalysisRow = {
  id: string;
  source_type: string;
  source_filename: string;
  storage_path: string;
  status: string;
  error_message: string | null;
  extracted_text: string | null;
  candidates_json: string;
  recommendations_json: string;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function serializeWeights(weight: number): number {
  return Math.round(weight * 1000);
}

function deserializeWeights(weight: number): number {
  return weight / 1000;
}

function rowToAnalysis(row: AnalysisRow): AnalysisRun {
  return {
    id: row.id,
    sourceType: row.source_type as AnalysisRun["sourceType"],
    sourceFilename: row.source_filename,
    status: row.status as AnalysisStatus,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    extractedText: row.extracted_text,
    candidates: parseJson(row.candidates_json),
    recommendations: parseJson(row.recommendations_json),
  };
}

export async function createAnalysis(input: {
  sourceType: AnalysisRun["sourceType"];
  sourceFilename: string;
  storagePath: string;
}): Promise<AnalysisRun> {
  const id = nanoid();
  sqlite
    .prepare(
      `
        INSERT INTO analyses (
          id, source_type, source_filename, storage_path, status, candidates_json, recommendations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(id, input.sourceType, input.sourceFilename, input.storagePath, "uploaded", "[]", "[]");

  const row = sqlite.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as AnalysisRow | undefined;

  if (!row) {
    throw new Error("Failed to create analysis");
  }

  return rowToAnalysis(row);
}

export async function getAnalysisById(id: string): Promise<(AnalysisRun & { storagePath: string }) | null> {
  const row = sqlite.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as AnalysisRow | undefined;
  if (!row) return null;
  return {
    ...rowToAnalysis(row),
    storagePath: row.storage_path,
  };
}

export async function updateAnalysisStoragePath(id: string, storagePath: string): Promise<void> {
  sqlite
    .prepare("UPDATE analyses SET storage_path = ?, updated_at = ? WHERE id = ?")
    .run(storagePath, new Date().toISOString(), id);
}

export async function queueAnalysis(id: string): Promise<void> {
  const existingJob = sqlite
    .prepare("SELECT id FROM jobs WHERE analysis_id = ? AND status IN ('queued', 'processing') LIMIT 1")
    .get(id);

  if (existingJob) return;

  sqlite
    .prepare("INSERT INTO jobs (id, analysis_id, status) VALUES (?, ?, ?)")
    .run(nanoid(), id, "queued");

  sqlite
    .prepare("UPDATE analyses SET status = ?, updated_at = ? WHERE id = ?")
    .run("queued", new Date().toISOString(), id);
}

export async function fetchQueuedJobs(): Promise<Array<{ id: string; analysisId: string }>> {
  const rows = sqlite
    .prepare("SELECT id, analysis_id FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 10")
    .all("queued") as Array<{ id: string; analysis_id: string }>;

  return rows.map((row) => ({ id: row.id, analysisId: row.analysis_id }));
}

export async function markJobProcessing(jobId: string, analysisId: string): Promise<void> {
  sqlite
    .prepare("UPDATE jobs SET status = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?")
    .run("processing", new Date().toISOString(), jobId);

  sqlite
    .prepare("UPDATE analyses SET status = ?, updated_at = ?, error_message = NULL WHERE id = ?")
    .run("processing", new Date().toISOString(), analysisId);
}

export async function completeAnalysis(input: {
  analysisId: string;
  extractedText: string;
  candidatesJson: string;
  recommendationsJson: string;
}): Promise<void> {
  sqlite
    .prepare(
      `
        UPDATE analyses
        SET status = ?, extracted_text = ?, candidates_json = ?, recommendations_json = ?, updated_at = ?, error_message = NULL
        WHERE id = ?
      `,
    )
    .run(
      "completed",
      input.extractedText,
      input.candidatesJson,
      input.recommendationsJson,
      new Date().toISOString(),
      input.analysisId,
    );

  sqlite
    .prepare("UPDATE jobs SET status = ?, updated_at = ?, last_error = NULL WHERE analysis_id = ?")
    .run("completed", new Date().toISOString(), input.analysisId);
}

export async function failAnalysis(input: {
  analysisId: string;
  jobId: string;
  error: string;
}): Promise<void> {
  sqlite
    .prepare("UPDATE analyses SET status = ?, updated_at = ?, error_message = ? WHERE id = ?")
    .run("failed", new Date().toISOString(), input.error, input.analysisId);

  sqlite
    .prepare("UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run("failed", input.error, new Date().toISOString(), input.jobId);
}

export async function getPreferences(): Promise<UserTastePreference> {
  const row = sqlite
    .prepare("SELECT * FROM preferences WHERE id = ?")
    .get("default") as
    | {
        id: string;
        body: number;
        acidity: number;
        tannin: number;
        sweetness: number;
        weight_body: number;
        weight_acidity: number;
        weight_tannin: number;
        weight_sweetness: number;
      }
    | undefined;

  if (!row) {
    return defaultPreference();
  }

  return {
      body: row.body,
      acidity: row.acidity,
      tannin: row.tannin,
      sweetness: row.sweetness,
      weights: {
        body: deserializeWeights(row.weight_body),
        acidity: deserializeWeights(row.weight_acidity),
        tannin: deserializeWeights(row.weight_tannin),
        sweetness: deserializeWeights(row.weight_sweetness),
      },
  };
}

export async function putPreferences(preferences: UserTastePreference): Promise<UserTastePreference> {
  const existing = sqlite.prepare("SELECT id FROM preferences WHERE id = ?").get("default");

  const payload = {
    id: "default",
    body: preferences.body,
    acidity: preferences.acidity,
    tannin: preferences.tannin,
    sweetness: preferences.sweetness,
    weightBody: serializeWeights(preferences.weights.body),
    weightAcidity: serializeWeights(preferences.weights.acidity),
    weightTannin: serializeWeights(preferences.weights.tannin),
    weightSweetness: serializeWeights(preferences.weights.sweetness),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    sqlite
      .prepare(
        `
          UPDATE preferences
          SET body = ?, acidity = ?, tannin = ?, sweetness = ?, weight_body = ?, weight_acidity = ?, weight_tannin = ?, weight_sweetness = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        payload.body,
        payload.acidity,
        payload.tannin,
        payload.sweetness,
        payload.weightBody,
        payload.weightAcidity,
        payload.weightTannin,
        payload.weightSweetness,
        payload.updatedAt,
        payload.id,
      );
  } else {
    sqlite
      .prepare(
        `
          INSERT INTO preferences (
            id, body, acidity, tannin, sweetness, weight_body, weight_acidity, weight_tannin, weight_sweetness, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        payload.id,
        payload.body,
        payload.acidity,
        payload.tannin,
        payload.sweetness,
        payload.weightBody,
        payload.weightAcidity,
        payload.weightTannin,
        payload.weightSweetness,
        payload.updatedAt,
      );
  }

  return preferences;
}

export async function updateRecommendations(
  analysisId: string,
  recommendations: Recommendation[],
): Promise<void> {
  sqlite
    .prepare("UPDATE analyses SET recommendations_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(recommendations), new Date().toISOString(), analysisId);
}
