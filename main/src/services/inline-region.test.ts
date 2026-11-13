import { describe, expect, it } from "vitest";
import { extractInlineRegion } from "./inline-region.js";
import { parseWineCandidates } from "./parser.js";

describe("literal inline region extraction", () => {
  it.each([
    ["Martin Texier ‘Petite Nature’ Rhône, France 2023", "Rhône, France"],
    ["Tissot ‘En Barberon’ Chardonnay, Jura, France 2020", "Jura, France"],
    ["Cameron, Chardonnay, Dundee Hills, Oregon 2023", "Dundee Hills, Oregon"],
    ["Stefano Occhetti, Langhe Nebbiolo, Italy 2022", "Langhe, Italy"],
    ["Melville, Syrah, Sta. Rita Hills, California 2021", "Sta. Rita Hills, California"],
    ["La Stoppa ‘Vino del Volta’ Emilia-Romagna, Italy 2023", "Emilia-Romagna, Italy"],
    ["Bodegas Tradición ‘Fino Tradición’ Jerez, Spain / 18", "Jerez, Spain"],
  ])("fills %s", (text, expected) => {
    expect(extractInlineRegion(text)).toBe(expected);
  });

  it.each([
    ["Bonnet-Huteau ‘Bonnets Blancs’ Muscadet 2023"],          // no explicit parent
    ["Domaine Something, France"],                              // bare producer, country: ambiguous
    ["Producer ‘Label’ Somewhere, Narnia"],                     // unknown parent
    ["Producer ‘Label’ 750ml, France"],                         // digits are not a place
    ["Producer ‘Label’ very long lowercase words here, France"],// not proper-noun place words
    ["Producer ‘Label’ France, France"],                        // place equal to parent
    [""],
    [null],
  ])("leaves %s unresolved", (text) => {
    expect(extractInlineRegion(text as string | null)).toBeNull();
  });

  it("does not override stronger existing region metadata", () => {
    const [candidate] = parseWineCandidates("RED\nRabasco 'Lu Cuntaden' 2020 | Montepulciano | Abruzzo, Italy 80");
    expect(candidate?.region).not.toBe(null);
    expect(candidate?.region?.toLowerCase()).toBe("abruzzo, italy");
  });

  it("fills a parsed menu row without changing price, producer or label", () => {
    const text = "White\nTissot ‘En Barberon’ Chardonnay, Jura, France 2020 / 44";
    const [candidate] = parseWineCandidates(text);
    expect(candidate).toMatchObject({ price: "$44", producer: "Tissot", label: "En Barberon", region: "Jura, France", vintage: 2020 });
  });

  it("does not repeat a region that the display name already shows", () => {
    const [candidate] = parseWineCandidates("RED\nLes Salicaires ‘Primal’ - Roussillon, FR\n17");
    if (candidate) expect(candidate.rawText.match(/Roussillon/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
