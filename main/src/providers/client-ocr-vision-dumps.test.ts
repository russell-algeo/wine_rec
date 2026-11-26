import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type ClientOcrDump, f1, loadCases, referenceFor, repoRoot, scoreDump } from "../test-support/client-ocr-eval.js";

// Real Apple Vision output for each case in ios/Tests/OCRFixtures/cases.json,
// recorded by the vision-ocr job of .github/workflows/ios.yml (macOS 15 runner).
const dumpDir = path.join(repoRoot, "ios/Tests/OCRFixtures/vision-dumps");
const cases = loadCases();

describe("server reading of recorded iPhone Vision output", () => {
  const scores = cases.map((testCase) => {
    const dump = JSON.parse(fs.readFileSync(path.join(dumpDir, `${testCase.id}.json`), "utf8")) as ClientOcrDump;
    return { id: testCase.id, ...scoreDump(dump, referenceFor(testCase, cases)) };
  });

  for (const score of scores) {
    it(`word boxes never make ${score.id} worse than the app's text alone`, () => {
      expect(f1(score.withLayout)).toBeGreaterThanOrEqual(f1(score.textOnly));
      expect(score.withLayout.sectionsRight).toBeGreaterThanOrEqual(score.textOnly.sectionsRight);
    });
  }

  it("reads every real screenshot and its transformed copies exactly", () => {
    for (const score of scores.filter((entry) => entry.id.startsWith("real-"))) {
      expect({ id: score.id, missing: score.withLayout.missing, extras: score.withLayout.extras, sections: score.withLayout.wrongSections })
        .toEqual({ id: score.id, missing: [], extras: [], sections: [] });
    }
  });

  it("keeps the overall result on the synthetic lists and photos", () => {
    const total = scores.reduce((sum, score) => sum + score.withLayout.matched, 0);
    const extras = scores.reduce((sum, score) => sum + score.withLayout.found - score.withLayout.matched, 0);
    // Recorded Nov 26 2026: 104 of 110 wines, 5 extra rows. The misses are Vision misreads
    // (a price it never returned, a shadowed price column) and one parser case shared with web OCR.
    expect(total).toBeGreaterThanOrEqual(104);
    expect(extras).toBeLessThanOrEqual(5);
  });
});
