import { describe, expect, it } from "vitest";

import {
  isSuspiciousEmptyVivinoSearch,
  selectVivinoSearchHits,
  shouldRetryZeroResultExploreSearch,
  type SearchHit,
} from "./vivino-browser.js";

function buildHit(wineId: number, wineName = `Wine ${wineId}`): SearchHit {
  return {
    wineId,
    wineryName: "Test Winery",
    wineName,
    regionAndCountry: "Test Region, Test Country",
    rating: 4,
    retailPrice: 20,
    imageUrl: "https://images.vivino.com/thumbs/example.png",
    vintagePageUrl: `https://www.vivino.com/w/${wineId}`,
    year: 2023,
  };
}

describe("selectVivinoSearchHits", () => {
  it("prefers DOM hits when links were extracted from the rendered page", () => {
    expect(
      selectVivinoSearchHits({
        domHits: [buildHit(1)],
        preloadedHits: [buildHit(2)],
      }),
    ).toEqual([buildHit(1)]);
  });

  it("falls back to preloaded-state hits when DOM extraction is empty", () => {
    expect(
      selectVivinoSearchHits({
        domHits: [],
        preloadedHits: [buildHit(2)],
      }),
    ).toEqual([buildHit(2)]);
  });
});

describe("isSuspiciousEmptyVivinoSearch", () => {
  it("treats zero result links as suspicious when neither DOM nor state produced hits", () => {
    expect(
      isSuspiciousEmptyVivinoSearch({
        domHits: [],
        preloadedHits: [],
        linkCount: 0,
        showsZeroWineMessage: false,
      }),
    ).toBe(true);
  });

  it("does not treat pages with result links as suspicious even when a lookup yields no hits", () => {
    expect(
      isSuspiciousEmptyVivinoSearch({
        domHits: [],
        preloadedHits: [],
        linkCount: 3,
        showsZeroWineMessage: false,
      }),
    ).toBe(false);
  });

  it("does not treat fallback preloaded-state hits as suspicious", () => {
    expect(
      isSuspiciousEmptyVivinoSearch({
        domHits: [],
        preloadedHits: [buildHit(3)],
        linkCount: 0,
        showsZeroWineMessage: false,
      }),
    ).toBe(false);
  });

  it("treats explore pages explicitly showing zero wines as real no-result pages", () => {
    expect(
      isSuspiciousEmptyVivinoSearch({
        domHits: [],
        preloadedHits: [],
        linkCount: 0,
        showsZeroWineMessage: true,
      }),
    ).toBe(false);
  });
});

describe("shouldRetryZeroResultExploreSearch", () => {
  it("retries explicit zero-result explore pages because they can be transient headless misses", () => {
    expect(
      shouldRetryZeroResultExploreSearch({
        domHits: [],
        preloadedHits: [],
        linkCount: 0,
        showsZeroWineMessage: true,
        url: "https://www.vivino.com/en/explore?search_term=division+villages+beton+american+red",
      }),
    ).toBe(true);
  });

  it("does not retry standard search pages that already have hits", () => {
    expect(
      shouldRetryZeroResultExploreSearch({
        domHits: [buildHit(1)],
        preloadedHits: [],
        linkCount: 10,
        showsZeroWineMessage: false,
        url: "https://www.vivino.com/en/search/wines?q=domaine+mongestine+bob+singlar+red",
      }),
    ).toBe(false);
  });

  it("does not retry non-explore zero-result pages", () => {
    expect(
      shouldRetryZeroResultExploreSearch({
        domHits: [],
        preloadedHits: [],
        linkCount: 0,
        showsZeroWineMessage: true,
        url: "https://www.vivino.com/en/search/wines?q=does+not+exist",
      }),
    ).toBe(false);
  });
});
