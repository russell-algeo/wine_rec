import { describe, expect, it } from "vitest";

import { buildLayoutAwareTextFromTsv } from "./tesseract-layout.js";
import { parseWineCandidates } from "../services/parser.js";
import { canonicalizeText, hasTesseract, ocrFixtureToTsv } from "../test-support/ocr-fixtures.js";

describe("tesseract layout normalization", () => {
  const integration = hasTesseract ? it : it.skip;

  integration("reconstructs product cards from the real store-grid screenshot", async () => {
    const tsv = await ocrFixtureToTsv("Screenshot 2026-03-08 at 10.11.31");
    const normalized = buildLayoutAwareTextFromTsv(tsv);
    const candidates = parseWineCandidates(normalized);
    const normalizedNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));

    expect(candidates.length).toBe(8);
    expect(normalizedNames).toEqual([
      canonicalizeText("Domaine de la Mongestine Bob Singlar Red Wine"),
      canonicalizeText("Le Babbler Bordeaux"),
      canonicalizeText("Jelu Estate Patagonia Pinot Noir"),
      canonicalizeText("Stel + Mar Cabernet"),
      canonicalizeText("Flavia Taille Terre Sicilia Red 1L"),
      canonicalizeText("Cardedu Praja Monica di Sardegna"),
      canonicalizeText("Casa Santos Lima Vinho Regional Lisboa Bons Ventos Tinto"),
      canonicalizeText("Bellande Pinot Noir"),
    ]);
    expect(candidates[5]?.label).toBe("Praja Monica di Sardegna");
  }, 15_000);

  integration("keeps wrapped grid titles and prices together on the real store-grid screenshot", async () => {
    const tsv = await ocrFixtureToTsv("Screenshot 2026-03-08 at 10.11.31");
    const normalized = buildLayoutAwareTextFromTsv(tsv);
    const candidates = parseWineCandidates(normalized);

    expect(normalized).toContain("Domaine de la Mongestine Bob Singlar");
    expect(normalized).toContain("Red Wine");
    expect(normalized).toContain("Casa Santos Lima, Vinho Regional");
    expect(normalized).toContain("Lisboa Bons Ventos Tinto");
    expect(candidates.map((candidate) => candidate.price)).toEqual([
      "$21.99",
      "$16.99",
      "$14.99",
      "$15.99",
      "$20.99",
      "$23.99",
      "$9.99",
      "$24.99",
    ]);
  }, 15_000);
});
