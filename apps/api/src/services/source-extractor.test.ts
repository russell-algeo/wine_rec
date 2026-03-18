import { afterEach, describe, expect, it, vi } from "vitest";

import { VivinoBrowser } from "../providers/vivino-browser.js";
import { parseWineCandidates } from "./parser.js";
import {
  extractCandidatesFromUrl,
  extractLeafTokens,
  groupTokensIntoItems,
  normalizeRawPrice,
} from "./source-extractor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// normalizeRawPrice
// ---------------------------------------------------------------------------

describe("normalizeRawPrice", () => {
  it("passes through a standard dollar price", () => {
    expect(normalizeRawPrice("$95")).toBe("$95");
    expect(normalizeRawPrice("$23.99")).toBe("$23.99");
  });

  it("takes the bottle (larger) price from slash format", () => {
    expect(normalizeRawPrice("16/72")).toBe("$72");
    expect(normalizeRawPrice("16 / 72")).toBe("$72");
    expect(normalizeRawPrice("16/$72")).toBe("$72");
    expect(normalizeRawPrice("19 / $86")).toBe("$86");
    expect(normalizeRawPrice("33/ 145")).toBe("$145");
  });

  it("takes the bottle (larger) price from dash format", () => {
    expect(normalizeRawPrice("20 - 80")).toBe("$80");
    expect(normalizeRawPrice("18 - 75")).toBe("$75");
    expect(normalizeRawPrice("18-75")).toBe("$75");
  });

  it("normalises a bare number in the wine price range", () => {
    expect(normalizeRawPrice("145")).toBe("$145");
    expect(normalizeRawPrice("$145")).toBe("$145");
  });

  it("rejects bare numbers outside the price range or non-numeric strings", () => {
    expect(normalizeRawPrice("4")).toBeNull();      // below $5
    expect(normalizeRawPrice("3000")).toBeNull();   // above $2000
    expect(normalizeRawPrice("G / B")).toBeNull();
    expect(normalizeRawPrice("glass")).toBeNull();
  });

  it("recognises leading currency symbols", () => {
    expect(normalizeRawPrice("€45")).toBe("€45");
    expect(normalizeRawPrice("£38")).toBe("£38");
    expect(normalizeRawPrice("€23.99")).toBe("€23.99");
  });

  it("recognises trailing currency symbols", () => {
    expect(normalizeRawPrice("45€")).toBe("€45");
  });

  it("recognises currency codes with a space", () => {
    expect(normalizeRawPrice("EUR 45")).toBe("EUR 45");
    expect(normalizeRawPrice("kr 280")).toBe("kr 280");
    expect(normalizeRawPrice("45 CHF")).toBe("CHF 45");
  });

  it("rejects non-numeric currency strings", () => {
    expect(normalizeRawPrice("EUR")).toBeNull();
    expect(normalizeRawPrice("€")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractLeafTokens
// ---------------------------------------------------------------------------

describe("extractLeafTokens", () => {
  it("emits a section token for h2/h3 headings", () => {
    const tokens = extractLeafTokens("<h2>Red</h2><p>Some wine</p>");
    expect(tokens[0]).toEqual({ type: "section", text: "Red" });
    expect(tokens[1]).toEqual({ type: "text", text: "Some wine" });
  });

  it("emits a price token for a standalone dollar price", () => {
    const tokens = extractLeafTokens("<p>$95</p>");
    expect(tokens).toEqual([{ type: "price", value: "$95" }]);
  });

  it("splits inline trailing price from the name", () => {
    const tokens = extractLeafTokens(
      "<div>Croci 'Lubigo' | Ortrugo | Emilia-Romagna, Italy 16/72</div>",
    );
    expect(tokens).toEqual([
      { type: "text", text: "Croci 'Lubigo' | Ortrugo | Emilia-Romagna, Italy" },
      { type: "price", value: "$72" },
    ]);
  });

  it("does not treat a 4-digit year as an inline price", () => {
    const tokens = extractLeafTokens("<p>Chardonnay, Germany, '22</p>");
    expect(tokens).toEqual([{ type: "text", text: "Chardonnay, Germany, '22" }]);
  });

  it("strips script and nav noise", () => {
    const html = "<nav>Home About</nav><script>var x=1</script><p>Wine Name</p><p>$50</p>";
    const tokens = extractLeafTokens(html);
    expect(tokens).not.toContainEqual(expect.objectContaining({ text: "Home About" }));
    expect(tokens).toContainEqual({ type: "text", text: "Wine Name" });
  });

  it("emits a section token for bare wine-category keywords", () => {
    const tokens = extractLeafTokens("<div>SPARKLING</div><p>Some wine $95</p>");
    expect(tokens[0]).toEqual({ type: "section", text: "SPARKLING" });
  });

  it("treats headings with uncommon section words as sections", () => {
    const tokens = extractLeafTokens("<h2>BIODYNAMIC SELECTIONS</h2><h2>HALF BOTTLES</h2>");
    expect(tokens[0]).toEqual({ type: "section", text: "BIODYNAMIC SELECTIONS" });
    expect(tokens[1]).toEqual({ type: "section", text: "HALF BOTTLES" });
  });

  it("treats a long heading with no wine signals as a wine name", () => {
    const tokens = extractLeafTokens("<h3>Domaine Croix de la Madeleine</h3>");
    expect(tokens[0]).toEqual({ type: "text", text: "Domaine Croix de la Madeleine" });
  });

  it("treats a heading with a comma as a wine name regardless of length", () => {
    const tokens = extractLeafTokens("<h3>Penfolds, Grange</h3>");
    expect(tokens[0]).toEqual({ type: "text", text: "Penfolds, Grange" });
  });
});

// ---------------------------------------------------------------------------
// groupTokensIntoItems — name-before-price (Entwine / Turks & Frogs style)
// ---------------------------------------------------------------------------

describe("groupTokensIntoItems — name-before-price", () => {
  it("pairs each name with the price that follows it", () => {
    const tokens = extractLeafTokens(`
      <h2>Red</h2>
      <h3>Gigondas, Domaine du Cayron, France, '22</h3>
      <p>$95</p>
      <h3>Brunello Di Montalcino, Ciacci Piccolomini, Italy, '20</h3>
      <p>$120</p>
    `);
    const items = groupTokensIntoItems(tokens);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "Gigondas, Domaine du Cayron, France, '22", price: "$95", section: "Red" });
    expect(items[1]).toMatchObject({ name: "Brunello Di Montalcino, Ciacci Piccolomini, Italy, '20", price: "$120" });
  });

  it("handles glass/bottle dash format prices", () => {
    const tokens = extractLeafTokens(`
      <h3>White Wines</h3>
      <p>SANCERRE, MOULIN JAMET, FRANCE, 2023</p>
      <p>20 - 80</p>
    `);
    const items = groupTokensIntoItems(tokens);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "SANCERRE, MOULIN JAMET, FRANCE, 2023", price: "$80" });
  });
});

// ---------------------------------------------------------------------------
// groupTokensIntoItems — price-before-name (Lise & Vito style)
// ---------------------------------------------------------------------------

describe("groupTokensIntoItems — price-before-name", () => {
  it("associates a leading price with the name that follows", () => {
    const tokens = extractLeafTokens(`
      <div class="menu-section">
        <span class="menu-item-price-top"><span class="currency-sign">$</span>14</span>
        <div class="menu-item-title">Roberto Henriquez 'Rivera del Notro Blanco' - Valle de Itata, CH</div>
      </div>
      <div class="menu-section">
        <span class="menu-item-price-top"><span class="currency-sign">$</span>17</span>
        <div class="menu-item-title">Les Salicaires 'Primal' - Roussillon, FR</div>
      </div>
    `);
    const items = groupTokensIntoItems(tokens);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      name: "Roberto Henriquez 'Rivera del Notro Blanco' - Valle de Itata, CH",
      price: "$14",
    });
    expect(items[1]).toMatchObject({
      name: "Les Salicaires 'Primal' - Roussillon, FR",
      price: "$17",
    });
  });
});

