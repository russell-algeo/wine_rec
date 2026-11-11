import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
const { operations, values } = vi.hoisted(() => ({ operations: [] as { command: string; keys: string[]; args?: string[] }[], values: new Map<string, unknown>() }));
vi.mock("./redis-client.js", () => ({ redis: {
  set: vi.fn(async (key: string, value: string) => { operations.push({ command: "set", keys: [key] }); values.set(key, value); return "OK"; }),
  get: vi.fn(async (key: string) => { operations.push({ command: "get", keys: [key] }); return values.get(key) ?? null; }),
  lrange: vi.fn(async (key: string) => { operations.push({ command: "lrange", keys: [key] }); return []; }),
  rpush: vi.fn(async (key: string) => { operations.push({ command: "rpush", keys: [key] }); return 1; }),
  llen: vi.fn(async (key: string) => { operations.push({ command: "llen", keys: [key] }); return 0; }),
  expire: vi.fn(async (key: string) => { operations.push({ command: "expire", keys: [key] }); return 1; }),
  del: vi.fn(async (...keys: string[]) => { operations.push({ command: "del", keys }); return 1; }),
  createScript: vi.fn((source: string) => ({ exec: vi.fn(async (keys: string[], args: string[]) => {
    operations.push({ command: "eval", keys, args });
    if (source.includes("local candidateKeyPrefix")) return null;
    if (source.includes("progressTracked")) return JSON.stringify({ updated: false, progressTracked: false, jobStatus: null });
    return 1;
  }) })),
} }));
let store: typeof import("./job-store.js");
beforeAll(async () => {
  vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("WINE_REC_NAMESPACE", "preview:qa"); vi.stubEnv("WINE_REC_PREVIEW_ROLE", "app");
  vi.stubEnv("VERCEL_URL", "wine-abc123def-team.vercel.app"); vi.stubEnv("CHUNK_WORKER_BASE_URL", "https://wine-worker-def456abc-team.vercel.app");
  store = await import("./job-store.js");
});
afterAll(() => vi.unstubAllEnvs());
describe("actual job-store key and Lua argument scoping", () => {
  it("keeps all reads/writes/cleanup/derived Lua keys inside the fixed namespace even for identical Production IDs", async () => {
    const id = "same-job";
    values.set(`job:${id}`, "production-sentinel");
    await store.createJob({ id, sourceType: "upload-image", sourceFilename: "synthetic.png" });
    await store.updateJob(id, { status: "processing" });
    await store.createJobWorkers(id, 1); await store.getJobWorker(id, 0); await store.listJobWorkers(id, 1);
    const candidates = [{ id: "same-candidate", rawText: "synthetic", price: null, menuTab: null, menuSection: null, lineNumber: 0, producer: null, label: null, vintage: null, color: null, varietal: null, region: null, notes: null, extractionConfidence: 1 }] as Parameters<typeof store.createJobCandidateWork>[1];
    await store.createJobCandidateWork(id, candidates);
    await store.getJob(id); await store.getJobState(id); await store.listJobCandidateWork(id, candidates);
    await store.updateJobWorker(id, 0, { status: "processing" });
    await store.updateJobCandidateWork(id, "same-candidate", { status: "processing" });
    await store.claimNextJobCandidate(id, "owner");
    await store.completeJobCandidate(id, "same-candidate", "owner", { candidateId: "same-candidate", fitScore: 50, matchConfidence: 0, profile: null, status: "unmatched" });
    await store.requeueJobCandidate(id, "same-candidate", "owner"); await store.failJobCandidate(id, "same-candidate", "owner", "synthetic");
    await store.hasQueuedJobCandidates(id); await store.clearJobCandidateQueue(id); await store.clearJobCandidateState(id);
    expect(operations.length).toBeGreaterThan(25);
    expect(operations.flatMap(op => op.keys).every(key => key.startsWith("preview:qa:job:same-job"))).toBe(true);
    expect(operations.find(op => op.args?.[0] === "preview:qa:job:same-job:candidate:")).toBeDefined();
    expect(values.get(`job:${id}`)).toBe("production-sentinel");
    expect(operations.some(op => ["flushall", "flushdb", "scan", "keys"].includes(op.command))).toBe(false);
  });
});
