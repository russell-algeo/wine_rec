import { afterEach, describe, expect, it, vi } from "vitest";

import { parseWineCandidates } from "./parser.js";
import { extractTextFromHtml, extractTextFromUrl } from "./source-extractor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("source extractor", () => {
  it("extracts Graham collection cards into parser-friendly text", () => {
    const html = `
      <main>
        <div class="card card--standard card--media">
          <div class="card__content">
            <div class="card__information">
              <h3 class="card__heading">
                <a href="/products/domaine-de-la-mongestine-bob-singlar-red-wine" class="full-unstyled-link">
                  Domaine de la Mongestine Bob Singlar Red Wine
                </a>
              </h3>
            </div>
          </div>
          <div class="price">
            <span class="price-item price-item--regular">$21.99</span>
          </div>
        </div>
        <div class="card card--standard card--media">
          <div class="card__content">
            <div class="card__information">
              <h3 class="card__heading">
                <a href="/products/cardedu-praja-monica" class="full-unstyled-link">
                  Cardedu 'Praja' Monica di Sardegna
                </a>
              </h3>
            </div>
          </div>
          <div class="price">
            <span class="price-item price-item--regular">$23.99</span>
          </div>
        </div>
      </main>
    `;

    const extractedText = extractTextFromHtml(
      "https://grahamwine.co/collections/red-wines",
      html,
    );
    const candidates = parseWineCandidates(extractedText);

    expect(extractedText.startsWith("RED")).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.rawText).toBe("Domaine de la Mongestine Bob Singlar Red Wine");
    expect(candidates[0]?.price).toBe("$21.99");
    expect(candidates[0]?.color).toBe("red");
    expect(candidates[1]?.rawText).toBe("Cardedu 'Praja' Monica di Sardegna");
    expect(candidates[1]?.price).toBe("$23.99");
  });

  it("follows Graham pagination links to collect the full wine list", async () => {
    const pages = new Map<string, string>([
      [
        "https://grahamwine.co/collections/red-wines",
        `
          <main>
            <div class="card card--standard card--media">
              <div class="card__content">
                <div class="card__information">
                  <h3 class="card__heading">
                    <a href="/products/domaine-de-la-mongestine-bob-singlar-red-wine" class="full-unstyled-link">
                      Domaine de la Mongestine Bob Singlar Red Wine
                    </a>
                  </h3>
                </div>
              </div>
              <div class="price">
                <span class="price-item price-item--regular">$21.99</span>
              </div>
            </div>
            <nav>
              <a href="/collections/red-wines?page=2">2</a>
            </nav>
          </main>
        `,
      ],
      [
        "https://grahamwine.co/collections/red-wines?page=2",
        `
          <main>
            <div class="card card--standard card--media">
              <div class="card__content">
                <div class="card__information">
                  <h3 class="card__heading">
                    <a href="/products/cardedu-praja-monica" class="full-unstyled-link">
                      Cardedu 'Praja' Monica di Sardegna
                    </a>
                  </h3>
                </div>
              </div>
              <div class="price">
                <span class="price-item price-item--regular">$23.99</span>
              </div>
            </div>
            <nav>
              <a href="/collections/red-wines?page=1">1</a>
              <a href="/collections/red-wines?page=3">3</a>
            </nav>
          </main>
        `,
      ],
      [
        "https://grahamwine.co/collections/red-wines?page=3",
        `
          <main>
            <div class="card card--standard card--media">
              <div class="card__content">
                <div class="card__information">
                  <h3 class="card__heading">
                    <a href="/products/casa-santos-lima-vinho-regional-lisboa-bons-ventos-tinto" class="full-unstyled-link">
                      Casa Santos Lima, Vinho Regional Lisboa Bons Ventos Tinto
                    </a>
                  </h3>
                </div>
              </div>
              <div class="price">
                <span class="price-item price-item--regular">$9.99</span>
              </div>
            </div>
          </main>
        `,
      ],
    ]);

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const html = pages.get(url);
      if (!html) {
        return new Response("missing", { status: 404 });
      }

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const extractedText = await extractTextFromUrl("https://grahamwine.co/collections/red-wines");
    const candidates = parseWineCandidates(extractedText);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.rawText)).toEqual([
      "Domaine de la Mongestine Bob Singlar Red Wine",
      "Cardedu 'Praja' Monica di Sardegna",
      "Casa Santos Lima, Vinho Regional Lisboa Bons Ventos Tinto",
    ]);
  });

  it("preserves wine-relevant tab organization and ignores non-wine panels", () => {
    const html = `
      <div class="menu-wrapper menu-style-simple">
        <div role="tablist" class="menu-selector">
          <label role="tab" class="menu-select-labels js-menu-select-labels" aria-selected="false">BY THE GLASS</label>
          <label role="tab" class="menu-select-labels js-menu-select-labels" aria-selected="false">BOTTLE LIST</label>
          <label role="tab" class="menu-select-labels js-menu-select-labels menu-select-labels--active" aria-selected="true">COCKTAILS</label>
        </div>
        <div class="menus menus--has-multiple">
          <div role="tabpanel" aria-label="BY THE GLASS" class="menu js-menu menu-active" style="display: block">
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>&ensp;&ensp;WHITE&ensp;&ensp;</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>14</span>
                  <div class="menu-item-title">Roberto Henriquez ‘Rivera del Notro Blanco’ - <i>Valle de Itata, CH</i></div>
                  <div class="menu-item-description">Dry, jalepeno margarita, grapefruit zest, lemon balm tea</div>
                </div>
              </div>
            </div>
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>&ensp;&ensp;RED&ensp;&ensp;</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>17</span>
                  <div class="menu-item-title">Les Salicaires ‘Primal’ - <i>Roussillon, FR</i></div>
                  <div class="menu-item-description">Chilled, dry, sour cherry, watermelon Jolly Rancher, sea kelp</div>
                </div>
              </div>
            </div>
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>SHERRY</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>12</span>
                  <div class="menu-item-title">Gutierrez Colosia ‘Fino’ - <i>Jerez, ES</i></div>
                </div>
              </div>
            </div>
          </div>
          <div role="tabpanel" aria-label="HAPPY HOUR" class="menu js-menu" style="display: block">
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>&ensp;&ensp;WINE&ensp;&ensp;</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>13</span>
                  <div class="menu-item-title">BY THE GLASS</div>
                  <div class="menu-item-description">SPARKLING, WHITE, ORANGE, RED OR CIDER!</div>
                </div>
              </div>
            </div>
          </div>
          <div role="tabpanel" aria-label="BOTTLE LIST" class="menu js-menu" style="display: block">
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>&ensp;&ensp;WHITE&ensp;&ensp;</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>21</span>
                  <div class="menu-item-title">Cantina Giardino ‘Gaia’ - <i>Campania, IT</i></div>
                  <div class="menu-item-description">Salty citrus, peach skin, chamomile</div>
                </div>
              </div>
            </div>
          </div>
          <div role="tabpanel" aria-label="COCKTAILS" class="menu js-menu" style="display: block">
            <div class="menu-section">
              <div class="menu-section-header">
                <div class="menu-section-title"><span>COCKTAILS</span></div>
              </div>
              <div class="menu-items">
                <div class="menu-item">
                  <span class="menu-item-price-top"><span class="currency-sign">$</span>19</span>
                  <div class="menu-item-title">Negroni</div>
                  <div class="menu-item-description">Bitter, boozy, orange peel</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const extractedText = extractTextFromHtml("https://www.liseandvito.com/menu", html);
    const candidates = parseWineCandidates(extractedText);

    expect(extractedText).toContain("WHITE");
    expect(extractedText).toContain("RED");
    expect(extractedText).not.toContain("SHERRY");
    expect(extractedText).not.toContain("Negroni");
    expect(extractedText).not.toContain("SPARKLING, WHITE, ORANGE, RED OR CIDER!");
    expect(extractedText).toContain("@@TAB: BY THE GLASS");
    expect(extractedText).toContain("@@TAB: BOTTLE LIST");
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.rawText).toBe("Roberto Henriquez ‘Rivera del Notro Blanco’ - Valle de Itata, CH");
    expect(candidates[0]?.price).toBe("$14");
    expect(candidates[0]?.menuTab).toBe("BY THE GLASS");
    expect(candidates[0]?.menuSection).toBe("WHITE");
    expect(candidates[1]?.rawText).toBe("Les Salicaires ‘Primal’ - Roussillon, FR");
    expect(candidates[1]?.price).toBe("$17");
    expect(candidates[1]?.menuTab).toBe("BY THE GLASS");
    expect(candidates[1]?.menuSection).toBe("RED");
    expect(candidates[1]?.color).toBe("red");
    expect(candidates[2]?.rawText).toBe("Cantina Giardino ‘Gaia’ - Campania, IT");
    expect(candidates[2]?.menuTab).toBe("BOTTLE LIST");
    expect(candidates[2]?.menuSection).toBe("WHITE");
  });
});
