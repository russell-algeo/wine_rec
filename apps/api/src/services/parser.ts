import type { WineCandidate } from "@wine-rec/contracts";
import { nanoid } from "nanoid";

const vintagePattern = /\b(19|20)\d{2}\b/;
const abbreviatedVintagePattern = /[''`'](\d{2})\b/;
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
const nonWineHints = [
  "martini",
  "draft",
  "gyokuro",
  "malt",
  "cocktail",
  "beer",
  "drinks",
  "rinks",
];
const menuTabMarkerPattern = /^@@TAB:\s*(.+)$/;
const menuSectionMarkerPattern = /^@@SECTION:\s*(.+)$/;
const inlinePricePattern =
  /^(.*?)(?:\s*\/\s*(\d{1,2})(?!\d)(?:\.\d{2})?(?:\.\s*\d+)?(?:\s+[A-Za-z0-9]+)?)\s*$/;
const ocrCorrections: Array<[RegExp, string]> = [
  [/\bRhone\b/g, "Rhône"],
  [/\bSchaztel\b/g, "Schäztel"],
  [/Tradicién/g, "Tradición"],
  [/Vino de\}\s+Volta/g, "Vino del Volta"],
];

function detectHint(line: string, hints: string[]): string | null {
  const normalized = line.toLowerCase();
  const hit = hints.find((hint) => normalized.includes(hint));
  return hit ?? null;
}

function sanitizeOcrLine(line: string): string {
  const trimmed = line
    .trim()
    .replace(/^[*•|]+\s*/, "")
    .replace(/\s+[|«»]+$/g, "")
    .trim();

  return applyOcrCorrections(trimmed);
}

function applyOcrCorrections(line: string): string {
  return ocrCorrections.reduce((value, [pattern, replacement]) => {
    return value.replace(pattern, replacement);
  }, line);
}

function extractInlinePrice(line: string): { title: string; price: string | null } {
  const match = line.match(inlinePricePattern);
  if (!match) {
    return { title: line.trim(), price: null };
  }

  return {
    title: match[1]?.trim() ?? line.trim(),
    price: `$${match[2]}`,
  };
}

export function isNonWineLine(line: string): boolean {
  const normalized = line
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  return nonWineHints.some((hint) => normalized.includes(hint));
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
    const labelTailLooksLikeMetadata = /,|\b(19|20)\d{2}\b/.test(labelTail);
    const label = [quotedLabelMatch[2]?.trim() ?? null, labelTail].filter(Boolean).join(" ") || null;
    return {
      producer: producer || null,
      label: labelTailLooksLikeMetadata ? (quotedLabelMatch[2]?.trim() ?? null) : label,
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

export function normalizeSectionHeader(line: string): string | null {
  const normalized = line
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  const words = normalized.split(" ").filter(Boolean);
  const headers = words.filter((word) => sectionColors.has(word));
  const noise = words.filter((word) => !sectionColors.has(word) && !/^\d+$/.test(word));

  if (headers.length >= 1 && noise.length === 0) {
    return headers[0] ?? null;
  }

  return null;
}

function isSectionHeader(line: string): boolean {
  return normalizeSectionHeader(line) !== null;
}

function isPriceLine(line: string): boolean {
  return /^\$\d+(?:\.\d{2})?$/.test(line) || /^\d+\s*\/\s*\d+$/.test(line);
}

function normalizePriceLine(line: string): string {
  if (/^\$\d+(?:\.\d{2})?$/.test(line)) return line;
  // "18 / 72" glass/bottle — take the bottle (larger) price
  const parts = line.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (parts) return `$${parts[2]}`;
  return line;
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

export function looksLikeTitleLine(line: string): boolean {
  if (vintagePattern.test(line)) return true;
  if (/^(NV|N\.V\.)\b/i.test(line)) return true;
  if (/[‘'“"][^’'"”]+[’'"”]/.test(line)) return true;
  if (/\s+-\s+/.test(line) || /\s+-$/.test(line)) return true;
  const words = line.split(/\s+/).filter(Boolean);
  const capitalizedWords = words.filter((word) => /^[A-Z][A-Za-z'’.-]+$/.test(word)).length;
  if (!line.includes(",") && words.length >= 4 && capitalizedWords >= 3) return true;
  return false;
}

export function parseBlock(
  lines: string[],
  startLineNumber: number,
  color: string | null,
  price: string | null,
  menuTab: string | null,
  menuSection: string | null,
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

  const { title: priceStrippedTitle, price: inlinePrice } = extractInlinePrice(
    applyOcrCorrections(title.replace(/\s+-\s+/, " - ")),
  );
  const normalizedTitle = priceStrippedTitle;
  const vintageMatch = normalizedTitle.match(vintagePattern);
  const abbrVintageMatch = !vintageMatch ? normalizedTitle.match(abbreviatedVintagePattern) : null;
  const vintage = vintageMatch
    ? Number(vintageMatch[0])
    : abbrVintageMatch
      ? (() => {
          const yy = Number(abbrVintageMatch[1]);
          return yy <= (new Date().getFullYear() - 2000) + 1 ? 2000 + yy : 1900 + yy;
        })()
      : null;
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
    price: price ?? inlinePrice,
    menuTab,
    menuSection,
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
  let currentMenuTab: string | null = null;
  let currentMenuSection: string | null = null;
  let currentBlock: string[] = [];
  let blockStartLineNumber = 0;

  const flushBlock = (price: string | null = null) => {
    const candidate = parseBlock(
      currentBlock,
      blockStartLineNumber,
      currentColor,
      price,
      currentMenuTab,
      currentMenuSection,
    );
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

    const tabMarker = line.match(menuTabMarkerPattern);
    if (tabMarker) {
      flushBlock();
      currentMenuTab = tabMarker[1]?.trim() ?? null;
      currentMenuSection = null;
      currentColor = null;
      return;
    }

    const sectionMarker = line.match(menuSectionMarkerPattern);
    if (sectionMarker) {
      flushBlock();
      currentMenuSection = sectionMarker[1]?.trim() ?? null;
      currentColor = normalizeSectionHeader(currentMenuSection ?? "");
      return;
    }

    if (isSectionHeader(line)) {
      flushBlock();
      currentColor = normalizeSectionHeader(line);
      currentMenuSection = line.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
      return;
    }

    if (isNonWineLine(line)) {
      flushBlock();
      return;
    }

    if (isPriceLine(line)) {
      flushBlock(normalizePriceLine(line));
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

export function buildCandidateFromItem(item: {
  name: string;
  price: string | null;
  section: string | null;
  tab: string | null;
}): WineCandidate | null {
  const color = item.section ? normalizeSectionHeader(item.section) : null;
  return parseBlock([item.name], 0, color, item.price, item.tab, item.section);
}
