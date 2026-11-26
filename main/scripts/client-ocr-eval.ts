// Scores what the server makes of the iPhone app's Apple Vision output.
//
//   prepare OUT                 writes each case's image (with its transform) to OUT/images
//   eval DUMPS [--tesseract IMAGES] [--verbose] [--check]
//                               scores the app's old text-only request against the
//                               current text-plus-word-boxes request, per case; with
//                               --tesseract, also the server's own OCR of the same image.
//                               --check fails when word boxes make any case worse, or
//                               (with --min-matched N) when fewer than N wines match.
//
// Run from main/: TSX_TSCONFIG_PATH=tsconfig.runtime.json npx tsx scripts/client-ocr-eval.ts ...
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import {
  type CaseScore,
  type ClientOcrDump,
  f1,
  loadCases,
  referenceFor,
  resolveImage,
  scoreCandidates,
  scoreDump,
} from "../src/test-support/client-ocr-eval.js";
import { parseWineCandidates } from "../src/services/parser.js";

const [command, target, ...rest] = process.argv.slice(2);
const cases = loadCases();

async function prepare(outDir: string) {
  const imagesDir = path.join(outDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  for (const testCase of cases) {
    const imagePath = resolveImage(testCase.image);
    const bytes = fs.readFileSync(imagePath);
    const transform = testCase.transform;
    let output: Buffer = bytes;
    let extension = path.extname(imagePath).toLowerCase();
    if (transform) {
      let image = sharp(bytes);
      if (transform.extract) image = image.extract(transform.extract);
      if (transform.resizeWidth) image = image.resize({ width: transform.resizeWidth });
      if (transform.rotate180WithExif) image = image.rotate(180);
      image = image.jpeg({ quality: transform.jpegQuality ?? 85 });
      if (transform.rotate180WithExif) image = image.withMetadata({ orientation: 3 });
      output = await image.toBuffer();
      extension = ".jpg";
    }
    fs.writeFileSync(path.join(imagesDir, `${testCase.id}${extension}`), output);
  }
  console.log(`wrote ${cases.length} images to ${imagesDir}`);
}

function cell(score: CaseScore): string {
  const sections = score.sectionsChecked ? ` s${score.sectionsRight}/${score.sectionsChecked}` : "";
  return `${score.matched}/${score.expected} +${score.found - score.matched}${sections} f1=${f1(score).toFixed(2)}`;
}

async function evaluate(dumpDir: string) {
  const verbose = rest.includes("--verbose");
  const check = rest.includes("--check");
  const tesseractIndex = rest.indexOf("--tesseract");
  const imagesDir = tesseractIndex >= 0 ? rest[tesseractIndex + 1] : undefined;
  let tesseract: { extractText(input: { storagePath: string; filename: string; mimeType: string; buffer: Buffer }): Promise<string> } | undefined;
  if (imagesDir) {
    process.env.OCR_PROVIDER = "tesseract-js";
    const { createOcrProvider } = await import("../src/providers/ocr.js");
    tesseract = createOcrProvider();
  }

  const totals = { text: [0, 0, 0, 0, 0], layout: [0, 0, 0, 0, 0], server: [0, 0, 0, 0, 0] };
  const add = (bucket: number[], score: CaseScore) => {
    bucket[0]! += score.matched;
    bucket[1]! += score.expected;
    bucket[2]! += score.found - score.matched;
    bucket[3]! += score.sectionsRight;
    bucket[4]! += score.sectionsChecked;
  };
  const regressions: string[] = [];
  const header = ["case", "app before (text)", "app now (text+boxes)", "used", ...(tesseract ? ["server OCR"] : [])];
  console.log(header.join(" | "));
  for (const testCase of cases) {
    const dumpPath = path.join(dumpDir, `${testCase.id}.json`);
    if (!fs.existsSync(dumpPath)) {
      console.log(`${testCase.id} | no dump`);
      regressions.push(`${testCase.id}: no dump`);
      continue;
    }
    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as ClientOcrDump;
    const reference = referenceFor(testCase, cases);
    const { textOnly, withLayout, source, chosenText } = scoreDump(dump, reference);
    add(totals.text, textOnly);
    add(totals.layout, withLayout);
    const row = [testCase.id, cell(textOnly), cell(withLayout), source];
    let server: CaseScore | undefined;
    if (tesseract && imagesDir) {
      const file = fs.readdirSync(imagesDir).find((name) => name.startsWith(`${testCase.id}.`));
      if (file) {
        const buffer = fs.readFileSync(path.join(imagesDir, file));
        const text = await tesseract.extractText({ storagePath: "", filename: "input.jpg", mimeType: "image/jpeg", buffer });
        server = scoreCandidates(parseWineCandidates(text), reference);
        add(totals.server, server);
        row.push(cell(server));
      }
    }
    console.log(row.join(" | "));
    if (f1(withLayout) < f1(textOnly) - 1e-9 || withLayout.sectionsRight < textOnly.sectionsRight) {
      regressions.push(`${testCase.id}: ${cell(textOnly)} -> ${cell(withLayout)}`);
    }
    if (verbose) {
      for (const [label, score] of [["text", textOnly], ["boxes", withLayout], ["server", server]] as const) {
        if (!score) continue;
        if (score.missing.length) console.log(`   ${label} missing: ${score.missing.join("; ")}`);
        if (score.extras.length) console.log(`   ${label} extra: ${score.extras.join("; ")}`);
        if (score.wrongSections.length) console.log(`   ${label} sections: ${score.wrongSections.join("; ")}`);
      }
      if (rest.includes("--text")) {
        console.log("   --- app text\n" + dump.recognizedText.split("\n").map((line) => `   | ${line}`).join("\n"));
        console.log("   --- chosen text\n" + chosenText.split("\n").map((line) => `   | ${line}`).join("\n"));
      }
    }
  }
  const summary = (bucket: number[]) =>
    `${bucket[0]}/${bucket[1]} wines, ${bucket[2]} extra, sections ${bucket[3]}/${bucket[4]}`;
  console.log(`TOTAL app before: ${summary(totals.text)}`);
  console.log(`TOTAL app now:    ${summary(totals.layout)}`);
  if (tesseract) {
    console.log(`TOTAL server OCR: ${summary(totals.server)}`);
    const { shutdownTesseractJsWorkers } = await import("../src/providers/ocr.js");
    await shutdownTesseractJsWorkers();
  }
  const minIndex = rest.indexOf("--min-matched");
  const minMatched = minIndex >= 0 ? Number(rest[minIndex + 1]) : 0;
  if (check && totals.layout[0]! < minMatched) {
    regressions.push(`only ${totals.layout[0]} wines matched with word boxes; expected at least ${minMatched}`);
  }
  if (check && regressions.length) {
    console.log(`FAIL:\n${regressions.join("\n")}`);
    process.exit(1);
  }
}

if (command === "prepare" && target) await prepare(target);
else if (command === "eval" && target) await evaluate(target);
else {
  console.log("usage: client-ocr-eval.ts prepare OUT | eval DUMPS [--tesseract IMAGES] [--verbose] [--text] [--check [--min-matched N]]");
  process.exit(2);
}
