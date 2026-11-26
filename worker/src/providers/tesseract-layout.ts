type TesseractWord = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  lineKey: string;
};

type LayoutLine = {
  key: string;
  words: TesseractWord[];
  top: number;
  bottom: number;
  column?: number | undefined;
};

const pricePattern = /^\$?\d{1,3}(?:\.\d{2})?$/;
// Preservation only, not price recognition: anomalous boxes can still contain
// real amounts with currency, column separators or footnote annotations.
// Keep punctuation-formatted amounts (including a terminal period) and all
// Unicode currency symbols even when the parser does not recognize the format.
// Quotes/underscores remain excluded so the observed page-edge blobs still trim.
const possibleAmountSuffixPattern = /^(?=.*\p{N})[\p{N}\p{Sc}\/|*†‡§¶#().,+−–—-]+$/u;
const ignoredWords = new Set(["sold", "out", "seal"]);
const inlineMenuPricePattern =
  /(?:NA|\$?\d+(?:\.\d{2})?)(?:\s*\/\s*(?:NA|\$?\d+(?:\.\d{2})?)){1,2}\s*$/i;
const menuSectionPattern = /\b(red|white|rose|rosé|sparkling|champagne|orange|sherry|sake|sweet)\b/i;
const menuSectionContextPattern = /\b(glass|carafe|bottle|split|wine|wines)\b/i;

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isIgnoredWord(text: string): boolean {
  return ignoredWords.has(text.toLowerCase());
}

function isLikelyPriceWord(text: string): boolean {
  if (!pricePattern.test(text.trim())) return false;
  const amount = Number(text.trim().replace(/^\$/, ""));
  return Number.isFinite(amount) && amount >= 5 && amount <= 400;
}

function lineText(words: TesseractWord[]): string {
  return trimDetachedPriceArtifacts(words).map((word) => word.text).join(" ").trim();
}

// A photographed page edge can become a detached punctuation blob on the same
// TSV line as a valid price. Keep real words, possible second amounts and nearby
// annotations intact; only trim geometrically detached, non-price artifacts.
function trimDetachedPriceArtifacts(words: TesseractWord[]): TesseractWord[] {
  if (words.length < 4) return words;
  const artifact = words.at(-1)!;
  const price = words.at(-2)!;
  // Even an out-of-range or annotated amount may be a real second price.
  if (!isLikelyPriceWord(price.text) || /\p{L}/u.test(artifact.text) ||
      possibleAmountSuffixPattern.test(artifact.text) ||
      /^[\/|*†‡§¶#\p{Sc}]+$/u.test(artifact.text)) return words;
  const titleWords = words.slice(0, -2).filter((word) => /\p{L}/u.test(word.text));
  if (titleWords.length < 2) return words;
  const gap = artifact.left - (price.left + price.width);
  if (gap <= 2 * price.height) return words;
  const digits = artifact.text.match(/\p{N}/gu) ?? [];
  // Digit-bearing blobs need an additional size anomaly. Never repair or
  // guess a digit inside the actual price token or discard another amount.
  if (digits.length > 1 || (digits.length === 1 && artifact.height <= price.height * 2)) return words;
  return words.slice(0, -1);
}

function wordCenter(word: TesseractWord): number {
  return word.left + word.width / 2;
}

function lineLooksLikeToolbar(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("filter:") ||
    normalized.includes("sort by:") ||
    normalized.includes("best selling") ||
    normalized.includes("products")
  );
}

function lineLooksLikeTitleContent(text: string): boolean {
  const normalized = text
    .replace(/[^A-Za-z0-9\s+'’,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  const words = normalized.split(" ").filter(Boolean);
  const alphaWords = words.filter((word) => /[A-Za-z]/.test(word));
  if (alphaWords.length >= 2) return true;
  return alphaWords.some((word) => word.length >= 5);
}

function lineLooksLikeInlineMenuRow(text: string): boolean {
  const match = text.match(inlineMenuPricePattern);
  if (match) {
    const priceBlob = match[0] ?? "";
    const slashCount = (priceBlob.match(/\//g) ?? []).length;
    // Glass / bottle pairs ("16 / 64") count too: the second price is the larger one.
    const pair = slashCount === 1 ? priceBlob.match(/(\d+(?:\.\d{2})?)\s*\/\s*\$?(\d+(?:\.\d{2})?)/) : null;
    const isGlassBottlePair = Boolean(pair && Number(pair[1]) >= 5 && Number(pair[2]) > Number(pair[1]) * 2);
    const isMultiPriceRow = slashCount >= 2 || /\bNA\b/i.test(priceBlob) || isGlassBottlePair;
    if (!isMultiPriceRow) return false;

    const title = text.replace(inlineMenuPricePattern, "").trim().replace(/[:\s]+$/, "");
    if (!title || !/[A-Za-z]/.test(title)) return false;

    return title.includes(",") || title.includes(":");
  }

  const barePriceMatch = text.match(/^(.*\S)\s+(\d{1,3}(?:\.\d{2})?)\s*$/);
  if (!barePriceMatch || !isLikelyPriceWord(barePriceMatch[2] ?? "")) {
    return false;
  }

  const title = barePriceMatch[1]?.trim().replace(/[:\s]+$/g, "") ?? "";
  const alphaWords = title.match(/[A-Za-z]{2,}/g) ?? [];
  if (alphaWords.length < 2) return false;

  return true;
}

function lineLooksLikeMenuSection(text: string): boolean {
  return menuSectionPattern.test(text) && menuSectionContextPattern.test(text);
}

function shouldPreferPlainText(lines: LayoutLine[]): boolean {
  const texts = lines.map((line) => lineText(line.words));
  const menuRows = texts.filter((text) => lineLooksLikeInlineMenuRow(text)).length;
  const sections = texts.filter((text) => lineLooksLikeMenuSection(text)).length;
  if (menuRows >= 2 && sections === 0) {
    return true;
  }
  return menuRows >= 4;
}

function findColumnIndex(word: TesseractWord, columnStarts: number[]): number {
  for (let index = columnStarts.length - 1; index >= 0; index -= 1) {
    if (word.left >= ((columnStarts[index] ?? 0) - 4)) {
      return index;
    }
  }

  return 0;
}

function plainTextFromLines(lines: LayoutLine[]): string {
  return lines
    .map((line) => lineText(line.words))
    .filter(Boolean)
    .join("\n");
}

export function buildPlainTextFromTsv(tsv: string): string {
  return plainTextFromLines(groupLinesFromTsv(tsv));
}

export function buildLayoutAwareTextFromTsv(tsv: string): string {
  return layoutAwareTextFromLines(groupLinesFromTsv(tsv));
}

/** A word box from another OCR engine, in pixels with a top-left origin. */
export type LayoutWord = { text: string; left: number; top: number; width: number; height: number };

/**
 * Runs the same layout pass as server OCR on words from another engine (the
 * iPhone app's Apple Vision text). Each input line is one engine observation.
 * Vision often returns the halves of one printed row as separate observations,
 * while single-block Tesseract returns the whole row, so observations that sit
 * on the same row are joined first; the two-column split then reads columns in
 * order exactly as it does for server OCR.
 */
export function buildLayoutAwareTextFromWordLines(input: LayoutWord[][]): string {
  const lines = deskewWordLines(input)
    .map((words, index) => words
      .map((word) => ({ ...word, text: word.text.trim(), conf: 100, lineKey: `client:${index}` }))
      .filter((word) => word.text.length > 0 && Number.isFinite(word.left) && Number.isFinite(word.top)
        && word.width >= 0 && word.height >= 0))
    .filter((words) => words.length > 0)
    .map((words, index) => makeLine(`client:${index}`, words))
    .sort(compareLines);
  return layoutAwareTextFromLines(splitTwoColumnLayout(mergeSameRowLines(lines)));
}

/**
 * Levels a tilted photo. Each long line's words give its slope; the slope is
 * fitted against height on the page (a keystoned photo tilts more at one end)
 * and every word is sheared back, so a price far to the right lands on its
 * wine's row instead of the row above. Straight screenshots are left as is.
 */
function deskewWordLines(input: LayoutWord[][]): LayoutWord[][] {
  const samples: Array<{ y: number; slope: number; weight: number }> = [];
  for (const words of input) {
    if (words.length < 3) continue;
    const heights = words.map((word) => word.height).sort((a, b) => a - b);
    const height = heights[Math.floor(heights.length / 2)] ?? 0;
    const xs = words.map((word) => word.left + word.width / 2);
    const ys = words.map((word) => word.top + word.height / 2);
    const span = Math.max(...xs) - Math.min(...xs);
    if (height <= 0 || span < 8 * height) continue;
    const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
    const varX = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
    const slope = xs.reduce((sum, x, index) => sum + (x - meanX) * (ys[index]! - meanY), 0) / varX;
    if (Math.abs(slope) <= 0.2) samples.push({ y: meanY, slope, weight: span });
  }
  if (samples.length < 3) return input;
  const sortedSlopes = samples.map((sample) => sample.slope).sort((a, b) => a - b);
  const median = sortedSlopes[Math.floor(sortedSlopes.length / 2)]!;
  const inliers = samples.filter((sample) => Math.abs(sample.slope - median) <= 0.02);
  if (inliers.length < 3) return input;

  // slope(y) = a + b * y, weighted by line length; flat when the fit is unstable.
  const totalWeight = inliers.reduce((sum, sample) => sum + sample.weight, 0);
  const meanY = inliers.reduce((sum, sample) => sum + sample.weight * sample.y, 0) / totalWeight;
  const meanSlope = inliers.reduce((sum, sample) => sum + sample.weight * sample.slope, 0) / totalWeight;
  const varY = inliers.reduce((sum, sample) => sum + sample.weight * (sample.y - meanY) ** 2, 0);
  const spreadY = Math.max(...inliers.map((sample) => sample.y)) - Math.min(...inliers.map((sample) => sample.y));
  const b = inliers.length >= 5 && varY > 0 && spreadY > 0
    ? inliers.reduce((sum, sample) => sum + sample.weight * (sample.y - meanY) * (sample.slope - meanSlope), 0) / varY
    : 0;
  const slopeAt = (y: number) => Math.max(-0.2, Math.min(0.2, meanSlope + b * (y - meanY)));
  const maxSlope = Math.max(Math.abs(slopeAt(meanY - spreadY)), Math.abs(slopeAt(meanY + spreadY)), Math.abs(meanSlope));
  if (maxSlope < 0.005) return input;

  const allWords = input.flat();
  const centerX = allWords.reduce((sum, word) => sum + word.left + word.width / 2, 0) / Math.max(1, allWords.length);
  return input.map((words) => words.map((word) => {
    const x = word.left + word.width / 2;
    const y = word.top + word.height / 2;
    return { ...word, top: word.top - slopeAt(y) * (x - centerX) };
  }));
}

function medianHeight(line: LayoutLine): number {
  const heights = line.words.map((word) => word.height).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 0;
}

function mergeSameRowLines(lines: LayoutLine[]): LayoutLine[] {
  const byCenter = [...lines].sort((left, right) => (left.top + left.bottom) - (right.top + right.bottom));
  const rows: LayoutLine[] = [];
  for (const line of byCenter) {
    const last = rows.at(-1);
    if (last) {
      const height = Math.max(medianHeight(last), medianHeight(line));
      const lastCenter = (last.top + last.bottom) / 2;
      const center = (line.top + line.bottom) / 2;
      const overlapsHorizontally = line.words.some((word) => last.words.some((other) =>
        word.left < other.left + other.width && other.left < word.left + word.width));
      if (Math.abs(lastCenter - center) <= height * 0.5 && !overlapsHorizontally) {
        rows[rows.length - 1] = makeLine(last.key, [...last.words, ...line.words]);
        continue;
      }
    }
    rows.push(line);
  }
  return rows.sort(compareLines);
}

function layoutAwareTextFromLines(lines: LayoutLine[]): string {
  if (shouldPreferPlainText(lines)) {
    return lines
      .map((line) => lineText(line.words))
      .filter(Boolean)
      .join("\n");
  }

  const renderedBlocks: string[] = [];
  const consumedLineIndexes = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    if (consumedLineIndexes.has(index)) continue;

    const bandIndexes = [index];
    const firstLine = lines[index]!;
    let totalPrices = firstLine.words.filter((word) => isLikelyPriceWord(word.text)).length;
    let cursor = index + 1;

    while (cursor < lines.length) {
      const previous = lines[cursor - 1]!;
      const next = lines[cursor]!;
      const nextPrices = next.words.filter((word) => isLikelyPriceWord(word.text)).length;
      if (nextPrices === 0 || next.top - previous.bottom > 85) {
        break;
      }

      bandIndexes.push(cursor);
      totalPrices += nextPrices;
      cursor += 1;
    }

    if (totalPrices < 2) {
      continue;
    }

    const bandLines = bandIndexes.map((bandIndex) => lines[bandIndex]!);
      const priceWords = bandLines
        .flatMap((line) => line.words)
        .filter((word) => isLikelyPriceWord(word.text))
        .sort((left, right) => left.left - right.left);

    if (priceWords.length < 2) {
      continue;
    }

    const titleLineIndexes: number[] = [];
    const titleWindowTop = bandLines[0]!.top - 80;
    let lookback = index - 1;
    while (lookback >= 0) {
      const candidateLine = lines[lookback]!;
      if (consumedLineIndexes.has(lookback)) {
        lookback -= 1;
        continue;
      }

      if (candidateLine.top < titleWindowTop) {
        break;
      }

      const text = lineText(candidateLine.words);
      if (!text || lineLooksLikeToolbar(text) || !lineLooksLikeTitleContent(text)) {
        lookback -= 1;
        continue;
      }

      titleLineIndexes.unshift(lookback);
      lookback -= 1;
    }

    const columnStarts = priceWords.map((word) => word.left);
    const linesByColumn = priceWords.map(() => [] as string[]);
    const sourceLineIndexes = [...titleLineIndexes, ...bandIndexes];

    for (const lineIndex of sourceLineIndexes) {
      const wordsByColumn = priceWords.map(() => [] as TesseractWord[]);
      for (const word of lines[lineIndex]!.words) {
        if (isLikelyPriceWord(word.text) || isIgnoredWord(word.text)) {
          continue;
        }

        const columnIndex = findColumnIndex(word, columnStarts);
        wordsByColumn[columnIndex]!.push(word);
      }

      wordsByColumn.forEach((words, columnIndex) => {
        if (words.length === 0) return;
        const text = lineText(words.sort((left, right) => left.left - right.left));
        if (!lineLooksLikeTitleContent(text)) return;
        linesByColumn[columnIndex]!.push(text);
      });
    }

    const blockByColumn = priceWords.map((priceWord, columnIndex) => {
      const title = linesByColumn[columnIndex]!.join("\n").trim();
      return title ? `${title}\n${priceWord.text}` : "";
    });

    const usefulBlocks = blockByColumn.filter(Boolean);
    if (usefulBlocks.length > 0) {
      renderedBlocks.push(...usefulBlocks);
      [...titleLineIndexes, ...bandIndexes].forEach((lineIndex) => consumedLineIndexes.add(lineIndex));
    }

    index = bandIndexes[bandIndexes.length - 1]!;
  }

  return renderedBlocks.length > 0 ? renderedBlocks.join("\n\n") : plainTextFromLines(lines);
}

function groupLinesFromTsv(tsv: string): LayoutLine[] {
  // CLI TSV has a header; the JS engine returns headerless rows.
  const rows = tsv.split(/\r?\n/);
  const wordBuckets = new Map<string, TesseractWord[]>();

  for (const row of rows) {
    if (!row.trim()) continue;
    const columns = row.split("\t");
    const level = columns[0];
    const text = columns[11]?.trim() ?? "";
    if (level !== "5" || !text) continue;

    const conf = parseInteger(columns[10] ?? "");
    if (conf < 20 && !isLikelyPriceWord(text)) continue;

    const lineKey = [columns[1], columns[2], columns[3], columns[4]].join(":");
    const word: TesseractWord = {
      text,
      left: parseInteger(columns[6] ?? ""),
      top: parseInteger(columns[7] ?? ""),
      width: parseInteger(columns[8] ?? ""),
      height: parseInteger(columns[9] ?? ""),
      conf,
      lineKey,
    };

    const bucket = wordBuckets.get(lineKey) ?? [];
    bucket.push(word);
    wordBuckets.set(lineKey, bucket);
  }

  const lines = [...wordBuckets.entries()]
    .map(([key, words]) => makeLine(key, words))
    .sort(compareLines);
  return splitTwoColumnLayout(lines);
}

function makeLine(key: string, words: TesseractWord[], column?: number): LayoutLine {
  return {
    key,
    words: words.sort((left, right) => left.left - right.left),
    top: Math.min(...words.map((word) => word.top)),
    bottom: Math.max(...words.map((word) => word.top + word.height)),
    column,
  };
}

function compareLines(left: LayoutLine, right: LayoutLine): number {
  if ((left.column ?? 0) !== (right.column ?? 0)) return (left.column ?? 0) - (right.column ?? 0);
  if (left.top !== right.top) return left.top - right.top;
  return left.words[0]!.left - right.words[0]!.left;
}

// A price token that can end a wine row; years (19xx/20xx) are vintages, not prices.
const rowEndPricePattern = /^[$€£]?\d{2,4}(?:[.,]\d{2})?[.,]?$/;
const hasLetters = (word: TesseractWord) => /\p{L}{2,}/u.test(word.text);
function isRowEndPrice(text: string): boolean {
  const trimmed = text.trim();
  return rowEndPricePattern.test(trimmed) && !/^(?:19|20)\d{2}$/.test(trimmed);
}

/**
 * Two-column wine lists (left column "Wine ... 40", right column "Wine ... 85")
 * come back from single-block OCR as one line per row spanning both columns,
 * which glues two wines and their prices together. When many rows show a
 * price followed by a wide gap and a new wine name at a consistent x position,
 * split every line at that gutter and read the left column before the right.
 * The gutter is fitted as a line (x = a + b*y) so tilted photos still split.
 */
function splitTwoColumnLayout(lines: LayoutLine[]): LayoutLine[] {
  if (lines.length < 8) return lines;
  const words = lines.flatMap((line) => line.words);
  const pageLeft = Math.min(...words.map((word) => word.left));
  const pageRight = Math.max(...words.map((word) => word.left + word.width));
  const span = pageRight - pageLeft;
  if (span <= 0) return lines;

  const gaps: Array<{ x: number; y: number }> = [];
  for (const line of lines) {
    const heights = line.words.map((word) => word.height).sort((a, b) => a - b);
    const height = heights[Math.floor(heights.length / 2)] ?? 0;
    for (let index = 1; index + 1 < line.words.length; index += 1) {
      const price = line.words[index]!;
      const next = line.words[index + 1]!;
      const gap = next.left - (price.left + price.width);
      const x = price.left + price.width + gap / 2;
      const relative = (x - pageLeft) / span;
      if (relative < 0.2 || relative > 0.8 || gap < 1.5 * height) continue;
      if (!isRowEndPrice(price.text)) continue;
      if (!line.words.slice(0, index).some(hasLetters)) continue;
      if (line.words.slice(index + 1).filter(hasLetters).length < 2) continue;
      gaps.push({ x, y: (line.top + line.bottom) / 2 });
      break;
    }
  }
  if (gaps.length < Math.max(4, lines.length * 0.12)) return lines;

  // Fit the gutter, dropping gaps far from the median, and refit once.
  const sortedX = gaps.map((gap) => gap.x).sort((a, b) => a - b);
  const medianX = sortedX[Math.floor(sortedX.length / 2)]!;
  let inliers = gaps.filter((gap) => Math.abs(gap.x - medianX) <= span * 0.08);
  if (inliers.length < Math.max(4, lines.length * 0.12)) return lines;
  const fit = (points: typeof gaps) => {
    const n = points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
    const varY = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    const slope = varY > 0 ? points.reduce((sum, point) => sum + (point.y - meanY) * (point.x - meanX), 0) / varY : 0;
    const bounded = Math.max(-0.1, Math.min(0.1, slope));
    return { slope: bounded, intercept: meanX - bounded * meanY };
  };
  let gutter = fit(inliers);
  inliers = gaps.filter((gap) => Math.abs(gap.x - (gutter.intercept + gutter.slope * gap.y)) <= span * 0.04);
  if (inliers.length < Math.max(4, lines.length * 0.12)) return lines;
  gutter = fit(inliers);
  const gutterAt = (y: number) => gutter.intercept + gutter.slope * y;

  const split: LayoutLine[] = [];
  let rightSegments = 0;
  let rightSegmentsWithPrice = 0;
  let leftSegmentsWithPrice = 0;
  for (const line of lines) {
    const x = gutterAt((line.top + line.bottom) / 2);
    const left = line.words.filter((word) => word.left + word.width / 2 < x);
    const right = line.words.filter((word) => word.left + word.width / 2 >= x);
    if (left.length > 0) split.push(makeLine(`${line.key}:c0`, left, 0));
    if (left.some((word) => isRowEndPrice(word.text))) leftSegmentsWithPrice += 1;
    if (right.length > 0) {
      split.push(makeLine(`${line.key}:c1`, right, 1));
      if (right.some(hasLetters)) {
        rightSegments += 1;
        if (right.some((word) => isRowEndPrice(word.text))) rightSegmentsWithPrice += 1;
      }
    }
  }
  // Price-then-tasting-notes rows look similar; a real second column has its own prices,
  // about as many as the left column even when each wine has a region line under it.
  const rightColumnPriced =
    rightSegmentsWithPrice / rightSegments >= 0.4 ||
    (rightSegmentsWithPrice >= 4 && rightSegmentsWithPrice >= 0.6 * leftSegmentsWithPrice);
  if (rightSegments === 0 || !rightColumnPriced) return lines;
  return split.sort(compareLines);
}
