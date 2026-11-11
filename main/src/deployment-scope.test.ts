import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentScope, previewDeploymentOrigin } from "./deployment-scope.js";

describe("fixed shared-database deployment scope", () => {
  it("preserves legacy Production and local defaults", () => {
    expect(deploymentScope({ VERCEL_ENV: "production" })).toEqual({ namespace: "", role: "app" });
    expect(deploymentScope({})).toEqual({ namespace: "", role: "app" });
  });
  it("requires a namespace and role in Preview", () => {
    expect(() => deploymentScope({ VERCEL_ENV: "preview" })).toThrow("refusing unprefixed");
    expect(() => deploymentScope({ VERCEL_ENV: "preview", WINE_REC_NAMESPACE: "preview:qa" })).toThrow("ROLE");
    expect(deploymentScope({ VERCEL_ENV: "preview", WINE_REC_NAMESPACE: "preview:qa", WINE_REC_PREVIEW_ROLE: "worker" })).toEqual({ namespace: "preview:qa", role: "worker" });
  });
  it.each(["production", "preview:*", "preview:../prod", "preview:qa:job", "preview:QA", " preview:qa", "preview:" + "x".repeat(49)])("rejects unsafe namespace %s", namespace => {
    expect(() => deploymentScope({ WINE_REC_NAMESPACE: namespace, WINE_REC_PREVIEW_ROLE: "app" })).toThrow("NAMESPACE");
  });
  it("does not allow a Production deploy to silently move its legacy keyspace", () => {
    expect(() => deploymentScope({ VERCEL_ENV: "production", WINE_REC_NAMESPACE: "preview:qa", WINE_REC_PREVIEW_ROLE: "app" })).toThrow("legacy");
  });
  it.each([undefined, "https://wine-rec.vercel.app", "https://wine-rec-git-qa-team.vercel.app", "http://wine-abc123def-team.vercel.app", "https://wine-abc123def-team.vercel.app/path", "https://wine-abc123def-team.vercel.app?x=1", "https://user:password@wine-abc123def-team.vercel.app", "https://example.com"])("rejects absent/mutable/unsafe Preview route %#", url => {
    expect(() => previewDeploymentOrigin(url)).toThrow("immutable Vercel");
  });
  it("accepts a syntactically immutable deployment, subject to separate metadata verification", () => {
    expect(previewDeploymentOrigin("wine-abc123def-team.vercel.app")).toBe("https://wine-abc123def-team.vercel.app");
  });
});


afterEach(() => vi.unstubAllEnvs());
describe("Preview startup fail-closed gate", () => {
  it.each(["missing-namespace", "missing-self-url", "missing-worker-url"])("rejects %s at module initialization before any side effect", async kind => {
    vi.resetModules();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("WINE_REC_NAMESPACE", kind === "missing-namespace" ? "" : "preview:qa");
    vi.stubEnv("WINE_REC_PREVIEW_ROLE", "app");
    vi.stubEnv("VERCEL_URL", kind === "missing-self-url" ? "" : "wine-abc123def-team.vercel.app");
    vi.stubEnv("CHUNK_WORKER_BASE_URL", kind === "missing-worker-url" ? "" : "wine-worker-def456abc-team.vercel.app");
    await expect(import("./deployment-scope.js")).rejects.toThrow();
  });
});
