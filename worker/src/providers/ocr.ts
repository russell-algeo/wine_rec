import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Worker as TesseractWorker } from "tesseract.js";

import { appConfig } from "../config.js";
import { parseWineCandidates } from "../services/parser.js";
import { prepareImageVariantsForOcr, type OcrImageVariant } from "./image-preprocessing.js";
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
const packageRequire = createRequire(import.meta.url);
const providerDir = fileURLToPath(new URL(".", import.meta.url));

type TesseractWorkerConfig = {
  corePath: string;
  workerPath: string;
  langPath: string;
  gzip: false;
  cacheMethod: "none";
  workerBlobURL: false;
};

function resolveExistingPath(candidates: string[], description: string): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve ${description}. Checked: ${candidates.join(", ")}`);
}

export function resolveTesseractJsWorkerConfig(): TesseractWorkerConfig {
  const projectRoot = path.resolve(providerDir, "..", "..");

  return {
    corePath: path.dirname(packageRequire.resolve("tesseract.js-core/package.json")),
    workerPath: packageRequire.resolve("tesseract.js/src/worker-script/node/index.js"),
    langPath: resolveExistingPath(
      [
        path.join(projectRoot, "tessdata"),
        path.join(process.cwd(), "tessdata"),
        path.join(process.cwd(), "main", "tessdata"),
      ],
      "Tesseract language data",
    ),
    gzip: false,
    cacheMethod: "none",
    workerBlobURL: false,
  };
}

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

function countLikelyPriceSignals(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(?:^|[\s:/])\$?\d{1,3}(?:\.\d{2})?\s*$/.test(line)).length;
}

function lineLooksLikeNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const alphaTokens = trimmed.match(/[A-Za-z]{2,}/g) ?? [];
  if (alphaTokens.length === 0) return true;
  const vowelishTokens = alphaTokens.filter((token) => /[aeiouy]/i.test(token));
  return alphaTokens.length >= 2 && vowelishTokens.length === 0;
}

function scoreExtractedTextQuality(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return Number.NEGATIVE_INFINITY;
  const candidates = parseWineCandidates(trimmed);
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const confidenceSum = candidates.reduce((sum, candidate) => sum + candidate.extractionConfidence, 0);
  const noisePenalty = lines.filter((line) => lineLooksLikeNoise(line)).length * 0.18;
  const priceSignals = countLikelyPriceSignals(trimmed) * 0.2;
  return confidenceSum + candidates.length * 0.35 + priceSignals - noisePenalty;
}

async function buildImageVariants(input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<OcrImageVariant[]> {
  if (input.filename.toLowerCase().endsWith(".txt") || input.mimeType === "application/pdf") {
    return [
      {
        label: "original",
        buffer: input.buffer,
        cropped: false,
        thresholded: false,
      },
    ];
  }

  return prepareImageVariantsForOcr(input.buffer);
}

class MockOcrProvider implements OcrProvider {
  name = "mock";
  isEnabled = true;
  detail = "Uses a bundled sample OCR response when no real OCR provider is configured.";

  async extractText(input: { buffer?: Buffer; storagePath: string; filename: string }): Promise<string> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      return readTextInput(input);
    }

    const fixturePath = path.resolve(process.cwd(), "../shared/test/fixtures/sample-ocr.txt");
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
    const variants = await buildImageVariants({
      buffer: bytes,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    const preferredVariant =
      variants.find((variant) => variant.cropped && !variant.thresholded) ??
      variants.find((variant) => !variant.thresholded) ??
      variants[0]!;
    const formData = new FormData();
    const fileBytes = new Uint8Array(preferredVariant.buffer);
    formData.set("apikey", appConfig.ocrSpaceApiKey);
    formData.set("language", "eng");
    formData.set("OCREngine", "2");
    formData.set("scale", "true");
    formData.set("isOverlayRequired", "false");
    formData.set("file", new File([fileBytes], input.filename.replace(/\.[^.]+$/, ".png"), { type: "image/png" }));

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

    const bytes = await readInputBuffer(input);
    const variants = await buildImageVariants({
      buffer: bytes,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wine-rec-ocr-"));

    try {
      let best:
        | {
            score: number;
            text: string;
          }
        | null = null;

      for (const [index, variant] of variants.entries()) {
        const inputPath = path.join(outputDir, `ocr-input-${index}${inferTempInputExtension(input.filename, input.mimeType)}`);
        const outputBase = path.join(outputDir, `ocr-result-${index}`);
        await fs.writeFile(inputPath, variant.buffer);
        await execFileAsync("tesseract", [inputPath, outputBase, "-l", "eng", "--psm", "6", "tsv"]);
        const tsv = await fs.readFile(`${outputBase}.tsv`, "utf8");
        const text = buildLayoutAwareTextFromTsv(tsv).trim();
        const score = scoreExtractedTextQuality(text);
        if (!best || score > best.score) {
          best = { score, text };
        }
      }

      return best?.text ?? "";
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => null);
    }
  }
}

// Worker pool — one worker per variant slot, persists across warm invocations.
// Initialization costs ~1–3 s per worker (WASM load + language model); paid at most once per container.
// Workers run independently so all variants can be recognized in parallel.
const TESSERACT_WORKER_POOL_SIZE = 4;
let _workerPoolPromise: Promise<TesseractWorker[]> | null = null;

async function getTesseractJsWorkerPool(): Promise<TesseractWorker[]> {
  if (!_workerPoolPromise) {
    const { createWorker } = await import("tesseract.js");
    const workerConfig = resolveTesseractJsWorkerConfig();

    const initStart = Date.now();
    console.log(`[ocr] initializing ${TESSERACT_WORKER_POOL_SIZE} workers`);
    _workerPoolPromise = Promise.all(
      Array.from({ length: TESSERACT_WORKER_POOL_SIZE }, () => createWorker("eng", 1, workerConfig)),
    ).then((workers) => {
      console.log(`[ocr] worker pool ready in ${Date.now() - initStart}ms`);
      return workers;
    });
  }

  return _workerPoolPromise;
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

    const t0 = Date.now();
    const bytes = await readInputBuffer(input);
    console.log(`[ocr] input read in ${Date.now() - t0}ms`);

    const t1 = Date.now();
    const variants = await buildImageVariants({
      buffer: bytes,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    console.log(`[ocr] ${variants.length} variants prepared in ${Date.now() - t1}ms`);

    const variantsToProcess = variants;

    const t2 = Date.now();
    const pool = await getTesseractJsWorkerPool();
    console.log(`[ocr] worker pool acquired in ${Date.now() - t2}ms`);

    const t3 = Date.now();
    const textResults = await Promise.all(
      variantsToProcess.map(async (variant, index) => {
        const tw = Date.now();
        const worker = pool[index % pool.length]!;
        const { data } = await worker.recognize(variant.buffer, {}, { tsv: true });
        console.log(`[ocr] variant ${index} (${variant.label}) recognized in ${Date.now() - tw}ms`);
        return buildLayoutAwareTextFromTsv(data.tsv ?? "").trim();
      }),
    );
    console.log(`[ocr] all variants recognized in ${Date.now() - t3}ms`);

    let best: { score: number; text: string } | null = null;
    for (const text of textResults) {
      const score = scoreExtractedTextQuality(text);
      if (!best || score > best.score) {
        best = { score, text };
      }
    }

    console.log(`[ocr] total extractText time: ${Date.now() - t0}ms`);
    return best?.text ?? "";
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
