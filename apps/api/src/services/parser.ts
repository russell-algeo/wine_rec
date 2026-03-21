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
  "pink",
  "sparkling",
  "orange",
  "sherry",
  "sake",
  "sweet",
];
const sectionHeaderContextHints = new Set([
  "wines",
  "glass",
  "glasses",
  "carafe",
  "carafes",
  "bottle",
  "bottles",
  "split",
  "list",
  "lists",
  "by",
  "the",
  "and",
]);
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
  // E-commerce / UI noise (Shopify, general web pages)
  "sold out",
  "regular price",
  "sale price",
  "add to cart",
  "your cart",
  "estimated total",
  "skip to content",
  "continue shopping",
  "have an account",
  "filter and sort",
  "log in to check",
];
const menuTabMarkerPattern = /^@@TAB:\s*(.+)$/;
const menuSectionMarkerPattern = /^@@SECTION:\s*(.+)$/;
const inlinePricePattern =
  /^(.*?)(?:\s*\/\s*(\d{1,2})(?!\d)(?:\.\d{2})?(?:\.\s*\d+)?(?:\s+[A-Za-z0-9]+)?)\s*$/;
const inlineMenuPricePattern =
  /^(.*?)(?::\s*|\s+)((?:NA|\$?\d+(?:\.\d{2})?)(?:\s*\/\s*(?:NA|\$?\d+(?:\.\d{2})?)){1,2})\s*$/i;
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

function normalizeTitleWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.-]+$/gu, "");
}

