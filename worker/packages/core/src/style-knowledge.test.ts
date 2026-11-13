import { describe, expect, it } from "vitest";
import { inferStyleKey, inferTasteVector } from "./index.js";
import { looksLikeNonWine, styleKeyFromText } from "./style-knowledge.js";

describe("styleKeyFromText", () => {
  it.each([
    ["2019 Domaine X, Sancerre", "sauvignon_blanc"],
    ["Brunello di Montalcino 2018", "sangiovese"],
    ["Rioja Blanco 2021", "medium_white"],
    ["Côtes du Rhône Rosé", "rose_dry"],
    ["Adernats Cava Xarel-lo, Parellada", "default_sparkling"],
    ["Enfant de Pinot Noir, Meunier, Champagne", "champagne"],
    ["Buenagente (tinto fino)", "tempranillo"],
    ["Junmai Daiginjo, Niigata", "sake"],
    ["Cape Tawny Port, Calitzdorp", "port_tawny"],
  ])("%s -> %s", (text, key) => {
    expect(styleKeyFromText(text)).toBe(key);
  });

  it("returns null when nothing identifies the style", () => {
    expect(styleKeyFromText("Special Reserve 2004")).toBeNull();
  });
});

describe("inferStyleKey", () => {
  it("prefers the wine's own text over a crude parsed varietal", () => {
    expect(inferStyleKey({ rawText: "Delaire Graff Rosé, Stellenbosch", varietal: "cabernet" }).key).toBe("rose_dry");
  });

  it("falls back to the section heading as non-specific evidence", () => {
    expect(inferStyleKey({ rawText: "Château Example 2019", menuSection: "Red Wines" })).toEqual({ key: "default_red", specific: false });
  });

  it("leaves spirits and cocktails unscored", () => {
    expect(looksLikeNonWine("Glenlivet 12 year single malt scotch")).toBe(true);
    const taste = inferTasteVector({ rawText: "Spanish Mojito, Bacardi rum, lime", menuSection: "White" });
    expect(taste.confidence).toBe(0);
  });

  it("gives specific evidence more confidence than section fallback", () => {
    expect(inferTasteVector({ rawText: "Barolo 2017" }).confidence).toBe(0.45);
    expect(inferTasteVector({ rawText: "House pour", menuSection: "Red" }).confidence).toBe(0.35);
  });
});
