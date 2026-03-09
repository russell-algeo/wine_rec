import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { appConfig } from "../config.js";
import { buildLayoutAwareTextFromTsv } from "./tesseract-layout.js";

export interface OcrProvider {
  name: string;
  isEnabled: boolean;
  detail: string;
  extractText(input: { storagePath: string; filename: string; mimeType: string }): Promise<string>;
}

const execFileAsync = promisify(execFile);

function hasTesseract(): boolean {
  const result = spawnSync("tesseract", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

class MockOcrProvider implements OcrProvider {
  name = "mock";
  isEnabled = true;
  detail = "Uses a bundled sample OCR response when no real OCR provider is configured.";

  async extractText(input: { storagePath: string; filename: string }): Promise<string> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      return fs.readFile(input.storagePath, "utf8");
    }

    const fixturePath = path.resolve(process.cwd(), "../../test/fixtures/sample-ocr.txt");
    return fs.readFile(fixturePath, "utf8");
  }
}

class OcrSpaceProvider implements OcrProvider {
  name = "ocr-space";
  isEnabled = Boolean(appConfig.ocrSpaceApiKey);
  detail = this.isEnabled
    ? "Configured with OCR.space."
    : "Missing OCR_SPACE_API_KEY; provider is disabled.";

  async extractText(input: { storagePath: string; filename: string; mimeType: string }): Promise<string> {
    if (!this.isEnabled) {
      throw new Error("OCR.space is not configured");
    }

    const bytes = await fs.readFile(input.storagePath);
    const formData = new FormData();
    formData.set("apikey", appConfig.ocrSpaceApiKey);
    formData.set("language", "eng");
    formData.set("OCREngine", "2");
    formData.set("scale", "true");
    formData.set("isOverlayRequired", "false");
    formData.set("file", new File([bytes], input.filename, { type: input.mimeType }));

    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`OCR.space request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      IsErroredOnProcessing?: boolean;
      ErrorMessage?: string[] | string;
      ParsedResults?: Array<{ ParsedText?: string }>;
    };

    if (payload.IsErroredOnProcessing) {
      const detail = Array.isArray(payload.ErrorMessage)
        ? payload.ErrorMessage.join(", ")
        : payload.ErrorMessage ?? "unknown OCR.space error";
      throw new Error(detail);
    }

    return payload.ParsedResults?.map((result) => result.ParsedText ?? "").join("\n").trim() ?? "";
  }
}

class TesseractOcrProvider implements OcrProvider {
  name = "tesseract";
  isEnabled = hasTesseract();
  detail = this.isEnabled
    ? "Uses local Tesseract OCR for image uploads."
    : "Tesseract is not installed; provider is disabled.";

  async extractText(input: { storagePath: string; filename: string; mimeType: string }): Promise<string> {
    if (!this.isEnabled) {
      throw new Error("Tesseract is not installed");
    }

    if (input.filename.toLowerCase().endsWith(".txt")) {
      return fs.readFile(input.storagePath, "utf8");
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Local Tesseract OCR currently supports image uploads, not PDFs");
    }

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wine-rec-ocr-"));
    const outputBase = path.join(outputDir, "ocr-result");

    await execFileAsync("tesseract", [input.storagePath, outputBase, "-l", "eng", "--psm", "6", "tsv"]);
    const tsv = await fs.readFile(`${outputBase}.tsv`, "utf8");
    return buildLayoutAwareTextFromTsv(tsv).trim();
  }
}

export function createOcrProvider(): OcrProvider {
  if (appConfig.ocrProvider === "tesseract") {
    return new TesseractOcrProvider();
  }
  if (appConfig.ocrProvider === "ocr-space") {
    return new OcrSpaceProvider();
  }
  return new MockOcrProvider();
}
