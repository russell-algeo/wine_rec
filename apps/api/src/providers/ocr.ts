import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { Worker as TesseractWorker } from "tesseract.js";

import { appConfig } from "../config.js";
import { buildLayoutAwareTextFromTsv } from "./tesseract-layout.js";

export interface OcrProvider {
  name: string;
  isEnabled: boolean;
  detail: string;
  extractText(input: {
    storagePath: string;
    filename: string;
    mimeType: string;
    buffer?: Buffer;
  }): Promise<string>;
}

const execFileAsync = promisify(execFile);

function hasTesseract(): boolean {
  const result = spawnSync("tesseract", ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function readInputBuffer(input: { buffer?: Buffer; storagePath: string }): Promise<Buffer> {
  if (input.buffer) {
    return input.buffer;
  }

  if (!input.storagePath) {
    throw new Error("OCR input is missing file data");
  }

  return fs.readFile(input.storagePath);
}

async function readTextInput(input: { buffer?: Buffer; storagePath: string }): Promise<string> {
  const bytes = await readInputBuffer(input);
  return Buffer.from(bytes).toString("utf8");
}

function inferTempInputExtension(filename: string, mimeType: string): string {
  const ext = path.extname(filename);
  if (ext) {
    return ext;
  }

  if (mimeType === "application/pdf") {
    return ".pdf";
  }

  if (mimeType === "text/plain") {
    return ".txt";
  }

  return ".png";
}

class MockOcrProvider implements OcrProvider {
  name = "mock";
  isEnabled = true;
  detail = "Uses a bundled sample OCR response when no real OCR provider is configured.";

  async extractText(input: { buffer?: Buffer; storagePath: string; filename: string }): Promise<string> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      return readTextInput(input);
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

  async extractText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    if (!this.isEnabled) {
      throw new Error("OCR.space is not configured");
    }

    const bytes = await readInputBuffer(input);
    const formData = new FormData();
    const fileBytes = new Uint8Array(bytes);
    formData.set("apikey", appConfig.ocrSpaceApiKey);
    formData.set("language", "eng");
    formData.set("OCREngine", "2");
    formData.set("scale", "true");
    formData.set("isOverlayRequired", "false");
    formData.set("file", new File([fileBytes], input.filename, { type: input.mimeType }));

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

  async extractText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    if (!this.isEnabled) {
      throw new Error("Tesseract is not installed");
    }

    if (input.filename.toLowerCase().endsWith(".txt")) {
      return readTextInput(input);
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Local Tesseract OCR currently supports image uploads, not PDFs");
    }

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wine-rec-ocr-"));
    const outputBase = path.join(outputDir, "ocr-result");
    const inputPath = input.buffer
      ? path.join(outputDir, `ocr-input${inferTempInputExtension(input.filename, input.mimeType)}`)
      : input.storagePath;

    try {
      if (input.buffer) {
        await fs.writeFile(inputPath, input.buffer);
      }

      await execFileAsync("tesseract", [inputPath, outputBase, "-l", "eng", "--psm", "6", "tsv"]);
      const tsv = await fs.readFile(`${outputBase}.tsv`, "utf8");
      return buildLayoutAwareTextFromTsv(tsv).trim();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => null);
    }
  }
}

// Module-level singleton — persists across warm invocations in the same container.
// Initialization costs ~1–3 s (WASM load + language model); paid at most once per container.
let _tesseractJsWorker: TesseractWorker | null = null;

async function getTesseractJsWorker(): Promise<TesseractWorker> {
  if (_tesseractJsWorker) return _tesseractJsWorker;

  const { createWorker } = await import("tesseract.js");
  const base = process.cwd(); // '/var/task' on Vercel — never use __dirname here

  _tesseractJsWorker = await createWorker("eng", 1, {
    corePath: path.join(base, "node_modules/tesseract.js-core"),
    workerPath: path.join(base, "node_modules/tesseract.js/src/worker-script/node/index.js"),
    langPath: path.join(base, "tessdata"),
    gzip: false,
    cacheMethod: "none",
    workerBlobURL: false,
  });

  return _tesseractJsWorker;
}

class TesseractJsOcrProvider implements OcrProvider {
  name = "tesseract-js";
  isEnabled = true;
  detail = "Uses Tesseract.js (WASM) for image uploads. No external API dependency.";

  async extractText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      return readTextInput(input);
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Tesseract.js OCR currently supports image uploads, not PDFs");
    }

    const bytes = await readInputBuffer(input);
    const worker = await getTesseractJsWorker();
    const { data } = await worker.recognize(bytes, {}, { tsv: true });
    return buildLayoutAwareTextFromTsv(data.tsv ?? "").trim();
  }
}

export function createOcrProvider(): OcrProvider {
  if (appConfig.ocrProvider === "tesseract-js") {
    return new TesseractJsOcrProvider();
  }
  if (appConfig.ocrProvider === "tesseract") {
    return new TesseractOcrProvider();
  }
  if (appConfig.ocrProvider === "ocr-space") {
    return new OcrSpaceProvider();
  }
  return new MockOcrProvider();
}
