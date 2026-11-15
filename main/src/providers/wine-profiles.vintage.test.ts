import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { rankMatch } from "@wine-rec/core";
import { VivinoBrowser, type SearchHit } from "./vivino-browser.js";
import { createWineProfileProviders } from "./wine-profiles.js";
import { parseWineCandidates } from "../services/parser.js";

type VintageFixture = { name: string; producer: string; label: string; requested: number; returned: number; region: string; source: string };
const fixtures = JSON.parse(readFileSync(new URL("../test-support/vintage-regressions.json", import.meta.url), "utf8")) as VintageFixture[];

function candidate(fixture: VintageFixture, vintage: number | null = fixture.requested): WineCandidate {
  return {
    id: "vintage-regression", rawText: `${fixture.name}${vintage == null ? "" : ` ${vintage}`}`,
    producer: fixture.producer, label: fixture.label, vintage, region: fixture.region,
    price: "$40", menuTab: null, menuSection: null, lineNumber: 0, color: null,
    varietal: null, notes: null, extractionConfidence: 0.96,
  };
}
function hit(fixture: VintageFixture, year: number | null = fixture.returned): SearchHit {
  return {
    wineId: 100, wineryName: fixture.producer, wineName: fixture.label, year,
    regionAndCountry: fixture.region, rating: 4.1, retailPrice: null,
    imageUrl: "https://example.com/bottle.jpg", vintagePageUrl: "https://example.com/wine/100",
  };
}
function setup() {
  const provider = createWineProfileProviders().find(entry => entry.name === "vivino-direct")!;
  const browser = VivinoBrowser.getInstance();
  const search = vi.spyOn(browser, "search");
  const page = vi.spyOn(browser, "fetchVintagePageMeta").mockResolvedValue({
    aggregateRating: { rating: 4.1, ratingCount: 50, ratingSource: "wine" }, imageUrl: "https://example.com/bottle.jpg",
  });
  const fetch = vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return { provider, search, page, fetch };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Policy (Nov 2026): Vivino's taste structure and flavour notes are per wine,
// not per vintage, and its search mostly returns whatever vintages shops
// sell. So a different or unknown vintage of the same Vivino wine is still a
// match; the menu's own vintage is shown, never the provider's other year.
describe("Vivino vintage handling (all provider I/O mocked)", () => {
  it.each(fixtures)("keeps $name when Vivino only lists $returned for requested $requested", async fixture => {
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: `${fixture.label} ${fixture.returned}` }]);
    const result = await provider.lookup(candidate(fixture));
    expect(result).not.toBeNull();
    expect(rankMatch(result!.matchScore)).toBe("matched");
    expect(result?.profile.vintage).toBe(fixture.requested);
    expect(result?.profile.label).toBe(fixture.label);
    expect(result?.profile.displayName).not.toContain(String(fixture.returned));
  });

  it.each(fixtures)("retains a verified exact year for $name", async fixture => {
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture, fixture.requested)]);
    const result = await provider.lookup(candidate(fixture));
    expect(result?.profile.vintage).toBe(fixture.requested);
    expect(rankMatch(result!.matchScore)).toBe("matched");
  });

  it("uses the menu's year when the provider year is unknown", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture, null)]);
    const result = await provider.lookup(candidate(fixture));
    expect(result?.profile.vintage).toBe(fixture.requested);
  });

  it("keeps the exact vintage when one wine ID has wrong, unknown, and exact hits", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture), hit(fixture, null), hit(fixture, fixture.requested)]);
    expect((await provider.lookup(candidate(fixture)))?.profile.vintage).toBe(fixture.requested);
  });

  it("does not invent a year when the menu has none", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture)]);
    expect((await provider.lookup(candidate(fixture, null)))?.profile.vintage).toBeNull();
  });
});

describe("grape identity regressions (offline)", () => {
  it("rejects the observed Salmon Run Riesling to Chardonnay-Riesling substitution", async () => {
    const fixture = { name: "Salmon Run Riesling", producer: "Salmon Run", label: "Riesling", requested: 2016, returned: 2016, region: "Finger Lakes, New York", source: "Observed public-menu canary contradiction" };
    const { provider, search, fetch } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: "Chardonnay-Riesling" }]);
    expect(await provider.lookup({ ...candidate(fixture), varietal: "Riesling" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["Riesling", "Riesling"],
    ["Syrah", "Shiraz"],
    ["Pinot Grigio", "Pinot Gris"],
    ["Grenache", "Garnacha"],
    ["Cabernet Sauvignon", "Cabernet Sauvignon"],
  ])("preserves compatible grape names %s / %s", async (menuGrape, providerGrape) => {
    const fixture = { name: `Example Estate ${menuGrape}`, producer: "Example Estate", label: menuGrape, requested: 2020, returned: 2020, region: "California", source: "Synthetic grape identity control" };
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: providerGrape }]);
    expect(await provider.lookup({ ...candidate(fixture), varietal: menuGrape })).not.toBeNull();
  });

  it.each([
    ["Cabernet / Merlot", "Cabernet Sauvignon / Merlot"],
    ["Syrah Blend", "Syrah Viognier"],
  ])("keeps incomplete grape evidence %s → %s possible", async (menuGrape, providerGrape) => {
    const fixture = { name: `Example Estate ${menuGrape}`, producer: "Example Estate", label: menuGrape, requested: 2020, returned: 2020, region: "California", source: "Synthetic review regression" };
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: providerGrape }]);
    expect(await provider.lookup({ ...candidate(fixture), varietal: menuGrape })).not.toBeNull();
  });
});

it.each([
  ["Hook & Ladder", "Chardonnay", 2015],
  ["Charles & Charles", "Cabernet Sauvignon", 2020],
] as const)("matches an exact wine in one search although producer %s has an ampersand", async (producerName, grape, year) => {
  const fixture = { name: `${producerName} ${grape}`, producer: producerName, label: grape, requested: year, returned: year, region: "", source: "Reviewer producer delimiter regression" };
  const { provider, search } = setup();
  search.mockResolvedValue([hit(fixture)]);
  const parsed = parseWineCandidates(`${producerName} ${grape} ${year}\n$40`);
  expect(parsed).toHaveLength(1);
  const result = await provider.lookup(parsed[0]!);
  expect(rankMatch(result!.matchScore)).toBe("matched");
  expect(search).toHaveBeenCalledTimes(1);
});
