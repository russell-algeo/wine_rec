import path from "node:path";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveTesseractJsWorkerConfig } from "./ocr.js";

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
