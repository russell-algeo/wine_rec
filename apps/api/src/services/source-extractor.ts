import type { SourceType } from "@wine-rec/contracts";

import { createOcrProvider } from "../providers/ocr.js";

const collectionPaginationLimit = 24;
const pricePattern = /^\$\d+(?:\.\d{2})?$/;
const wineSectionHeadings = new Map([
  ["sparkling", "sparkling"],
  ["wine", "wine"],
  ["white", "white"],
  ["orange", "orange"],
  ["pink", "rose"],
  ["rose", "rose"],
  ["rosé", "rose"],
  ["red", "red"],
]);
const nonWineSectionHeadings = new Set([
  "cocktails",
  "beerzeroproof",
  "vermouthmore",
  "housespecials",
  "snacks",
  "happyhour",
  "sherry",
  "sweet",
]);
const genericMenuGroupingTitles = new Set([
  "bytheglass",
  "bythebottle",
  "bottlelist",
  "wine",
  "wines",
]);
const wineCategoryLegendHints = ["sparkling", "white", "orange", "pink", "rose", "red", "cider"];

export async function extractSourceText(input: {
  sourceType: SourceType;
  filename: string;
  mimeType: string;
  storagePath: string;
  sourceUrl?: string;
  fileBuffer?: Buffer;
}): Promise<string> {
  if (input.sourceUrl || input.sourceType === "url-html" || input.sourceType === "url-pdf") {
    if (!input.sourceUrl) {
      throw new Error("URL analysis is missing source metadata");
    }

    return extractTextFromUrl(input.sourceUrl);
  }

  const ocrProvider = createOcrProvider();
  return ocrProvider.extractText(
    input.fileBuffer
      ? {
          ...input,
          buffer: input.fileBuffer,
        }
      : input,
  );
}

export async function extractTextFromUrl(sourceUrl: string): Promise<string> {
  const initialDocument = await fetchHtmlDocument(new URL(sourceUrl));
  const initialHost = normalizeHost(initialDocument.url);

  if (initialHost === "grahamwine.co") {
    const entries = await extractPaginatedGrahamCollectionEntries(initialDocument);
    if (entries.length > 0) {
      return buildCollectionText(initialDocument.url, entries);
    }
  }

  return extractTextFromHtml(initialDocument.url.toString(), initialDocument.html);
}

export function extractTextFromHtml(sourceUrl: string, html: string): string {
  const url = new URL(sourceUrl);
  const host = normalizeHost(url);

  if (host === "grahamwine.co") {
    const entries = extractGrahamCollectionEntries(html);
    if (entries.length > 0) {
      return buildCollectionText(url, entries);
    }
  }

  if (host === "liseandvito.com") {
    const extracted = extractLiseAndVitoMenuText(html);
    if (extracted) {
      return extracted;
    }

    return "";
  }

  return htmlToLines(html).join("\n");
}

async function extractPaginatedGrahamCollectionEntries(initialDocument: {
  url: URL;
  html: string;
}): Promise<string[]> {
  const pending = [initialDocument];
  const visitedUrls = new Set<string>();
  const queuedUrls = new Set<string>([canonicalUrl(initialDocument.url)]);
  const seenEntries = new Set<string>();
  const entries: string[] = [];

  while (pending.length > 0 && visitedUrls.size < collectionPaginationLimit) {
    const current = pending.shift()!;
    const currentKey = canonicalUrl(current.url);
    if (visitedUrls.has(currentKey)) {
      continue;
    }

    visitedUrls.add(currentKey);

    for (const entry of extractGrahamCollectionEntries(current.html)) {
      if (seenEntries.has(entry)) {
        continue;
      }

      seenEntries.add(entry);
      entries.push(entry);
    }

    const paginationUrls = extractPaginationUrls(current.url, current.html);
    for (const paginationUrl of paginationUrls) {
      const paginationKey = canonicalUrl(paginationUrl);
      if (queuedUrls.has(paginationKey) || visitedUrls.has(paginationKey)) {
        continue;
      }

      queuedUrls.add(paginationKey);
      pending.push(await fetchHtmlDocument(paginationUrl));
    }
  }

  return entries;
}

