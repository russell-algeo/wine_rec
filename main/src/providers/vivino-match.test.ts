import { describe, expect, it } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { buildVivinoIdentityQueries, scoreVivinoIdentity } from "./vivino-match.js";

function row(rawText: string, producer: string | null, label: string | null, extra: Partial<WineCandidate> = {}): WineCandidate {
  return {
    id: "row", rawText, producer, label, vintage: null, price: "$50", menuTab: null, menuSection: null,
    lineNumber: 0, color: null, varietal: null, region: null, notes: null, extractionConfidence: 0.9, ...extra,
  };
}
const hit = (wineryName: string, wineName: string, regionAndCountry = "") => ({ wineryName, wineName, regionAndCountry });

// Cases come from the dev half of the shared corpus (real wine lists).
describe("scoreVivinoIdentity", () => {
  it("matches the right producer's wine although parser fields are misassigned", () => {
    const greywacke = row("GREYWACKE SAUVIGNON BLANC 2022   85 €", "GREYWACKE SAUVIGNON BLANC", "85 €");
    expect(scoreVivinoIdentity(greywacke, hit("Greywacke", "Sauvignon Blanc 2025", "Marlborough, New Zealand"))).toBeGreaterThan(0.85);
    expect(scoreVivinoIdentity(greywacke, hit("Lexicon", "Sauvignon Blanc 2022", "Marlborough, New Zealand"))).toBeLessThan(0.6);
  });

  it("does not take a namesake producer", () => {
    const rocca = row("Bruno Rocca, Barbera d ’Alba 2023", "Bruno Rocca", "Barbera d ’Alba");
    const right = scoreVivinoIdentity(rocca, hit("Bruno Rocca", "Barbera d'Alba 2022", "Barbera d'Alba, Italy"));
    const wrong = scoreVivinoIdentity(rocca, hit("Bruno Giacosa", "Barbera d’Alba 2023", "Piemonte, Italy"));
    expect(right).toBeGreaterThan(0.85);
    expect(wrong).toBeLessThan(0.6);
    const boillot = row("2015 Domaine J.M. Boillot, Puligny-Montrachet, 1er Cru Les Combettes", "Domaine J.M. Boillot", "Puligny-Montrachet");
    expect(scoreVivinoIdentity(boillot, hit("Domaine Henri Boillot", "Puligny-Montrachet 1er Cru Les Combettes 2020"))).toBeLessThan(0.6);
  });

  it("rejects another cuvée of the same producer", () => {
    const thevenard = row("2021 Macon Uchizy Cuvée Marguerite, Domaine Thevenard", "Macon Uchizy Cuvée Marguerite", "Domaine Thevenard");
    expect(scoreVivinoIdentity(thevenard, hit("Domaine Thevenard", "Mâcon-Lugny Les Genièvres 2023"))).toBeLessThan(0.6);
  });

  it("treats a place-only wine name as the producer's main wine", () => {
    const alion = row("ALION 2019 130 € Alion. Tempranillo.", "ALION", "130 € Alion. Tempranillo.");
    expect(scoreVivinoIdentity(alion, hit("Alión", "Ribera del Duero 2019", "Ribera del Duero, Spain"))).toBeGreaterThan(0.75);
  });

  it("keeps rosé and non-rosé wines apart", () => {
    const comtes = row("2013 Comtes de Champagne, Taittinger Reims", "Comtes de Champagne", "Taittinger Reims");
    const blanc = scoreVivinoIdentity(comtes, hit("Taittinger", "Comtes de Champagne Blanc de Blancs 2013"));
    const rose = scoreVivinoIdentity(comtes, hit("Taittinger", "Comtes de Champagne Rosé 2011"));
    expect(blanc).toBeGreaterThan(rose);
    expect(rose).toBeLessThan(0.6);
  });

  it("accepts grape synonyms and one-letter spelling slips", () => {
    expect(scoreVivinoIdentity(row("Penfolds Bin 28 Kalimna Shiraz", "Penfolds", "Bin 28 Kalimna Shiraz"),
      hit("Penfolds", "Bin 28 Kalimna Syrah"))).toBeGreaterThan(0.85);
    expect(scoreVivinoIdentity(row("Blend, Deux Grenoilles, Sine Qua Non, Ventura 2016", "Blend", "Deux Grenoilles Sine Qua Non"),
      hit("Sine Qua Non", "Deux Grenouilles 2016"))).toBeGreaterThan(0.85);
  });
});

describe("buildVivinoIdentityQueries", () => {
  it("drops vintages, prices, places and classification words that empty Vivino's search", () => {
    const queries = buildVivinoIdentityQueries(row("2019 Nicolas Catena, Alta, Malbec, Mendoza, Argentina", "Nicolas Catena", "Alta Malbec Mendoza Argentina", { vintage: 2019, region: "Mendoza, Argentina" }));
    expect(queries[0]).toBe("nicolas catena alta malbec");
    expect(queries).toContain("nicolas catena");
    expect(queries.join(" ")).not.toMatch(/2019|argentina|mendoza/);
  });

  it("returns nothing for a section heading with no name", () => {
    expect(buildVivinoIdentityQueries(row("Blanc de Blancs", "Blanc de", "Blancs"))).toEqual([]);
  });
});
