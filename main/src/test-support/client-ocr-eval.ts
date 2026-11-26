import fs from "node:fs";
import path from "node:path";

import type { ClientOcrLayout } from "@wine-rec/contracts";
import { parseWineCandidates } from "../services/parser.js";
import { chooseClientOcrText } from "../providers/client-ocr-text.js";
import { canonicalizeText } from "./ocr-fixtures.js";

/** One case of ios/Tests/OCRFixtures/cases.json. */
export type ClientOcrCase = {
  id: string;
  image: string;
  transform?: {
    resizeWidth?: number;
    extract?: { left: number; top: number; width: number; height: number };
    rotate180WithExif?: boolean;
    jpegQuality?: number;
  };
  sameAs?: string;
  text?: string;
  expected?: { prices: string[]; names: string[]; sections?: (string | null)[] };
};

/** The JSON body the app would POST to /api/client-ocr, as VisionOCRDump writes it. */
export type ClientOcrDump = {
  sourceFilename: string;
  recognizedText: string;
  layout?: ClientOcrLayout;
  settings?: string;
  milliseconds?: number;
};

export type ReferenceWine = {
  price: string;
  name: string;
  /** undefined: not checked. null: the wine must have no section. */
  section?: string | null;
  region?: string | null;
};

export type CaseScore = {
  expected: number;
  found: number;
  matched: number;
  sectionsChecked: number;
  sectionsRight: number;
  regionsChecked: number;
  regionsRight: number;
  missing: string[];
  extras: string[];
  wrongSections: string[];
};

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const casesPath = path.join(repoRoot, "ios/Tests/OCRFixtures/cases.json");

export function loadCases(): ClientOcrCase[] {
  return (JSON.parse(fs.readFileSync(casesPath, "utf8")) as { cases: ClientOcrCase[] }).cases;
}

/** A case's image path; a path without an extension is a file-name prefix. */
export function resolveImage(image: string): string {
  const full = path.join(repoRoot, image);
  if (fs.existsSync(full)) return full;
  const dir = path.dirname(full);
  const match = fs.readdirSync(dir).find((name) => name.startsWith(path.basename(full)));
  if (!match) throw new Error(`No image matching ${image}`);
  return path.join(dir, match);
}

export function referenceFor(testCase: ClientOcrCase, cases: ClientOcrCase[]): ReferenceWine[] {
  const source = testCase.sameAs ? cases.find((other) => other.id === testCase.sameAs) : testCase;
  if (!source) throw new Error(`Unknown sameAs ${testCase.sameAs}`);
  if (source.expected) {
    return source.expected.prices.map((price, index) => ({
      price,
      name: source.expected!.names[index]!,
      ...(source.expected!.sections ? { section: source.expected!.sections[index] ?? null } : {}),
    }));
  }
  if (!source.text) throw new Error(`Case ${source.id} has no reference`);
  const clean = fs.readFileSync(path.join(repoRoot, source.text), "utf8");
  return parseWineCandidates(clean).map((candidate) => ({
    price: candidate.price ?? "",
    name: candidate.producer ?? candidate.rawText.split(/\s+/).slice(0, 2).join(" "),
    section: candidate.menuSection ?? null,
    region: candidate.region ?? null,
  }));
}

type Parsed = ReturnType<typeof parseWineCandidates>[number];

/** Matches parsed wines to the reference by price and name, in list order. */
export function scoreCandidates(candidates: Parsed[], reference: ReferenceWine[]): CaseScore {
  const used = new Set<number>();
  const score: CaseScore = {
    expected: reference.length,
    found: candidates.length,
    matched: 0,
    sectionsChecked: 0,
    sectionsRight: 0,
    regionsChecked: 0,
    regionsRight: 0,
    missing: [],
    extras: [],
    wrongSections: [],
  };
  for (const wine of reference) {
    const name = canonicalizeText(wine.name);
    const index = candidates.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) &&
        candidate.price === wine.price &&
        canonicalizeText(candidate.rawText).includes(name),
    );
    if (index < 0) {
      score.missing.push(`${wine.name} ${wine.price}`);
      continue;
    }
    used.add(index);
    score.matched += 1;
    const candidate = candidates[index]!;
    if (wine.section !== undefined) {
      score.sectionsChecked += 1;
      if ((candidate.menuSection ?? null)?.toLowerCase() === wine.section?.toLowerCase()) score.sectionsRight += 1;
      else score.wrongSections.push(`${wine.name}: ${candidate.menuSection ?? "none"} (want ${wine.section ?? "none"})`);
    }
    if (wine.region) {
      score.regionsChecked += 1;
      if (candidate.region && canonicalizeText(candidate.region) === canonicalizeText(wine.region)) score.regionsRight += 1;
    }
  }
  candidates.forEach((candidate, index) => {
    if (!used.has(index)) score.extras.push(`${candidate.rawText.replace(/\s+/g, " ").slice(0, 60)} ${candidate.price ?? ""}`);
  });
  return score;
}

export function f1(score: CaseScore): number {
  if (score.matched === 0) return 0;
  const precision = score.matched / score.found;
  const recall = score.matched / score.expected;
  return (2 * precision * recall) / (precision + recall);
}

/** Old app (text only) and current app (text plus word boxes) for one dump. */
export function scoreDump(dump: ClientOcrDump, reference: ReferenceWine[]) {
  const textOnly = scoreCandidates(parseWineCandidates(dump.recognizedText), reference);
  const choice = chooseClientOcrText(dump.recognizedText, dump.layout);
  const withLayout = scoreCandidates(parseWineCandidates(choice.text), reference);
  return { textOnly, withLayout, source: choice.source, chosenText: choice.text };
}
