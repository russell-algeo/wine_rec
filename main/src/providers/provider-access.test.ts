import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { ProviderAccessBlockedError, ProviderRequestStoppedError, assertProviderAccessAllowed, assertProviderResponseAllowed } from "./provider-access.js";
import { VivinoBrowser, RetryableVivinoBrowserError, type SearchHit } from "./vivino-browser.js";
import { createWineProfileProviders } from "./wine-profiles.js";

const candidate: WineCandidate = { id: "blocked-fixture", rawText: "Example Estate Riesling 2020", producer: "Example Estate", label: "Riesling", vintage: 2020, price: "$40", menuTab: null, menuSection: null, lineNumber: 0, color: null, varietal: "Riesling", region: null, notes: null, extractionConfidence: 0.95 };
const hit: SearchHit = { wineId: 10, wineryName: "Example Estate", wineName: "Riesling", year: 2020, rating: 4, retailPrice: null, imageUrl: "https://example.com/bottle.jpg", vintagePageUrl: "https://example.com/w/10", regionAndCountry: "" };
const provider = () => createWineProfileProviders().find(value => value.name === "vivino-direct")!;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("terminal access-boundary detection", () => {
  it.each([401, 403])("treats HTTP %s as terminal", status => {
    expect(() => assertProviderAccessAllowed({ status })).toThrow(ProviderAccessBlockedError);
  });
  it.each(["challenge", "captcha"])("treats an AWS %s action as terminal", action => {
    expect(() => assertProviderAccessAllowed({ status: 202, headers: { "X-Amzn-Waf-Action": action } })).toThrow(ProviderAccessBlockedError);
  });
  it("detects an HTML challenge even with HTTP 200", async () => {
    await expect(assertProviderResponseAllowed(new Response('<script src="challenge.js"></script>', { headers: { "content-type": "text/html" } }))).rejects.toBeInstanceOf(ProviderAccessBlockedError);
  });
  it.each([undefined, "application/json", "text/plain"])("detects a challenge with missing or wrong Content-Type %s", async contentType => {
    const response = new Response('<script src="challenge.js"></script>', { headers: contentType ? { "content-type": contentType } : {} });
    if (!contentType) response.headers.delete("content-type");
    await expect(assertProviderResponseAllowed(response)).rejects.toBeInstanceOf(ProviderAccessBlockedError);
  });
  it.each(["Access Denied", "CAPTCHA", "Security Check", "Verify that you are human"])("detects the HTTP-200 interstitial title %s", async title => {
    await expect(assertProviderResponseAllowed(new Response(`<html><title>${title}</title></html>`))).rejects.toBeInstanceOf(ProviderAccessBlockedError);
  });
  it("allows ordinary AWS integration and benign JSON without consuming the original body", async () => {
    const normal = '<html><title>Example Estate Riesling</title><script src="https://example.com/awswaf/integration.js"></script></html>';
    const response = new Response(normal);
    await expect(assertProviderResponseAllowed(response)).resolves.toBeUndefined();
    expect(await response.text()).toBe(normal);
    const json = '{"wine":{"name":"Example Estate"},"awswafIntegration":true}';
    const data = new Response(json, { headers: { "content-type": "application/json" } });
    await expect(assertProviderResponseAllowed(data)).resolves.toBeUndefined();
    expect(await data.json()).toMatchObject({ wine: { name: "Example Estate" } });
  });
  it("does not call ordinary missing data or rate limiting a challenge", async () => {
    expect(() => assertProviderAccessAllowed({ status: 404 })).not.toThrow();
    expect(() => assertProviderAccessAllowed({ status: 429 })).not.toThrow();
    await expect(assertProviderResponseAllowed(new Response('{"tastes":null}', { headers: { "content-type": "application/json" } }))).resolves.toBeUndefined();
  });
});

