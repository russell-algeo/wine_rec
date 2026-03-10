import { chromium, type Browser, type BrowserContext } from "playwright";

import { appConfig } from "../config.js";

export interface SearchHit {
  wineId: number;
  wineryName: string;
  wineName: string;
  regionAndCountry: string;
  rating: number | null;
  imageUrl: string | null;
  vintagePageUrl: string;
  year: number | null;
}

export type VivinoRatingSource = "vintage" | "wine";

export interface VivinoAggregateRating {
  rating: number | null;
  ratingCount: number | null;
  ratingSource: VivinoRatingSource | null;
}

export interface VivinoVintagePageMeta {
  aggregateRating: VivinoAggregateRating | null;
  imageUrl: string | null;
}

type VivinoStatistics = {
  ratings_average?: number | null;
  ratings_count?: number | null;
};

type VivinoVintagePageInformation = {
  vintage?: {
    statistics?: VivinoStatistics | null;
  } | null;
  wine?: {
    statistics?: VivinoStatistics | null;
  } | null;
};

type VivinoVintagePageEvaluation = {
  pageInformation: VivinoVintagePageInformation | null;
  imageUrl: string | null;
};

function normalizeVivinoImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function isVivinoPlaceholderImageUrl(value: string | null | undefined): boolean {
  const normalized = normalizeVivinoImageUrl(value);
  return normalized != null && /\/assets\/bottleShot\/fallback_\d+\.png(?:$|\?)/i.test(normalized);
}

export function pickPreferredVivinoImageUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const normalized = normalizeVivinoImageUrl(candidate);
    if (!normalized || isVivinoPlaceholderImageUrl(normalized)) continue;
    return normalized;
  }

  return null;
}

function normalizeAggregateRating(
  stats: VivinoStatistics | null | undefined,
  ratingSource: VivinoRatingSource,
): VivinoAggregateRating | null {
  const rating = stats?.ratings_average;
  const ratingCount = stats?.ratings_count;
  if (
    rating == null ||
    !Number.isFinite(rating) ||
    rating <= 0 ||
    ratingCount == null ||
    !Number.isFinite(ratingCount) ||
    ratingCount <= 0
  ) {
    return null;
  }

  return {
    rating,
    ratingCount: Math.round(ratingCount),
    ratingSource,
  };
}

export function pickVivinoAggregateRating(
  info: VivinoVintagePageInformation | null | undefined,
): VivinoAggregateRating {
  const wineAggregate = normalizeAggregateRating(info?.wine?.statistics, "wine");
  if (wineAggregate) {
    return wineAggregate;
  }

  return (
    normalizeAggregateRating(info?.vintage?.statistics, "vintage") ?? {
      rating: null,
      ratingCount: null,
      ratingSource: null,
    }
  );
}

// Keep browser-side evaluators as raw strings so tsx/esbuild helpers like `__name`
// are not serialized into the page context and crash `page.evaluate(...)`.
const SEARCH_HITS_EVALUATION = String.raw`
(() => {
  const extractBackgroundImageUrl = (value) => {
    if (!value) return null;
    const match = value.match(/url\((['"]?)(.*?)\1\)/i);
    return match && match[2] ? match[2].trim() : null;
  };

  const pickImageUrl = (...candidates) => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const normalized = trimmed.startsWith("//") ? "https:" + trimmed : trimmed;
      if (!/^https?:\/\//i.test(normalized)) continue;
      if (/\/assets\/bottleShot\/fallback_\d+\.png(?:$|\?)/i.test(normalized)) {
        continue;
      }
      return normalized;
    }

    return null;
  };

  const cards = Array.from(document.querySelectorAll('[class*="WineCard"]'));
  const results = [];

  for (const card of cards) {
    const link = card.querySelector('a[data-testid="vintagePageLink"]');
    if (!link) continue;

    const href = link.getAttribute("href") || "";
    const idMatch = href.match(/\/w\/(\d+)/);
    const yearMatch = href.match(/[?&]year=(\d{4})/);
    const wineIdText = idMatch && idMatch[1];
    if (!wineIdText) continue;

    const wineId = parseInt(wineIdText, 10);
    const yearText = yearMatch && yearMatch[1];
    const year = yearText ? parseInt(yearText, 10) : null;
    const vintagePageUrl = new URL(href, window.location.origin).toString();

    const wineryEl = card.querySelector('[class*="wineInfoVintage__truncate"]');
    const nameEl = card.querySelector('[class*="wineInfoVintage__vintage"]');
    const regionEl = card.querySelector('[class*="wineInfoLocation__regionAndCountry"]');
    const ratingEl = card.querySelector('[class*="vivinoRating__averageValue"]');
    const bottleSection = card.querySelector('[class*="bottleSection"]') || card;
    const imageEl = bottleSection.querySelector(
      'img[data-testid="deferredHiddenImage"], img[src], img[data-src]'
    );
    const bottleVisual = bottleSection.querySelector(
      '[class*="bottleShot"], [class*="wineLabel"], [role="img"][aria-label]'
    );

    const wineryName = (wineryEl && wineryEl.textContent || "").trim();
    const wineName = (nameEl && nameEl.textContent || "").trim();
    const regionAndCountry = (regionEl && regionEl.textContent || "").trim();
    const ratingText = (ratingEl && ratingEl.textContent || "").trim();
    const rating = ratingText ? parseFloat(ratingText) : null;
    const backgroundImageUrl = bottleVisual
      ? extractBackgroundImageUrl(
          bottleVisual.style.backgroundImage ||
            window.getComputedStyle(bottleVisual).backgroundImage,
        )
      : null;
    const imageUrl = pickImageUrl(
      backgroundImageUrl,
      imageEl && imageEl.currentSrc,
      imageEl && imageEl.getAttribute("src") && imageEl.getAttribute("src").trim(),
      imageEl && imageEl.getAttribute("data-src") && imageEl.getAttribute("data-src").trim(),
    );

    if (!wineryName && !wineName) continue;

    results.push({
      wineId,
      wineryName,
      wineName,
      regionAndCountry,
      rating: rating !== null && Number.isFinite(rating) ? rating : null,
      imageUrl,
      vintagePageUrl,
      year,
    });
  }

  return results;
})()
`;

