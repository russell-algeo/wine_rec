import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "./vivino-browser.js";
import { compareVintageEvidence, compareGrapeEvidence, hasContradictoryGrapeIdentity } from "./wine-identity-evidence.js";
import { parseWineCandidates } from "../services/parser.js";
import { hasTesseract, ocrFixtureToText } from "../test-support/ocr-fixtures.js";

type Row = { name: string; input: string; source: string; hit: Pick<SearchHit, "wineryName" | "wineName" | "year" | "vintageText">; vintageComparison: string; grapeConflict: boolean; grapeComparison: string };
const rows = JSON.parse(readFileSync(new URL("../test-support/identity-menu-corpus.json", import.meta.url), "utf8")) as Row[];
const hit = (fields: Partial<SearchHit>): SearchHit => ({ wineId: 10, wineryName: "Example Estate", wineName: "Brut", year: null, rating: null, retailPrice: null, imageUrl: null, vintagePageUrl: "https://example.com/w/10", regionAndCountry: "", ...fields });

describe("hand-labeled parsed-menu identity corpus", () => {
  it.each(rows)("$name", row => {
    const candidates = parseWineCandidates(row.input);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(compareVintageEvidence(candidate, hit(row.hit))).toBe(row.vintageComparison);
    expect(hasContradictoryGrapeIdentity(candidate, hit(row.hit))).toBe(row.grapeConflict);
    expect(compareGrapeEvidence(candidate, hit(row.hit))).toBe(row.grapeComparison);
  });

  const integration = hasTesseract ? it : it.skip;
  integration("uses real photographed-menu OCR without inventing grapes or NV", async () => {
    // Labels were read from the actual local image, not produced by the parser:
    // Cameron Chardonnay 2023; Melville Syrah 2021; Coquillette has no stated year.
    const text = await ocrFixtureToText("Screenshot 2026-03-08 at 10.48.03");
    const candidates = parseWineCandidates(text);
    const cameron = candidates.find(row => /cameron/i.test(row.rawText))!;
    const melville = candidates.find(row => /melville/i.test(row.rawText))!;
    const coquillette = candidates.find(row => /coquillette/i.test(row.rawText))!;
    expect(cameron).toBeDefined(); expect(melville).toBeDefined(); expect(coquillette).toBeDefined();
    expect(compareVintageEvidence(cameron, hit({ wineryName: "Cameron", wineName: "Chardonnay", year: 2023 }))).toBe("exact");
    expect(hasContradictoryGrapeIdentity(cameron, hit({ wineName: "Chardonnay" }))).toBe(false);
    expect(hasContradictoryGrapeIdentity(melville, hit({ wineName: "Shiraz" }))).toBe(false);
    expect(hasContradictoryGrapeIdentity(melville, hit({ wineName: "Chardonnay" }))).toBe(true);
    expect(compareVintageEvidence(coquillette, hit({ wineName: "Inflorescence", year: 2020 }))).toBe("unconstrained");
  }, 15000);
});
