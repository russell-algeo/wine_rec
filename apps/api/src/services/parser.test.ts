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

  it("recognizes glass/bottle prices and uses the bottle price", () => {
    const extractedText = [
      "@@SECTION: House Wine Selections",
      "Saperavi, Kakheti, Georgia '21",
      "18 / 72",
      "",
      "Sancerre, Roland Tissier '23",
      "22 / 88",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rawText).toBe("Saperavi, Kakheti, Georgia '21");
    expect(candidates[0]?.price).toBe("$72");
    expect(candidates[1]?.rawText).toBe("Sancerre, Roland Tissier '23");
    expect(candidates[1]?.price).toBe("$88");
  });

  it("recognizes compound color section headers like 'White & Orange-Rose'", () => {
    const extractedText = [
      "White & Orange-Rose",
      "Sancerre, Domaine Roland Tissier et Fils, '22",
      "$95",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.color).toBe("white");
    expect(candidates[0]?.price).toBe("$95");
  });

  it("parses pipe-delimited OCR format: Name | Varietal | Region Price", () => {
    const extractedText = [
      "RED",
      "Maxime Troncy 'Sourire' 2021 | Gamay | Beaujolais, France 17/68 *",
      "Rabasco 'Lu Cuntaden' 2020 | Montepulciano | Abruzzo, Italy 80",
      "Domaine des Frères 'Les Pucelles' Chinon 2021 | Cabernet Franc | Loire Valley, France 80",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(3);

    expect(candidates[0]?.rawText).toBe("Maxime Troncy 'Sourire' 2021, Gamay, Beaujolais, France");
    expect(candidates[0]?.producer).toBe("Maxime Troncy");
    expect(candidates[0]?.label).toBe("Sourire");
    expect(candidates[0]?.vintage).toBe(2021);
    expect(candidates[0]?.varietal).toBe("gamay");
    expect(candidates[0]?.region).toBe("Beaujolais, France");
    expect(candidates[0]?.price).toBe("$68");
    expect(candidates[0]?.color).toBe("red");

    expect(candidates[1]?.rawText).toBe("Rabasco 'Lu Cuntaden' 2020, Montepulciano, Abruzzo, Italy");
    expect(candidates[1]?.varietal).toBe("montepulciano");
    expect(candidates[1]?.region).toBe("Abruzzo, Italy");
    expect(candidates[1]?.price).toBe("$80");

    expect(candidates[2]?.rawText).toBe("Domaine des Frères 'Les Pucelles' Chinon 2021, Cabernet Franc, Loire Valley, France");
    expect(candidates[2]?.varietal).toBe("cabernet franc");
    expect(candidates[2]?.region).toBe("Loire Valley, France");
    expect(candidates[2]?.price).toBe("$80");
  });

  it("recovers varietal and region when OCR delivers pipe segments as separate lines", () => {
    // When Tesseract strips trailing "|" characters, "Name | Varietal | Region Price" arrives
    // as three separate lines. The parser should promote them to structured fields.
    const extractedText = [
      "RED",
      "Elodie Balme |",
      "Grenache/Carignan |",
      "Rhone, France 16/65*",
      "Mylene Bru 'Cartouche' |",
      "Syrah |",
      "VDF 20/80",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    expect(candidates).toHaveLength(2);

    expect(candidates[0]?.rawText).toBe("Elodie Balme, Grenache/Carignan, Rhône, France");
    expect(candidates[0]?.varietal).toBe("grenache/carignan");
    expect(candidates[0]?.region).toBe("Rhône, France");
    expect(candidates[0]?.price).toBe("$65");

    expect(candidates[1]?.rawText).toBe("Mylene Bru 'Cartouche', Syrah, VDF");
    expect(candidates[1]?.varietal).toBe("syrah");
    expect(candidates[1]?.price).toBe("$80");
  });

  it("parses screenshot-shaped OCR text with inline multi-price rows", () => {
    const extractedText = [
      "7:17PM Wed Mar 18 FP",
      "zoves winelist",
      "Google zoves winelist x | LMA",
      "Silver Oak), Sauvignon Blanc, and sparkling options, with half-off select bottles on",
      "Tuesdays. Zov's +4",
      "White Wines (Glass/Carafe/Bottle)",
      "¢ Bianchi Chardonnay, Central Coast: $14 / $27 / $49",
      "Mer Soleil Reserve Chardonnay, Monterey: $16 / $31/ $56",
      "Post & Beam Chardonnay, Carneros: $20 / $39 / $70",
      "Domain Des Marechaudes Chardonnay, Burgundy: $15 / $29 / $52",
      "¢ Duckhorn Sauvignon Blane, North Coast: $15 / $29 / $52",
      "¢ Levendi Sauvignon Blane, Napa Valley: $18 / $35 / $63",
      "e Jermann Pinot Grigio, Friuli, Italy: $14 / $27 / $49",
      "* Sonoma Cutrer Chardonnay, Russian River: NA/ NA/ $60",
      "¢ Rombauer Chardonnay, Carneros: NA/NA/ $70",
      "* Studio by Miraval Rose, Provence: $13 / $25 / $45 @ zovs",
      "Red Wines (Glass/Carafe/Bottle) 2",
      "¢ Bonanza Cabernet Sauvignon, Napa/Lake: $14 / $27 / $49",
      "¢ Daou Cabernet Sauvignon, Napa Valley: $20 / $39 / $70",
      "¢ Post. & Beam Cabernet Sauvignon, Napa Valley: $20 / $39 / $70",
      "¢ Duckhorn Merlot, Napa Valley: $18 / $35 / $63",
      "Silver Oak Cabernet Sauvignon, Alexander Valley: NA / NA / $110",
      "Jayson by Pahimeyer Cabernet, Napa: NA/ NA / $120",
      "¢ Cardwell Hills Pinot Noir, Willamette Valley: NA / NA/ $55",
      "¢ Golden Eye Pinot Noir, Anderson Valley: NA / NA/ $90",
      "¢ Paraduxx Proprietary Red, Napa Valley: NA / NA/ $85 @ Zovs",
      "Sparkling (Split/Bottle) 2",
      "e Mionetto Prosecco, Italy: $13 / NA",
    ].join("\n");

    const candidates = parseWineCandidates(extractedText);
    const normalizedNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));

    expect(candidates).toHaveLength(20);
    expect(normalizedNames).toContain(canonicalizeText("Bianchi Chardonnay, Central Coast"));
    expect(normalizedNames).toContain(canonicalizeText("Silver Oak Cabernet Sauvignon, Alexander Valley"));
    expect(normalizedNames).toContain(canonicalizeText("Mionetto Prosecco, Italy"));
    expect(candidates[0]?.price).toBe("$49");
    expect(candidates[0]?.color).toBe("white");
    expect(candidates[10]?.color).toBe("red");
    expect(candidates[19]?.color).toBe("sparkling");
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
        rawText: canonicalizeText("Stéphane Coquillette Champagne, France"),
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
