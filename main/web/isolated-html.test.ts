import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isolatedHtml } from "./isolated-html";

describe("isolated page resources", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  it("removes Google font preconnects and styles before parsing the local page", () => {
    const isolated = isolatedHtml(html, true);
    expect(isolated).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(isolated).toContain('src="/src/main.tsx"');
  });
  it("preserves the hosted page unchanged", () => {
    expect(isolatedHtml(html, false)).toBe(html);
  });
});
