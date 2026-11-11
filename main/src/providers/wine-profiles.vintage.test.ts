import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { rankMatch, scoreWineMatch } from "@wine-rec/core";
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

describe("Vivino vintage identity regressions (all provider I/O mocked)", () => {
  it.each(fixtures)("rejects $name $returned for requested $requested before enrichment", async fixture => {
    const { provider, search, page, fetch } = setup();
    search.mockResolvedValue([hit(fixture)]);
    expect(await provider.lookup(candidate(fixture))).toBeNull();
    expect(page).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(fixtures)("retains a verified exact year for $name", async fixture => {
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture, fixture.requested)]);
    const result = await provider.lookup(candidate(fixture));
    expect(result?.profile.vintage).toBe(fixture.requested);
    expect(result?.matchScore).toBeGreaterThan(0.38);
  });

  it("does not copy the requested year into an unknown provider year or call it matched", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture, null)]);
    const result = await provider.lookup(candidate(fixture));
    expect(result).not.toBeNull();
    expect(result?.profile.vintage).toBeNull();
    expect(rankMatch(result!.matchScore)).toBe("low-confidence");
  });

  it.each(["wrong", "unknown"] as const)("continues bounded query variants after a high-scoring %s year", async kind => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValueOnce([hit(fixture, kind === "wrong" ? fixture.returned : null)])
      .mockResolvedValue([hit(fixture, fixture.requested)]);
    const result = await provider.lookup(candidate(fixture));
    expect(search.mock.calls.length).toBeGreaterThan(1);
    expect(result?.profile.vintage).toBe(fixture.requested);
  });

  it("keeps the exact vintage when one wine ID has wrong, unknown, and exact hits", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture), hit(fixture, null), hit(fixture, fixture.requested)]);
    expect((await provider.lookup(candidate(fixture)))?.profile.vintage).toBe(fixture.requested);
  });

  it("still permits a known provider year when the menu has no year constraint", async () => {
    const fixture = fixtures[1]!;
    const { provider, search } = setup();
    search.mockResolvedValue([hit(fixture)]);
    expect((await provider.lookup(candidate(fixture, null)))?.profile.vintage).toBe(fixture.returned);
  });
});

// NV examples are synthetic identity controls, not claims about a particular
// producer's product catalogue. They exercise the missing-vs-explicit marker.
describe("non-vintage and blend identity regressions (offline)", () => {
  const sparkling: VintageFixture = { name: "Example Estate Brut", producer: "Example Estate", label: "Brut", requested: 2018, returned: 2022, region: "Champagne, France", source: "Synthetic identity control" };
  const nvCandidate = () => ({ ...candidate(sparkling, null), rawText: "NV Example Estate Brut", label: "Brut NV" });

  it.each(["NV", "N.V.", "non-vintage"])("rejects a dated result for an explicit %s menu wine", async marker => {
    const { provider, search, fetch } = setup();
    search.mockResolvedValue([hit(sparkling)]);
    const input = { ...nvCandidate(), rawText: `${marker} Example Estate Brut`, label: "Brut" };
    expect(await provider.lookup(input)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an explicit NV result for a dated menu wine", async () => {
    const { provider, search, fetch } = setup();
    search.mockResolvedValue([{ ...hit(sparkling, null), wineName: "Brut N.V." }]);
    expect(await provider.lookup(candidate(sparkling))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not treat an unknown provider year as confirmed NV", async () => {
    const { provider, search } = setup();
    search.mockResolvedValue([hit(sparkling, null)]);
    const result = await provider.lookup(nvCandidate());
    expect(result).not.toBeNull();
    expect(result?.profile.vintage).toBeNull();
    expect(rankMatch(result!.matchScore)).not.toBe("matched");
  });

  it("keeps searching after an unknown year for an explicit NV hit", async () => {
    const { provider, search } = setup();
    search.mockResolvedValueOnce([hit(sparkling, null)])
      .mockResolvedValue([{ ...hit(sparkling, null), wineName: "Brut N.V." }]);
    const result = await provider.lookup(nvCandidate());
    expect(search.mock.calls.length).toBeGreaterThan(1);
    expect(result?.profile.label).toBe("Brut N.V.");
  });

  it("accepts explicit NV evidence without fabricating a numeric year", async () => {
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(sparkling, null), wineName: "Brut N.V." }]);
    const result = await provider.lookup(nvCandidate());
    expect(result).not.toBeNull();
    expect(result?.profile.vintage).toBeNull();
  });

  it("does not infer NV from unrelated notes or geographic fields", async () => {
    const { provider, search } = setup();
    search.mockResolvedValue([hit(sparkling)]);
    const input = { ...candidate(sparkling, null), notes: "NV supplier tasting", region: "Nevada, NV" };
    expect((await provider.lookup(input))?.profile.vintage).toBe(sparkling.returned);
  });

  it("rejects the observed Salmon Run Riesling to Chardonnay-Riesling substitution", async () => {
    const fixture = { name: "Salmon Run Riesling", producer: "Salmon Run", label: "Riesling", requested: 2016, returned: 2016, region: "Finger Lakes, New York", source: "Observed public-menu canary contradiction" };
    const { provider, search, fetch } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: "Chardonnay-Riesling" }]);
    expect(await provider.lookup({ ...candidate(fixture), varietal: "Riesling" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["Riesling", "Riesling"],
    ["Chardonnay-Riesling", "Riesling / Chardonnay"],
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

  it("does not invent a grape constraint for a generic named cuvee", async () => {
    const fixture = { name: "Example Estate Reserve", producer: "Example Estate", label: "Reserve", requested: 2020, returned: 2020, region: "California", source: "Synthetic unknown-grape control" };
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: "Reserve Chardonnay-Riesling" }]);
    expect(await provider.lookup(candidate(fixture))).not.toBeNull();
  });
});

