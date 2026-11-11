import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWineCandidates } from "./parser.js";

// First three rows are hand-labeled public-menu snippets from Venable Bistro.
// Remaining rows pair reported region-only failures with synthetic wine/price
// controls. These labels test parsing, not actual bottle availability or identity.
const rows = [
  ["Riesling, Dr. Pauly-bergweiler Trocken 2017", "$10 / $36", "Mosel, Germany", "$36"],
  ["Pinot grigio, il conti 2017", "$7 / $24", "Veneto, Italy", "$24"],
  ["Chardonnay, Hook & Ladder 2015", "$11 / $44", "Russian River Valley, California", "$44"],
  ["Dr. Konstantin Frank Riesling 2017", "10 / 36", "Finger Lakes, New York", "$36"],
  ["Billecart-Salmon Brut NV", "$75", "Champagne, France", "$75"],
  ["Masciarelli Montepulciano 2017", "40", "Abruzzo, Italy", "$40"],
  ["Jermann Pinot Grigio 2017", "$12 / $48", "Friuli, Italy", "$48"],
  ["Domaine Gayda Syrah 2017", "9 / 36", "Languedoc, France", "$36"],
];

describe("post-price region continuations", () => {
  it("retains eight wines with their prices and regions, without geography candidates", () => {
    const wines = parseWineCandidates(["WHITE", ...rows.flatMap(([name, price, region]) => [name, price, region])].join("\n"));
    expect(wines).toHaveLength(rows.length);
    wines.forEach((wine, i) => {
      const [name, , region, price] = rows[i]!;
      expect(wine).toMatchObject({ rawText: `${name}, ${region}`, price, region, notes: null });
    });
  });

  it.each([["$40", "$10"], ["$10", "$40"]])("retains the bottle amount across consecutive price lines %s then %s", (first, second) => {
    const wines = parseWineCandidates(`WHITE\nDomaine Example Riesling 2020\n${first}\n${second}\nMosel, Germany`);
    expect(wines).toHaveLength(1);
    expect(wines[0]).toMatchObject({ price: "$40", region: "Mosel, Germany" });
  });

  it("attaches the known Napa Valley geography after a price", () => {
    const wines = parseWineCandidates("RED\nDomaine Example Cabernet Sauvignon 2020\n$90\nNapa Valley, California");
    expect(wines).toHaveLength(1);
    expect(wines[0]).toMatchObject({ price: "$90", region: "Napa Valley, California" });
  });

  it("retains separately priced appellation-named wines", () => {
    const wines = parseWineCandidates("WHITE\nDomaine Example Riesling 2020\n$40\nChampagne, France\n$65\nSancerre, Roland Tissier '23\n$88");
    expect(wines).toHaveLength(3);
    expect(wines.map(({ price }) => price)).toEqual(["$40", "$65", "$88"]);
    expect(wines[1]?.rawText).toBe("Champagne, France");
    expect(wines[2]?.rawText).toBe("Sancerre, Roland Tissier '23");
  });

  it("does not absorb adjacent complete wines or arbitrary country-suffixed names", () => {
    const wines = parseWineCandidates("SPARKLING\nNV Billecart-Salmon Brut Champagne\n$75\nLouis Roederer, France\n$85\n2019 Domaine Example Chardonnay\n$50\nMosel, Germany\n2020 Ridge Cabernet Sauvignon\n$90");
    expect(wines).toHaveLength(4);
    expect(wines[1]).toMatchObject({ rawText: "Louis Roederer, France", price: "$85" });
    expect(wines[2]).toMatchObject({ vintage: 2019, region: "Mosel, Germany", price: "$50" });
    expect(wines[3]).toMatchObject({ vintage: 2020, price: "$90" });
  });

  it("does not carry geography across menu section or tab boundaries", () => {
    const wines = parseWineCandidates("WHITE\nDomaine Example Riesling 2020\n$40\n@@TAB: BOTTLES\n@@SECTION: RED\nRidge Cabernet Sauvignon 2020\n$90\nSonoma, California");
    expect(wines).toHaveLength(2);
    expect(wines[0]).toMatchObject({ region: null, price: "$40", menuTab: null, color: "white" });
    expect(wines[1]).toMatchObject({ region: "Sonoma, California", price: "$90", menuTab: "BOTTLES", color: "red" });
  });

  it("keeps the worker parser identical to the tested main parser", () => {
    expect(fs.readFileSync(new URL("../../../worker/src/services/parser.ts", import.meta.url), "utf8"))
      .toBe(fs.readFileSync(new URL("./parser.ts", import.meta.url), "utf8"));
  });
});
