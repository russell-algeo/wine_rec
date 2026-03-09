import type { WineCandidate } from "@wine-rec/contracts";
import { nanoid } from "nanoid";

const vintagePattern = /\b(19|20)\d{2}\b/;
const colorHints = ["red", "white", "rose", "rosé", "sparkling", "champagne", "orange"];
const sectionHeaderHints = [
  "red",
  "white",
  "rose",
  "rosé",
  "sparkling",
  "orange",
  "sherry",
  "sake",
  "sweet",
];
const varietalHints = [
  "sauvignon blanc",
  "cabernet sauvignon",
  "cabernet",
  "pinot noir",
  "pinot grigio",
  "riesling",
  "chardonnay",
  "syrah",
  "shiraz",
  "merlot",
  "malbec",
  "champagne",
  "prosecco",
];
const regionHints = [
  "burgundy",
  "bordeaux",
  "sonoma",
  "napa",
  "sancerre",
  "rioja",
  "tuscany",
  "champagne",
  "mosel",
];
const sectionColors = new Set(sectionHeaderHints);

function detectHint(line: string, hints: string[]): string | null {
  const normalized = line.toLowerCase();
  const hit = hints.find((hint) => normalized.includes(hint));
  return hit ?? null;
}

function sanitizeOcrLine(line: string): string {
  return line
    .trim()
    .replace(/^[*•|]+\s*/, "")
    .replace(/\s+[|«»]+$/g, "")
    .trim();
}

function inferProducerAndLabel(
  line: string,
  vintage: number | null,
): Pick<WineCandidate, "producer" | "label"> {
  const withoutVintage = vintage ? line.replace(String(vintage), "").trim() : line.trim();
  const quotedLabelMatch = withoutVintage.match(/^(.*?)\s*[‘'“"]([^’'"”]+)[’'"”]\s*(.*)$/);

  if (quotedLabelMatch) {
    const producer = quotedLabelMatch[1]?.trim().replace(/\s+-\s*$/, "") ?? null;
    const labelTail = quotedLabelMatch[3]?.trim().replace(/^[-,]\s*/, "") ?? "";
    const label = [quotedLabelMatch[2]?.trim() ?? null, labelTail].filter(Boolean).join(" ") || null;
    return {
      producer: producer || null,
      label,
    };
  }

  const trailingVarietal = [...varietalHints]
    .sort((left, right) => right.length - left.length)
    .find((hint) => new RegExp(`${hint.replace(/\s+/g, "\\s+")}$`, "i").test(withoutVintage));

  if (trailingVarietal) {
    const varietalMatch = withoutVintage.match(
      new RegExp(`^(.*)\\s+(${trailingVarietal.replace(/\s+/g, "\\s+")})$`, "i"),
    );
    const producer = varietalMatch?.[1]?.trim() ?? null;
    const label = varietalMatch?.[2]?.trim() ?? null;
    if (producer && label) {
      return { producer, label };
    }
  }

  const parts = withoutVintage.split(/\s{2,}| - |, /).filter(Boolean);

  if (parts.length >= 2) {
    return {
      producer: parts[0] ?? null,
      label: parts.slice(1).join(" ").trim() || null,
    };
  }

  const words = withoutVintage.split(" ").filter(Boolean);
  return {
    producer: words.slice(0, 2).join(" ") || null,
    label: words.slice(2).join(" ") || null,
  };
}

function normalizeSectionHeader(line: string): string | null {
  const normalized = line
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  const words = normalized.split(" ").filter(Boolean);
  const headers = words.filter((word) => sectionColors.has(word));
  const noise = words.filter((word) => !sectionColors.has(word) && !/^\d+$/.test(word));

  if (headers.length === 1 && noise.length === 0) {
    return headers[0] ?? null;
  }

  return null;
}

function isSectionHeader(line: string): boolean {
  return normalizeSectionHeader(line) !== null;
}

function isPriceLine(line: string): boolean {
  return /^\$\d+(?:\.\d{2})?$/.test(line);
}

function looksLikeRegionLine(line: string): boolean {
  return /,\s*[A-Z]{2}$/.test(line);
}