describe("reviewed incomplete grape evidence (offline)", () => {
  it.each([
    ["Cabernet / Merlot", "Cabernet Sauvignon / Merlot"],
    ["Chardonnay / Pinot", "Chardonnay Pinot Noir"],
    ["Chardonnay / PN", "Chardonnay Pinot Noir"],
    ["Syrah Blend", "Syrah Viognier"],
  ])("keeps %s → %s possible, not confirmed or rejected", async (menuGrape, providerGrape) => {
    const fixture = { name: `Example Estate ${menuGrape}`, producer: "Example Estate", label: menuGrape, requested: 2020, returned: 2020, region: "California", source: "Synthetic review regression" };
    const { provider, search } = setup();
    search.mockResolvedValue([{ ...hit(fixture), wineName: providerGrape }]);
    const result = await provider.lookup({ ...candidate(fixture), varietal: menuGrape });
    expect(result).not.toBeNull();
    expect(rankMatch(result!.matchScore)).not.toBe("matched");
  });
});


it.each(["Example Estate Cabernet 2020\n$40", "Cabernet / Merlot, Example Estate 2020\n$40\nFrance"])("caps actual parsed incomplete-grape evidence: %s", async input => {
  const fixture = { name: "Example Estate Cabernet", producer: "Example Estate", label: "Cabernet Sauvignon / Merlot", requested: 2020, returned: 2020, region: "", source: "Reviewer ordering regression" };
  const { provider, search } = setup();
  search.mockResolvedValue([hit(fixture)]);
  const parsed = parseWineCandidates(input);
  expect(parsed).toHaveLength(1);
  const result = await provider.lookup(parsed[0]!);
  expect(result).not.toBeNull();
  expect(rankMatch(result!.matchScore)).not.toBe("matched");
});

it.each([
  ["Hook & Ladder", "Chardonnay", 2015],
  ["Charles & Charles", "Cabernet Sauvignon", 2020],
] as const)("does not downgrade or retry an exact grape match because producer %s has an ampersand", async (producerName, grape, year) => {
  const fixture = { name: `${producerName} ${grape}`, producer: producerName, label: grape, requested: year, returned: year, region: "", source: "Reviewer producer delimiter regression" };
  const { provider, search } = setup();
  search.mockResolvedValue([hit(fixture)]);
  const parsed = parseWineCandidates(`${producerName} ${grape} ${year}\n$40`);
  expect(parsed).toHaveLength(1);
  const result = await provider.lookup(parsed[0]!);
  expect(result).not.toBeNull();
  expect(result!.matchScore).toBeCloseTo(scoreWineMatch(parsed[0]!, {
    producer: producerName, label: grape, vintage: year, varietal: null, region: "",
  }));
  expect(search).toHaveBeenCalledTimes(1);
});
