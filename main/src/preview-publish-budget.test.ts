import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock("./store/redis-client.js", () => ({ redis: { eval: mocks.eval } }));
async function load(namespace = "preview:qa", role = "app") {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", namespace ? "preview" : "production");
  vi.stubEnv("WINE_REC_NAMESPACE", namespace);
  vi.stubEnv("WINE_REC_PREVIEW_ROLE", role);
  vi.stubEnv("VERCEL_URL", "wine-abc123def-team.vercel.app");
  vi.stubEnv("CHUNK_WORKER_BASE_URL", "wine-worker-def456abc-team.vercel.app");
  vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", "6");
  vi.stubEnv("WINE_REC_PREVIEW_EXPIRES_AT", new Date(Date.now() + 3600000).toISOString());
  mocks.eval.mockReset().mockResolvedValue(1);
  return import("./preview-publish-budget.js");
}
afterEach(() => vi.unstubAllEnvs());
describe("Preview publication admission", () => {
  it.each([undefined, "", "0", "7", "999", "1.5", "06", "NaN", " 6", "6\n"])("rejects missing/unsafe allowance %s", async value => {
    const budget = await load(); vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", value);
    await expect(budget.reservePreviewPublication({ mode: "coordinator", jobId: "j" })).rejects.toThrow("limit");
    expect(mocks.eval).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "tomorrow", "2026-01-01", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])("rejects missing/malformed/expired/distant deadline %s", async value => {
    const budget = await load(); vi.stubEnv("WINE_REC_PREVIEW_EXPIRES_AT", value);
    expect(() => budget.previewBudgetConfig()).toThrow(); expect(mocks.eval).not.toHaveBeenCalled();
  });
  it("leaves Production untouched even with invalid Preview settings", async () => {
    const budget = await load(""); vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", "wrong");
    vi.stubEnv("WINE_REC_PREVIEW_EXPIRES_AT", "wrong");
    expect(budget.previewBudgetConfig()).toBeNull();
    await budget.reservePreviewPublication({ mode: "worker", jobId: "j", workerIndex: 9 });
    expect(mocks.eval).not.toHaveBeenCalled();
  });
  it("app and worker share the exact atomic key and prerequisite permit", async () => {
    let budget = await load();
    await budget.reservePreviewPublication({ mode: "coordinator", jobId: "j" });
    expect(mocks.eval.mock.calls[0]![1]).toEqual(["preview:qa:qstash-smoke-budget:v1"]);
    expect(mocks.eval.mock.calls[0]![2].slice(2)).toEqual(['["coordinator","j"]', ""]);
    budget = await load("preview:qa", "worker");
    await budget.reservePreviewPublication({ mode: "worker", jobId: "j", workerIndex: 0 });
    expect(mocks.eval.mock.calls[0]![1]).toEqual(["preview:qa:qstash-smoke-budget:v1"]);
    expect(mocks.eval.mock.calls[0]![2].slice(2)).toEqual(['["worker","j"]', '["coordinator","j"]']);
  });
  it.each([0, -1, -2, -3, -4, -5, "1", null])("fails closed on unconfirmed admission %s", async result => {
    const budget = await load(); mocks.eval.mockResolvedValue(result);
    await expect(budget.reservePreviewPublication({ mode: "coordinator", jobId: "j" })).rejects.toThrow("denied");
    expect(mocks.eval).toHaveBeenCalledOnce();
  });
  it("does not retry or refund after an ambiguous Redis response", async () => {
    const budget = await load(); mocks.eval.mockRejectedValue(new Error("lost response"));
    await expect(budget.reservePreviewPublication({ mode: "coordinator", jobId: "j" })).rejects.toThrow("lost response");
    expect(mocks.eval).toHaveBeenCalledOnce();
  });
  it("rejects any extra worker before Redis", async () => {
    const budget = await load();
    await expect(budget.reservePreviewPublication({ mode: "worker", jobId: "j", workerIndex: 1 })).rejects.toThrow("worker zero");
    expect(mocks.eval).not.toHaveBeenCalled();
  });
});
