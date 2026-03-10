import { describe, expect, it } from "vitest";

import { parseWineCandidates } from "./parser.js";
import { canonicalizeText, hasTesseract, ocrFixtureToText } from "../test-support/ocr-fixtures.js";

describe("wine parser", () => {
  it("groups title, notes, and price into a single wine candidate block", () => {
    const extractedText = [
      "RED",
      "",
      "Les Salicaires ‘Primal’ - Roussillon, FR",
      "",
      "Chilled, dry, sour cherry, watermelon Jolly Rancher, sea kelp",
      "",
      "$17",
      "",
      "Toby Bainbridge ‘Crush’ - Loire Valley, FR",
      "",
      "Chilled, dry, Ocean Spray cranberry, tangerine skins, dried hibiscus",
      "",
      "$15",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.producer).toBe("Les Salicaires");
    expect(candidates[0]?.label).toBe("Primal");
    expect(candidates[0]?.region).toBe("Roussillon, FR");
    expect(candidates[0]?.color).toBe("red");
    expect(candidates[0]?.notes).toContain("sour cherry");
    expect(candidates[0]?.price).toBe("$17");
    expect(candidates[1]?.price).toBe("$15");
  });

  it("keeps quoted labels ahead of trailing appellation text", () => {
    const extractedText = ["Cardedu 'Praja' Monica di Sardegna", "$23.99"].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rawText).toBe("Cardedu 'Praja' Monica di Sardegna");
    expect(candidates[0]?.producer).toBe("Cardedu");
    expect(candidates[0]?.label).toBe("Praja Monica di Sardegna");
    expect(candidates[0]?.price).toBe("$23.99");
  });

  it("merges wrapped title continuation lines before the price", () => {
    const extractedText = [
      "Domaine de la Mongestine Bob Singlar",
      "Red Wine",
      "$21.99",
      "",
      "Casa Santos Lima, Vinho Regional",
      "Lisboa Bons Ventos Tinto",
      "$9.99",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rawText).toBe("Domaine de la Mongestine Bob Singlar Red Wine");
    expect(candidates[1]?.rawText).toBe("Casa Santos Lima, Vinho Regional Lisboa Bons Ventos Tinto");
    expect(candidates[0]?.price).toBe("$21.99");
    expect(candidates[1]?.price).toBe("$9.99");
  });

  it("preserves structured tab and section markers in parsed candidates", () => {
    const extractedText = [
      "@@TAB: BY THE GLASS",
      "@@SECTION: RED",
      "Les Salicaires ‘Primal’ - Roussillon, FR",
      "Chilled, dry, sour cherry, watermelon Jolly Rancher, sea kelp",
      "$17",
      "",
      "@@TAB: BOTTLE LIST",
      "@@SECTION: WHITE",
      "Cantina Giardino ‘Gaia’ - Campania, IT",
      "Salty citrus, peach skin, chamomile",
      "$21",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.menuTab).toBe("BY THE GLASS");
    expect(candidates[0]?.menuSection).toBe("RED");
    expect(candidates[0]?.color).toBe("red");
    expect(candidates[1]?.menuTab).toBe("BOTTLE LIST");
    expect(candidates[1]?.menuSection).toBe("WHITE");
    expect(candidates[1]?.color).toBe("white");
  });

  const integration = hasTesseract ? it : it.skip;

  integration("parses the real red-menu screenshot into three wines", async () => {
    const extractedText = await ocrFixtureToText("Screenshot 2026-03-08 at 9.47.34");
    const candidates = parseWineCandidates(extractedText);
    const candidateNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));
    const includesWine = (name: string) =>
      candidateNames.some((candidateName) => candidateName.includes(canonicalizeText(name)));

    expect(candidates).toHaveLength(3);
    expect(includesWine("Les Salicaires Primal")).toBe(true);
    expect(includesWine("Toby Bainbridge Crush")).toBe(true);
    expect(includesWine("United Cellars of Tekov Kind of Glou")).toBe(true);
    expect(candidates.map((candidate) => candidate.price)).toEqual(["$17", "$15", "$17"]);
  }, 15_000);

  integration("parses the photographed sectioned menu from the real screenshot", async () => {
    const extractedText = await ocrFixtureToText("Screenshot 2026-03-08 at 10.48.03");
    const candidates = parseWineCandidates(extractedText);
    const normalizedCandidates = candidates.map((candidate) => ({
      rawText: canonicalizeText(candidate.rawText),
      price: candidate.price,
      color: candidate.color,
    }));

    expect(normalizedCandidates).toEqual([
      {
        rawText: canonicalizeText("Martin Texier Petite Nature Rhône, France 2023"),
        price: "$19",
        color: "sparkling",
      },
      {
        rawText: canonicalizeText("Stéphane Coquillette Inflorescence Champagne, France"),
        price: "$31",
        color: "sparkling",
      },
      {
        rawText: canonicalizeText("Bonnet-Huteau Bonnets Blancs Muscadet 2023"),
        price: "$14",
        color: "white",
      },
      {
        rawText: canonicalizeText("Schäztel Naturweiss Rheinhessen, Germany 2022"),
        price: "$19",
        color: "white",
      },
      {
        rawText: canonicalizeText("Cameron, Chardonnay, Dundee Hills, Oregon 2023"),
        price: "$28",
        color: "white",
      },
      {
        rawText: canonicalizeText("Franz Strohmeier Lysegren No. 9 Styria, Austria 2021"),
        price: "$38",
        color: "white",
      },
      {
        rawText: canonicalizeText("Tissot En Barberon Chardonnay, Jura, France 2020"),
        price: "$44",
        color: "white",
      },
      {
        rawText: canonicalizeText("Emmanuel Haget Loustic Saumur, France 2023"),
        price: "$16",
        color: "red",
      },
      {
        rawText: canonicalizeText("Stefano Occhetti, Langhe Nebbiolo, Italy 2022"),
        price: "$22",
        color: "red",
      },
      {
        rawText: canonicalizeText("Melville, Syrah, Sta. Rita Hills, California 2021"),
        price: "$26",
        color: "red",
      },
      {
        rawText: canonicalizeText("Bodegas Tradición Fino Tradición Jerez, Spain"),
        price: "$18",
        color: "sherry",
      },
      {
        rawText: canonicalizeText("Asahara Shuzo Musashino Sparkling Saitama, Japan"),
        price: "$16",
        color: "sake",
      },
      {
        rawText: canonicalizeText("Kidoizumi Shuzo Yamadanishiki Chiba, Japan"),
        price: "$17",
        color: "sake",
      },
      {
        rawText: canonicalizeText("Kirei Shuzo Hachiku Hiroshima, Japan"),
        price: "$19",
        color: "sake",
      },
      {
        rawText: canonicalizeText("Ota Shuzo Dokan Umeshu Shiga. Japan"),
        price: "$18",
        color: "sweet",
      },
      {
        rawText: canonicalizeText("La Stoppa Vino del Volta Emilia-Romagna, Italy 2023"),
        price: "$26",
        color: "sweet",
      },
    ]);
  }, 15_000);
});
