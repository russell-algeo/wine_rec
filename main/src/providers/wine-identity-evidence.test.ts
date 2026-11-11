import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { SEARCH_PAGE_EVALUATION as evaluation, type SearchHit } from "./vivino-browser.js";
import { compareVintageEvidence, hasContradictoryGrapeIdentity } from "./wine-identity-evidence.js";

const candidate: WineCandidate = { id: "identity", rawText: "NV Example Estate Brut", producer: "Example Estate", label: "Brut", vintage: null, price: "$40", menuTab: null, menuSection: null, lineNumber: 0, color: null, varietal: null, region: null, notes: null, extractionConfidence: 0.95 };
const hit: SearchHit = { wineId: 1, wineryName: "Example Estate", wineName: "Brut", year: null, regionAndCountry: "Champagne, France", rating: null, retailPrice: null, imageUrl: null, vintagePageUrl: "https://example.com/w/1" };

// Execute the actual browser extraction string against a tiny, synthetic DOM.
// No browser, HTTP client, production credentials, or live provider is used.
function extract(year: unknown, domName?: string) {
  const match = { vintage: { year, wine: { id: 1, name: "Brut", winery: { name: "Example Estate" }, region: { name: "Champagne", country: { name: "France" } } } } };
  const scope = { querySelector: (selector: string) => selector.includes("__truncate") ? { textContent: "Example Estate" } : selector.includes("__vintage") ? { textContent: domName } : null };
  const link = { getAttribute: () => "/w/1", closest: () => scope };
  const document = {
    querySelectorAll: (selector: string) => selector.startsWith("a[") ? (domName ? [link] : []) : selector === "[data-preloaded-state]" ? [{ getAttribute: () => JSON.stringify({ search_results: { matches: [match] } }) }] : [],
    body: { innerText: "" }, documentElement: { outerHTML: "" }, title: "Synthetic offline fixture",
  };
  return runInNewContext(evaluation, { document, window: { location: { origin: "https://example.com", href: "https://example.com/search" } }, URL }) as { domHits: SearchHit[]; preloadedHits: SearchHit[] };
}

describe("explicit vintage evidence", () => {
  it.each(["NV", "N.V.", "non-vintage", "[NV]", "N/V"])("preserves preloaded %s instead of collapsing it into unknown", marker => {
    const result = extract(marker).preloadedHits[0]!;
    expect(result.year).toBeNull();
    expect(result.vintageText).toBe(marker);
    expect(compareVintageEvidence(candidate, result)).toBe("exact");
  });
  it.each([null, undefined, 0, ""])("does not infer NV from missing/placeholder year %s", year => {
    const result = extract(year).preloadedHits[0]!;
    expect(result.year).toBeNull();
    expect(compareVintageEvidence(candidate, result)).toBe("unknown");
  });
  it("preserves a numeric year from preloaded state", () => {
    const result = extract(2020).preloadedHits[0]!;
    expect(result.year).toBe(2020);
    expect(compareVintageEvidence(candidate, result)).toBe("conflict");
  });
  it("preserves explicit NV from the rendered wine name", () => {
    const result = extract(null, "Brut N.V.").domHits[0]!;
    expect(result.year).toBeNull();
    expect(compareVintageEvidence(candidate, result)).toBe("exact");
  });
  it("does not read an appended geographic NV abbreviation as a vintage", () => {
    expect(compareVintageEvidence({ ...candidate, rawText: "Example Estate Brut, Nevada, NV", region: "Nevada, NV" }, { ...hit, year: 2020 })).toBe("unconstrained");
  });
  it.each(["Example Estate Brut Nevada NV $40", "Example Estate Brut, NEVADA, NV $40"])("excludes parsed geography despite a trailing price: %s", rawText => {
    expect(compareVintageEvidence({ ...candidate, rawText, region: "Nevada NV" }, { ...hit, year: 2020 })).toBe("unconstrained");
  });
  it("does not infer a marker from a substring such as NVidia", () => {
    expect(compareVintageEvidence({ ...candidate, rawText: "NVidia Estate Brut" }, { ...hit, year: 2020 })).toBe("unconstrained");
  });
});

describe("bounded explicit grape identity", () => {
  it.each([
    ["Riesling", "Chardonnay-Riesling"],
    ["Cabernet Sauvignon", "Cabernet Franc"],
    ["Pinot Noir", "Pinot Gris"],
  ])("detects a named contradiction %s / %s", (label, wineName) => {
    expect(hasContradictoryGrapeIdentity({ ...candidate, label }, { ...hit, wineName })).toBe(true);
  });
  it("does not constrain the hit using grapes mentioned only in notes, producer, or region", () => {
    expect(hasContradictoryGrapeIdentity({ ...candidate, producer: "Riesling Estate", notes: "Chardonnay-like body", region: "Malbec Valley" }, { ...hit, wineName: "Brut Pinot Noir" })).toBe(false);
  });
  it("treats unavailable provider grape evidence as unknown rather than a contradiction", () => {
    expect(hasContradictoryGrapeIdentity({ ...candidate, label: "Riesling" }, hit)).toBe(false);
  });
  it("keeps tested evidence helpers and browser extraction identical in the worker", () => {
    for (const file of ["wine-identity-evidence.ts", "vivino-browser.ts"]) {
      expect(readFileSync(new URL(`../../../worker/src/providers/${file}`, import.meta.url), "utf8"))
        .toBe(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
    }
  });
});
