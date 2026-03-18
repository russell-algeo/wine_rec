import type { WineCandidate } from "@wine-rec/contracts";

import { createOcrProvider } from "../providers/ocr.js";
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
  const doc = await fetchHtmlDocument(new URL(sourceUrl));
  const strategy = detectStrategy(doc.html);

  if (strategy === "ecommerce") {
    return extractEcommerceCandidates(doc.html, doc.url);
  }

  return extractMenuCandidates(doc.html);
}

// ---------------------------------------------------------------------------
// Strategy detection
// ---------------------------------------------------------------------------

function detectStrategy(html: string): "ecommerce" | "menu" {
  // Shopify / generic product-collection pages: links to /products/<slug>
  // combined with price-item class elements.
  const hasProductLinks = /href=["'][^"']*\/products\/[^"']+["']/i.test(html);
  const hasPriceItemClass = /class=["'][^"']*\bprice-item\b[^"']*["']/i.test(html);
  return hasProductLinks && hasPriceItemClass ? "ecommerce" : "menu";
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
]);

const wineSectionKeywords = new Set([
  "red", "white", "orange", "rose", "rosé", "sparkling", "champagne",
  "sherry", "sake", "sweet", "wine", "wines",
  "glass", "bottle",
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
  // Match a price at the very end: "Wine Name text 16/72" or "Wine Name 145"
  const match = text.match(/^(.*\S)\s+(\$?\d+(?:\s*[/\-–]\s*\$?\d+)?)$/);
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
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|form|figure)\b[\s\S]*?<\/\1>/gi, " ");

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

export function groupTokensIntoItems(tokens: LeafToken[]): RawMenuItem[] {
  const items: RawMenuItem[] = [];
  let currentSection: string | null = null;
  let pendingPrice: string | null = null;
  let nameLines: string[] = [];

  const flushItem = (price: string | null): void => {
    if (nameLines.length === 0) return;
    const name = nameLines.join(" ").trim();
    nameLines = [];
    if (!name || isNonWineLine(name)) return;
    if (isNonWineSection(currentSection)) return;
    items.push({ name, price, section: currentSection, tab: null });
  };

  for (const token of tokens) {
    if (token.type === "section") {
      flushItem(pendingPrice);
      pendingPrice = null;
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
          flushItem(token.value);
          pendingPrice = null;
        }
      } else {
        // No name accumulated yet — price is ahead of name
        pendingPrice = token.value;
      }
      continue;
    }

    // Text token
    if (isNonWineLine(token.text)) {
      flushItem(pendingPrice);
      pendingPrice = null;
      continue;
    }

    // If we already have name lines and the new token looks like a fresh title,
    // flush the current block before starting the new one.
    if (nameLines.length > 0 && looksLikeTitleLine(token.text)) {
      flushItem(pendingPrice);
      pendingPrice = null;
    }

    nameLines.push(token.text);
  }

  flushItem(pendingPrice);
  return items;
}

function extractMenuCandidates(html: string): WineCandidate[] {
  const tokens = extractLeafTokens(html);
  const items = groupTokensIntoItems(tokens);
  return items
    .map((item) => buildCandidateFromItem(item))
    .filter((c): c is WineCandidate => c !== null);
}

// ---------------------------------------------------------------------------
// E-commerce extraction (Shopify-style product collection pages)
// ---------------------------------------------------------------------------

