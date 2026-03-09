import { describe, expect, it } from "vitest";

import type { WineCandidate } from "@wine-rec/contracts";

import { createWineProfileProviders } from "./wine-profiles.js";

describe("wine profile providers", () => {
  it("allows the Apify provider to be disabled by runtime settings", () => {
    const provider = createWineProfileProviders({
      apifyVivinoEnabled: false,
    }).find((entry) => entry.name === "apify-vivino");

    if (!provider) {
      throw new Error("apify-vivino provider is not registered");
    }

    expect(provider.isEnabled).toBe(false);
  });

  it("uses the extracted title as the fallback display name for inferred profiles", async () => {
    const provider = createWineProfileProviders().find((entry) => entry.name === "rule-based");
    if (!provider) {
      throw new Error("rule-based provider is not registered");
    }

    const candidate: WineCandidate = {
      id: "candidate-1",
      rawText: "Cardedu 'Praja' Monica di Sardegna",
      price: "$23.99",
      menuTab: null,
      menuSection: null,
      lineNumber: 0,
      producer: "Cardedu",
      label: "Praja Monica di Sardegna",
      vintage: null,
      color: null,
      varietal: null,
      region: null,
      notes: null,
      extractionConfidence: 0.88,
    };

    const result = await provider.lookup(candidate);
    expect(result?.profile.displayName).toBe(candidate.rawText);
    expect(result?.matchScore).toBe(0.05);
    expect(result?.profile.taste.body).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.acidity).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.tannin).toBeLessThanOrEqual(5);
    expect(result?.profile.taste.sweetness).toBeLessThanOrEqual(5);
  });
});
