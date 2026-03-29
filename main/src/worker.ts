import { bootstrapDatabase } from "./db/bootstrap.js";
import { appConfig } from "./config.js";
import { VivinoBrowser } from "./providers/vivino-browser.js";
import {
  completeAnalysis,
  failAnalysis,
  fetchQueuedJobs,
  getAnalysisById,
  isAnalysisCancellationRequested,
  markAnalysisCanceled,
  markJobProcessing,
  saveAnalysisExtraction,
  updateRecommendations,
} from "./services/repository.js";
import { AnalysisCanceledError, runAnalysisPipeline } from "./services/pipeline.js";
import { readAnalysisMetadata } from "./services/storage.js";

bootstrapDatabase();

const activeJobIds = new Set<string>();
const activeJobTasks = new Set<Promise<void>>();
let scheduling = false;
let shuttingDown = false;

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

  if (analysis.cancellationRequested || analysis.status === "canceled") {
    await markAnalysisCanceled({
      analysisId: job.analysisId,
      jobId: job.id,
    });
    return;
  }

  const started = await markJobProcessing(job.id, job.analysisId);

  if (!started) {
    await markAnalysisCanceled({
      analysisId: job.analysisId,
      jobId: job.id,
    });
    return;
  }

  try {
    const metadata = await readAnalysisMetadata(analysis.id, analysis.storagePath);
    const result = await runAnalysisPipeline({
      sourceType: analysis.sourceType,
      filename: analysis.sourceFilename,
      storagePath: analysis.storagePath,
      mimeType: metadata.mimeType ?? "image/jpeg",
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    }, {
      shouldCancel: async () => isAnalysisCancellationRequested(analysis.id),
      onCandidatesParsed: async ({ extractedText, candidates }) => {
        await saveAnalysisExtraction({
          analysisId: analysis.id,
          extractedText,
          candidates,
        });
      },
      onCandidateProcessed: async ({ recommendations }) => {
        await updateRecommendations(analysis.id, recommendations);
      },
    });

    const completed = await completeAnalysis({
      analysisId: analysis.id,
      extractedText: result.extractedText,
      candidatesJson: JSON.stringify(result.candidates),
      recommendationsJson: JSON.stringify(result.recommendations),
    });

    if (!completed) {
      await markAnalysisCanceled({
        analysisId: analysis.id,
        jobId: job.id,
      });
    }
  } catch (error) {
    if (error instanceof AnalysisCanceledError || (await isAnalysisCancellationRequested(analysis.id))) {
      await markAnalysisCanceled({
        analysisId: analysis.id,
        jobId: job.id,
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown worker error";
    await failAnalysis({
      analysisId: analysis.id,
      jobId: job.id,
      error: message,
    });
  }
}

function startJob(job: { id: string; analysisId: string }): void {
  activeJobIds.add(job.id);

  let task: Promise<void>;
  task = processJob(job).finally(() => {
    activeJobIds.delete(job.id);
    activeJobTasks.delete(task);

    if (!shuttingDown) {
      void scheduleJobs();
    }
  });

  activeJobTasks.add(task);
}

async function scheduleJobs(): Promise<void> {
  if (scheduling || shuttingDown) {
    return;
  }

  if (activeJobIds.size >= appConfig.workerConcurrency) {
    return;
  }

  scheduling = true;

  try {
    while (!shuttingDown && activeJobIds.size < appConfig.workerConcurrency) {
      const queuedJobs = await fetchQueuedJobs();
      const nextJob = queuedJobs.find((job) => !activeJobIds.has(job.id));

      if (!nextJob) {
        return;
      }

      startJob(nextJob);
    }
  } finally {
    scheduling = false;
  }
}

await scheduleJobs();
const pollHandle = setInterval(() => {
  void scheduleJobs();
}, appConfig.workerPollIntervalMs);

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(pollHandle);
  await Promise.allSettled([...activeJobTasks]);
  await VivinoBrowser.getInstance().close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
