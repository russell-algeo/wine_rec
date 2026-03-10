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

  it("normalizes legacy 10-point taste values into the 5-point scale", () => {
    expect(normalizeTasteValue(10)).toBe(5);
    expect(normalizeTasteValue(9)).toBe(5);
    expect(normalizeTasteValue(6)).toBe(3);
    expect(normalizeTasteValue(4)).toBe(4);
  });
});
