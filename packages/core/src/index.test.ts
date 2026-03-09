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

  it("normalizes legacy 10-point taste values into the 5-point scale", () => {
    expect(normalizeTasteValue(10)).toBe(5);
    expect(normalizeTasteValue(9)).toBe(5);
    expect(normalizeTasteValue(6)).toBe(3);
    expect(normalizeTasteValue(4)).toBe(4);
  });
});
