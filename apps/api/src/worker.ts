import fs from "node:fs/promises";
import path from "node:path";

import { bootstrapDatabase } from "./db/bootstrap.js";
import { appConfig } from "./config.js";
import {
  completeAnalysis,
  failAnalysis,
  fetchQueuedJobs,
  getAnalysisById,
  markJobProcessing,
} from "./services/repository.js";
import { runAnalysisPipeline } from "./services/pipeline.js";

bootstrapDatabase();

async function readMimeType(analysisId: string, storagePath: string): Promise<string> {
  const metadataPath = path.join(path.dirname(storagePath), `${analysisId}.meta.json`);
  const raw = await fs.readFile(metadataPath, "utf8");
  const metadata = JSON.parse(raw) as { mimeType?: string };
  return metadata.mimeType ?? "image/jpeg";
}

async function processJob(job: { id: string; analysisId: string }): Promise<void> {
  const analysis = await getAnalysisById(job.analysisId);
  if (!analysis) {
    await failAnalysis({
      analysisId: job.analysisId,
      jobId: job.id,
      error: "Analysis was not found",
    });
    return;
  }

  await markJobProcessing(job.id, job.analysisId);

  try {
    const mimeType = await readMimeType(analysis.id, analysis.storagePath);
    const result = await runAnalysisPipeline({
      filename: analysis.sourceFilename,
      storagePath: analysis.storagePath,
      mimeType,
    });

    await completeAnalysis({
      analysisId: analysis.id,
      extractedText: result.extractedText,
      candidatesJson: JSON.stringify(result.candidates),
      recommendationsJson: JSON.stringify(result.recommendations),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    await failAnalysis({
      analysisId: analysis.id,
      jobId: job.id,
      error: message,
    });
  }
}

async function poll(): Promise<void> {
  const queuedJobs = await fetchQueuedJobs();
  for (const job of queuedJobs) {
    await processJob(job);
  }
}

await poll();
setInterval(() => {
  void poll();
}, appConfig.workerPollIntervalMs);
