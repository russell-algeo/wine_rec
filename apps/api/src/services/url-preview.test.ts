import { describe, expect, it, vi } from "vitest";
import { fetchUrlPreview } from "./url-preview.js";

describe("fetchUrlPreview", () => {
  it("extracts title and domain from HTML", async () => {
    const fakeHtml = `<html><head><title>North End Grille — Wine List</title></head><body></body></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fakeHtml,
    } as unknown as Response);

    const result = await fetchUrlPreview("https://northendgrille.com/wine-list");
    expect(result.title).toBe("North End Grille — Wine List");
    expect(result.domain).toBe("northendgrille.com");
  });

  it("returns null title when title tag is missing", async () => {
    const fakeHtml = `<html><head></head><body></body></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fakeHtml,
    } as unknown as Response);

    const result = await fetchUrlPreview("https://example.com/menu");
    expect(result.title).toBeNull();
    expect(result.domain).toBe("example.com");
  });

  it("throws when fetch returns non-ok status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    await expect(fetchUrlPreview("https://example.com")).rejects.toThrow("404");
  });

  it("decodes HTML entities in the title", async () => {
    const fakeHtml = `<html><head><title>Orange Wine &ndash; Graham Wine Co.</title></head></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fakeHtml,
    } as unknown as Response);

    const result = await fetchUrlPreview("https://grahamwine.co/collections/orange");
    expect(result.title).toBe("Orange Wine – Graham Wine Co.");
  });

  it("decodes numeric and hex HTML entities", async () => {
    const fakeHtml = `<html><head><title>Bern&#8217;s &amp; Wine &#x26; Spirits</title></head></html>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => fakeHtml,
    } as unknown as Response);

    const result = await fetchUrlPreview("https://example.com");
    expect(result.title).toBe("Bern\u2019s & Wine & Spirits");
  });
});
