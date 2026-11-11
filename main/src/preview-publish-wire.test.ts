import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ eval: vi.fn(), update: vi.fn(), blob: vi.fn(), del: vi.fn(), trace: [] as string[] }));
vi.mock("./store/redis-client.js", () => ({ redis: { eval: m.eval } }));
vi.mock("@vercel/blob", () => ({ del: m.del }));
vi.mock("./providers/ocr.js", () => ({ createOcrProvider: () => ({ isEnabled: true }) }));
vi.mock("./services/upload-storage.js", () => ({ storeUpload: m.blob, isPrivateUploadReference: () => true, readPrivateUpload: vi.fn() }));
vi.mock("./store/job-store.js", () => ({
  createJob: async (input: object) => ({ ...input, status: "queued", queueMessageId: null, errorMessage: null,
    extractedText: null, candidates: [], recommendations: [], workerCount: 0,
    createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z" }),
  updateJob: m.update,
}));
async function load(preview = true) {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", preview ? "preview" : "production");
  vi.stubEnv("WINE_REC_NAMESPACE", preview ? "preview:qa" : "");
  vi.stubEnv("WINE_REC_PREVIEW_ROLE", "app");
  vi.stubEnv("VERCEL_URL", "wine-abc123def-team.vercel.app");
  vi.stubEnv("CHUNK_WORKER_BASE_URL", "wine-worker-def456abc-team.vercel.app");
  vi.stubEnv("QSTASH_TOKEN", "synthetic-offline-only");
  vi.stubEnv("QSTASH_URL", "https://qstash.example.test");
  vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", "6");
  vi.stubEnv("WINE_REC_PREVIEW_EXPIRES_AT", new Date(Date.now() + 3600000).toISOString());
  return import("./api-handlers.js");
}
const upload = { buffer: Buffer.from("synthetic"), filename: "synthetic.png", mimeType: "image/png" };
beforeEach(() => {
  vi.clearAllMocks(); m.trace.length = 0;
  m.eval.mockReset().mockImplementation(async () => { m.trace.push("reserved"); return 1; });
  m.update.mockReset().mockImplementation(async (_id, patch) => { m.trace.push(patch.status ?? "tracked"); });
  m.del.mockReset().mockImplementation(async () => { m.trace.push("deleted"); });
  m.blob.mockReset().mockImplementation(async (id: string) => ({ privateBlobPathname: `uploads/${id}` }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("real QStash SDK bounded Preview transport", () => {
  it("sends one attempt, zero deliveries retries, no callback, stable dedup header", async () => {
    const api = await load();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      m.trace.push("published");
      const headers = new Headers(init?.headers);
      expect(headers.get("upstash-retries")).toBe("0");
      expect(headers.get("upstash-failure-callback")).toBeNull();
      expect(headers.get("upstash-callback")).toBeNull();
      expect(headers.get("upstash-retry-delay")).toBeNull();
      expect(headers.get("upstash-deduplication-id")).toMatch(/^[a-f0-9]{64}$/);
      return new Response('{"messageId":"synthetic-message"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    await api.createUploadAnalysis(upload);
    expect(fetch).toHaveBeenCalledOnce(); expect(m.eval).toHaveBeenCalledOnce();
    expect(m.trace).toEqual(["reserved", "published", "tracked"]);
  });
  it("does not retry ambiguous network publication; terminalizes before exact cleanup", async () => {
    const api = await load();
    const fetch = vi.fn(async () => { m.trace.push("ambiguous"); throw new TypeError("connection lost after acceptance"); });
    vi.stubGlobal("fetch", fetch);
    await expect(api.createUploadAnalysis(upload)).rejects.toThrow("connection lost");
    expect(fetch).toHaveBeenCalledOnce(); expect(m.eval).toHaveBeenCalledOnce();
    expect(m.trace).toEqual(["reserved", "ambiguous", "failed", "deleted"]);
    expect(m.del).toHaveBeenCalledWith(expect.stringMatching(/^uploads\/pv_qa_/));
  });
  it("retains the source when ambiguous publication cannot be durably stopped", async () => {
    const api = await load();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("lost publish response"); }));
    m.update.mockRejectedValue(new Error("terminal Redis write failed"));
    await expect(api.createUploadAnalysis(upload)).rejects.toThrow("terminal Redis write failed");
    expect(m.del).not.toHaveBeenCalled(); expect(m.eval).toHaveBeenCalledOnce();
  });
  it("retains accepted work and source when queue-ID bookkeeping fails", async () => {
    const api = await load();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"messageId":"synthetic-message"}', { status: 200 })));
    m.update.mockRejectedValue(new Error("queue ID write failed"));
    await expect(api.createUploadAnalysis(upload)).resolves.toMatchObject({ status: "queued" });
    expect(m.del).not.toHaveBeenCalled(); expect(m.eval).toHaveBeenCalledOnce();
  });
  it("publishes nothing when Redis rejects admission", async () => {
    const api = await load(); m.eval.mockResolvedValue(-5);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(api.createUploadAnalysis(upload)).rejects.toThrow("denied");
    expect(fetch).not.toHaveBeenCalled(); expect(m.trace).toEqual(["failed", "deleted"]);
  });
  it("fails missing budget configuration before Blob storage", async () => {
    const api = await load(); vi.stubEnv("WINE_REC_PREVIEW_PUBLISH_LIMIT", undefined);
    await expect(api.createUploadAnalysis(upload)).rejects.toThrow("limit");
    expect(m.blob).not.toHaveBeenCalled(); expect(m.eval).not.toHaveBeenCalled();
  });
  it("preserves Production coordinator retries/callback and avoids budget reads", async () => {
    const api = await load(false);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("upstash-retries")).toBe("1");
      expect(headers.get("upstash-failure-callback")).toBe("https://wine-abc123def-team.vercel.app/api/worker-failure");
      expect(headers.get("upstash-deduplication-id")).toBeNull();
      return new Response('{"messageId":"synthetic-message"}', { status: 200 });
    }));
    await api.createUploadAnalysis(upload);
    expect(m.eval).not.toHaveBeenCalled();
  });
});
