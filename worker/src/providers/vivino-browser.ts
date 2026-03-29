import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import chromium from "@sparticuz/chromium-min";
import { chromium as playwrightChromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { appConfig } from "../config.js";

const SERVERLESS_CHROMIUM_VERSION = "143.0.4";
const SERVERLESS_CHROMIUM_PACK_URL = `https://github.com/Sparticuz/chromium/releases/download/v${SERVERLESS_CHROMIUM_VERSION}/chromium-v${SERVERLESS_CHROMIUM_VERSION}-pack.${process.arch === "arm64" ? "arm64" : "x64"}.tar`;
const SERVERLESS_BROWSER_TASK_CONCURRENCY = 1;
const MAX_BROWSER_PAGE_RETRIES = 1;
const MAX_BROWSER_RESTART_RETRIES = 1;
const BLOCKED_SERVERLESS_RESOURCE_TYPES = new Set([
  "font",
  "image",
  "manifest",
  "media",
]);
const BLOCKED_SERVERLESS_HOST_PATTERNS = [
  /(^|\.)appboycdn\.com$/i,
  /(^|\.)braze\.(com|eu)$/i,
  /(^|\.)criteo\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)hotjar\.com$/i,
];
const SERVERLESS_PLAYWRIGHT_PROFILE_DIR_PREFIX = "playwright_chromiumdev_profile-";
const VIVINO_PLACEHOLDER_IMAGE_PATH_PATTERN = /\/bottleShot\/fallback_\d+\.png(?:$|\?)/i;
const VIVINO_ZERO_RESULT_EXPLORE_RETRY_PREFIX = "VIVINO_ZERO_RESULT_EXPLORE_RETRY:";

function getConfiguredChromiumBrotliDir(): string | null {
  const configured = process.env.CHROMIUM_BROTLI_DIR?.trim();
  return configured ? configured : null;
}

function getConfiguredChromiumPackUrl(): string {
  const configured = process.env.CHROMIUM_PACK_URL?.trim();
  return configured || SERVERLESS_CHROMIUM_PACK_URL;
}

async function getServerlessChromiumExecutablePath(): Promise<string> {
  const configuredDir = getConfiguredChromiumBrotliDir();
  if (configuredDir) {
    try {
      console.log("[vivino-browser] Using prepackaged Chromium Brotli dir: %s", configuredDir);
      return await chromium.executablePath(configuredDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        "[vivino-browser] Falling back to Chromium pack URL after %s failed: %s",
        configuredDir,
        message,
      );
    }
  }

  const configuredUrl = getConfiguredChromiumPackUrl();

  try {
    return await chromium.executablePath(configuredUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      configuredUrl !== SERVERLESS_CHROMIUM_PACK_URL &&
      /Unexpected status code|Failed to download|ECONN|ENOTFOUND/i.test(message)
    ) {
      console.log(
        "[vivino-browser] Falling back to bundled Chromium pack URL after %s failed: %s",
        configuredUrl,
        message,
      );
      return chromium.executablePath(SERVERLESS_CHROMIUM_PACK_URL);
    }

    throw error;
  }
}

function isServerlessChromiumGraphicsEnabled(): boolean {
  const configured = process.env.CHROMIUM_GRAPHICS_MODE?.trim().toLowerCase();
  if (!configured) {
    return false;
  }

  return configured === "1" || configured === "true" || configured === "enabled" || configured === "on";
}

async function createServerlessPlaywrightProfileDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), SERVERLESS_PLAYWRIGHT_PROFILE_DIR_PREFIX));
}

