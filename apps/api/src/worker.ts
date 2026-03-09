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
import { readAnalysisMetadata } from "./services/storage.js";

bootstrapDatabase();

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
    const metadata = await readAnalysisMetadata(analysis.id, analysis.storagePath);
    const result = await runAnalysisPipeline({
      sourceType: analysis.sourceType,
      filename: analysis.sourceFilename,
      storagePath: analysis.storagePath,
      mimeType: metadata.mimeType ?? "image/jpeg",
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
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
