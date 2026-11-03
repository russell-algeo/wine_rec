import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  bootstrapDatabaseMock,
  createAnalysisMock,
  createClientOcrAnalysisHandlerMock,
  createUploadAnalysisHandlerMock,
  createOcrProviderMock,
  createWineProfileProvidersMock,
  fetchUrlPreviewMock,
  getAnalysisByIdMock,
  getProviderCanaryMock,
  getPreferencesMock,
  putPreferencesMock,
  queueAnalysisMock,
  readAnalysisMetadataMock,
  requestAnalysisCancellationMock,
  saveUploadMock,
  saveUrlSourceMock,
  updateAnalysisStoragePathMock,
  writeAnalysisMetadataMock,
  RequestErrorMock,
} = vi.hoisted(() => ({
  bootstrapDatabaseMock: vi.fn(),
  createAnalysisMock: vi.fn(),
  createClientOcrAnalysisHandlerMock: vi.fn(),
  createUploadAnalysisHandlerMock: vi.fn(),
  createOcrProviderMock: vi.fn(),
  createWineProfileProvidersMock: vi.fn(),
  fetchUrlPreviewMock: vi.fn(),
  getAnalysisByIdMock: vi.fn(),
  getProviderCanaryMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  putPreferencesMock: vi.fn(),
  queueAnalysisMock: vi.fn(),
  readAnalysisMetadataMock: vi.fn(),
  requestAnalysisCancellationMock: vi.fn(),
  saveUploadMock: vi.fn(),
  saveUrlSourceMock: vi.fn(),
  updateAnalysisStoragePathMock: vi.fn(),
  writeAnalysisMetadataMock: vi.fn(),
  RequestErrorMock: class RequestError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "RequestError";
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("./db/bootstrap.js", () => ({
  bootstrapDatabase: bootstrapDatabaseMock,
}));

vi.mock("./providers/ocr.js", () => ({
  createOcrProvider: createOcrProviderMock,
}));

vi.mock("./providers/wine-profiles.js", () => ({
  createWineProfileProviders: createWineProfileProvidersMock,
}));

vi.mock("./services/repository.js", () => ({
  createAnalysis: createAnalysisMock,
  getAnalysisById: getAnalysisByIdMock,
  getPreferences: getPreferencesMock,
  putPreferences: putPreferencesMock,
  queueAnalysis: queueAnalysisMock,
  requestAnalysisCancellation: requestAnalysisCancellationMock,
  updateAnalysisStoragePath: updateAnalysisStoragePathMock,
}));

vi.mock("./services/storage.js", () => ({
  readAnalysisMetadata: readAnalysisMetadataMock,
  saveUpload: saveUploadMock,
  saveUrlSource: saveUrlSourceMock,
  writeAnalysisMetadata: writeAnalysisMetadataMock,
}));

vi.mock("./services/url-preview.js", () => ({
  fetchUrlPreview: fetchUrlPreviewMock,
}));

vi.mock("./api-handlers.js", () => ({
  RequestError: RequestErrorMock,
  cancelAnalysis: vi.fn(),
  createClientOcrAnalysis: createClientOcrAnalysisHandlerMock,
  createUploadAnalysis: createUploadAnalysisHandlerMock,
  createUrlAnalysis: vi.fn(),
  getAnalysisRun: vi.fn(),
  getPreview: vi.fn(),
  getProviderCanary: getProviderCanaryMock,
  getProviderHealth: vi.fn(async () => []),
}));

import { buildApp } from "./app.js";

function buildMultipartUpload(filename: string, mimeType: string, content: string): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = "----wine-rec-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(content, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  };
}

describe("app upload route", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  const originalProviderCanaryEnabled = process.env.WINE_REC_PROVIDER_CANARY_ENABLED;
  const originalProviderCanarySecret = process.env.WINE_REC_PROVIDER_CANARY_SECRET;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeEach(() => {
    vi.clearAllMocks();

    createWineProfileProvidersMock.mockReturnValue([]);
    createOcrProviderMock.mockReturnValue({
      name: "mock",
      isEnabled: true,
      detail: "Uses a bundled sample OCR response when no real OCR provider is configured.",
      extractText: vi.fn(),
    });
    delete process.env.WINE_REC_PROVIDER_CANARY_ENABLED;
    delete process.env.WINE_REC_PROVIDER_CANARY_SECRET;
    delete process.env.VERCEL_ENV;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }

    if (originalProviderCanaryEnabled === undefined) {
      delete process.env.WINE_REC_PROVIDER_CANARY_ENABLED;
    } else {
      process.env.WINE_REC_PROVIDER_CANARY_ENABLED = originalProviderCanaryEnabled;
    }

    if (originalProviderCanarySecret === undefined) {
      delete process.env.WINE_REC_PROVIDER_CANARY_SECRET;
    } else {
      process.env.WINE_REC_PROVIDER_CANARY_SECRET = originalProviderCanarySecret;
    }

    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it("rejects uploads when the configured OCR provider is disabled", async () => {
    createUploadAnalysisHandlerMock.mockRejectedValue(
      new RequestErrorMock(
        "Image and PDF uploads require OCR. Tesseract is not installed; provider is disabled. Use a wine-list URL instead or configure an available OCR provider.",
        503,
      ),
    );

    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...buildMultipartUpload("menu.png", "image/png", "fake-image-bytes"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      message:
        "Image and PDF uploads require OCR. Tesseract is not installed; provider is disabled. Use a wine-list URL instead or configure an available OCR provider.",
    });
    expect(createUploadAnalysisHandlerMock).toHaveBeenCalledTimes(1);
  });

  it("accepts uploads when the configured OCR provider is enabled", async () => {
    createUploadAnalysisHandlerMock.mockResolvedValue({
      analysisId: "analysis-1",
      status: "uploaded",
    });

    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...buildMultipartUpload("menu.png", "image/png", "fake-image-bytes"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      analysisId: "analysis-1",
      status: "uploaded",
    });
    expect(createUploadAnalysisHandlerMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      filename: "menu.png",
      mimeType: "image/png",
    });
  });

  it("accepts client OCR text submissions", async () => {
    createClientOcrAnalysisHandlerMock.mockResolvedValue({
      analysisId: "analysis-client-ocr",
      status: "queued",
    });

    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/client-ocr",
      payload: {
        sourceFilename: "camera-menu.jpg",
        recognizedText: "Domaine Test Pinot Noir 2022",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      analysisId: "analysis-client-ocr",
      status: "queued",
    });
    expect(createClientOcrAnalysisHandlerMock).toHaveBeenCalledWith({
      sourceFilename: "camera-menu.jpg",
      recognizedText: "Domaine Test Pinot Noir 2022",
    });
  });

  it("keeps the provider canary route disabled by default", async () => {
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/debug/provider-canary",
      payload: {
        mode: "dry-run",
        candidates: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(getProviderCanaryMock).not.toHaveBeenCalled();
  });

  it("requires the provider canary secret header when explicitly enabled", async () => {
    process.env.WINE_REC_PROVIDER_CANARY_ENABLED = "true";
    process.env.WINE_REC_PROVIDER_CANARY_SECRET = "test-secret";
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/debug/provider-canary",
      payload: {
        mode: "dry-run",
        candidates: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(getProviderCanaryMock).not.toHaveBeenCalled();
  });

  it("runs provider canary dry runs without recommendation-quality output", async () => {
    process.env.WINE_REC_PROVIDER_CANARY_ENABLED = "true";
    process.env.WINE_REC_PROVIDER_CANARY_SECRET = "test-secret";
    getProviderCanaryMock.mockResolvedValue({
      provider: "vivino-direct",
      mode: "dry-run",
      candidateLimit: 3,
      recommendationQualityEvaluated: false,
      summary: {
        candidateCount: 1,
        plannedQueryCount: 1,
        fetchedQueryCount: 0,
        okCount: 0,
        blockedCount: 0,
        directHitCount: 0,
      },
      candidates: [
        {
          candidateId: "candidate-1",
          query: "producer label 2021",
          status: "planned",
          bodyClass: "not-fetched",
          recordCount: 0,
          directHit: {
            accepted: false,
            matchScore: null,
            providerWineId: null,
            matchedName: null,
          },
        },
      ],
    });
    app = await buildApp();

    const payload = {
      mode: "dry-run",
      candidates: [
        {
          id: "candidate-1",
          rawText: "Producer Label 2021",
          producer: "Producer",
          label: "Label",
          vintage: 2021,
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/debug/provider-canary",
      headers: {
        "x-provider-canary-secret": "test-secret",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      mode: "dry-run",
      recommendationQualityEvaluated: false,
    }));
    expect(response.json()).not.toHaveProperty("recommendations");
    expect(getProviderCanaryMock).toHaveBeenCalledWith(payload);
  });

  it("does not allow the provider canary route in production even when enabled", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.WINE_REC_PROVIDER_CANARY_ENABLED = "true";
    process.env.WINE_REC_PROVIDER_CANARY_SECRET = "test-secret";
    app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/debug/provider-canary",
      headers: {
        "x-provider-canary-secret": "test-secret",
      },
      payload: {
        mode: "dry-run",
        candidates: [],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(getProviderCanaryMock).not.toHaveBeenCalled();
  });
});
