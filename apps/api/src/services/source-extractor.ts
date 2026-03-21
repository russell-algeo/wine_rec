import type { WineCandidate } from "@wine-rec/contracts";

import { createOcrProvider } from "../providers/ocr.js";
import { VivinoBrowser } from "../providers/vivino-browser.js";
import {
  buildCandidateFromItem,
  isNonWineLine,
  looksLikeTitleLine,
} from "./parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeafToken =
  | { type: "section"; text: string }
  | { type: "price"; value: string }
  | { type: "text"; text: string };

export type RawMenuItem = {
  name: string;
  price: string | null;
  section: string | null;
  tab: string | null;
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function extractSourceText(input: {
  sourceType: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  sourceUrl?: string;
  fileBuffer?: Buffer;
}): Promise<string> {
  const ocrProvider = createOcrProvider();
  return ocrProvider.extractText(
    input.fileBuffer
      ? { ...input, buffer: input.fileBuffer }
      : input,
  );
}

export async function extractCandidatesFromUrl(sourceUrl: string): Promise<WineCandidate[]> {
  const { url: resolvedUrl, html } = await fetchHtmlDocument(new URL(sourceUrl));
  let candidates = extractMenuCandidates(html);

  // Follow pagination links (e.g. Shopify collection pages with ?page=N).
  const pageUrls = extractPaginationUrls(html, resolvedUrl);
  if (pageUrls.length > 0) {
    const extraPages = await Promise.all(
      pageUrls.slice(0, 9).map(async (pageUrl) => {
        try {
          const { html: pageHtml } = await fetchHtmlDocument(pageUrl);
          return extractMenuCandidates(pageHtml);
        } catch {
          return [] as WineCandidate[];
        }
      }),
    );
    for (const pageCandidates of extraPages) {
      candidates = candidates.concat(pageCandidates);
    }
    return candidates;
  }

  if (candidates.length > 0) {
    return candidates;
  }

  // Static HTML yielded nothing — page may be JS-rendered. Try the browser.
  let renderedHtml: string;
  try {
    renderedHtml = await VivinoBrowser.getInstance().renderHtml(sourceUrl);
  } catch {
    return candidates;
  }

  return extractMenuCandidates(renderedHtml);
}

// ---------------------------------------------------------------------------
// Menu extraction — token stream state machine
// ---------------------------------------------------------------------------

const nonWineSectionKeywords = new Set([
  "cocktail", "cocktails",
  "spirit", "spirits",
  "beer", "beers", "draft",
  "whiskey", "whisky", "bourbon", "scotch", "rye",
  "rum", "tequila", "mezcal", "gin", "vodka", "brandy", "cognac",
  "negroni", "negronis", "martini", "martinis",
  "mocktail", "mocktails",
  "food", "snack", "snacks",
  "starter", "starters", "appetizer", "appetizers",
  "entree", "entrees", "main", "mains", "dessert", "desserts",
  "shellfish", "oyster", "oysters", "seafood", "raw",
  "cheese", "charcuterie", "cured", "meat", "meats",
]);

const wineSectionKeywords = new Set([
  "red", "white", "orange", "rose", "rosé", "sparkling", "champagne",
  "sherry", "sake", "sweet", "wine", "wines",
  "glass", "bottle",
  "pink",
]);

function isNonWineSection(section: string | null): boolean {
  if (!section) return false;
  const words = section.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim().split(" ");
  return words.some((w) => nonWineSectionKeywords.has(w));
}

function looksLikeSectionName(text: string): boolean {
  // A standalone text line is treated as a section boundary if it contains only
  // recognised wine/non-wine keywords (1-4 words, no price-like tokens).
  const words = text.toLowerCase().replace(/[^a-záàéèêëùûü\s&]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const knownWords = new Set([...wineSectionKeywords, ...nonWineSectionKeywords, "by", "the", "and", "house", "selections", "list", "menu", "our", "wines"]);
  return words.every((w) => knownWords.has(w));
}

export function normalizeRawPrice(raw: string): string | null {
  const t = raw.trim();

  // Standard: $95 or $23.99
  if (/^\$\d+(?:\.\d{2})?$/.test(t)) return t;

  // Glass/bottle with slash: 16/72, 16 / 72, 16/$72, $16/$72, 19 / $86
  const slash = t.match(/^\$?(\d+)\s*\/\s*\$?(\d+)(?:\.\d{2})?$/);
  if (slash) {
    const a = Number.parseInt(slash[1]!, 10);
    const b = Number.parseInt(slash[2]!, 10);
    return `$${Math.max(a, b)}`;
  }

  // Glass/bottle with dash: 20 - 80, 18 - 75, 18-75
  const dash = t.match(/^\$?(\d+)\s*[-–]\s*\$?(\d+)(?:\.\d{2})?$/);
  if (dash) {
    const a = Number.parseInt(dash[1]!, 10);
    const b = Number.parseInt(dash[2]!, 10);
    return `$${Math.max(a, b)}`;
  }

  // Non-USD currency symbols: €45, £38 (leading or trailing)
  const CURRENCY_SYMBOLS = "€£¥₩₹";
  const leadSymbol = t.match(new RegExp(`^([${CURRENCY_SYMBOLS}])\\s*(\\d[\\d,.]*)$`));
  const trailSymbol = !leadSymbol && t.match(new RegExp(`^(\\d[\\d,.]*)\\s*([${CURRENCY_SYMBOLS}])$`));
  const symMatch = leadSymbol ?? trailSymbol;
  if (symMatch) {
    const symbol = leadSymbol ? symMatch[1]! : symMatch[2]!;
    const amountStr = leadSymbol ? symMatch[2]! : symMatch[1]!;
    const n = Number.parseFloat(amountStr.replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 5 && n <= 20000) {
      return `${symbol}${n % 1 === 0 ? Math.round(n) : n.toFixed(2)}`;
    }
  }

  // Non-USD currency codes: EUR 45, kr 280, 45 CHF (leading or trailing, space-separated)
  const CURRENCY_CODES = "EUR|GBP|CHF|SEK|DKK|NOK|JPY|CAD|AUD|NZD|kr";
  const leadCode = t.match(new RegExp(`^(${CURRENCY_CODES})\\s+(\\d[\\d,.]*)$`, "i"));
  const trailCode = !leadCode && t.match(new RegExp(`^(\\d[\\d,.]*)\\s+(${CURRENCY_CODES})$`, "i"));
  const codeMatch = leadCode ?? trailCode;
  if (codeMatch) {
    const rawCode = leadCode ? codeMatch[1]! : codeMatch[2]!;
    const code = rawCode.length === 2 ? rawCode.toLowerCase() : rawCode.toUpperCase();
    const amountStr = leadCode ? codeMatch[2]! : codeMatch[1]!;
    const n = Number.parseFloat(amountStr.replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 5 && n <= 20000) {
      return `${code} ${n % 1 === 0 ? Math.round(n) : n.toFixed(2)}`;
    }
  }

  // Bare number in reasonable wine-price range: 145, $145
  const bare = t.match(/^\$?(\d+)(?:\.\d{2})?$/);
  if (bare) {
    const n = Number.parseInt(bare[1]!, 10);
    if (n >= 5 && n <= 2000) return `$${n}`;
  }

  return null;
}

function extractTrailingInlinePrice(text: string): { name: string; price: string } | null {
  // Try slash/dash form first. This prevents greedy (.*) from assigning "33/" to
  // the name and matching only "145" as the price — the slash form forces the
  // regex engine to backtrack until the full "33/ 145" pattern is found.
  const slashMatch = text.match(/^(.*\S)\s+(\$?\d+\s*[\/–\-]\s*\$?\d+)$/);
  const match = slashMatch ?? text.match(/^(.*\S)\s+(\$?\d+(?:\.\d{2})?)$/);
  if (!match) return null;

  const name = match[1]!.trim();
  const rawPrice = match[2]!.trim();

  // Name must have alphabetic content
  if (!/[A-Za-z]/.test(name)) return null;

  // Do not misidentify a 4-digit year (1900-2030) as a price
  if (/^(19|20)\d{2}$/.test(rawPrice)) return null;

  const price = normalizeRawPrice(rawPrice);
  if (!price) return null;

  return { name, price };
}

function looksLikeWineName(text: string): boolean {
  if (/\b(19|20)\d{2}\b/.test(text)) return true;       // 4-digit vintage
  if (/[''`']\d{2}\b/.test(text)) return true;           // abbreviated vintage '22
  if (/[''"][^''"]{2,}[''"]/.test(text)) return true;    // quoted label 'Primal'
  if (/\s+-\s+/.test(text)) return true;                 // dash separator
  if (text.includes(",")) return true;                   // commas = wine info parts
  return false;
}

export function extractLeafTokens(html: string): LeafToken[] {
  // Strip noise elements
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Strip entire head section (title, meta, etc.) and known non-content elements.
    // Also strip Shopify/e-commerce custom elements (cart-drawer, menu-drawer).
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|form|figure|head|cart-drawer|cart-notification|menu-drawer)\b[\s\S]*?<\/\1>/gi, " ")
    // Strip screen-reader-only labels (e.g. Shopify's "Regular price", "Sale price" spans).
    .replace(/<[^>]+\bclass="[^"]*\bvisually-hidden\b[^"]*"[^>]*>[\s\S]*?<\/[a-z]+>/gi, " ");

  // Mark headings so we can classify them after stripping tags
  const marked = cleaned
    .replace(/<h[234][^>]*>/gi, "\n@@HEADING@@")
    .replace(/<\/h[234]>/gi, "\n")
    .replace(/<\/(div|section|article|p|li|ul|ol|tr|table|label|span|main)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decodeEntities(marked)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const tokens: LeafToken[] = [];

  for (const line of lines) {
    if (line.startsWith("@@HEADING@@")) {
      const text = line.slice("@@HEADING@@".length).trim();
      if (!text) continue;

      // Layer 1: strong wine-name signals → wine name (text token)
      // Layer 2: known section keyword → section token
      // Layer 3: word-count fallback — long headings (>4 words) are wine names, short are sections
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const isWine =
        looksLikeWineName(text) ||
        (!looksLikeSectionName(text) && wordCount > 4);

      if (isWine) {
        const inline = extractTrailingInlinePrice(text);
        if (inline) {
          tokens.push({ type: "text", text: inline.name });
          tokens.push({ type: "price", value: inline.price });
        } else {
          tokens.push({ type: "text", text });
        }
      } else {
        tokens.push({ type: "section", text });
      }
      continue;
    }

    // Bento/GetBento CMS splits prices across two lines via </span>:
    //   "glass $"  (label fragment — discard)
    //   "13 per Glass"  (glass price — discard; we take the bottle price instead)
    //   "bottle $"  (label fragment — discard)
    //   "64 per Bottle"  (bottle price — emit as price token)
    if (/^(glass|bottle)\s*\$\s*$/.test(line)) continue;
    const perUnitMatch = line.match(/^(\d+(?:\.\d{2})?)\s+per\s+(glass|bottle)$/i);
    if (perUnitMatch) {
      if (perUnitMatch[2]!.toLowerCase() === "bottle") {
        const p = normalizeRawPrice(perUnitMatch[1]!);
        if (p) tokens.push({ type: "price", value: p });
      }
      continue;
    }

    // Attempt inline trailing price extraction first
    const inline = extractTrailingInlinePrice(line);
    if (inline) {
      tokens.push({ type: "text", text: inline.name });
      tokens.push({ type: "price", value: inline.price });
      continue;
    }

    // Attempt standalone price
    const price = normalizeRawPrice(line);
    if (price) {
      tokens.push({ type: "price", value: price });
      continue;
    }

    // Non-heading text — may still be a section name (e.g. Squarespace divs)
    if (looksLikeSectionName(line)) {
      tokens.push({ type: "section", text: line });
      continue;
    }

    tokens.push({ type: "text", text: line });
  }

  return tokens;
}

/**
 * Returns true when a text snippet contains structural wine-menu signals:
 * a pipe separator, a 4-digit vintage year, or a quoted wine label.
 * Used to distinguish wine-entry text from tasting-note prose.
 */
function hasWineStructureSignals(text: string): boolean {
  if (text.includes("|")) return true;
  if (/\b(19|20)\d{2}\b/.test(text)) return true;
  if (/['''""][^'''""]{2,}['''""]/.test(text)) return true;
  return false;
}

export function groupTokensIntoItems(tokens: LeafToken[]): RawMenuItem[] {
  const items: RawMenuItem[] = [];
  let currentSection: string | null = null;
  let pendingPrice: string | null = null;
  let nameLines: string[] = [];
  // Set to true when we flush a name-before-price item (inline glass price extracted).
  // A bare price token that arrives with no accumulated name immediately after is
  // the dangling bottle price for the same item — discard it rather than attributing
  // it to the next wine (BINX-style "18 / $80" split across nodes).
  let justFlushedNameBeforePrice = false;
  // Set to true when we see a non-alphabetic "/" separator token. Signals that the
  // next price token is a bottle price and should upgrade the last item's price.
  let afterSlash = false;

  const flushItem = (price: string | null, nameBeforePrice = false): void => {
    if (nameLines.length === 0) return;
    const name = nameLines.join(" ").trim().replace(/\s*\|\s*/g, ", ");
    nameLines = [];
    if (!name || isNonWineLine(name)) {
      justFlushedNameBeforePrice = false;
      return;
    }
    if (isNonWineSection(currentSection)) {
      justFlushedNameBeforePrice = false;
      return;
    }
    justFlushedNameBeforePrice = nameBeforePrice;
    items.push({ name, price, section: currentSection, tab: null });
  };

  for (const token of tokens) {
    if (token.type === "section") {
      flushItem(pendingPrice);
      pendingPrice = null;
      justFlushedNameBeforePrice = false;
      afterSlash = false;
      currentSection = token.text;
      continue;
    }

    if (token.type === "price") {
      if (nameLines.length > 0) {
        if (pendingPrice !== null) {
          // Price-before-name pattern: had price → saw name → now another price
          // Flush the accumulated name with the saved pending price
          flushItem(pendingPrice);
          pendingPrice = token.value; // this price is for the next item
        } else {
          // Name-before-price pattern
          flushItem(token.value, true);
          pendingPrice = null;
        }
      } else {
        if (justFlushedNameBeforePrice && afterSlash) {
          // Dangling bottle price after a confirmed "/" separator — upgrade the
          // last item's price if the bottle price is larger than the glass price.
          const lastItem = items[items.length - 1];
          if (lastItem) {
            const lastNum = Number.parseInt((lastItem.price ?? "0").replace(/\D/g, ""), 10);
            const newNum = Number.parseInt(token.value.replace(/\D/g, ""), 10);
            if (Number.isFinite(newNum) && newNum > lastNum) {
              lastItem.price = token.value;
            }
          }
          afterSlash = false;
        } else if (!justFlushedNameBeforePrice) {
          // No name accumulated yet — save as pending price for the next wine.
          pendingPrice = token.value;
        }
      }
      continue;
    }

    // Text token
    if (isNonWineLine(token.text)) {
      if (!/[A-Za-z]/.test(token.text)) {
        // Pure structural separator (/, $, ·, etc.) — skip without flushing so
        // the current wine name accumulation is not interrupted.
        // Set afterSlash when the separator is "/" so the next price token can
        // be identified as a dangling bottle price and upgrade the glass price.
        if (token.text.includes("/")) {
          afterSlash = true;
        }
        // Do NOT reset justFlushedNameBeforePrice here: the "/" appears between
        // the inline glass price and the dangling bottle price in split-node menus.
        continue;
      }
      // Substantive non-wine text — flush and reset.
      flushItem(pendingPrice);
      pendingPrice = null;
      justFlushedNameBeforePrice = false;
      afterSlash = false;
      continue;
    }

    // If we already have name lines and the new token looks like a fresh title,
    // flush the current block before starting the new one.
    // Exception: afterSlash means this token is a continuation (e.g., second
    // varietal in "Cab Sauv / Zinfandel" split across nodes).
    if (nameLines.length > 0 && !afterSlash && looksLikeTitleLine(token.text)) {
      flushItem(pendingPrice);
      pendingPrice = null;
    }

    // Shopify Dawn and similar themes repeat the product name in two separate h3 tags
    // (one inside the image overlay, one in the info section). When the incoming text
    // exactly matches the first line of the current block, treat it as a duplicate and
    // flush the current block before starting fresh.
    if (nameLines.length > 0 && token.text === nameLines[0]) {
      flushItem(pendingPrice);
      pendingPrice = null;
    }

    // Skip tasting-note-like text when the accumulated name already has wine
    // structure signals. Tasting notes lack pipe separators, vintage years, and
    // quoted labels — so they would otherwise merge into the wine name.
    if (
      nameLines.length > 0 &&
      !afterSlash &&
      hasWineStructureSignals(nameLines.join(" ")) &&
      !hasWineStructureSignals(token.text)
    ) {
      continue;
    }

    afterSlash = false;
    justFlushedNameBeforePrice = false;
    nameLines.push(token.text);
  }

  flushItem(pendingPrice);

  // Deduplicate: items with the same normalised name AND same price are parsing
  // artifacts (e.g. Squarespace price-top/price-bottom duplication). Keep the
  // last occurrence — it appears after the section header and therefore has the
  // correct section context. Items with the same name but different prices are
  // intentional (e.g., glass vs. bottle listings) and are kept as-is.
  const lastIndexByKey = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const key = `${items[i]!.name.toLowerCase().replace(/\s+/g, " ").trim()}||${items[i]!.price ?? ""}`;
    lastIndexByKey.set(key, i);
  }
  return items.filter((_, i) => {
    const key = `${items[i]!.name.toLowerCase().replace(/\s+/g, " ").trim()}||${items[i]!.price ?? ""}`;
    return lastIndexByKey.get(key) === i;
  });
}

/**
 * Removes priceless duplicates that have a priced counterpart with the same
 * name and section. This handles card-based layouts (e.g. Shopify Dawn) that
 * render the product heading twice — once inside the image overlay (no price
 * nearby) and once in the info section (with price).
 *
 * Items with the same name but *different* prices are left alone — they are
 * intentional (e.g. glass vs. bottle listings on a restaurant wine menu).
 */
function removePricelessDuplicates(items: RawMenuItem[]): RawMenuItem[] {
  const keyedWithPrice = new Set<string>();
  for (const item of items) {
    if (item.price !== null) {
      const key = `${item.section ?? ""}::${item.name.toLowerCase().replace(/\s+/g, " ").trim()}`;
      keyedWithPrice.add(key);
    }
  }
  return items.filter((item) => {
    if (item.price !== null) return true;
    const key = `${item.section ?? ""}::${item.name.toLowerCase().replace(/\s+/g, " ").trim()}`;
    return !keyedWithPrice.has(key);
  });
}

function extractMenuCandidates(html: string): WineCandidate[] {
  const tokens = extractLeafTokens(html);
  const items = removePricelessDuplicates(groupTokensIntoItems(tokens));
  return items
    .map((item) => buildCandidateFromItem(item))
    .filter((c): c is WineCandidate => c !== null);
}

function extractPaginationUrls(html: string, baseUrl: URL): URL[] {
  const urls: URL[] = [];
  const seen = new Set<string>();
  const hrefPattern = /href="([^"#]*[?&]page=\d+[^"]*)"/gi;
  let match;
  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      const pageUrl = new URL(match[1]!, baseUrl);
      pageUrl.hash = "";
      const key = pageUrl.toString();
      if (!seen.has(key)) {
        seen.add(key);
        urls.push(pageUrl);
      }
    } catch {
      // invalid URL, skip
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

async function fetchHtmlDocument(url: URL): Promise<{ url: URL; html: string }> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,*/*;q=0.5",
      "user-agent": "WineRecBot/0.1 (+https://localhost)",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL with ${response.status}`);
  }

  const resolvedUrl = response.url ? new URL(response.url) : new URL(url.toString());
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/pdf") || resolvedUrl.pathname.toLowerCase().endsWith(".pdf")) {
    throw new Error("PDF URLs are not yet supported; use an uploaded PDF instead");
  }

  return { url: resolvedUrl, html: await response.text() };
}

function normalizeHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function canonicalUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  return normalized.toString();
}

function cleanInlineText(value: string | null): string | null {
  if (!value) return null;

  const text = decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+/g, " - ")
    .trim();

  return text || null;
}

function extractFirst(input: string, pattern: RegExp): string | null {
  const match = input.match(pattern);
  return match?.[1] ?? null;
}


function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", copy: "©", emsp: " ", ensp: " ",
    gt: ">", lt: "<", nbsp: " ", ndash: "-", mdash: "-",
    quot: '"', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
    thinsp: " ", eacute: "é", Eacute: "É",
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, value: string) => {
    if (value.startsWith("#x") || value.startsWith("#X")) {
      const cp = Number.parseInt(value.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : entity;
    }
    if (value.startsWith("#")) {
      const cp = Number.parseInt(value.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : entity;
    }
    return named[value] ?? entity;
  });
}