function extractGrahamCollectionEntries(html: string): string[] {
  const blocks = collectBalancedDivBlocks(
    html,
    /<div[^>]+class=["'][^"']*\bcard\b[^"']*\bcard--standard\b[^"']*["'][^>]*>/gi,
  );
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const title = cleanInlineText(
      extractFirst(
        block,
        new RegExp(
          `<a[^>]+href="/products/[^"]+"[^>]+${classTokenMatcher("full-unstyled-link")}[^>]*>([\\s\\S]*?)<\\/a>`,
          "i",
        ),
      ),
    );
    const price = normalizePrice(
      cleanInlineText(
        extractFirst(
          block,
          new RegExp(`<span[^>]+${classTokenMatcher("price-item")}[^>]*>([\\s\\S]*?)<\\/span>`, "i"),
        ),
      ),
    );

    if (!title || !price) {
      continue;
    }

    const key = `${title}::${price}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push(`${title}\n${price}`);
  }

  return entries;
}

function buildCollectionText(url: URL, entries: string[]): string {
  const heading = inferCollectionHeading(url);
  return heading ? [heading, ...entries].join("\n\n") : entries.join("\n\n");
}

function inferCollectionHeading(url: URL): string | null {
  const path = url.pathname.toLowerCase();
  if (path.includes("red")) return "RED";
  if (path.includes("white")) return "WHITE";
  if (path.includes("rose") || path.includes("ros")) return "ROSE";
  if (path.includes("sparkling") || path.includes("champagne")) return "SPARKLING";
  if (path.includes("orange")) return "ORANGE";
  return null;
}

function extractLiseAndVitoMenuText(html: string): string | null {
  const panels = collectMenuTabPanels(html);
  const panelLines = panels
    .map((panel) => ({
      label: panel.label,
      lines: tokenizeHtmlText(panel.html),
    }))
    .filter((panel) => panelContainsWineSections(panel.lines));

  if (panelLines.length === 0) {
    return null;
  }
  const entries: string[] = [];

  for (const panel of panelLines) {
    entries.push(`@@TAB: ${panel.label}`);

    let currentSection: string | null = null;
    for (let index = 0; index < panel.lines.length; index += 1) {
      const line = panel.lines[index]!;
      const headingKey = canonicalHeading(line);

      if (wineSectionHeadings.has(headingKey)) {
        currentSection = line.trim();
        entries.push(`@@SECTION: ${currentSection}`);
        continue;
      }

      if (nonWineSectionHeadings.has(headingKey)) {
        currentSection = null;
        continue;
      }

      if (!currentSection) {
        continue;
      }

      const priceRead = readSplitPrice(panel.lines, index);
      if (!priceRead) {
        continue;
      }

      const title = panel.lines[priceRead.nextIndex];
      if (!title || looksLikeSectionBoundary(title) || looksLikePriceToken(title)) {
        continue;
      }

      const descriptionCandidate = panel.lines[priceRead.nextIndex + 1];
      const description =
        descriptionCandidate &&
        !looksLikeSectionBoundary(descriptionCandidate) &&
        !looksLikePriceToken(descriptionCandidate)
          ? descriptionCandidate
          : null;

      if (looksLikeMenuGroupingEntry(title, description)) {
        index = description ? priceRead.nextIndex + 1 : priceRead.nextIndex;
        continue;
      }

      entries.push(
        description ? `${title}\n${description}\n${priceRead.price}` : `${title}\n${priceRead.price}`,
      );
      index = description ? priceRead.nextIndex + 1 : priceRead.nextIndex;
    }
  }

  return entries.length > 0 ? entries.join("\n\n") : null;
}

function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(div|section|article|header|footer|main|nav|p|li|ul|ol|h[1-6]|tr|table|label|span)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function tokenizeHtmlText(html: string): string[] {
  return decodeEntities(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cleanInlineText(value: string | null): string | null {
  if (!value) {
    return null;
  }

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

function normalizePrice(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.replace(/\s+/g, "").match(/\$(\d+(?:\.\d{2})?)/);
  if (!match) {
    return null;
  }

  const price = `$${match[1]}`;
  return pricePattern.test(price) ? price : null;
}

function extractFirst(input: string, pattern: RegExp): string | null {
  const match = input.match(pattern);
  return match?.[1] ?? null;
}

function classTokenMatcher(token: string): string {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `class=["'](?:[^"']*\\s)?${escapedToken}(?:\\s[^"']*)?["']`;
}

function canonicalHeading(input: string): string {
  return input.toLowerCase().replace(/[^a-zé]/g, "");
}

function looksLikeSectionBoundary(input: string): boolean {
  const canonical = canonicalHeading(input);
  return wineSectionHeadings.has(canonical) || nonWineSectionHeadings.has(canonical);
}

function looksLikePriceToken(input: string): boolean {
  return input === "$" || /^\$?\d+(?:\.\d{2})?$/.test(input);
}

function panelContainsWineSections(lines: string[]): boolean {
  return lines.some((line) => wineSectionHeadings.has(canonicalHeading(line)));
}

function looksLikeMenuGroupingEntry(title: string, description: string | null): boolean {
  const normalizedTitle = canonicalHeading(title);
  if (!genericMenuGroupingTitles.has(normalizedTitle) || !description) {
    return false;
  }

  const normalizedDescription = description
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const matchedHints = wineCategoryLegendHints.filter((hint) => normalizedDescription.includes(hint));
  return matchedHints.length >= 2;
}

function readSplitPrice(
  lines: string[],
  startIndex: number,
): { price: string; nextIndex: number } | null {
  const current = lines[startIndex];
  if (!current) {
    return null;
  }

  if (pricePattern.test(current)) {
    return { price: current, nextIndex: startIndex + 1 };
  }

  if (current === "$") {
    const amount = lines[startIndex + 1];
    if (amount && /^\d+(?:\.\d{2})?$/.test(amount)) {
      return {
        price: `$${amount}`,
        nextIndex: startIndex + 2,
      };
    }
  }

  return null;
}

function extractPaginationUrls(baseUrl: URL, html: string): URL[] {
  const discovered = new Map<number, URL>();
  const hrefPattern = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefPattern.exec(html))) {
    const href = match[1];
    if (!href) {
      continue;
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(href, baseUrl);
    } catch {
      continue;
    }

    if (normalizeHost(nextUrl) !== normalizeHost(baseUrl)) {
      continue;
    }

    if (nextUrl.pathname !== baseUrl.pathname) {
      continue;
    }

    const pageValue = nextUrl.searchParams.get("page");
    if (!pageValue) {
      continue;
    }

    const pageNumber = Number(pageValue);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      continue;
    }

    if (pageNumber === 1) {
      continue;
    }

    nextUrl.hash = "";
    discovered.set(pageNumber, nextUrl);
  }

  return [...discovered.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, url]) => url);
}

