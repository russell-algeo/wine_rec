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
import { applyOcrCorrections, parseWineCandidates } from "../services/parser.js";
import {
  prepareColumnVariantsForOcr,
  prepareImageVariantsForOcr,
  preparePhotoFocusVariantsForOcr,
  shouldUsePhotoFocusOcr,
  type OcrImageVariant,
} from "./image-preprocessing.js";
import { buildLayoutAwareTextFromTsv, buildPlainTextFromTsv } from "./tesseract-layout.js";

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
  extractStructuredText?(input: {
    storagePath: string;
    filename: string;
    mimeType: string;
    buffer?: Buffer;
  }): Promise<StructuredOcrExtraction>;
}

export type OcrStructuredRowCandidate = {
  rawText: string;
  lineNumber: number;
  source: {
    variant: string | null;
    family: string | null;
    textKind: "layout" | "plain";
    windowSize: number;
    lineIndex: number;
    cropBounds?: OcrImageVariant["bounds"];
  };
};

export type StructuredOcrExtraction = {
  extractedText: string;
  rowCandidates: OcrStructuredRowCandidate[];
  rowStats: {
    rawRows: number;
    candidateRows: number;
    malformedRows: number;
    duplicateRows: number;
  };
};

type RecognizedOcrVariant = OcrImageVariant & {
  confidence: number | null;
  layoutText: string;
  plainText: string;
};

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

const structuredOcrStopTokens = new Set([
  "wine",
  "wines",
  "red",
  "white",
  "rose",
  "rosé",
  "sparkling",
  "orange",
  "champagne",
  "and",
  "the",
  "de",
  "di",
  "la",
  "le",
  "les",
  "of",
  "valley",
  "country",
  "by",
  "glass",
  "bottle",
  "carafe",
  "split",
  "menu",
  "view",
  "full",
  "download",
  "docg",
  "doc",
  "italy",
  "france",
  "california",
]);

function normalizeStructuredOcrText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’'“”"`]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function structuredIdentityTokens(value: string | null | undefined): string[] {
  return normalizeStructuredOcrText(value)
    .split(/\s+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(19|20)\d{2}$/.test(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !structuredOcrStopTokens.has(token));
}

