import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoopbackUrl, installIsolatedFetch } from "./isolated-network.js";

afterEach(() => vi.unstubAllGlobals());
describe("isolated network boundary", () => {
  it("accepts only local HTTP source fixtures", () => {
    expect(assertLoopbackUrl("http://localhost:8080/menu").hostname).toBe("127.0.0.1");
    for (const url of ["https://wine-rec.vercel.app", "http://127.0.0.1.example.com", "http://user:secret@localhost", "file:///etc/passwd"]) {
      expect(() => assertLoopbackUrl(url)).toThrow();
    }
  });
  it("stops external redirects before contacting the destination", async () => {
    const underlying = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "https://example.com" } }));
    vi.stubGlobal("fetch", underlying);
    const restore = installIsolatedFetch();
    await expect(fetch("http://localhost:8080/menu")).rejects.toThrow("local HTTP");
    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying.mock.calls[0]?.[1]).toEqual({ redirect: "manual" });
    restore();
  });
});