function fakeBrowserPage(evaluation: unknown, status = 200) {
  const page = {
    goto: vi.fn(async () => ({ status: () => status, headers: () => ({}) })),
    waitForSelector: vi.fn(async () => null), evaluate: vi.fn(async () => evaluation),
    waitForTimeout: vi.fn(async () => undefined), close: vi.fn(async () => undefined), isClosed: () => false,
  };
  const browser = VivinoBrowser.getInstance();
  // These private seams replace browser creation itself, not just page data.
  // No actual browser, URL, process, or network request can be created here.
  const launch = vi.spyOn(browser as any, "getOrLaunchBrowser").mockResolvedValue({ isConnected: () => true });
  const newPage = vi.spyOn(browser as any, "newPage").mockResolvedValue(page);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call in offline browser test"); }));
  return { browser, page, launch, newPage };
}

describe("browser challenge propagation without retries", () => {
  it.each([false, true])("stops a challenged search (zero-wine banner=%s) after one navigation", async showsZeroWineMessage => {
    const { browser, page, newPage } = fakeBrowserPage({ domHits: [], preloadedHits: [], linkCount: 0, showsZeroWineMessage, hasAwsWafChallenge: true, url: "https://example.com/explore" });
    await expect(browser.search("synthetic wine")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(page.goto).toHaveBeenCalledTimes(1); expect(newPage).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled(); expect(page.close).toHaveBeenCalledTimes(1);
  });
  it("stops a denied navigation before DOM extraction", async () => {
    const { browser, page } = fakeBrowserPage({}, 403);
    await expect(browser.search("synthetic wine")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(page.goto).toHaveBeenCalledTimes(1); expect(page.evaluate).not.toHaveBeenCalled();
  });
  it("does not silently downgrade a challenged vintage page into missing metadata", async () => {
    const { browser, page, newPage } = fakeBrowserPage({ pageInformation: null, imageUrl: null, hasAwsWafChallenge: true });
    await expect(browser.fetchVintagePageMeta("https://example.com/w/10")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(page.goto).toHaveBeenCalledTimes(1); expect(newPage).toHaveBeenCalledTimes(1);
  });
  it.each(["Access Denied", "CAPTCHA", "Security Check"])("stops a browser title-only %s before empty-page retry", async title => {
    const { browser, page, newPage } = fakeBrowserPage({ domHits: [], preloadedHits: [], linkCount: 0, hasAwsWafChallenge: false, title });
    await expect(browser.search("synthetic wine")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(page.goto).toHaveBeenCalledTimes(1); expect(newPage).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });
  it("executes actual browser evaluation strings with shared challenge detection and no injected helper dependency", async () => {
    const { browser, page } = fakeBrowserPage({});
    const document = {
      title: "Example Estate", body: { innerText: "Showing 0 wine" },
      documentElement: { outerHTML: '<script src="challenge.js"></script>' },
      querySelectorAll: () => [], querySelector: () => null,
    };
    page.evaluate.mockImplementation(async (...args: unknown[]) => runInNewContext(String(args[0]), {
      document, window: { location: { href: "https://example.com/search", origin: "https://example.com" } }, URL,
    }));
    await expect(browser.search("synthetic wine")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    await expect(browser.fetchVintagePageMeta("https://example.com/w/10")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    // A generic AWS integration alone does not make ordinary metadata a challenge.
    document.documentElement.outerHTML = '<script src="https://example.com/awswaf/integration.js"></script>';
    await expect(browser.fetchVintagePageMeta("https://example.com/w/10")).resolves.toEqual({ aggregateRating: null, imageUrl: null });
    document.title = "Security Check";
    await expect(browser.fetchVintagePageMeta("https://example.com/w/10")).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(page.goto).toHaveBeenCalledTimes(4);
  });
  it("checks job cancellation before navigation and preserves its terminal control flow", async () => {
    const { browser, page } = fakeBrowserPage({}); const stopped = new ProviderRequestStoppedError();
    await expect(browser.search("synthetic wine", () => { throw stopped; })).rejects.toBe(stopped);
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe("provider access boundary", () => {
  it("stops search variants and subsequent lookups after a blocked browser search", async () => {
    const blocked = new ProviderAccessBlockedError(); const browser = VivinoBrowser.getInstance();
    const search = vi.spyOn(browser, "search").mockRejectedValue(blocked);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const active = provider();
    await expect(active.lookup(candidate)).rejects.toBe(blocked);
    await expect(active.lookup(candidate)).rejects.toBe(blocked);
    expect(search).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [403, {}, "denied"],
    [202, { "x-amzn-waf-action": "challenge" }, "challenge"],
    [200, { "content-type": "text/html" }, '<script src="challenge.js"></script>'],
    [200, { "content-type": "application/json" }, '<script src="challenge.js"></script>'],
    [200, {}, '<title>Security Check</title>'],
  ] as const)("stops enrichment on HTTP %s access evidence without browser fallback or taste request", async (status, headers, body) => {
    const browser = VivinoBrowser.getInstance();
    vi.spyOn(browser, "search").mockResolvedValue([hit]);
    const page = vi.spyOn(browser, "fetchVintagePageMeta").mockResolvedValue(null);
    const fetch = vi.fn(async () => new Response(body, { status, headers })); vi.stubGlobal("fetch", fetch);
    await expect(provider().lookup(candidate)).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(fetch).toHaveBeenCalledTimes(1); expect(page).not.toHaveBeenCalled();
  });
  it("preserves a vintage-page challenge without starting taste enrichment", async () => {
    const browser = VivinoBrowser.getInstance(); vi.spyOn(browser, "search").mockResolvedValue([hit]);
    vi.spyOn(browser, "fetchVintagePageMeta").mockRejectedValue(new ProviderAccessBlockedError());
    const fetch = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetch);
    await expect(provider().lookup(candidate)).rejects.toBeInstanceOf(ProviderAccessBlockedError);
    expect(fetch).toHaveBeenCalledTimes(1); // reviews only; no tastes or alternate endpoint after block
  });
  it("does not conflate an ordinary retryable browser failure with an access denial", async () => {
    vi.spyOn(VivinoBrowser.getInstance(), "search").mockRejectedValue(new RetryableVivinoBrowserError("search", "browser closed"));
    await expect(provider().lookup(candidate)).rejects.toMatchObject({ name: "RetryableWineProfileLookupError" });
  });
});

it("latches the boundary synchronously before the detector throws", () => {
  let latched: Error | null = null;
  expect(() => assertProviderAccessAllowed({ hasChallenge: true, onAccessBlocked: error => { latched = error; } })).toThrow(ProviderAccessBlockedError);
  expect(latched).toBeInstanceOf(ProviderAccessBlockedError);
});

it("blocks another lookup's next endpoint before the first lookup finishes unwinding", async () => {
  const browser = VivinoBrowser.getInstance(); const active = provider();
  let firstGuard: import("./provider-access.js").ProviderRequestGuard | undefined;
  let releaseSecond!: (hits: SearchHit[]) => void; let releaseFirstResponse!: (response: Response) => void;
  const search = vi.spyOn(browser, "search").mockImplementationOnce(async (_query, guard) => { firstGuard = guard; return [hit]; })
    .mockImplementationOnce(async () => new Promise(resolve => { releaseSecond = resolve; }));
  const fetch = vi.fn(async () => new Promise<Response>(resolve => { releaseFirstResponse = resolve; })); vi.stubGlobal("fetch", fetch);
  const first = active.lookup(candidate); const firstRejected = expect(first).rejects.toBeInstanceOf(ProviderAccessBlockedError);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const second = active.lookup({ ...candidate, id: "second" }); const secondRejected = expect(second).rejects.toBeInstanceOf(ProviderAccessBlockedError);
  await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  firstGuard!.onAccessBlocked!(new ProviderAccessBlockedError());
  releaseSecond([hit]); await secondRejected;
  expect(fetch).toHaveBeenCalledTimes(1);
  releaseFirstResponse(new Response("denied", { status: 403 })); await firstRejected;
});
