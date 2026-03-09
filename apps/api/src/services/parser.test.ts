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
  });

  integration("parses the photographed sectioned menu from the real screenshot", async () => {
    const extractedText = await ocrFixtureToText("Screenshot 2026-03-08 at 10.48.03");
    const candidates = parseWineCandidates(extractedText);
    const candidateNames = candidates.map((candidate) => canonicalizeText(candidate.rawText));
    const includesWine = (name: string) =>
      candidateNames.some((candidateName) => candidateName.includes(canonicalizeText(name)));

    expect(candidateNames).not.toContain("1");
    expect(candidateNames).not.toContain("rinks");
    expect(includesWine("Martin Texier Petite Nature")).toBe(true);
    expect(includesWine("Stephane Coquillette Inflorescence")).toBe(true);
    expect(includesWine("Bonnet-Huteau Bonnets Blancs")).toBe(true);
    expect(includesWine("Emmanuel Haget Loustic")).toBe(true);
    expect(includesWine("Bodegas Tradicien Fino Tradicien")).toBe(true);
    expect(includesWine("Asahara Shuzo Musashino Sparkling")).toBe(true);
    expect(includesWine("Ota Shuzo Dokan Umeshu")).toBe(true);

    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Martin Texier Petite Nature")),
      )?.color,
    ).toBe("sparkling");
    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Bonnet-Huteau Bonnets Blancs")),
      )?.color,
    ).toBe("white");
    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Emmanuel Haget Loustic")),
      )?.color,
    ).toBe("red");
    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Bodegas Tradicien Fino Tradicien")),
      )?.color,
    ).toBe("sherry");
    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Asahara Shuzo Musashino Sparkling")),
      )?.color,
    ).toBe("sake");
    expect(
      candidates.find((candidate) =>
        canonicalizeText(candidate.rawText).includes(canonicalizeText("Ota Shuzo Dokan Umeshu")),
      )?.color,
    ).toBe("sweet");
  });
});
