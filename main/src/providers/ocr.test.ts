import path from "node:path";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildStructuredOcrRowsFromRecognizedVariants, resolveTesseractJsWorkerConfig } from "./ocr.js";

describe("resolveTesseractJsWorkerConfig", () => {
  it("resolves OCR assets independently of process.cwd()", () => {
    const originalCwd = process.cwd();
    const repoRoot = path.resolve(originalCwd, "..");

    process.chdir(repoRoot);

    try {
      const config = resolveTesseractJsWorkerConfig();

      expect(config.workerPath).toContain(`${path.sep}main${path.sep}node_modules${path.sep}tesseract.js${path.sep}`);
      expect(existsSync(config.workerPath)).toBe(true);
      expect(existsSync(path.join(config.corePath, "package.json"))).toBe(true);
      expect(existsSync(path.join(config.langPath, "eng.traineddata"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("buildStructuredOcrRowsFromRecognizedVariants", () => {
  it("builds deduped one- and two-line row candidates from calibrated plain OCR text", () => {
    const rows = buildStructuredOcrRowsFromRecognizedVariants([
      {
        label: "photo-vertical-left-mid-clahe",
        family: "photo-focus",
        cropped: true,
        thresholded: false,
        bounds: { left: 0.2, top: 0, width: 0.35, height: 1 },
        buffer: Buffer.from(""),
        confidence: 88,
        layoutText: "",
        plainText: [
          "STENCI",
          "REROSCO! Dimitti Cacovich_$    E",
          "STENCI",
          "REROSCO! Dimitti Cacovich_$    E",
          "toggle navigation reservations",
        ].join("\n"),
      },
    ]);

    expect(rows.some((row) => /Stencnik.*Refosco.*Dimitri.*Cacovich/.test(row.rawText))).toBe(true);
    expect(rows.stats?.candidateRows).toBeLessThan(rows.stats?.rawRows ?? 0);
    expect(rows.stats?.duplicateRows).toBeGreaterThan(0);
    expect(rows.stats?.malformedRows).toBeGreaterThan(0);
  });
});