// ---------------------------------------------------------------------------
// groupTokensIntoItems — inline prices (BINX style)
// ---------------------------------------------------------------------------

describe("groupTokensIntoItems — inline prices", () => {
  it("extracts wines with prices embedded at the end of the name line", () => {
    const tokens = extractLeafTokens(`
      <div>SPARKLING</div>
      <div>Croci 'Lubigo' | Ortrugo | Emilia-Romagna, Italy 16/72</div>
      <div>Hager Matthias 'Blanc de Noir' Reserve 2019 | Zweigelt | Austria 145</div>
    `);
    const items = groupTokensIntoItems(tokens);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "Croci 'Lubigo' | Ortrugo | Emilia-Romagna, Italy", price: "$72", section: "SPARKLING" });
    expect(items[1]).toMatchObject({ name: "Hager Matthias 'Blanc de Noir' Reserve 2019 | Zweigelt | Austria", price: "$145" });
  });
});

// ---------------------------------------------------------------------------
// groupTokensIntoItems — non-wine section filtering
// ---------------------------------------------------------------------------

describe("groupTokensIntoItems — non-wine filtering", () => {
  it("excludes items under cocktail and spirits sections", () => {
    const tokens = extractLeafTokens(`
      <h3>RED</h3>
      <p>Some Pinot Noir, Burgundy, France 2022</p><p>$80</p>
      <h3>COCKTAILS</h3>
      <p>Negroni</p><p>$18</p>
      <h3>WHITE</h3>
      <p>Sancerre, Loire Valley 2023</p><p>$75</p>
    `);
    const items = groupTokensIntoItems(tokens);
    expect(items.map((i) => i.name)).not.toContain("Negroni");
    expect(items.map((i) => i.section)).not.toContain("COCKTAILS");
    expect(items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: extractCandidatesFromUrl using mocked fetch
// ---------------------------------------------------------------------------

describe("extractCandidatesFromUrl", () => {
  it("extracts wine candidates from a restaurant menu page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `<html><body>
            <h2>Red</h2>
            <h3>Gigondas, Domaine du Cayron, France, '22</h3><p>$95</p>
            <h3>Brunello Di Montalcino, Ciacci Piccolomini, Italy, '20</h3><p>$120</p>
            <h2>White & Orange-Rose</h2>
            <h3>Sancerre, Domaine Roland Tissier et Fils, '22</h3><p>$95</p>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const candidates = await extractCandidatesFromUrl("https://www.entwinenyc.com/wine");
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const names = candidates.map((c) => c.rawText);
    expect(names.some((n) => n.includes("Gigondas"))).toBe(true);
    expect(names.some((n) => n.includes("Brunello"))).toBe(true);
    expect(names.some((n) => n.includes("Sancerre"))).toBe(true);
    expect(candidates.find((c) => c.rawText.includes("Gigondas"))?.price).toBe("$95");
    expect(candidates.find((c) => c.rawText.includes("Gigondas"))?.color).toBe("red");
  });

  it("extracts wine candidates from an e-commerce collection page via the menu token stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `<html><body>
            <div class="card card--standard card--media">
              <a href="/products/domaine-mongestine" class="full-unstyled-link">
                Domaine de la Mongestine Bob Singlar Red Wine
              </a>
              <span class="price-item price-item--regular">$21.99</span>
            </div>
            <div class="card card--standard card--media">
              <a href="/products/cardedu-praja" class="full-unstyled-link">
                Cardedu 'Praja' Monica di Sardegna
              </a>
              <span class="price-item price-item--regular">$23.99</span>
            </div>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const candidates = await extractCandidatesFromUrl("https://grahamwine.co/collections/red-wines");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rawText).toContain("Domaine de la Mongestine");
    expect(candidates[0]?.price).toBe("$21.99");
    expect(candidates[1]?.rawText).toContain("Cardedu");
    expect(candidates[1]?.price).toBe("$23.99");
  });

  it("falls back to browser rendering when static HTML yields no candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<html><body><div id="root"></div></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const renderedHtml = `<html><body>
      <h2>Red</h2>
      <h3>Gigondas, Domaine du Cayron, France, '22</h3>
      <p>$95</p>
    </body></html>`;

    const mockRenderHtml = vi.fn(async () => renderedHtml);
    vi.spyOn(VivinoBrowser, "getInstance").mockReturnValue({
      renderHtml: mockRenderHtml,
    } as unknown as VivinoBrowser);

    const candidates = await extractCandidatesFromUrl("https://example.com/wine");
    expect(mockRenderHtml).toHaveBeenCalledWith("https://example.com/wine");
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.some((c) => c.rawText.includes("Gigondas"))).toBe(true);
  });

  it("returns empty results when both static and browser rendering yield nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`<html><body></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    vi.spyOn(VivinoBrowser, "getInstance").mockReturnValue({
      renderHtml: vi.fn(async () => `<html><body></body></html>`),
    } as unknown as VivinoBrowser);

    const candidates = await extractCandidatesFromUrl("https://example.com/wine");
    expect(candidates).toHaveLength(0);
  });

  it("skips the browser when static extraction succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `<html><body><h2>Red</h2><h3>Brunello, Ciacci, Italy, '20</h3><p>$120</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const mockRenderHtml = vi.fn();
    vi.spyOn(VivinoBrowser, "getInstance").mockReturnValue({
      renderHtml: mockRenderHtml,
    } as unknown as VivinoBrowser);

    const candidates = await extractCandidatesFromUrl("https://example.com/wine");
    expect(mockRenderHtml).not.toHaveBeenCalled();
    expect(candidates.length).toBeGreaterThanOrEqual(1);
  });
});
