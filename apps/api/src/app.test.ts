import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  bootstrapDatabaseMock,
  createAnalysisMock,
  createOcrProviderMock,
  createWineProfileProvidersMock,
  fetchUrlPreviewMock,
  getAnalysisByIdMock,
  getPreferencesMock,
  putPreferencesMock,
  queueAnalysisMock,
  readAnalysisMetadataMock,
  requestAnalysisCancellationMock,
  saveUploadMock,
  saveUrlSourceMock,
  updateAnalysisStoragePathMock,
  writeAnalysisMetadataMock,
} = vi.hoisted(() => ({
  bootstrapDatabaseMock: vi.fn(),
  createAnalysisMock: vi.fn(),
  createOcrProviderMock: vi.fn(),
  createWineProfileProvidersMock: vi.fn(),
  fetchUrlPreviewMock: vi.fn(),
  getAnalysisByIdMock: vi.fn(),
  getPreferencesMock: vi.fn(),
  putPreferencesMock: vi.fn(),
  queueAnalysisMock: vi.fn(),
  readAnalysisMetadataMock: vi.fn(),
  requestAnalysisCancellationMock: vi.fn(),
  saveUploadMock: vi.fn(),
  saveUrlSourceMock: vi.fn(),
  updateAnalysisStoragePathMock: vi.fn(),
  writeAnalysisMetadataMock: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();

    createWineProfileProvidersMock.mockReturnValue([]);
    createOcrProviderMock.mockReturnValue({
      name: "mock",
      isEnabled: true,
      detail: "Uses a bundled sample OCR response when no real OCR provider is configured.",
      extractText: vi.fn(),
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("rejects uploads when the configured OCR provider is disabled", async () => {
    createOcrProviderMock.mockReturnValue({
      name: "tesseract",
      isEnabled: false,
      detail: "Tesseract is not installed; provider is disabled.",
      extractText: vi.fn(),
    });

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
    expect(createAnalysisMock).not.toHaveBeenCalled();
    expect(saveUploadMock).not.toHaveBeenCalled();
  });

  it("accepts uploads when the configured OCR provider is enabled", async () => {
    createAnalysisMock.mockResolvedValue({
      id: "analysis-1",
      status: "uploaded",
    });
    getAnalysisByIdMock.mockResolvedValue({
      id: "analysis-1",
      status: "uploaded",
    });
    saveUploadMock.mockResolvedValue("/tmp/menu.png");

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
    expect(createAnalysisMock).toHaveBeenCalledWith({
      sourceType: "upload-image",
      sourceFilename: "menu.png",
      storagePath: "",
    });
    expect(saveUploadMock).toHaveBeenCalledWith("analysis-1", "menu.png", expect.any(Buffer));
    expect(writeAnalysisMetadataMock).toHaveBeenCalledWith("analysis-1", "/tmp/menu.png", {
      mimeType: "image/png",
    });
    expect(updateAnalysisStoragePathMock).toHaveBeenCalledWith("analysis-1", "/tmp/menu.png");
  });
});
