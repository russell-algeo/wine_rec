import { describe, expect, it } from "vitest";
import { annotatePriceConflicts, hasPriceConflict } from "./price-conflicts.js";
import { parseWineCandidates } from "./parser.js";

const selectedText = [
  "White",
  "Tissot ‘En Barberon’ Chardonnay, Jura, France 2020 / 44",
  "Cameron, Chardonnay, Dundee Hills, Oregon 2023 / 28",
].join("\n");

describe("conflicting OCR price evidence", () => {
  it("flags an exact row another pass priced differently, keeping the selected price", () => {
    const selected = parseWineCandidates(selectedText);
    const alternate = selectedText.replace("/ 44", "/ 41");
    const annotated = annotatePriceConflicts(selected, [alternate]);
    const tissot = annotated.find((c) => c.producer === "Tissot")!;
    expect(tissot.price).toBe("$44");
    expect(tissot.priceAlternatives).toEqual(["$41"]);
    expect(hasPriceConflict(annotated.find((c) => c.producer === "Cameron")!)).toBe(false);
  });

  it("returns the same candidates, order and ids", () => {
    const selected = parseWineCandidates(selectedText);
    const annotated = annotatePriceConflicts(selected, [selectedText.replace("/ 28", "/ 23")]);
    expect(annotated.map((c) => [c.id, c.price, c.rawText])).toEqual(selected.map((c) => [c.id, c.price, c.rawText]));
  });

  it("ignores formatting-only price differences and identical passes", () => {
    const selected = parseWineCandidates(selectedText);
    const annotated = annotatePriceConflicts(selected, [selectedText, selectedText.replace("/ 44", "/ 44.00")]);
    expect(annotated.some(hasPriceConflict)).toBe(false);
  });

  it("does not compare rows whose identity or context differs", () => {
    const selected = parseWineCandidates(selectedText);
    const differentVintage = selectedText.replace("2020 / 44", "2021 / 41");
    const differentSection = selectedText.replace("White", "Red").replace("/ 44", "/ 41");
    expect(annotatePriceConflicts(selected, [differentVintage]).some(hasPriceConflict)).toBe(false);
    expect(annotatePriceConflicts(selected, [differentSection]).some(hasPriceConflict)).toBe(false);
  });

  it("does not compare ambiguous duplicate rows", () => {
    const duplicated = `${selectedText}\nTissot ‘En Barberon’ Chardonnay, Jura, France 2020 / 44`;
    const selected = parseWineCandidates(duplicated);
    const annotated = annotatePriceConflicts(selected, [duplicated.replace(/\/ 44/g, "/ 41")]);
    expect(annotated.some(hasPriceConflict)).toBe(false);
  });

  it("collects distinct alternatives from several passes", () => {
    const selected = parseWineCandidates(selectedText);
    const annotated = annotatePriceConflicts(selected, [
      selectedText.replace("/ 44", "/ 41"),
      selectedText.replace("/ 44", "/ 14"),
      selectedText.replace("/ 44", "/ 41"),
    ]);
    expect(annotated.find((c) => c.producer === "Tissot")?.priceAlternatives).toEqual(["$14", "$41"]);
  });

  it("ignores implausible dropped-digit readings", () => {
    const selected = parseWineCandidates(selectedText);
    const annotated = annotatePriceConflicts(selected, [selectedText.replace("/ 44", "/ 4")]);
    expect(annotated.some(hasPriceConflict)).toBe(false);
  });

  it("is a no-op without alternates", () => {
    const selected = parseWineCandidates(selectedText);
    expect(annotatePriceConflicts(selected, [])).toBe(selected);
  });
});
