import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { buildLayoutAwareTextFromTsv } from "../providers/tesseract-layout.js";

const execFileAsync = promisify(execFile);
const fixtureDir = path.resolve(process.cwd(), "../shared/test/fixtures");

export const hasTesseract =
  spawnSync("tesseract", ["--version"], {
    stdio: "ignore",
  }).status === 0;

export async function findFixturePath(prefix: string): Promise<string> {
  const fixtureName = (await fs.readdir(fixtureDir)).find((name) => name.startsWith(prefix));
  if (!fixtureName) {
    throw new Error(`Expected fixture starting with "${prefix}" in ${fixtureDir}`);
  }
  return path.join(fixtureDir, fixtureName);
}

export async function ocrFixtureToTsv(prefix: string): Promise<string> {
  const fixturePath = await findFixturePath(prefix);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "wine-rec-test-ocr-"));
  const outputBase = path.join(outputDir, "fixture");

  try {
    await execFileAsync("tesseract", [fixturePath, outputBase, "-l", "eng", "--psm", "6", "tsv"]);
    return await fs.readFile(`${outputBase}.tsv`, "utf8");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

export async function ocrFixtureToText(prefix: string): Promise<string> {
  const tsv = await ocrFixtureToTsv(prefix);
  return buildLayoutAwareTextFromTsv(tsv);
}

export function canonicalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’'“”"]/g, " ")
    .replace(/[^+\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}
