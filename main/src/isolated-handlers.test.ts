import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppHandlers } from "./app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let handlers: AppHandlers;
let drain: () => Promise<void>;
beforeAll(async () => {
  vi.stubEnv("WINE_REC_ISOLATED", "true");
  vi.stubEnv("ENABLE_VIVINO_DIRECT", "false");
  vi.stubEnv("WINE_PROFILE_PROVIDER_ORDER", "rule-based");
  vi.stubEnv("OCR_PROVIDER", "tesseract-js");
  const { createIsolatedHandlers } = await import("./isolated-handlers.js");
  const { buildApp } = await import("./app.js");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
  ({ handlers, drain } = createIsolatedHandlers());
  app = await buildApp(handlers);
});
afterAll(async () => { await drain(); await app.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("isolated real pipeline", () => {
  it("completes client OCR locally and serves results with no hosted calls", async () => {
    const response = await app.inject({ method: "POST", url: "/api/client-ocr", payload: {
      sourceFilename: "labeled-menu.txt", recognizedText: "Ridge Cabernet Sauvignon 2021\n$75",
    } });
    expect(response.statusCode).toBe(200);
    await drain();
    const result = await app.inject({ method: "GET", url: `/api/analyses/${response.json().analysisId}` });
    expect(result.json()).toMatchObject({ status: "completed", candidates: [expect.objectContaining({ producer: "Ridge" })] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns 404 for missing jobs and rejects remote URL inputs", async () => {
    expect((await app.inject({ method: "GET", url: "/api/analyses/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/urls", payload: { url: "https://example.com/menu" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/preview?url=https://example.com/menu" })).statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("records extraction failures instead of fabricated completion", async () => {
    const response = await handlers.createUploadAnalysis({ buffer: Buffer.from("not an image"), filename: "bad.png", mimeType: "image/png" });
    await drain();
    expect(await handlers.getAnalysisRun(response.analysisId)).toMatchObject({ status: "failed", errorMessage: expect.any(String) });
  });
  it("cancels queued work and repeated cancel is harmless", async () => {
    const submitted = handlers.createClientOcrAnalysis({ sourceFilename: "menu.txt", recognizedText: "Ridge Cabernet Sauvignon 2021" });
    const { analysisId } = await submitted;
    const stopped = await handlers.cancelAnalysis(analysisId);
    await drain();
    expect(stopped?.status).toBe("canceled");
    expect((await handlers.cancelAnalysis(analysisId))?.status).toBe("canceled");
  });
});
