import { describe, expect, it } from "vitest";

import {
  defaultPreference,
  inferTasteVector,
  normalizeTasteValue,
  rankMatch,
  scoreRecommendation,
  scoreWineMatch,
} from "./index.js";

describe("core scoring", () => {
  it("prefers high acidity and low sweetness for the default preference", () => {
    const crisp = inferTasteVector({
      label: "Sancerre Sauvignon Blanc",
      varietal: "sauvignon blanc",
      color: "white",
    });
    const soft = inferTasteVector({
      label: "Rich Chardonnay",
      varietal: "chardonnay",
      color: "white",
    });

    expect(scoreRecommendation(defaultPreference(), crisp)).toBeGreaterThan(
      scoreRecommendation(defaultPreference(), soft),
    );
  });

  it("scores exact producer and label matches highly", () => {
    const score = scoreWineMatch(
      {
        producer: "Domaine de la Villaudiere",
        label: "Sancerre Sauvignon Blanc",
        vintage: 2022,
        varietal: "sauvignon blanc",
        region: "sancerre",
      },
      {
        producer: "Domaine de la Villaudiere",
        label: "Sancerre Sauvignon Blanc",
        vintage: 2022,
        varietal: "sauvignon blanc",
        region: "sancerre",
      },
    );

    expect(score).toBeGreaterThanOrEqual(0.99);
    expect(rankMatch(score)).toBe("matched");
  });

  it("penalizes contradictory rose variants when the candidate omits rose", () => {
    const candidate = {
      producer: "Le Babbler",
      label: "Bordeaux",
      vintage: null,
      varietal: null,
      region: "bordeaux",
      rawText: "Le Babbler Bordeaux",
      color: null,
    };

    const plain = scoreWineMatch(candidate, {
      producer: "Le Babbler",
      label: "Bordeaux 2022",
      vintage: 2022,
      varietal: null,
      region: "Bordeaux, France",
    });
    const rose = scoreWineMatch(candidate, {
      producer: "Le Babbler",
      label: "Bordeaux Rosé 2024",
      vintage: 2024,
      varietal: null,
      region: "Bordeaux, France",
    });

    expect(plain).toBeGreaterThan(rose);
  });

  it("recovers label tokens that Vivino splits across producer and region", () => {
    const score = scoreWineMatch(
      {
        producer: "Cardedu",
        label: "Praja Monica di Sardegna",
        vintage: null,
        varietal: null,
        region: null,
        rawText: "Cardedu Praja Monica di Sardegna",
        color: null,
      },
      {
        producer: "Azienda Vitivinicola Cardedu",
        label: "Praja Monica 2024",
        vintage: 2024,
        varietal: null,
        region: "Monica di Sardegna, Italy",
      },
    );

    expect(score).toBeGreaterThan(0.55);
  });

  it("prefers the exact tinto variant over other Bons Ventos variants", () => {
    const candidate = {
      producer: "Casa Santos Lima",
      label: "Vinho Regional Lisboa Bons Ventos Tinto",
      vintage: null,
      varietal: null,
      region: null,
      rawText: "Casa Santos Lima Vinho Regional Lisboa Bons Ventos Tinto",
      color: null,
    };

    const tinto = scoreWineMatch(candidate, {
      producer: "Casa Santos Lima",
      label: "Bons Ventos Tinto",
      vintage: null,
      varietal: null,
      region: "Douro, Portugal",
    });
    const branco = scoreWineMatch(candidate, {
      producer: "Casa Santos Lima",
      label: "Bons Ventos Branco",
      vintage: null,
      varietal: null,
      region: "Lisboa, Portugal",
    });
    const reserva = scoreWineMatch(candidate, {
      producer: "Casa Santos Lima",
      label: "Bons Ventos Reserva",
      vintage: null,
      varietal: null,
      region: "Lisboa, Portugal",
    });

    expect(tinto).toBeGreaterThan(branco);
    expect(tinto).toBeGreaterThan(reserva);
  });

  // Real-world menu parsing cases where the appellation/region appears in the producer
  // field and the winery name appears in the label. The pooled token score must recover.
  describe("field-misaligned menu parsing (real Entwine menu)", () => {
    const THRESHOLD = 0.38;

    it("matches Gigondas Domaine du Cayron when appellation is in producer field", () => {
      const score = scoreWineMatch(
        { producer: "Gigondas", label: "Domaine du Cayron France", vintage: 2022, varietal: null, region: "France", rawText: "Gigondas Domaine du Cayron France '22" },
        { producer: "Domaine du Cayron", label: "Gigondas", vintage: 2022, varietal: null, region: "Gigondas, France" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("matches Domaine Galévan despite accent on Galevan and missing 'e' in Domain", () => {
      const score = scoreWineMatch(
        { producer: "Chateauneuf Du Pape", label: "Domain Galevan", vintage: 2021, varietal: null, region: "France", rawText: "Chateauneuf Du Pape Domain Galevan France '21" },
        { producer: "Domaine Galévan", label: "Châteauneuf-du-Pape Rouge", vintage: 2021, varietal: null, region: "Châteauneuf-du-Pape, France" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("matches La Rioja Alta Viña Arana despite accent stripping and Gran Reserva in profile label", () => {
      const score = scoreWineMatch(
        { producer: "Rioja Gran Reseva", label: "Vina Arana", vintage: 2017, varietal: null, region: "Spain", rawText: "Rioja Gran Reseva Vina Arana La Rioja Alta Spain '17" },
        { producer: "La Rioja Alta", label: "Viña Arana Gran Reserva", vintage: 2017, varietal: null, region: "Rioja, Spain" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("matches Ciacci Piccolomini d'Aragona Brunello di Montalcino", () => {
      const score = scoreWineMatch(
        { producer: "Brunello Di Montalcino", label: "Ciacci Piccolomini", vintage: 2020, varietal: null, region: "Italy", rawText: "Brunello Di Montalcino Ciacci Piccolomini Italy '20" },
        { producer: "Ciacci Piccolomini d'Aragona", label: "Brunello di Montalcino", vintage: 2020, varietal: null, region: "Brunello di Montalcino, Italy" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("matches Viberti Giovanni Buon Padre Barolo despite buan→buon typo on menu", () => {
      const score = scoreWineMatch(
        { producer: "Barolo Viberti", label: "Giovanni Buan Padre", vintage: null, varietal: null, region: null, rawText: "Barolo Viberti Giovanni Buan Padre '20" },
        { producer: "Viberti Giovanni", label: "Buon Padre Barolo", vintage: 2019, varietal: null, region: "Barolo, Italy" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("matches Weingut OTT Ried Stein Grüner Veltliner with accent on Grüner", () => {
      const score = scoreWineMatch(
        { producer: "Gruner Veltliner", label: "Ried Stein OTT", vintage: 2021, varietal: "gruner veltliner", region: "Austria", rawText: "Gruner Veltliner Ried Stein OTT Austria '21" },
        { producer: "Weingut OTT", label: "Ried Stein Grüner Veltliner", vintage: 2021, varietal: null, region: "Kremstal, Austria" },
      );
      expect(score).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it("ranks the correct Turley profile above a different Napa producer", () => {
      const candidate = { producer: "Turley", label: "Napa Cabernet", vintage: 2022, varietal: "cabernet", region: "Napa", rawText: "Turley Napa Cabernet 2022" };
      const turleyScore   = scoreWineMatch(candidate, { producer: "Turley Wine Cellars", label: "Napa Valley Cabernet Sauvignon", vintage: 2022, varietal: null, region: "Napa Valley, California" });
      const beringerScore = scoreWineMatch(candidate, { producer: "Beringer", label: "Napa Private Reserve Cabernet", vintage: 2022, varietal: null, region: "Napa, California" });
      expect(turleyScore).toBeGreaterThan(beringerScore);
    });
  });

  // These wines were already matching correctly. Ensure the new pooled scoring
  // does not regress any of them (threshold 0.38).
  describe("regression: existing correct matches still pass", () => {
    const THRESHOLD = 0.38;

    it("direct field-aligned matches score ≥0.38", () => {
      const cases: Array<[string, Parameters<typeof scoreWineMatch>]> = [
        ["Eminence Road Lamb's Quarters Vineyard Pinot Noir",
          [{ producer: "Eminence Road Farm Winery", label: "Lamb's Quarters Vineyard Pinot Noir", vintage: null, varietal: "pinot noir", region: null, rawText: "Eminence Road Farm Winery Lamb's Quarters Vineyard Pinot Noir" },
           { producer: "Eminence Road Farm Winery", label: "Lamb's Quarters Vineyard Pinot Noir", vintage: null, varietal: null, region: null }]],
        ["Joseph Drouhin Chambolle-Musigny Premier Cru 2021",
          [{ producer: "Joseph Drouhin", label: "Chambolle-Musigny Premier Cru", vintage: 2021, varietal: "pinot noir", region: "Burgundy", rawText: "Joseph Drouhin Chambolle-Musigny Premier Cru 2021" },
           { producer: "Joseph Drouhin", label: "Chambolle-Musigny Premier Cru", vintage: 2021, varietal: null, region: "Chambolle-Musigny, France" }]],
        ["Bollinger La Grande Année Brut Champagne 2014",
          [{ producer: "Bollinger", label: "La Grande Année Brut Champagne", vintage: 2014, varietal: null, region: "Champagne", rawText: "Bollinger La Grande Année Brut Champagne 2014", color: "sparkling" },
           { producer: "Bollinger", label: "La Grande Année Brut", vintage: 2014, varietal: null, region: "Champagne, France" }]],
        ["Billecart-Salmon Cuvée Elisabeth Salmon Brut Rosé 2012",
          [{ producer: "Billecart-Salmon", label: "Cuvee Elisabeth Salmon Brut Rose", vintage: 2012, varietal: null, region: "Champagne", rawText: "Billecart-Salmon Cuvee Elisabeth Salmon Brut Rose Millesime 2012", color: "sparkling" },
           { producer: "Billecart-Salmon", label: "Cuvée Elisabeth Salmon Brut Rosé", vintage: 2012, varietal: null, region: "Champagne, France" }]],
        ["Forlorn Hope Queen of the Sierra Amber",
          [{ producer: "Forlorn Hope", label: "Queen of the Sierra Amber", vintage: null, varietal: null, region: null, rawText: "Forlorn Hope Queen of the Sierra Amber" },
           { producer: "Forlorn Hope", label: "Queen of the Sierra Amber", vintage: null, varietal: null, region: null }]],
        ["Bulli Frizzante Colli Piacentini Julius Bolle Macerato (tokens scrambled vs profile)",
          [{ producer: "Bulli", label: "Frizzante Colli Piacentini Julius Bolle Macerato", vintage: null, varietal: null, region: null, rawText: "Bulli Frizzante Colli Piacentini Julius Bolle Macerato" },
           { producer: "Bulli", label: "Julius Bolle Macerato Colli Piacentini Frizzante", vintage: null, varietal: null, region: null }]],
      ];

      for (const [name, [candidate, profile]] of cases) {
        expect(scoreWineMatch(candidate, profile), name).toBeGreaterThanOrEqual(THRESHOLD);
      }
    });

    it("Vivino canonical name differs from menu label but still matches", () => {
      // Paul Mas Estate Pays D'Oc → Saint Hilaire Vineyard Pinot Noir Réserve
      expect(scoreWineMatch(
        { producer: "Paul Mas Estate", label: "Pays D'Oc Single Vineyard Pinot Noir", vintage: null, varietal: "pinot noir", region: "Pays d'Oc", rawText: "Paul Mas Estate Pays D'Oc Single Vineyard Collection Pinot Noir" },
        { producer: "Paul Mas Estate", label: "Saint Hilaire Vineyard Pinot Noir Réserve", vintage: null, varietal: null, region: "Pays d'Oc, France" },
      )).toBeGreaterThanOrEqual(THRESHOLD);

      // Weingut Loimer → Loimer (winery prefix differs)
      expect(scoreWineMatch(
        { producer: "Weingut Loimer", label: "Gluegglich Rot", vintage: null, varietal: null, region: null, rawText: "Weingut Loimer Gluegglich Rot" },
        { producer: "Loimer", label: "Gluegglich Rot", vintage: null, varietal: null, region: "Niederösterreich, Austria" },
      )).toBeGreaterThanOrEqual(THRESHOLD);

      // Guillot-Broux Bourgogne Rouge Les Renardières → Domaine Guillot-Broux Les Renardières 2022
      expect(scoreWineMatch(
        { producer: "Guillot-Broux", label: "Bourgogne Rouge Les Renardières", vintage: 2022, varietal: null, region: "Burgundy", rawText: "Guillot-Broux Bourgogne Rouge Les Renardières 2022" },
        { producer: "Domaine Guillot-Broux", label: "Les Renardières", vintage: 2022, varietal: null, region: "Mâcon, France" },
      )).toBeGreaterThanOrEqual(THRESHOLD);

      // François Ducrot — accent in producer name
      expect(scoreWineMatch(
        { producer: "François Ducrot", label: "Auguste", vintage: null, varietal: null, region: null, rawText: "François Ducrot Auguste" },
        { producer: "François Ducrot", label: "Auguste", vintage: null, varietal: null, region: null },
      )).toBeGreaterThanOrEqual(THRESHOLD);
    });
  });

  it("normalizes legacy 10-point taste values into the 5-point scale", () => {
    expect(normalizeTasteValue(10)).toBe(5);
    expect(normalizeTasteValue(9)).toBe(5);
    expect(normalizeTasteValue(6)).toBe(3);
    expect(normalizeTasteValue(4)).toBe(4);
  });
});