const VINTAGE_PAGE_META_EVALUATION = String.raw`
(() => {
  const preloadedState = window.__PRELOADED_STATE__ || {};
  const state =
    preloadedState.vintagePageInformation ||
    preloadedState.winePageInformation ||
    null;
  const imageEl =
    document.querySelector('picture[class*="wineLabel-module__picture"] img') ||
    document.querySelector('img[class*="wineLabel-module__image"]') ||
    document.querySelector('[class*="wineLabel-module__picture"] img');

  return {
    pageInformation: state
      ? {
          vintage: state.vintage
            ? {
                statistics: state.vintage.statistics || null,
              }
            : null,
          wine: state.wine
            ? {
                statistics: state.wine.statistics || null,
              }
            : null,
        }
      : null,
    imageUrl:
      (imageEl && imageEl.currentSrc) ||
      (imageEl && imageEl.getAttribute("src") && imageEl.getAttribute("src").trim()) ||
      null,
  };
})()
`;

export class VivinoBrowser {
  private static instance: VivinoBrowser | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  static getInstance(): VivinoBrowser {
    if (!VivinoBrowser.instance) {
      VivinoBrowser.instance = new VivinoBrowser();
    }
    return VivinoBrowser.instance;
  }

  async search(query: string): Promise<SearchHit[]> {
    const context = await this.getOrLaunchContext();
    const page = await context.newPage();

    try {
      await page.goto(
        `https://www.vivino.com/search/wines?q=${encodeURIComponent(query)}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        },
      );

      await page.waitForSelector('[class*="WineCard"]', {
        timeout: 10_000,
      }).catch(() => null);

      const rawHits = await page.evaluate(SEARCH_HITS_EVALUATION);
      const hits = Array.isArray(rawHits) ? (rawHits as SearchHit[]) : [];
      const normalizedHits = hits.map((hit) => ({
        ...hit,
        imageUrl: pickPreferredVivinoImageUrl(hit.imageUrl),
      }));

      console.log(
        "[vivino-browser] Search for %j returned %d hits",
        query,
        normalizedHits.length,
      );
      return normalizedHits;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("[vivino-browser] Search failed for %j: %s", query, message);
      if (message.includes("Target page, context or browser has been closed")) {
        this.context = null;
        this.browser = null;
      }
      return [];
    } finally {
      await page.close().catch(() => null);
    }
  }

  async fetchVintagePageMeta(vintagePageUrl: string): Promise<VivinoVintagePageMeta | null> {
    const context = await this.getOrLaunchContext();
    const page = await context.newPage();

    try {
      await page.goto(vintagePageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const rawEvaluation = await page.evaluate(VINTAGE_PAGE_META_EVALUATION);
      const evaluation =
        rawEvaluation && typeof rawEvaluation === "object"
          ? (rawEvaluation as VivinoVintagePageEvaluation)
          : { pageInformation: null, imageUrl: null };

      const aggregateRating = pickVivinoAggregateRating(evaluation.pageInformation);
      return {
        aggregateRating:
          aggregateRating.rating !== null && aggregateRating.ratingCount !== null
            ? aggregateRating
            : null,
        imageUrl: pickPreferredVivinoImageUrl(evaluation.imageUrl),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        "[vivino-browser] Vintage page fetch failed for %j: %s",
        vintagePageUrl,
        message,
      );
      if (message.includes("Target page, context or browser has been closed")) {
        this.context = null;
        this.browser = null;
      }
      return null;
    } finally {
      await page.close().catch(() => null);
    }
  }

  async fetchAggregateRating(vintagePageUrl: string): Promise<VivinoAggregateRating | null> {
    return (await this.fetchVintagePageMeta(vintagePageUrl))?.aggregateRating ?? null;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => null);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => null);
      this.browser = null;
    }
  }

  private async getOrLaunchContext(): Promise<BrowserContext> {
    if (this.context && this.browser?.isConnected()) return this.context;

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: appConfig.vivinoDirectHeadless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    };

    if (appConfig.vivinoDirectChromeExecutable) {
      launchOptions.executablePath = appConfig.vivinoDirectChromeExecutable;
    }

    this.browser = await chromium.launch(launchOptions);

    this.context = await this.browser.newContext({
      userAgent: appConfig.vivinoDirectUserAgent,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Mask navigator.webdriver
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    console.log(
      "[vivino-browser] Chromium launched (headless=%s)",
      appConfig.vivinoDirectHeadless,
    );
    return this.context;
  }
}
