import { describe, expect, it } from "vitest";

import type { WineCandidate } from "@wine-rec/contracts";

import { createWineProfileProviders } from "./wine-profiles.js";

describe("wine profile providers", () => {
  it("uses the extracted title as the fallback display name for inferred profiles", async () => {
    const provider = createWineProfileProviders().find((entry) => entry.name === "rule-based");
    if (!provider) {
      throw new Error("rule-based provider is not registered");
    }

    const candidate: WineCandidate = {
      id: "candidate-1",
      rawText: "Cardedu 'Praja' Monica di Sardegna",
      price: "$23.99",
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
  });
});