function sanitizeOcrLine(line: string): string {
  const trimmed = line
    .trim()
    .replace(/^[*•|¢]+\s*/, "")
    .replace(/\s+[|«»]+$/g, "")
    .replace(/\s*[*†‡§¶#]+\s*$/, "")
    .replace(/\s+@\s*[A-Za-z0-9'’.+-]+$/u, "")
    .trim();

  const withoutSingleLetterBullet = trimmed.replace(/^[a-z]\s+(?=[A-Z])/u, "");
  return applyOcrCorrections(withoutSingleLetterBullet);
}

/**
 * Strips trailing annotation markers (*, †, etc.) from a string.
 * These appear on wine menus to flag organic, vegan, natural items.
 */
function stripAnnotationMarkers(text: string): string {
  return text.replace(/\s*[*†‡§¶#]+\s*$/, "").trim();
}

/**
 * Extracts a trailing price from a region segment like "Beaujolais, France 17/68"
 * or "Abruzzo, Italy 80". Returns null if no recognizable price is found.
 */
function extractTrailingOcrPrice(text: string): { region: string; price: string } | null {
  const clean = stripAnnotationMarkers(text);
  const match = clean.match(/^(.*\S)\s+(\d+(?:\s*\/\s*\d+)?)$/);
  if (!match) return null;

  const rawPrice = match[2]!.trim();
  const region = match[1]!.trim();

  if (/^(19|20)\d{2}$/.test(rawPrice)) return null;

  const slashMatch = rawPrice.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (slashMatch) {
    return { region, price: `$${Math.max(Number(slashMatch[1]), Number(slashMatch[2]))}` };
  }

  const n = Number(rawPrice);
  if (n >= 5 && n <= 2000) return { region, price: `$${n}` };

  return null;
}

/**
 * Parses a pipe-delimited OCR line: "Producer 'Label' Vintage | Varietal | Region Price".
 * Returns null if no pipes are present.
 */
function parsePipeDelimitedOcrLine(line: string): {
  name: string;
  varietal: string | null;
  region: string | null;
  price: string | null;
} | null {
  if (!line.includes("|")) return null;

  const segments = line.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  const name = segments[0]!;
  const varietalRaw = segments[1] ?? null;
  const varietal = varietalRaw ? stripAnnotationMarkers(varietalRaw) || null : null;

  if (segments.length < 3) {
    const extracted = extractTrailingOcrPrice(varietalRaw ?? "");
    if (extracted) {
      return { name, varietal: null, region: extracted.region, price: extracted.price };
    }
    return { name, varietal, region: null, price: null };
  }

  const regionSegment = segments.slice(2).join(", ");
  const extracted = extractTrailingOcrPrice(regionSegment);

  return {
    name,
    varietal,
    region: extracted?.region ?? (stripAnnotationMarkers(regionSegment) || null),
    price: extracted?.price ?? null,
  };
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

function extractInlineMenuPrice(line: string): { title: string; price: string | null } | null {
  const match = line.match(inlineMenuPricePattern);
  if (!match) {
    return null;
  }

  const title = match[1]?.trim().replace(/[:\s]+$/g, "") ?? "";
  const priceBlob = match[2] ?? "";
  const usesExplicitMenuSeparator = title.endsWith(":") || priceBlob.includes("$");
  if (!title || !/[A-Za-z]/.test(title)) {
    return null;
  }
  if (!usesExplicitMenuSeparator) {
    return null;
  }

  const numericPrices = priceBlob
    .split(/\s*\/\s*/g)
    .map((token) => token.trim())
    .filter((token) => token && !/^NA$/i.test(token))
    .map((token) => Number(token.replace(/^\$/, "")))
    .filter((value) => Number.isFinite(value));

  return {
    title,
    price: numericPrices.length > 0 ? `$${Math.max(...numericPrices)}` : null,
  };
}

export function isNonWineLine(line: string): boolean {
  // Single-letter / single-letter column headers like "G / B" (glass/bottle indicators)
  if (/^[A-Za-z]\s*\/\s*[A-Za-z]$/.test(line.trim())) return true;
  const normalized = line
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  // Prose descriptions (>200 chars) are never wine names.
  if (normalized.length > 200) return true;
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

  if (headers.length >= 1 && noise.every((word) => sectionHeaderContextHints.has(word))) {
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

/**
 * Returns true if the line looks like a standalone grape varietal fragment,
 * e.g. "Grenache/Carignan" or "Syrah" that OCR placed on its own line after
 * stripping a trailing pipe from "Name | Varietal |".
 */
function looksLikeVarietalFragment(line: string): boolean {
  const trimmed = line.trim();
  // "Grenache/Carignan", "Mourvedre/Grenache" — slash-separated grape names, no spaces or digits
  if (/^[A-Z][A-Za-zÀ-ÿ]+(\/[A-Z][A-Za-zÀ-ÿ]+)+$/.test(trimmed)) return true;
  // Single-word known varietal: the entire line must be one word (no spaces), preventing
  // false positives like "Stéphane Coquillette Champagne, France/31" which contains "champagne"
  // as a substring of varietalHints.
  if (/^[A-Za-zÀ-ÿ]+$/.test(trimmed)) {
    return detectHint(trimmed, varietalHints) !== null;
  }
  return false;
}

function looksLikeTitleContinuation(line: string): boolean {
  if (vintagePattern.test(line)) return false;
  if (/^(NV|N\.V\.)\b/i.test(line)) return false;
  if (/[‘'“"][^’'"”]+[’'"”]/.test(line)) return false;
  if (/\s+-\s+/.test(line) || /\s+-$/.test(line)) return false;
  // A standalone varietal fragment should not be consumed as a title continuation;
  // it needs to stay in the notes so synthetic extraction can promote it.
  if (looksLikeVarietalFragment(line)) return false;
  if (looksLikeRegionLine(line)) return true;
  if (line.includes(",")) return false;

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;

  const alphaWords = words.filter((word) => /[A-Za-z]/.test(word));
  if (alphaWords.length === 0) return false;

  const titleLikeWords = alphaWords.filter((word) => {
    const normalizedWord = normalizeTitleWord(word);
    return /^\p{Lu}[\p{L}'’.-]*$/u.test(normalizedWord) || /^\p{Lu}{2,}$/u.test(normalizedWord);
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
  if (abbreviatedVintagePattern.test(line)) return true;
  if (/^(NV|N\.V\.)\b/i.test(line)) return true;
  if (/[‘'“"][^’'"”]+[’'"”]/.test(line)) return true;
  if (/\s+-\s+/.test(line) || /\s+-$/.test(line)) return true;
  const words = line.split(/\s+/).filter(Boolean);
  const capitalizedWords = words.filter((word) => /^\p{Lu}[\p{L}'’.-]+$/u.test(normalizeTitleWord(word))).length;
  if (/\/\s*\$?\d+(?:\.\d{2})?\b/.test(line) && capitalizedWords >= 3) return true;
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

  // Parse pipe-delimited OCR format: "Name | Varietal | Region Price"
  const pipeData = parsePipeDelimitedOcrLine(title);
  const titleForParsing = pipeData ? pipeData.name : title;
  const inlineMenuPrice = pipeData ? null : extractInlineMenuPrice(titleForParsing);

  const { title: priceStrippedTitle, price: inlinePrice } = extractInlinePrice(
    applyOcrCorrections((inlineMenuPrice?.title ?? titleForParsing).replace(/\s+-\s+/, " - ")),
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

  // When pipeData is null, OCR may have delivered the pipe-delimited segments as separate
  // lines (trailing "|" stripped by sanitizeOcrLine). Detect "Varietal" + "Region Price"
  // fragments in the note lines and promote them to structured fields.
  let syntheticVarietal: string | null = null;
  let syntheticRegion: string | null = null;
  let syntheticPrice: string | null = null;
  let adjustedNoteStart = noteStartIndex;

  if (!pipeData && lines.length > noteStartIndex) {
    const firstNote = lines[noteStartIndex]!;
    if (looksLikeVarietalFragment(firstNote)) {
      syntheticVarietal = firstNote;
      adjustedNoteStart++;
      const secondNote = lines[adjustedNoteStart];
      if (secondNote) {
        const extracted = extractTrailingOcrPrice(secondNote);
        if (extracted) {
          syntheticRegion = extracted.region;
          syntheticPrice = extracted.price;
        } else {
          syntheticRegion = stripAnnotationMarkers(secondNote) || null;
        }
        adjustedNoteStart++;
      }
    }
  }

  const effectiveVarietal = pipeData?.varietal ?? syntheticVarietal;
  const effectiveRegion = pipeData?.region ?? syntheticRegion ?? rightTitle;
  const effectivePrice = pipeData?.price ?? syntheticPrice ?? inlineMenuPrice?.price;

  const varietal = effectiveVarietal?.toLowerCase() ?? detectHint(`${normalizedTitle} ${lines.slice(noteStartIndex).join(" ")}`, varietalHints);
  const region = effectiveRegion ?? detectHint(normalizedTitle, regionHints);
  const notes = lines.slice(adjustedNoteStart).join(" ").trim() || null;

  // Build a human-readable rawText. When we have structured varietal/region info
  // (either from inline pipes or from promoted note fragments), join with ", " so that
  // the display reads naturally: "Elodie Balme, Grenache/Carignan, Rhône, France".
  const rawTextParts = [
    pipeData ? pipeData.name : normalizedTitle,
    effectiveVarietal,
    effectiveRegion,
  ].filter(Boolean);
  const rawText = rawTextParts.length > 1 ? rawTextParts.join(", ") : (pipeData ? pipeData.name : normalizedTitle);

  return {
    id: nanoid(),
    rawText,
    price: price ?? effectivePrice ?? inlinePrice,
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
  const sanitizedLines = rawLines.map((rawLine) => sanitizeOcrLine(rawLine));
  const firstSectionIndex = sanitizedLines.findIndex((line) => line && isSectionHeader(line));
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

  sanitizedLines.forEach((line, index) => {
    if (firstSectionIndex >= 0 && index < firstSectionIndex) {
      return;
    }

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

    const inlineMenuPrice = extractInlineMenuPrice(line);
    if (inlineMenuPrice) {
      flushBlock();
      const candidate = parseBlock(
        [inlineMenuPrice.title],
        index,
        currentColor,
        inlineMenuPrice.price,
        currentMenuTab,
        currentMenuSection,
      );
      if (candidate) {
        candidates.push(candidate);
      }
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