export interface SearchHit {
  wineId: number;
  wineryName: string;
  wineName: string;
  regionAndCountry: string;
  rating: number | null;
  retailPrice: number | null;
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

export interface VivinoSearchPageEvaluation {
  domHits: SearchHit[];
  preloadedHits: SearchHit[];
  linkCount: number;
  hasPreloadedState: boolean;
  hasAwsWafChallenge: boolean;
  showsZeroWineMessage: boolean;
  title: string;
  url: string;
}

export class RetryableVivinoBrowserError extends Error {
  constructor(
    readonly operation: string,
    readonly reason: string,
  ) {
    super(`Retryable browser failure during ${operation}: ${reason}`);
    this.name = "RetryableVivinoBrowserError";
  }
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

function defaultVivinoSearchPageEvaluation(): VivinoSearchPageEvaluation {
  return {
    domHits: [],
    preloadedHits: [],
    linkCount: 0,
    hasPreloadedState: false,
    hasAwsWafChallenge: false,
    showsZeroWineMessage: false,
    title: "",
    url: "",
  };
}

function normalizeVivinoImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function isVivinoPlaceholderImageUrl(value: string | null | undefined): boolean {
  const normalized = normalizeVivinoImageUrl(value);
  return normalized != null && VIVINO_PLACEHOLDER_IMAGE_PATH_PATTERN.test(normalized);
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

export function selectVivinoSearchHits(evaluation: Pick<VivinoSearchPageEvaluation, "domHits" | "preloadedHits">): SearchHit[] {
  return evaluation.domHits.length > 0 ? evaluation.domHits : evaluation.preloadedHits;
}

export function isSuspiciousEmptyVivinoSearch(
  evaluation: Pick<
    VivinoSearchPageEvaluation,
    "domHits" | "preloadedHits" | "linkCount" | "showsZeroWineMessage"
  >,
): boolean {
  return (
    evaluation.linkCount === 0 &&
    selectVivinoSearchHits(evaluation).length === 0 &&
    !evaluation.showsZeroWineMessage
  );
}

export function shouldRetryZeroResultExploreSearch(
  evaluation: Pick<
    VivinoSearchPageEvaluation,
    "domHits" | "preloadedHits" | "linkCount" | "showsZeroWineMessage" | "url"
  >,
): boolean {
  return (
    evaluation.linkCount === 0 &&
    selectVivinoSearchHits(evaluation).length === 0 &&
    evaluation.showsZeroWineMessage &&
    /\/explore(?:[/?]|$)/i.test(evaluation.url)
  );
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

function shouldAbortServerlessRequest(url: string, resourceType: string): boolean {
  if (BLOCKED_SERVERLESS_RESOURCE_TYPES.has(resourceType)) {
    return true;
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }

  return BLOCKED_SERVERLESS_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

// Keep browser-side evaluators as raw strings so tsx/esbuild helpers like `__name`
// are not serialized into the page context and crash `page.evaluate(...)`.
const SEARCH_PAGE_EVALUATION = String.raw`
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
      if (/\/bottleShot\/fallback_\d+\.png(?:$|\?)/i.test(normalized)) {
        continue;
      }
      return normalized;
    }

    return null;
  };
  const normalizeYear = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
  };
  const toNumberOrNull = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const buildVintagePageUrl = (match) => {
    const wineId = toNumberOrNull(match && match.vintage && match.vintage.wine && match.vintage.wine.id);
    if (!wineId) return null;
    const seoName = match && match.vintage && match.vintage.seo_name;
    const url = new URL(seoName ? "/en/" + seoName + "/w/" + wineId : "/w/" + wineId, window.location.origin);
    const year = normalizeYear(match && match.vintage && match.vintage.year);
    const priceId =
      toNumberOrNull(match && match.price && match.price.id) ||
      toNumberOrNull(match && match.prices && match.prices[0] && match.prices[0].id);
    if (year) {
      url.searchParams.set("year", String(year));
    }
    if (priceId) {
      url.searchParams.set("price_id", String(priceId));
    }
    return url.toString();
  };

  const resultLinks = Array.from(
    document.querySelectorAll('a[data-testid="vintagePageLink"], a[href*="/w/"]')
  );
  const domResults = [];
  const seenWineIds = new Set();

  for (const link of resultLinks) {
    const href = link.getAttribute("href") || "";
    const idMatch = href.match(/\/w\/(\d+)/);
    const yearMatch = href.match(/[?&]year=(\d{4})/);
    const wineIdText = idMatch && idMatch[1];
    if (!wineIdText) continue;

    const wineId = parseInt(wineIdText, 10);
    if (!Number.isFinite(wineId) || seenWineIds.has(wineId)) continue;
    seenWineIds.add(wineId);
    const yearText = yearMatch && yearMatch[1];
    const year = yearText ? parseInt(yearText, 10) : null;
    const vintagePageUrl = new URL(href, window.location.origin).toString();
    const scope =
      link.closest('[class*="WineCard"]') ||
      link.closest("article, section, li, div") ||
      link;

    const wineryEl = scope.querySelector('[class*="wineInfoVintage__truncate"]');
    const nameEl = scope.querySelector('[class*="wineInfoVintage__vintage"]');
    const regionEl = scope.querySelector('[class*="wineInfoLocation__regionAndCountry"]');
    const ratingEl = scope.querySelector('[class*="vivinoRating__averageValue"]');
    const bottleSection = scope.querySelector('[class*="bottleSection"]') || scope;
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

    const priceEl =
      scope.querySelector('[class*="addToCart"] [class*="price"]') ||
      scope.querySelector('[class*="addToCart__price"]') ||
      scope.querySelector('[class*="offerPrice"]') ||
      scope.querySelector('[class*="priceSection"] [class*="amount"]');
    const priceText = (priceEl && priceEl.textContent || "").trim();
    const priceNumMatch = priceText.match(/[\d]+(?:\.\d{1,2})?/);
    const retailPrice = priceNumMatch ? parseFloat(priceNumMatch[0]) : null;

    domResults.push({
      wineId,
      wineryName,
      wineName,
      regionAndCountry,
      rating: rating !== null && Number.isFinite(rating) ? rating : null,
      retailPrice: retailPrice !== null && Number.isFinite(retailPrice) && retailPrice > 0 ? retailPrice : null,
      imageUrl,
      vintagePageUrl,
      year,
    });
  }

  let rawPreloadedState = null;
  for (const element of Array.from(document.querySelectorAll("[data-preloaded-state]"))) {
    const candidate = element.getAttribute("data-preloaded-state");
    if (candidate) {
      rawPreloadedState = candidate;
      break;
    }
  }

  let preloadedHits = [];
  if (rawPreloadedState) {
    try {
      const parsed = JSON.parse(rawPreloadedState);
      const matches = parsed && parsed.search_results && parsed.search_results.matches;
      if (Array.isArray(matches)) {
        preloadedHits = matches
          .map((match) => {
            const wineId = toNumberOrNull(match && match.vintage && match.vintage.wine && match.vintage.wine.id);
            if (!wineId) return null;
            const wineryName = ((match && match.vintage && match.vintage.wine && match.vintage.wine.winery && match.vintage.wine.winery.name) || "").trim();
            const wineName = ((match && match.vintage && match.vintage.wine && match.vintage.wine.name) || "").trim();
            const regionName = ((match && match.vintage && match.vintage.wine && match.vintage.wine.region && match.vintage.wine.region.name) || "").trim();
            const countryName = ((match && match.vintage && match.vintage.wine && match.vintage.wine.region && match.vintage.wine.region.country && match.vintage.wine.region.country.name) || "").trim();
            if (!wineryName && !wineName) return null;
            const regionAndCountry = [regionName, countryName].filter(Boolean).join(", ");
            const vintageStats = match && match.vintage && match.vintage.statistics;
            const wineStats = match && match.vintage && match.vintage.wine && match.vintage.wine.statistics;
            const rating =
              toNumberOrNull(vintageStats && vintageStats.ratings_average) ??
              toNumberOrNull(wineStats && wineStats.ratings_average);
            const retailPrice =
              toNumberOrNull(match && match.price && match.price.amount) ??
              toNumberOrNull(match && match.prices && match.prices[0] && match.prices[0].amount);
            const variations = match && match.vintage && match.vintage.image && match.vintage.image.variations;
            return {
              wineId,
              wineryName,
              wineName,
              regionAndCountry,
              rating,
              retailPrice,
              imageUrl: pickImageUrl(
                variations && variations.bottle_small,
                variations && variations.large,
                variations && variations.bottle_medium,
                variations && variations.label_large,
                variations && variations.label,
                variations && variations.medium,
              ),
              vintagePageUrl: buildVintagePageUrl(match),
              year: normalizeYear(match && match.vintage && match.vintage.year),
            };
          })
          .filter(Boolean);
      }
    } catch {}
  }

  const bodyText = (document.body && document.body.innerText) || "";

  return {
    domHits: domResults,
    preloadedHits,
    linkCount: resultLinks.length,
    hasPreloadedState: Boolean(rawPreloadedState),
    hasAwsWafChallenge: /awswaf|challenge\.js/i.test(document.documentElement.outerHTML),
    showsZeroWineMessage: /showing\s+0\s+wine/i.test(bodyText),
    title: document.title,
    url: window.location.href,
  };
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
  private launchPromise: Promise<Browser> | null = null;
  private activeBrowserTasks = 0;
  private readonly browserTaskWaiters: Array<() => void> = [];
  private readonly browserContexts = new Map<Browser, BrowserContext>();
  private readonly browserProfileDirs = new Map<Browser, string>();

  static getInstance(): VivinoBrowser {
    if (!VivinoBrowser.instance) {
      VivinoBrowser.instance = new VivinoBrowser();
    }
    return VivinoBrowser.instance;
  }

  async search(query: string): Promise<SearchHit[]> {
    const searchUrl = `https://www.vivino.com/search/wines?q=${encodeURIComponent(query)}`;
    try {
      return await this.runBrowserTaskWithRetries(`search ${JSON.stringify(query)}`, async (page) => {
        const evaluateSearchPage = async (waitTimeoutMs: number): Promise<{
          evaluation: VivinoSearchPageEvaluation;
          hits: SearchHit[];
        }> => {
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });

          await page
            .waitForSelector('a[data-testid="vintagePageLink"], a[href*="/w/"]', {
              timeout: waitTimeoutMs,
            })
            .catch(() => null);

          const rawEvaluation = await page.evaluate(SEARCH_PAGE_EVALUATION);
          const evaluation =
            rawEvaluation && typeof rawEvaluation === "object"
              ? ({
                  ...defaultVivinoSearchPageEvaluation(),
                  ...(rawEvaluation as Partial<VivinoSearchPageEvaluation>),
                } as VivinoSearchPageEvaluation)
              : defaultVivinoSearchPageEvaluation();
          const hits = selectVivinoSearchHits(evaluation).map((hit) => ({
            ...hit,
            imageUrl: pickPreferredVivinoImageUrl(hit.imageUrl),
          }));
          return {
            evaluation,
            hits,
          };
        };

        let { evaluation, hits } = await evaluateSearchPage(5_000);
        if (!hits.length && isSuspiciousEmptyVivinoSearch(evaluation)) {
          const diagnostics = JSON.stringify({
            url: evaluation.url,
            title: evaluation.title,
            linkCount: evaluation.linkCount,
            hasPreloadedState: evaluation.hasPreloadedState,
            hasAwsWafChallenge: evaluation.hasAwsWafChallenge,
            showsZeroWineMessage: evaluation.showsZeroWineMessage,
          });
          console.log(
            "[vivino-browser] Suspicious empty search page for %j, retrying once: %s",
            query,
            diagnostics,
          );
          await page.waitForTimeout(500);
          ({ evaluation, hits } = await evaluateSearchPage(5_000));
          if (!hits.length && isSuspiciousEmptyVivinoSearch(evaluation)) {
            throw new RetryableVivinoBrowserError(
              `search ${JSON.stringify(query)}`,
              `Vivino search rendered zero result links: ${JSON.stringify({
                url: evaluation.url,
                title: evaluation.title,
                linkCount: evaluation.linkCount,
                hasPreloadedState: evaluation.hasPreloadedState,
                hasAwsWafChallenge: evaluation.hasAwsWafChallenge,
                showsZeroWineMessage: evaluation.showsZeroWineMessage,
              })}`,
            );
          }
        }

        if (!hits.length && shouldRetryZeroResultExploreSearch(evaluation)) {
          const diagnostics = JSON.stringify({
            url: evaluation.url,
            title: evaluation.title,
            linkCount: evaluation.linkCount,
            hasPreloadedState: evaluation.hasPreloadedState,
            hasAwsWafChallenge: evaluation.hasAwsWafChallenge,
            showsZeroWineMessage: evaluation.showsZeroWineMessage,
          });
          console.log(
            "[vivino-browser] Zero-result explore page for %j, retrying with a fresh page: %s",
            query,
            diagnostics,
          );
          throw new Error(`${VIVINO_ZERO_RESULT_EXPLORE_RETRY_PREFIX}${diagnostics}`);
        }

        console.log(
          "[vivino-browser] Search for %j returned %d hits",
          query,
          hits.length,
        );
        return hits;
      });
    } catch (error) {
      if (error instanceof RetryableVivinoBrowserError) {
        if (error.reason.startsWith(VIVINO_ZERO_RESULT_EXPLORE_RETRY_PREFIX)) {
          console.log(
            "[vivino-browser] Search exhausted fresh-page retries for zero-result explore page %j: %s",
            query,
            error.reason.slice(VIVINO_ZERO_RESULT_EXPLORE_RETRY_PREFIX.length),
          );
          return [];
        }
        console.log("[vivino-browser] Search exhausted retries for %j: %s", query, error.reason);
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.log("[vivino-browser] Search failed for %j: %s", query, message);
      throw new RetryableVivinoBrowserError(`search ${JSON.stringify(query)}`, message);
    }
  }

  async fetchVintagePageMeta(vintagePageUrl: string): Promise<VivinoVintagePageMeta | null> {
    try {
      return await this.runBrowserTaskWithRetries(
        `vintage page fetch ${JSON.stringify(vintagePageUrl)}`,
        async (page) => {
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
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        "[vivino-browser] Vintage page fetch failed for %j: %s",
        vintagePageUrl,
        message,
      );
      return null;
    }
  }

  async fetchAggregateRating(vintagePageUrl: string): Promise<VivinoAggregateRating | null> {
    return (await this.fetchVintagePageMeta(vintagePageUrl))?.aggregateRating ?? null;
  }

  async renderHtml(url: string): Promise<string> {
    return this.runBrowserTaskWithRetries(`render ${url}`, async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      return page.content();
    });
  }

  async close(): Promise<void> {
    this.activeBrowserTasks = 0;
    this.browserTaskWaiters.length = 0;
    await this.resetBrowser();
  }

  private async newPage(browser: Browser): Promise<Page> {
    const ownedContext = this.browserContexts.get(browser);
    const page = ownedContext
      ? await ownedContext.newPage()
      : await browser.newPage();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route("**/*", async (route) => {
      if (shouldAbortServerlessRequest(route.request().url(), route.request().resourceType())) {
        await route.abort();
        return;
      }

      await route.continue();
    });
    const cdpSession = await page.context().newCDPSession(page);
    page.once("close", () => {
      void cdpSession.detach().catch(() => null);
    });
    await cdpSession.send("Network.enable");
    await cdpSession.send("Network.setUserAgentOverride", {
      userAgent: appConfig.vivinoDirectUserAgent,
      acceptLanguage: "en-US,en;q=0.9",
      platform: "Windows",
    });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });
    await page.addInitScript(({ userAgent }) => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "userAgent", { get: () => userAgent });
      Object.defineProperty(navigator, "language", { get: () => "en-US" });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    }, { userAgent: appConfig.vivinoDirectUserAgent });

    return page;
  }

  private async runBrowserTask<T>(task: () => Promise<T>): Promise<T> {
    const maxConcurrentTasks = this.getMaxConcurrentBrowserTasks();
    if (!Number.isFinite(maxConcurrentTasks)) {
      return task();
    }

    const release = await this.acquireBrowserTaskSlot(maxConcurrentTasks);

    try {
      return await task();
    } finally {
      release();
    }
  }

  private async runBrowserTaskWithRetries<T>(
    operation: string,
    task: (page: Page) => Promise<T>,
  ): Promise<T> {
    return this.runBrowserTask(async () => {
      let pageRetryCount = 0;
      let browserRetryCount = 0;

      while (true) {
        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
          browser = await this.getOrLaunchBrowser();
          page = await this.newPage(browser);
          return await task(page);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const recoveryScope = this.classifyRecoverableBrowserError(message, browser, page);
          if (!recoveryScope) {
            throw error;
          }

          if (recoveryScope === "page" && pageRetryCount < MAX_BROWSER_PAGE_RETRIES) {
            pageRetryCount += 1;
            console.log(
              "[vivino-browser] %s hit a page-level browser failure, retrying page (%d/%d): %s",
              operation,
              pageRetryCount,
              MAX_BROWSER_PAGE_RETRIES,
              message,
            );
            continue;
          }

          if (browserRetryCount < MAX_BROWSER_RESTART_RETRIES) {
            browserRetryCount += 1;
            console.log(
              "[vivino-browser] %s hit a browser-level failure, retrying with a fresh browser (%d/%d): %s",
              operation,
              browserRetryCount,
              MAX_BROWSER_RESTART_RETRIES,
              message,
            );
            await this.invalidateBrowser(browser);
            continue;
          }

          throw new RetryableVivinoBrowserError(operation, message);
        } finally {
          await page?.close().catch(() => null);
        }
      }
    });
  }

  private async getOrLaunchBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = this.launchBrowser();
    try {
      this.browser = await this.launchPromise;
      return this.browser;
    } finally {
      this.launchPromise = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

    if (isServerless) {
      chromium.setGraphicsMode = isServerlessChromiumGraphicsEnabled();
    }

    let browser: Browser;
    if (isServerless) {
      const profileDir = await createServerlessPlaywrightProfileDir();
      try {
        const context = await playwrightChromium.launchPersistentContext(profileDir, {
          args: [...chromium.args, "--disable-blink-features=AutomationControlled"],
          executablePath: await getServerlessChromiumExecutablePath(),
          headless: true,
        });
        const persistentBrowser = context.browser();
        if (!persistentBrowser) {
          await context.close().catch(() => null);
          throw new Error("Persistent Chromium context did not expose a browser instance.");
        }

        this.browserContexts.set(persistentBrowser, context);
        this.browserProfileDirs.set(persistentBrowser, profileDir);
        console.log("[vivino-browser] Tracking Chromium user-data-dir: %s", profileDir);
        browser = persistentBrowser;
      } catch (error) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => null);
        throw error;
      }
    } else {
      browser = await this.launchLocalBrowser();
    }

    browser.on("disconnected", () => {
      if (this.browser === browser) {
        console.log("[vivino-browser] Chromium disconnected");
        this.browser = null;
      }
      void this.cleanupOwnedBrowser(browser);
    });

    console.log(
      "[vivino-browser] Chromium launched (serverless=%s, headless=%s, graphics=%s)",
      isServerless,
      isServerless ? true : appConfig.vivinoDirectHeadless,
      isServerless ? String(chromium.setGraphicsMode) : "default",
    );

    return browser;
  }

  private getMaxConcurrentBrowserTasks(): number {
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    return isServerless ? SERVERLESS_BROWSER_TASK_CONCURRENCY : Number.POSITIVE_INFINITY;
  }

  private async acquireBrowserTaskSlot(maxConcurrentTasks: number): Promise<() => void> {
    if (this.activeBrowserTasks < maxConcurrentTasks) {
      this.activeBrowserTasks += 1;
      return () => {
        this.releaseBrowserTaskSlot();
      };
    }

    await new Promise<void>((resolve) => {
      this.browserTaskWaiters.push(resolve);
    });

    return () => {
      this.releaseBrowserTaskSlot();
    };
  }

  private releaseBrowserTaskSlot(): void {
    const next = this.browserTaskWaiters.shift();
    if (next) {
      next();
      return;
    }

    this.activeBrowserTasks = Math.max(0, this.activeBrowserTasks - 1);
  }

  private async launchLocalBrowser(): Promise<Browser> {
    const { chromium: localChromium } = await import("playwright");
    const launchOptions: Parameters<typeof playwrightChromium.launch>[0] = {
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

    return localChromium.launch(launchOptions);
  }

  private classifyRecoverableBrowserError(
    message: string,
    browser: Browser | null,
    page: Page | null,
  ): "page" | "browser" | null {
    if (message.startsWith(VIVINO_ZERO_RESULT_EXPLORE_RETRY_PREFIX)) {
      return "page";
    }

    if (
      !/Target page, context or browser has been closed|Target\.closed|Browser has been closed|browser has been closed|Page closed|has been closed|ERR_INSUFFICIENT_RESOURCES|FILE_ERROR_NO_SPACE/i.test(
        message,
      )
    ) {
      return null;
    }

    if (!browser || !browser.isConnected()) {
      return "browser";
    }

    if (!page) {
      return "browser";
    }

    if (/Browser has been closed|browser has been closed|ERR_INSUFFICIENT_RESOURCES|FILE_ERROR_NO_SPACE/i.test(message)) {
      return "browser";
    }

    return page.isClosed() ? "page" : "browser";
  }

  private async resetBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.launchPromise = null;

    if (browser) {
      await this.cleanupOwnedBrowser(browser);
    }
  }

  private async invalidateBrowser(browser: Browser | null): Promise<void> {
    if (!browser) {
      await this.resetBrowser();
      return;
    }

    if (this.browser === browser) {
      this.browser = null;
      this.launchPromise = null;
    }

    await this.cleanupOwnedBrowser(browser);
  }

  private async cleanupOwnedBrowser(browser: Browser): Promise<void> {
    const ownedContext = this.browserContexts.get(browser);
    const profileDir = this.browserProfileDirs.get(browser);

    this.browserContexts.delete(browser);
    this.browserProfileDirs.delete(browser);
    if (ownedContext) {
      await ownedContext.close().catch(() => null);
    } else {
      await browser.close().catch(() => null);
    }

    if (!profileDir) {
      return;
    }

    await rm(profileDir, { recursive: true, force: true }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log("[vivino-browser] Failed to remove Chromium user-data-dir %s: %s", profileDir, message);
    });
  }
}
