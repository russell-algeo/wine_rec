import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { parseWineCandidates } from "./parser.js";

type ParserRegression = {
  name: string;
  source: string;
  input: string;
  expected: Array<Partial<WineCandidate>>;
};

// These labels target observable row/field behavior. They do not claim exact
// producer identification or OCR/bottle-matching accuracy for an entire menu.
const regressions = JSON.parse(fs.readFileSync(
  new URL("../test-support/parser-regressions.json", import.meta.url), "utf8",
)) as ParserRegression[];

describe("labeled parser regressions", () => {
  it.each(regressions)("$name", ({ input, expected }) => {
    const candidates = parseWineCandidates(input);
    expect(candidates).toHaveLength(expected.length);
    candidates.forEach((candidate, index) => {
      expect(candidate).toMatchObject(expected[index]!);
    });
  });
});