function cleanStructuredOcrRow(value: string): string {
  return applyOcrCorrections(value)
    .replace(/\b(?:glass|bottle)\s+\$?\d+(?:\.\d{2})?/gi, "")
    .replace(/\$\d+(?:\.\d{2})?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[*•|¢>\-–—:;.,\s]+/, "")
    .replace(/[*†‡§¶#]+\s*$/g, "")
    .trim();
}

function rowQualityReason(value: string): string | null {
  const tokens = structuredIdentityTokens(value);
  if (tokens.length < 2) return "too few identity tokens";
  if (tokens.length > 12) return "too many identity/noise tokens";
  const normalizedTokens = normalizeStructuredOcrText(value).split(/\s+/).filter(Boolean);
  const numericTokens = normalizedTokens.filter((token) => /^\d+$/.test(token));
  if (numericTokens.length > tokens.length) return "price/numeric dominated";
  if (/^(?:beer|lager|ipa|cocktail|espresso|download|view full|favorite dishes|reservations|toggle navigation)\b/i.test(value)) {
    return "non-wine line";
  }
  return null;
}

function shouldRejectStructuredPreLine(value: string): boolean {
  const tokens = structuredIdentityTokens(value);
  if (tokens.length > 8) return true;
  if (tokens.length < 2) return false;

  const vowelishTokens = tokens.filter((token) => /[aeiouy]/i.test(token));
  return vowelishTokens.length / tokens.length < 0.35;
}

export function buildStructuredOcrRowsFromRecognizedVariants(
  variants: RecognizedOcrVariant[],
): StructuredOcrExtraction["rowCandidates"] & { stats?: StructuredOcrExtraction["rowStats"] } {
  const rawRows: OcrStructuredRowCandidate[] = [];

  const addRow = (
    variant: RecognizedOcrVariant,
    textKind: "layout" | "plain",
    rawText: string,
    windowSize: number,
    lineIndex: number,
  ) => {
    const cleaned = cleanStructuredOcrRow(rawText);
    if (!cleaned || !/[A-Za-z]/.test(cleaned)) return;
    rawRows.push({
      rawText: cleaned,
      lineNumber: lineIndex,
      source: {
        variant: variant.label,
        family: variant.family ?? null,
        textKind,
        windowSize,
        lineIndex,
        cropBounds: variant.bounds,
      },
    });
  };

  for (const variant of variants) {
    const text = variant.plainText;
    const lines = text
      .split(/\r?\n/)
      .map(cleanStructuredOcrRow)
      .flatMap((line) => line.split(/\s{2,}|\s+\|\s+|;\s+/))
      .map(cleanStructuredOcrRow)
      .filter((line) => line && /[A-Za-z]/.test(line))
      .filter((line) => !/^(?:\d+|na)$/i.test(line))
      .filter((line) => !/^(?:red|white|rose|rosé|sparkling|orange|champagne|wines?|by the glass)$/i.test(line))
      .filter((line) => !shouldRejectStructuredPreLine(line));

    lines.forEach((line, index) => addRow(variant, "plain", line, 1, index));
    for (let index = 0; index < lines.length - 1; index += 1) {
      const pair = `${lines[index]} ${lines[index + 1]}`;
      if (structuredIdentityTokens(pair).length <= 18) {
        addRow(variant, "plain", pair, 2, index);
      }
    }
  }

  const seen = new Set<string>();
  let malformedRows = 0;
  let duplicateRows = 0;
  const candidates: OcrStructuredRowCandidate[] = [];

  for (const row of rawRows) {
    const malformedReason = rowQualityReason(row.rawText);
    if (malformedReason) malformedRows += 1;

    const normalized = normalizeStructuredOcrText(row.rawText);
    if (!normalized || seen.has(normalized)) {
      duplicateRows += 1;
      continue;
    }
    seen.add(normalized);
    if (malformedReason) continue;

    candidates.push(row);
  }

  return Object.assign(candidates, {
    stats: {
      rawRows: rawRows.length,
      candidateRows: candidates.length,
      malformedRows,
      duplicateRows,
    },
  });
}

function chooseBestRecognizedText(variants: RecognizedOcrVariant[]): string {
  let best: { score: number; text: string } | null = null;
  for (const variant of variants) {
    for (const text of [variant.layoutText, variant.plainText]) {
      const score = scoreExtractedTextQuality(text);
      if (!best || score > best.score) {
        best = { score, text };
      }
    }
  }
  return best?.text ?? "";
}

function buildStructuredExtractionFromRecognizedVariants(variants: RecognizedOcrVariant[]): StructuredOcrExtraction {
  const rowCandidates = buildStructuredOcrRowsFromRecognizedVariants(variants);
  return {
    extractedText: chooseBestRecognizedText(variants),
    rowCandidates,
    rowStats: rowCandidates.stats ?? {
      rawRows: 0,
      candidateRows: rowCandidates.length,
      malformedRows: 0,
      duplicateRows: 0,
    },
  };
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

  const baseVariants = await prepareImageVariantsForOcr(input.buffer);
  const columnVariants = await prepareColumnVariantsForOcr(input.buffer);
  const photoFocusVariants = await shouldUsePhotoFocusOcr(input.buffer)
    ? await preparePhotoFocusVariantsForOcr(input.buffer)
    : [];
  return [...baseVariants, ...columnVariants, ...photoFocusVariants];
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
    const variants = await prepareImageVariantsForOcr(bytes);
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

    const recognized = await this.recognizeInput(input);
    return chooseBestRecognizedText(recognized);
  }

  async extractStructuredText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<StructuredOcrExtraction> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      const extractedText = await readTextInput(input);
      return {
        extractedText,
        rowCandidates: [],
        rowStats: { rawRows: 0, candidateRows: 0, malformedRows: 0, duplicateRows: 0 },
      };
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Local Tesseract OCR currently supports image uploads, not PDFs");
    }

    return buildStructuredExtractionFromRecognizedVariants(await this.recognizeInput(input));
  }

  private async recognizeInput(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<RecognizedOcrVariant[]> {
    if (!this.isEnabled) {
      throw new Error("Tesseract is not installed");
    }

    const bytes = await readInputBuffer(input);
    const variants = await buildImageVariants({
      buffer: bytes,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wine-rec-ocr-"));

    try {
      const recognized: RecognizedOcrVariant[] = [];

      for (const [index, variant] of variants.entries()) {
        const inputPath = path.join(outputDir, `ocr-input-${index}${inferTempInputExtension(input.filename, input.mimeType)}`);
        const outputBase = path.join(outputDir, `ocr-result-${index}`);
        await fs.writeFile(inputPath, variant.buffer);
        await execFileAsync("tesseract", [inputPath, outputBase, "-l", "eng", "--psm", "6", "tsv"]);
        const tsv = await fs.readFile(`${outputBase}.tsv`, "utf8");
        recognized.push({
          ...variant,
          confidence: null,
          layoutText: buildLayoutAwareTextFromTsv(tsv).trim(),
          plainText: buildPlainTextFromTsv(tsv).trim(),
        });
      }

      return recognized;
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
    const recognized = await this.recognizeInput(input);
    console.log(`[ocr] total extractText time: ${Date.now() - t0}ms`);
    return chooseBestRecognizedText(recognized);
  }

  async extractStructuredText(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<StructuredOcrExtraction> {
    if (input.filename.toLowerCase().endsWith(".txt")) {
      const extractedText = await readTextInput(input);
      return {
        extractedText,
        rowCandidates: [],
        rowStats: { rawRows: 0, candidateRows: 0, malformedRows: 0, duplicateRows: 0 },
      };
    }

    if (input.mimeType === "application/pdf") {
      throw new Error("Tesseract.js OCR currently supports image uploads, not PDFs");
    }

    const t0 = Date.now();
    const extraction = buildStructuredExtractionFromRecognizedVariants(await this.recognizeInput(input));
    console.log(
      `[ocr] structured rows: ${extraction.rowStats.candidateRows} usable (${extraction.rowStats.malformedRows} malformed, ${extraction.rowStats.duplicateRows} duplicate)`,
    );
    console.log(`[ocr] total extractStructuredText time: ${Date.now() - t0}ms`);
    return extraction;
  }

  private async recognizeInput(input: {
    buffer?: Buffer;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<RecognizedOcrVariant[]> {
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
    const recognized: RecognizedOcrVariant[] = [];
    for (let index = 0; index < variantsToProcess.length; index += pool.length) {
      const batch = variantsToProcess.slice(index, index + pool.length);
      const batchResults = await Promise.all(
        batch.map(async (variant, batchIndex) => {
          const variantIndex = index + batchIndex;
          const tw = Date.now();
          const worker = pool[batchIndex]!;
          const { data } = await worker.recognize(variant.buffer, {}, { tsv: true });
          console.log(`[ocr] variant ${variantIndex} (${variant.label}) recognized in ${Date.now() - tw}ms`);
          const tsv = data.tsv ?? "";
          return {
            ...variant,
            confidence: data.confidence ?? null,
            layoutText: buildLayoutAwareTextFromTsv(tsv).trim(),
            plainText: buildPlainTextFromTsv(tsv).trim(),
          } satisfies RecognizedOcrVariant;
        }),
      );
      recognized.push(...batchResults);
    }
    console.log(`[ocr] all variants recognized in ${Date.now() - t3}ms`);
    return recognized;
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