function looksLikeTitleContinuation(line: string): boolean {
  if (vintagePattern.test(line)) return false;
  if (/^(NV|N\.V\.)\b/i.test(line)) return false;
  if (/[‘'“"][^’'"”]+[’'"”]/.test(line)) return false;
  if (/\s+-\s+/.test(line) || /\s+-$/.test(line)) return false;
  if (looksLikeRegionLine(line)) return true;
  if (line.includes(",")) return false;

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;

  const alphaWords = words.filter((word) => /[A-Za-z]/.test(word));
  if (alphaWords.length === 0) return false;

  const titleLikeWords = alphaWords.filter((word) => {
    return /^[A-Z][A-Za-z'’.-]*$/.test(word) || /^[A-Z]{2,}$/.test(word);
  }).length;

  if (titleLikeWords / alphaWords.length >= 0.6) {
    return true;
  }

  const hintText = line.toLowerCase();
  return (
    colorHints.some((hint) => hintText.includes(hint)) ||
    varietalHints.some((hint) => hintText.includes(hint))
  );
}

function looksLikeTitleLine(line: string): boolean {
  if (vintagePattern.test(line)) return true;
  if (/^(NV|N\.V\.)\b/i.test(line)) return true;
  if (/[‘'“"][^’'"”]+[’'"”]/.test(line)) return true;
  if (/\s+-\s+/.test(line) || /\s+-$/.test(line)) return true;
  const words = line.split(/\s+/).filter(Boolean);
  const capitalizedWords = words.filter((word) => /^[A-Z][A-Za-z'’.-]+$/.test(word)).length;
  if (!line.includes(",") && words.length >= 4 && capitalizedWords >= 3) return true;
  return false;
}

function parseBlock(
  lines: string[],
  startLineNumber: number,
  color: string | null,
  price: string | null,
): WineCandidate | null {
  if (lines.length === 0) return null;

  const titleLines = [lines[0] ?? ""];
  let noteStartIndex = 1;

  while (lines[noteStartIndex]) {
    const nextLine = lines[noteStartIndex]!;
    const currentTitle = titleLines[titleLines.length - 1] ?? "";

    if ((currentTitle.endsWith("-") || currentTitle.endsWith("—")) && looksLikeRegionLine(nextLine)) {
      titleLines.push(nextLine);
      noteStartIndex += 1;
      continue;
    }

    if (looksLikeTitleContinuation(nextLine)) {
      titleLines.push(nextLine);
      noteStartIndex += 1;
      continue;
    }

    break;
  }

  const title = titleLines.join(" ").trim();
  if (!/[\p{L}]/u.test(title)) {
    return null;
  }

  const normalizedTitle = title.replace(/\s+-\s+/, " - ");
  const vintageMatch = normalizedTitle.match(vintagePattern);
  const vintage = vintageMatch ? Number(vintageMatch[0]) : null;
  const splitTitle = normalizedTitle.split(/\s+-\s+/);
  const leftTitle = splitTitle[0] ?? normalizedTitle;
  const rightTitle = splitTitle[1]?.trim() ?? null;
  const { producer, label } = inferProducerAndLabel(leftTitle, vintage);
  const varietal = detectHint(`${normalizedTitle} ${lines.slice(noteStartIndex).join(" ")}`, varietalHints);
  const region = rightTitle ?? detectHint(normalizedTitle, regionHints);
  const notes = lines.slice(noteStartIndex).join(" ").trim() || null;

  return {
    id: nanoid(),
    rawText: normalizedTitle,
    price,
    lineNumber: startLineNumber,
    producer,
    label,
    vintage,
    color,
    varietal,
    region,
    notes,
    extractionConfidence: region || label ? 0.88 : 0.72,
  } satisfies WineCandidate;
}

export function parseWineCandidates(extractedText: string): WineCandidate[] {
  const rawLines = extractedText.split(/\r?\n/);
  const candidates: WineCandidate[] = [];
  let currentColor: string | null = null;
  let currentBlock: string[] = [];
  let blockStartLineNumber = 0;

  const flushBlock = (price: string | null = null) => {
    const candidate = parseBlock(currentBlock, blockStartLineNumber, currentColor, price);
    if (candidate) {
      candidates.push(candidate);
    }
    currentBlock = [];
  };

  rawLines.forEach((rawLine, index) => {
    const line = sanitizeOcrLine(rawLine);
    if (!line) {
      return;
    }

    if (isSectionHeader(line)) {
      flushBlock();
      currentColor = normalizeSectionHeader(line);
      return;
    }

    if (isPriceLine(line)) {
      flushBlock(line);
      return;
    }

    if (currentBlock.length > 0 && looksLikeTitleLine(line) && !looksLikeTitleContinuation(line)) {
      flushBlock();
      blockStartLineNumber = index;
    }

    if (currentBlock.length === 0) {
      blockStartLineNumber = index;
    }

    currentBlock.push(line);
  });

  flushBlock();
  return candidates.filter((candidate) => candidate.extractionConfidence >= 0.5);
}
