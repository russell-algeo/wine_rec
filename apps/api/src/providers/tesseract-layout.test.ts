import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildLayoutAwareTextFromTsv } from "./tesseract-layout.js";
import { parseWineCandidates } from "../services/parser.js";
import { canonicalizeText, hasTesseract, ocrFixtureToTsv } from "../test-support/ocr-fixtures.js";

const execFileAsync = promisify(execFile);

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

  integration("preserves row-based menu screenshots instead of exploding them into fake columns", async () => {
    const imagePath = path.resolve(process.cwd(), "../../apps/web/public/images/RENEFAkn5FlzzGhhpc_QL.png");
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "-l", "eng", "--psm", "6", "tsv"],
      { encoding: "utf8", maxBuffer: 20_000_000 },
    );

    const normalized = buildLayoutAwareTextFromTsv(stdout);
    const candidates = parseWineCandidates(normalized);
    const normalizedNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));

    expect(normalized).toContain("Bianchi Chardonnay, Central Coast: $14 / $27 / $49");
    expect(normalized).toContain("Sparkling (Split/Bottle)");
    expect(candidates).toHaveLength(20);
    expect(normalizedNames).toContain(canonicalizeText("Bianchi Chardonnay, Central Coast"));
    expect(normalizedNames).toContain(canonicalizeText("Paraduxx Proprietary Red, Napa Valley"));
    expect(normalizedNames).toContain(canonicalizeText("Mionetto Prosecco, Italy"));
  }, 15_000);
});
