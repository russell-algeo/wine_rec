import { parseWineCandidates } from "../services/parser.js";

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

/** Scores OCR text by what the parser can get from it; used to pick between OCR passes. */
export function scoreExtractedTextQuality(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return Number.NEGATIVE_INFINITY;
  const candidates = parseWineCandidates(trimmed);
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const confidenceSum = candidates.reduce((sum, candidate) => sum + candidate.extractionConfidence, 0);
  const noisePenalty = lines.filter((line) => lineLooksLikeNoise(line)).length * 0.18;
  const priceSignals = countLikelyPriceSignals(trimmed) * 0.2;
  // A small tie-break favors observed section context; losing a priced wine
  // remains much more costly than losing a heading.
  const sectionCoverage = (candidates.filter((candidate) => candidate.menuSection).length / Math.max(1, candidates.length)) * 0.01;
  return confidenceSum + candidates.length * 0.35 + priceSignals + sectionCoverage - noisePenalty;
}

