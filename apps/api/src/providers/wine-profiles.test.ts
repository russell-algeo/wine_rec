import { afterEach, describe, expect, it, vi } from "vitest";

import type { WineCandidate } from "@wine-rec/contracts";

import {
  VivinoBrowser,
  pickPreferredVivinoImageUrl,
  pickVivinoAggregateRating,
} from "./vivino-browser.js";
import {
  createWineProfileProviders,
  extractVivinoImageUrlFromHtml,
  extractTastingNoteGroups,
  normalizeVivinoTasteReviewCount,
} from "./wine-profiles.js";

function vivinoStructureToScale(value: number | null | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(5, Math.round(value)));
}

function getVivinoProvider() {
  const provider = createWineProfileProviders().find((entry) => entry.name === "vivino-direct");
  if (!provider) {
    throw new Error("vivino-direct provider is not registered");
  }

  return provider;
}

function buildVivinoCandidate(): WineCandidate {
  return {
    id: "candidate-vivino",
    rawText: "Stefano Occhetti Langhe Nebbiolo",
    price: "$38.00",
    menuTab: null,
    menuSection: null,
    lineNumber: 0,
    producer: "Stefano Occhetti",
    label: "Langhe Nebbiolo",
    vintage: null,
    color: "red",
    varietal: "Nebbiolo",
    region: "Langhe, Italy",
    notes: null,
    extractionConfidence: 0.96,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wine profile providers", () => {
  it("registers only the active provider chain", () => {
    const providers = createWineProfileProviders();

    expect(providers.map((provider) => provider.name)).toEqual([
      "vivino-direct",
      "rule-based",
    ]);
  });

  it("uses the extracted title as the fallback display name for inferred profiles", async () => {
    const provider = createWineProfileProviders().find((entry) => entry.name === "rule-based");
    if (!provider) {
      throw new Error("rule-based provider is not registered");
    }

    const candidate: WineCandidate = {
      id: "candidate-1",
      rawText: "Cardedu 'Praja' Monica di Sardegna",
      price: "$23.99",
      menuTab: null,
      menuSection: null,
      lineNumber: 0,
      producer: "Cardedu",
      label: "Praja Monica di Sardegna",
      vintage: null,
      color: null,
      varietal: null,
      region: null,
      notes: null,
      extractionConfidence: 0.88,
    };

    const result = await provider.lookup(candidate);
    expect(result?.profile.displayName).toBe(candidate.rawText);
    expect(result?.matchScore).toBe(0.05);
    expect(result?.profile.taste.body).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.acidity).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.tannin).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.sweetness).toBeLessThanOrEqual(5);
  });

  it("uses the /reviews endpoint for the top-level rating before falling back to page scraping", async () => {
    const provider = getVivinoProvider();
    const browser = VivinoBrowser.getInstance();
    const searchSpy = vi.spyOn(browser, "search").mockResolvedValue([
      {
        wineId: 9007803,
        wineryName: "Stefano Occhetti",
        wineName: "Langhe Nebbiolo",
        regionAndCountry: "Langhe, Italy",
        rating: 4.2,
        imageUrl: null,
        vintagePageUrl:
          "https://www.vivino.com/en/stefano-occhetti-langhe-nebbiolo/w/9007803?ref=nav-search",
        year: null,
      },
    ]);
    const scrapeSpy = vi.spyOn(browser, "fetchVintagePageMeta").mockResolvedValue({
      aggregateRating: {
        rating: 4.2,
        ratingCount: 383,
        ratingSource: "wine",
      },
      imageUrl: "https://images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
    });
    const fetchMock = vi.fn(async (input: URL | string | Request) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : String(input);

      if (url === "https://www.vivino.com/api/wines/9007803/reviews?per_page=1&language=en") {
        return new Response(
          JSON.stringify({
            reviews: [
              {
                vintage: {
                  statistics: {
                    ratings_average: 4.2,
                    ratings_count: 383,
                  },
                  image: {
                    variations: {
                      large:
                        "//images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
                    },
                  },
                  wine: {
                    id: 9007803,
                  },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url === "https://www.vivino.com/api/wines/9007803/tastes") {
        return new Response(
          JSON.stringify({
            tastes: {
              structure: {
                acidity: 3.8,
                sweetness: 1.2,
                tannin: 2.7,
                intensity: 3.6,
                user_structure_count: 40,
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.lookup(buildVivinoCandidate());

    expect(result?.profile.rating).toBe(4.2);
    expect(result?.profile.ratingCount).toBe(383);
    expect(result?.profile.ratingSource).toBe("wine");
    expect(result?.profile.imageUrl).toBe(
      "https://images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
    );
    expect(scrapeSpy).not.toHaveBeenCalled();
    expect(searchSpy).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.map(([input]) =>
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : String(input),
      ),
    ).toEqual(
      expect.arrayContaining([
        "https://www.vivino.com/api/wines/9007803/reviews?per_page=1&language=en",
        "https://www.vivino.com/api/wines/9007803/tastes",
      ]),
    );
  });

  it("falls back to the page scrape when the /reviews endpoint has no aggregate data", async () => {
    const provider = getVivinoProvider();
    const browser = VivinoBrowser.getInstance();
    vi.spyOn(browser, "search").mockResolvedValue([
      {
        wineId: 9007803,
        wineryName: "Stefano Occhetti",
        wineName: "Langhe Nebbiolo",
        regionAndCountry: "Langhe, Italy",
        rating: 4.2,
        imageUrl: null,
        vintagePageUrl:
          "https://www.vivino.com/en/stefano-occhetti-langhe-nebbiolo/w/9007803?ref=nav-search",
        year: null,
      },
    ]);
    const scrapeSpy = vi.spyOn(browser, "fetchVintagePageMeta").mockResolvedValue({
      aggregateRating: {
        rating: 4.2,
        ratingCount: 383,
        ratingSource: "wine",
      },
      imageUrl: "https://images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
    });
    const fetchMock = vi.fn(async (input: URL | string | Request) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : String(input);

      if (url === "https://www.vivino.com/api/wines/9007803/reviews?per_page=1&language=en") {
        return new Response(
          JSON.stringify({
            reviews: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url === "https://www.vivino.com/api/wines/9007803/tastes") {
        return new Response(
          JSON.stringify({
            tastes: {
              structure: {
                acidity: 3.8,
                sweetness: 1.2,
                tannin: 2.7,
                intensity: 3.6,
                user_structure_count: 40,
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.lookup(buildVivinoCandidate());

    expect(result?.profile.rating).toBe(4.2);
    expect(result?.profile.ratingCount).toBe(383);
    expect(result?.profile.ratingSource).toBe("wine");
    expect(result?.profile.imageUrl).toBe(
      "https://images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
    );
    expect(scrapeSpy).toHaveBeenCalledOnce();
  });

  it("fetches the product page HTML for an image fallback without invoking the browser scrape", async () => {
    const provider = getVivinoProvider();
    const browser = VivinoBrowser.getInstance();
    vi.spyOn(browser, "search").mockResolvedValue([
      {
        wineId: 9007803,
        wineryName: "Stefano Occhetti",
        wineName: "Langhe Nebbiolo",
        regionAndCountry: "Langhe, Italy",
        rating: 4.2,
        imageUrl: null,
        vintagePageUrl:
          "https://www.vivino.com/en/stefano-occhetti-langhe-nebbiolo/w/9007803?ref=nav-search",
        year: null,
      },
    ]);
    const scrapeSpy = vi.spyOn(browser, "fetchVintagePageMeta").mockResolvedValue({
      aggregateRating: {
        rating: 4.2,
        ratingCount: 383,
        ratingSource: "wine",
      },
      imageUrl: "https://images.vivino.com/thumbs/should-not-be-used_375x500.jpg",
    });
    const fetchMock = vi.fn(async (input: URL | string | Request) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : String(input);

      if (url === "https://www.vivino.com/api/wines/9007803/reviews?per_page=1&language=en") {
        return new Response(
          JSON.stringify({
            reviews: [
              {
                vintage: {
                  statistics: {
                    ratings_average: 4.2,
                    ratings_count: 383,
                  },
                  wine: {
                    id: 9007803,
                  },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url === "https://www.vivino.com/api/wines/9007803/tastes") {
        return new Response(
          JSON.stringify({
            tastes: {
              structure: {
                acidity: 3.8,
                sweetness: 1.2,
                tannin: 2.7,
                intensity: 3.6,
                user_structure_count: 40,
              },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (
        url ===
        "https://www.vivino.com/en/stefano-occhetti-langhe-nebbiolo/w/9007803?ref=nav-search"
      ) {
        return new Response(
          [
            '<picture class="wineLabel-module__picture--2DM3o wineLabel-module__imperfectLabel--1AqxK">',
            '<source media="(min-width: 425px)" srcset="//images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_150x200.jpg, //images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg 2x">',
            '<img class="wineLabel-module__image--3HOnd" alt="Stefano Occhetti Langhe Nebbiolo" src="//images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_150x200.jpg">',
            "</picture>",
          ].join(""),
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        );
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.lookup(buildVivinoCandidate());

    expect(result?.profile.rating).toBe(4.2);
    expect(result?.profile.ratingCount).toBe(383);
    expect(result?.profile.ratingSource).toBe("wine");
    expect(result?.profile.imageUrl).toBe(
      "https://images.vivino.com/thumbs/eWMCv0yOQBm-P5O7ZIAiMQ_375x500.jpg",
    );
    expect(scrapeSpy).not.toHaveBeenCalled();
  });
});

describe("vivinoStructureToScale", () => {
  it("maps taste API ~1-5 values correctly", () => {
    expect(vivinoStructureToScale(3.76)).toBe(4);
    expect(vivinoStructureToScale(2.07)).toBe(2);
    expect(vivinoStructureToScale(1.49)).toBe(1);
    expect(vivinoStructureToScale(1.98)).toBe(2);
  });

  it("clamps to 1-5 range", () => {
    expect(vivinoStructureToScale(0.1)).toBe(1);
    expect(vivinoStructureToScale(5.9)).toBe(5);
  });

  it("returns undefined for null/undefined/NaN", () => {
    expect(vivinoStructureToScale(null)).toBeUndefined();
    expect(vivinoStructureToScale(undefined)).toBeUndefined();
    expect(vivinoStructureToScale(NaN)).toBeUndefined();
  });
});

describe("pickVivinoAggregateRating", () => {
  it("prefers the wine-level top block over a vintage-specific aggregate", () => {
    expect(
      pickVivinoAggregateRating({
        vintage: {
          statistics: {
            ratings_average: 4.1,
            ratings_count: 82,
          },
        },
        wine: {
          statistics: {
            ratings_average: 3.7,
            ratings_count: 701,
          },
        },
      }),
    ).toEqual({
      rating: 3.7,
      ratingCount: 701,
      ratingSource: "wine",
    });
  });

  it("still uses the wine-level top block when the selected year is below Vivino's threshold", () => {
    expect(
      pickVivinoAggregateRating({
        vintage: {
          statistics: {
            ratings_average: 0,
            ratings_count: 1,
          },
        },
        wine: {
          statistics: {
            ratings_average: 3.7,
            ratings_count: 701,
          },
        },
      }),
    ).toEqual({
      rating: 3.7,
      ratingCount: 701,
      ratingSource: "wine",
    });
  });
});

describe("pickPreferredVivinoImageUrl", () => {
  it("falls back from Vivino's generic bottle placeholder to the page image", () => {
    expect(
      pickPreferredVivinoImageUrl(
        "https://web-common.vivino.com/assets/bottleShot/fallback_1.png",
        "//images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_375x500.jpg",
      ),
    ).toBe("https://images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_375x500.jpg");
  });

  it("returns null when every candidate is invalid or a placeholder", () => {
    expect(
      pickPreferredVivinoImageUrl(
        "",
        "https://web-common.vivino.com/assets/bottleShot/fallback_2.png",
        undefined,
      ),
    ).toBeNull();
  });
});

describe("extractTastingNoteGroups", () => {
  it("normalizes, sorts, deduplicates, and limits Vivino flavor groups", () => {
    expect(
      extractTastingNoteGroups([
        {
          group: "non_oak",
          color: "#F5F0EC",
          stats: { score: 16.4 },
          primary_keywords: [{ name: "almond" }, { name: "hazelnut" }],
        },
        {
          group: "microbio",
          color: "#F9F3ED",
          stats: { score: 14.1 },
          primary_keywords: [{ name: "yeast" }, { name: "cream" }],
        },
        {
          group: "black_fruit",
          color: "#E3D7EF",
          stats: { score: 9.1 },
          primary_keywords: [
            { name: "blackberry", image: "//images.vivino.com/flavors/blackberry.png" },
            { name: "blueberry" },
          ],
        },
        {
          group: "yeasty",
          color: "#F9F3ED",
          stats: { score: 8.2 },
          primary_keywords: [{ name: "yeast" }, { name: "cream" }, { name: "Cream" }],
        },
        {
          group: "red_fruit",
          color: "#F9EBEA",
          stats: { score: 12.4 },
          primary_keywords: [
            { name: "raspberry" },
            { name: "strawberry", image: "//images.vivino.com/flavors/strawberry.png" },
          ],
        },
        {
          group: "floral",
          color: "#F4E8F1",
          stats: { score: 1.2 },
          primary_keywords: [{ name: "violet" }],
        },
      ]),
    ).toEqual([
      {
        key: "non-oak",
        label: "Ageing",
        score: 16.4,
        noteCount: 2,
        keywords: ["almond", "hazelnut"],
        keywordImageUrls: [null, null],
        color: "#F5F0EC",
        imageUrl: null,
      },
      {
        key: "microbio",
        label: "Yeasty",
        score: 14.1,
        noteCount: 2,
        keywords: ["yeast", "cream"],
        keywordImageUrls: [null, null],
        color: "#F9F3ED",
        imageUrl: null,
      },
      {
        key: "red-fruit",
        label: "Red Fruit",
        score: 12.4,
        noteCount: 2,
        keywords: ["raspberry", "strawberry"],
        keywordImageUrls: [null, "https://images.vivino.com/flavors/strawberry.png"],
        color: "#F9EBEA",
        imageUrl: "https://images.vivino.com/flavors/strawberry.png",
      },
    ]);
  });
});

describe("extractVivinoImageUrlFromHtml", () => {
  it("prefers the higher-resolution hero image from the product page HTML", () => {
    expect(
      extractVivinoImageUrlFromHtml([
        '<picture class="wineLabel-module__picture--2DM3o wineLabel-module__imperfectLabel--1AqxK">',
        '<source media="(min-width: 425px)" srcset="//images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_150x200.jpg, //images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_375x500.jpg 2x">',
        '<img class="wineLabel-module__image--3HOnd" alt="Les Salicaires Primal" src="//images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_150x200.jpg">',
        "</picture>",
      ].join("")),
    ).toBe("https://images.vivino.com/thumbs/AZ_BlLu_Tm6Q7b4O5lqqTw_375x500.jpg");
  });
});

describe("normalizeVivinoTasteReviewCount", () => {
  it("returns the Vivino user taste review count", () => {
    expect(normalizeVivinoTasteReviewCount(2)).toBe(2);
    expect(normalizeVivinoTasteReviewCount(0)).toBe(0);
  });

  it("returns null for invalid counts", () => {
    expect(normalizeVivinoTasteReviewCount(null)).toBeNull();
    expect(normalizeVivinoTasteReviewCount(undefined)).toBeNull();
    expect(normalizeVivinoTasteReviewCount(NaN)).toBeNull();
    expect(normalizeVivinoTasteReviewCount(-1)).toBeNull();
  });
});