async function extractEcommerceCandidates(html: string, pageUrl: URL): Promise<WineCandidate[]> {
  const allPages = [{ url: pageUrl, html }];
  const visitedUrls = new Set([canonicalUrl(pageUrl)]);

  const paginationUrls = extractPaginationUrls(pageUrl, html);
  for (const nextUrl of paginationUrls) {
    const key = canonicalUrl(nextUrl);
    if (visitedUrls.has(key) || allPages.length >= 24) break;
    visitedUrls.add(key);
    allPages.push(await fetchHtmlDocument(nextUrl));
  }

  const seenKeys = new Set<string>();
  const items: RawMenuItem[] = [];

  for (const page of allPages) {
    const color = inferColorFromUrl(page.url);
    for (const item of extractEcommerceItemsFromPage(page.html)) {
      const key = `${item.name}::${item.price}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      items.push({ ...item, section: color, tab: null });
    }
  }

  return items
    .map((item) => buildCandidateFromItem(item))
    .filter((c): c is WineCandidate => c !== null);
}

function extractEcommerceItemsFromPage(html: string): Array<{ name: string; price: string | null }> {
  const blocks = collectBalancedDivBlocks(
    html,
    /<div[^>]+class=["'][^"']*\bcard\b[^"']*\bcard--standard\b[^"']*["'][^>]*>/gi,
  );
  const results: Array<{ name: string; price: string | null }> = [];

  for (const block of blocks) {
    const rawTitle = cleanInlineText(
      extractFirst(
        block,
        new RegExp(
          `<a[^>]+href="/products/[^"]+"[^>]+${classTokenMatcher("full-unstyled-link")}[^>]*>([\\s\\S]*?)<\\/a>`,
          "i",
        ),
      ),
    );
    const rawPrice = cleanInlineText(
      extractFirst(
        block,
        new RegExp(`<span[^>]+${classTokenMatcher("price-item")}[^>]*>([\\s\\S]*?)<\\/span>`, "i"),
      ),
    );

    if (!rawTitle) continue;
    const price = rawPrice ? (normalizeRawPrice(rawPrice) ?? null) : null;
    results.push({ name: rawTitle, price });
  }

  return results;
}

function extractPaginationUrls(baseUrl: URL, html: string): URL[] {
  const discovered = new Map<number, URL>();
  const hrefPattern = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefPattern.exec(html))) {
    const href = match[1];
    if (!href) continue;

    let nextUrl: URL;
    try {
      nextUrl = new URL(href, baseUrl);
    } catch {
      continue;
    }

    if (normalizeHost(nextUrl) !== normalizeHost(baseUrl)) continue;
    if (nextUrl.pathname !== baseUrl.pathname) continue;

    const pageValue = nextUrl.searchParams.get("page");
    if (!pageValue) continue;

    const pageNumber = Number(pageValue);
    if (!Number.isInteger(pageNumber) || pageNumber < 2) continue;

    nextUrl.hash = "";
    discovered.set(pageNumber, nextUrl);
  }

  return [...discovered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, url]) => url);
}

function inferColorFromUrl(url: URL): string | null {
  const path = url.pathname.toLowerCase();
  if (path.includes("red")) return "RED";
  if (path.includes("white")) return "WHITE";
  if (path.includes("rose") || path.includes("rosé")) return "ROSE";
  if (path.includes("sparkling") || path.includes("champagne")) return "SPARKLING";
  if (path.includes("orange")) return "ORANGE";
  return null;
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

function classTokenMatcher(token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `class=["'](?:[^"']*\\s)?${escaped}(?:\\s[^"']*)?["']`;
}

function collectBalancedDivBlocks(input: string, pattern: RegExp): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input))) {
    const block = sliceBalancedDiv(input, match.index);
    if (!block) continue;
    blocks.push(block);
    pattern.lastIndex = match.index + block.length;
  }

  return blocks;
}

function sliceBalancedDiv(input: string, startIndex: number): string | null {
  const divPattern = /<\/?div\b[^>]*>/gi;
  divPattern.lastIndex = startIndex;

  let depth = 0;
  let firstFound = false;
  let match: RegExpExecArray | null;

  while ((match = divPattern.exec(input))) {
    if (!firstFound) {
      firstFound = true;
      depth = 1;
      continue;
    }

    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return input.slice(startIndex, divPattern.lastIndex);
    } else {
      depth += 1;
    }
  }

  return null;
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
