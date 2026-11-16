import { describe, expect, it } from "vitest";
import type { WineCandidate } from "@wine-rec/contracts";
import { buildVivinoIdentityQueries, hasColourConflict, producersWithCuvee, scoreVivinoIdentity, scoreVivinoIdentityDetail } from "./vivino-match.js";

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

describe("stricter identity checks", () => {
  it("does not read a grape as a misspelt producer", () => {
    expect(scoreVivinoIdentity(row("D.O. Rioja. Tempranillo", "D.O. Rioja", "Tempranillo"), hit("Tempranello", "Tempranillo - Brunello", "Gualtallary, Argentina"))).toBeLessThan(0.6);
  });
  it("requires a quoted cuvée to be in the hit", () => {
    const burgaud = row("2024 Gamay, Jean-Marc Burgaud 'Chollet' Morgon, Beaujolais", "Jean-Marc Burgaud", "Chollet");
    expect(scoreVivinoIdentity(burgaud, hit("Jean-Marc Burgaud", "Beaujolais-Lantignié 2024", "Beaujolais-Lantignié, France"))).toBeLessThan(0.6);
  });
  it("won't guess which wine a producer-only row means", () => {
    expect(scoreVivinoIdentity(row("118. Van Duzer Willamette 2018", "Van Duzer", "Willamette"), hit("Van Duzer", "Riesling", "Willamette Valley, United States"))).toBeLessThan(0.6);
    expect(scoreVivinoIdentity(row("Van Duzer Willamette 2018", "Van Duzer", "Willamette", { menuSection: "PINOT NOIR" }), hit("Van Duzer", "Pinot Noir", "Willamette Valley, United States"))).toBeGreaterThan(0.75);
  });
  it("still takes a named cuvée whose grape the menu leaves out", () => {
    expect(scoreVivinoIdentity(row("Raen, Royal St. Robert, Sonoma Coast '16", "Raen", "Royal St. Robert"), hit("Raen", "Royal St Robert Cuvée Pinot Noir 2022", "Sonoma Coast, United States"))).toBeGreaterThan(0.75);
  });
  it("flags red against white", () => {
    expect(hasColourConflict(row("Chardonnay, Lucien Le Moine '15", "Chardonnay", "Lucien Le Moine"), hit("Lucien le Moine", "Fleurie", "Fleurie, France"))).toBe(true);
    expect(hasColourConflict(row("Pommard 1er Cru, Jean-Marc Boillot", "Jean-Marc Boillot", "Pommard"), hit("J.M. Boillot", "Pommard", "Pommard, France"))).toBe(false);
  });
});

describe("rows that name no producer", () => {
  it("matches on a distinctive cuvée name when nearly every row word is in the hit", () => {
    const giallo = row("Greco di Tufo - Giallo D’Arles", "Greco di Tufo", "Giallo D’Arles");
    const detail = scoreVivinoIdentityDetail(giallo, hit("Quintodecimo", "Giallo d'Arles Greco di Tufo 2024", "Greco di Tufo, Italy"));
    expect(detail.withoutProducer).toBe(true);
    expect(detail.score).toBeGreaterThan(0.75);
    expect(detail.cuveeTokens).toEqual(["giallo", "arles"]);
  });

  it("does not match on a grape or appellation alone", () => {
    const chardonnay = row("Chardonnay, Sonoma County", "Chardonnay", "Sonoma County");
    expect(scoreVivinoIdentity(chardonnay, hit("Kistler", "Sonoma Coast Chardonnay", "Sonoma Coast, United States"))).toBeLessThan(0.6);
    const greco = row("Greco di Tufo", "Greco di Tufo", null);
    expect(scoreVivinoIdentity(greco, hit("Mastroberardino", "Greco di Tufo 2022", "Greco di Tufo, Italy"))).toBeLessThan(0.6);
  });

  it("counts the producers that make a cuvée", () => {
    const hits = [hit("Faiveley", "Chambolle-Musigny 1er Cru Les Amoureuses"), hit("Comte Georges de Vogüé", "Les Amoureuses Chambolle-Musigny"), hit("Faiveley", "Les Amoureuses 2019")];
    expect(producersWithCuvee(hits, ["amoureuses"]).size).toBe(2);
    expect(producersWithCuvee([hit("Quintodecimo", "Giallo d'Arles Greco di Tufo")], ["giallo", "arles"]).size).toBe(1);
  });
});

describe("buildVivinoIdentityQueries", () => {
  it("drops vintages, prices, places and classification words that empty Vivino's search", () => {
    const queries = buildVivinoIdentityQueries(row("2019 Nicolas Catena, Alta, Malbec, Mendoza, Argentina", "Nicolas Catena", "Alta Malbec Mendoza Argentina", { vintage: 2019, region: "Mendoza, Argentina" }));
    expect(queries[0]).toBe("nicolas catena alta");
    expect(queries).toContain("nicolas catena");
    expect(queries.join(" ")).not.toMatch(/2019|argentina|mendoza/);
  });

  it("puts names before grapes and drops business words", () => {
    const lapostolle = buildVivinoIdentityQueries(row("CABERNET Casa Lapostolle 'Cuvée Alexander', Chile", "CABERNET Casa Lapostolle", "Cuvée Alexander"));
    expect(lapostolle[0]).toBe("lapostolle alexander");
    expect(buildVivinoIdentityQueries(row("Tempranillo, Merlot", "Tempranillo", "Merlot"))).toEqual([]);
  });

  it("returns nothing for a section heading with no name", () => {
    expect(buildVivinoIdentityQueries(row("Blanc de Blancs", "Blanc de", "Blancs"))).toEqual([]);
  });

  it("doesn't take a shared first name as the producer", () => {
    const pommard = row("Pommard 1er Cru, Jean-Marc Boillot, Les Rugiens '01", "Pommard 1er Cru", "Jean-Marc Boillot");
    expect(scoreVivinoIdentity(pommard, hit("Jean-Marc Vincent", "Auxey-Duresses 1er Cru 'Les Bréterins'", "Auxey-Duresses Premier Cru, France"))).toBeLessThan(0.6);
  });

  it("flags an appellation-only wine name the row doesn't mention", () => {
    const sancerre = row("2024 J. de Villebois Sancerre, Loire Valley", "J. de Villebois", "Sancerre");
    expect(scoreVivinoIdentityDetail(sancerre, hit("Domaine J. de Villebois", "Pouilly Fumé", "Pouilly-Fumé, France")).appellationGuess).toBe(true);
    expect(scoreVivinoIdentityDetail(sancerre, hit("Domaine J. de Villebois", "Sancerre", "Sancerre, France")).appellationGuess).toBe(false);
  });
});
