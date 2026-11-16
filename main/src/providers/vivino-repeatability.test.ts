import { afterEach, describe, expect, it, vi } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { VivinoBrowser, type SearchHit } from "./vivino-browser.js";
import { createWineProfileProviders } from "./wine-profiles.js";
import { vivinoMatchCacheKey } from "./vivino-match-cache.js";

const candidate: WineCandidate = {
  id: "c1", rawText: "2023 Rebula, Iggy Adelaide Hills, SA", producer: "Iggy", label: "Rebula", vintage: 2023,
  price: "$70", menuTab: null, menuSection: "WHITE WINES", lineNumber: 0, color: "white", varietal: null,
  region: null, notes: null, extractionConfidence: 0.9,
};
const hit = (wineId: number, wineryName: string, wineName: string): SearchHit => ({
  wineId, wineryName, wineName, year: 2023, rating: 4, retailPrice: null, imageUrl: null,
  vintagePageUrl: `https://www.vivino.com/w/${wineId}`, regionAndCountry: "",
});
const shopListing = [hit(1, "Iggy Pop", "Lust For Life Shiraz"), hit(2, "Ziggy", "Chardonnay")];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("repeatable Vivino lookups", () => {
  it("asks again when the catalogue search just repeats the shop listing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const calls: boolean[] = [];
    let catalogueCalls = 0;
    vi.spyOn(VivinoBrowser.getInstance(), "search").mockImplementation(async (_query, _guard, options) => {
      calls.push(Boolean(options?.includeNonBuyable));
      if (!options?.includeNonBuyable) return shopListing;
      catalogueCalls += 1;
      return catalogueCalls === 1 ? shopListing : [hit(3, "Iggy Wines", "Rebula 2023")];
    });
    vi.spyOn(VivinoBrowser.getInstance(), "fetchVintagePageMeta").mockResolvedValue(null as never);
    const provider = createWineProfileProviders().find(value => value.name === "vivino-direct")!;
    const result = await provider.lookup(candidate);
    expect(calls.slice(0, 3)).toEqual([false, true, true]);
    expect(result?.profile.displayName).toContain("Rebula");
  });

  it("keys remembered matches on the menu row, ignoring case, accents and spacing", () => {
    const key = vivinoMatchCacheKey(candidate);
    expect(vivinoMatchCacheKey({ ...candidate, rawText: "2023  REBULA, Iggy Adelaide Hills, SA " })).toBe(key);
    expect(vivinoMatchCacheKey({ ...candidate, vintage: 2022 })).not.toBe(key);
    expect(vivinoMatchCacheKey({ ...candidate, menuSection: "RED WINES" })).not.toBe(key);
  });

  it("won't pick one of a producer's appellation wines when the row names none of them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const leMoine: WineCandidate = { ...candidate, rawText: "Chardonnay, Lucien Le Moine '15", producer: "Chardonnay", label: "Lucien Le Moine", vintage: 2015, menuSection: null, color: null };
    const withRegion = (wineId: number, wineName: string) => ({ ...hit(wineId, "Lucien le Moine", wineName), regionAndCountry: `${wineName}, France` });
    vi.spyOn(VivinoBrowser.getInstance(), "search").mockResolvedValue([withRegion(11, "Bonnes-Mares Grand Cru"), withRegion(12, "Clos Saint-Denis Grand Cru")]);
    const provider = createWineProfileProviders().find(value => value.name === "vivino-direct")!;
    expect(await provider.lookup(leMoine)).toBeNull();
  });
});
