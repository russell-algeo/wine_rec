import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildLayoutAwareTextFromTsv } from "./tesseract-layout.js";
import { parseWineCandidates } from "../services/parser.js";
import {
  canonicalizeText,
  findFixturePath,
  hasTesseract,
  ocrFixtureToTsv,
} from "../test-support/ocr-fixtures.js";

const execFileAsync = promisify(execFile);

function buildSyntheticTsv(words: Array<{
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height?: number;
  conf?: number;
  text: string;
}>): string {
  const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const rows = words.map((entry) =>
    [
      "5",
      "1",
      "1",
      "1",
      String(entry.line),
      String(entry.word),
      String(entry.left),
      String(entry.top),
      String(entry.width),
      String(entry.height ?? 12),
      String(entry.conf ?? 95),
      entry.text,
    ].join("\t"),
  );

  return [header, ...rows].join("\n");
}

describe("tesseract layout normalization", () => {
  it("reconstructs single bare-number price columns into menu blocks", () => {
    const tsv = buildSyntheticTsv([
      { line: 1, word: 1, left: 12, top: 12, width: 54, text: "karatta" },
      { line: 1, word: 2, left: 72, top: 12, width: 58, text: "'griffin'" },
      { line: 1, word: 3, left: 138, top: 12, width: 40, text: "shiraz" },
      { line: 1, word: 4, left: 208, top: 12, width: 20, text: "75" },
      { line: 2, word: 1, left: 12, top: 46, width: 60, text: "heinrich" },
      { line: 2, word: 2, left: 82, top: 46, width: 44, text: "'naked" },
      { line: 2, word: 3, left: 132, top: 46, width: 38, text: "white'" },
      { line: 2, word: 4, left: 208, top: 46, width: 20, text: "72" },
    ]);

    const normalized = buildLayoutAwareTextFromTsv(tsv);
    const candidates = parseWineCandidates(normalized);

    expect(normalized).toContain("karatta 'griffin' shiraz 75");
    expect(normalized).toContain("heinrich 'naked white' 72");
    expect(candidates.map((candidate) => candidate.price)).toEqual(["$75", "$72"]);
  });

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

  integration("preserves photographed sectioned menus as readable plain text", async () => {
    const imagePath = await findFixturePath("Screenshot 2026-03-08 at 10.48.03");
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "-l", "eng", "--psm", "6", "tsv"],
      { encoding: "utf8", maxBuffer: 20_000_000 },
    );

    const normalized = buildLayoutAwareTextFromTsv(stdout);
    const candidates = parseWineCandidates(normalized);
    const normalizedNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));

    expect(normalized).toContain("Martin Texier");
    expect(normalized).toContain("Stéphane Coquillette");
    expect(normalized).toContain("Sake");
    expect(candidates).toHaveLength(16);
    expect(normalizedNames).toContain(canonicalizeText("Martin Texier Petite Nature Rhône France 2023"));
    expect(normalizedNames).toContain(canonicalizeText("Melville Syrah Sta Rita Hills California 2021"));
    expect(normalizedNames).toContain(canonicalizeText("Ota Shuzo Dokan Umeshu Shiga Japan"));
  }, 15_000);
});
