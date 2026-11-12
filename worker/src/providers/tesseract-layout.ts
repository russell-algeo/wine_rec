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
    const isMultiPriceRow = slashCount >= 2 || /\bNA\b/i.test(priceBlob);
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

export function buildPlainTextFromTsv(tsv: string): string {
  return groupLinesFromTsv(tsv)
    .map((line) => lineText(line.words))
    .filter(Boolean)
    .join("\n");
}

export function buildLayoutAwareTextFromTsv(tsv: string): string {
  const lines = groupLinesFromTsv(tsv);
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

  return renderedBlocks.length > 0 ? renderedBlocks.join("\n\n") : buildPlainTextFromTsv(tsv);
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

  return [...wordBuckets.entries()]
    .map(([key, words]) => ({
      key,
      words: words.sort((left, right) => left.left - right.left),
      top: Math.min(...words.map((word) => word.top)),
      bottom: Math.max(...words.map((word) => word.top + word.height)),
    }))
    .sort((left, right) => {
      if (left.top !== right.top) return left.top - right.top;
      return left.words[0]!.left - right.words[0]!.left;
    });
}