async function fetchHtmlDocument(url: URL): Promise<{ url: URL; html: string }> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
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

  return {
    url: resolvedUrl,
    html: await response.text(),
  };
}

function normalizeHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function canonicalUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  return normalized.toString();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectMenuTabPanels(html: string): Array<{ label: string; html: string }> {
  const panels: Array<{ label: string; html: string }> = [];
  const panelPattern =
    /<div(?=[^>]*role=["']tabpanel["'])(?=[^>]*aria-label=["']([^"']+)["'])[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = panelPattern.exec(html))) {
    const label = cleanInlineText(match[1] ?? null);
    const panelHtml = sliceBalancedDiv(html, match.index);
    if (!label || !panelHtml) {
      continue;
    }

    panels.push({ label, html: panelHtml });
    panelPattern.lastIndex = match.index + panelHtml.length;
  }

  return panels;
}

function collectBalancedDivBlocks(input: string, pattern: RegExp): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input))) {
    const block = sliceBalancedDiv(input, match.index);
    if (!block) {
      continue;
    }

    blocks.push(block);
    pattern.lastIndex = match.index + block.length;
  }

  return blocks;
}

function extractBalancedDivByPattern(input: string, pattern: RegExp): string | null {
  const match = pattern.exec(input);
  if (!match) {
    return null;
  }

  return sliceBalancedDiv(input, match.index);
}

function sliceBalancedDiv(input: string, startIndex: number): string | null {
  const divPattern = /<\/?div\b[^>]*>/gi;
  divPattern.lastIndex = startIndex;

  let depth = 0;
  let firstTokenFound = false;
  let match: RegExpExecArray | null;

  while ((match = divPattern.exec(input))) {
    const token = match[0];

    if (!firstTokenFound) {
      firstTokenFound = true;
      depth = 1;
      continue;
    }

    if (token.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, divPattern.lastIndex);
      }
      continue;
    }

    depth += 1;
  }

  return null;
}

function decodeEntities(input: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    copy: "©",
    emsp: " ",
    ensp: " ",
    gt: ">",
    lt: "<",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    quot: "\"",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    thinsp: " ",
    eacute: "é",
    Eacute: "É",
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, value: string) => {
    if (value.startsWith("#x") || value.startsWith("#X")) {
      const codePoint = Number.parseInt(value.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    if (value.startsWith("#")) {
      const codePoint = Number.parseInt(value.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    return namedEntities[value] ?? entity;
  });
}
