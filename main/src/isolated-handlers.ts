import type { AnalysisRun, CreateAnalysisResponse } from "@wine-rec/contracts";
import type { AppHandlers } from "./app.js";
import { RequestError, getProviderHealth, getPreview } from "./api-handlers.js";
import { appConfig } from "./config.js";
import { createId } from "./id.js";
import { assertLoopbackUrl } from "./isolated-network.js";
import { parseWineCandidates } from "./services/parser.js";
import { AnalysisCanceledError, runAnalysisPipeline, runCandidateAnalysis } from "./services/pipeline.js";

/** Ephemeral local harness using the production OCR, parser and ranking code. */
export function createIsolatedHandlers(): { handlers: AppHandlers; drain: () => Promise<void> } {
  if (process.env.WINE_REC_ISOLATED !== "true" || appConfig.enableVivinoDirect
      || appConfig.providerOrder.some(name => name !== "rule-based")
      || !["tesseract-js", "tesseract", "mock"].includes(appConfig.ocrProvider)) {
    throw new Error("Use npm run dev:isolated to select local-only providers");
  }
  const runs = new Map<string, AnalysisRun>();
  const pending = new Set<Promise<void>>();
  type Hooks = Parameters<typeof runAnalysisPipeline>[1];
  type Result = Awaited<ReturnType<typeof runAnalysisPipeline>>;

  function submit(sourceType: AnalysisRun["sourceType"], sourceFilename: string,
    processInput: (hooks: Hooks) => Promise<Result>): CreateAnalysisResponse {
    if (pending.size >= 4) throw new RequestError("Four local analyses are already running", 429);
    while (runs.size >= 30) {
      const oldest = [...runs.values()].find(run => ["completed", "failed", "canceled"].includes(run.status));
      if (!oldest) break;
      runs.delete(oldest.id);
    }
    const id = createId();
    const now = new Date().toISOString();
    const run: AnalysisRun = { id, sourceType, sourceFilename, status: "queued", errorMessage: null,
      createdAt: now, updatedAt: now, extractedText: null, candidates: [], recommendations: [] };
    runs.set(id, run);
    const update = (patch: Partial<AnalysisRun>) => Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    const canceled = () => run.status === "canceled";
    let task: Promise<void>;
    task = Promise.resolve().then(async () => {
      if (canceled()) return;
      update({ status: "processing" });
      try {
        const result = await processInput({
          shouldCancel: canceled,
          onCandidatesParsed: ({ extractedText, candidates }) => { update({ extractedText, candidates }); },
          onCandidateProcessed: ({ recommendations }) => { update({ recommendations }); },
        });
        if (!canceled()) update({ ...result, status: "completed" });
      } catch (error) {
        if (!canceled()) update(error instanceof AnalysisCanceledError
          ? { status: "canceled" }
          : { status: "failed", errorMessage: error instanceof Error ? error.message : "Local analysis failed" });
      }
    }).finally(() => pending.delete(task));
    pending.add(task);
    return { analysisId: id, status: "queued" };
  }

  return {
    drain: async () => { await Promise.allSettled([...pending]); },
    handlers: {
      getProviderHealth,
      getPreview: async url => {
        try { assertLoopbackUrl(url); } catch { throw new RequestError("Serve saved HTML on localhost for isolated URL analysis", 400); }
        return getPreview(url);
      },
      getAnalysisRun: async id => structuredClone(runs.get(id) ?? null),
      cancelAnalysis: async id => {
        const run = runs.get(id);
        if (run && ["queued", "processing"].includes(run.status)) {
          Object.assign(run, { status: "canceled", updatedAt: new Date().toISOString() });
        }
        return structuredClone(run ?? null);
      },
      createUploadAnalysis: async input => {
        if (input.mimeType === "application/pdf") throw new RequestError("Local Tesseract does not support PDF uploads; use an image", 415);
        return submit("upload-image", input.filename, hooks => runAnalysisPipeline({
          sourceType: "upload-image", filename: input.filename, mimeType: input.mimeType ?? "image/jpeg",
          storagePath: "", fileBuffer: input.buffer,
        }, hooks, { browserFallback: false }));
      },
      createUrlAnalysis: async ({ url }) => {
        try { assertLoopbackUrl(url); } catch { throw new RequestError("Serve saved HTML on localhost for isolated URL analysis", 400); }
        return submit("url-html", url, hooks => runAnalysisPipeline({
          sourceType: "url-html", sourceUrl: url, filename: "menu.html", mimeType: "text/html", storagePath: "",
        }, hooks, { browserFallback: false }));
      },
      createClientOcrAnalysis: async ({ sourceFilename, recognizedText }) => {
        const extractedText = recognizedText.trim();
        if (!extractedText) throw new RequestError("Recognized text is required", 400);
        return submit("client-ocr-text", sourceFilename, async hooks => {
          const candidates = parseWineCandidates(extractedText);
          await hooks?.onCandidatesParsed?.({ extractedText, candidates });
          const { recommendations } = await runCandidateAnalysis({ candidates }, hooks);
          return { extractedText, candidates, recommendations };
        });
      },
    },
  };
}
