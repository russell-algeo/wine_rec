import { Client } from "@upstash/qstash";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadScope(namespace: string, role = "app") {
  vi.resetModules();
  vi.stubEnv("VERCEL_ENV", namespace ? "preview" : "production");
  vi.stubEnv("WINE_REC_NAMESPACE", namespace);
  vi.stubEnv("WINE_REC_PREVIEW_ROLE", role);
  vi.stubEnv("VERCEL_URL", "wine-abc123def-team.vercel.app");
  vi.stubEnv("CHUNK_WORKER_BASE_URL", "wine-worker-def456abc-team.vercel.app");
  return import("./deployment-scope.js");
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("QStash flow-control wire contract", () => {
  it("reproduces the hosted colon rejection with the real SDK and mocked transport", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("upstash-flow-control-key")).toBe("preview:qa.analysis.same-job.worker");
      return new Response(JSON.stringify({ error: "flowControlKey must be alphanumeric, hyphen, underscore, or period" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }));
    const client = new Client({ token: "synthetic-offline-only", baseUrl: "https://qstash.example.test" });
    await expect(client.publishJSON({
      url: "https://wine-worker-def456abc-team.vercel.app/api/chunk-worker", body: {},
      flowControl: { key: "preview:qa.analysis.same-job.worker", parallelism: 1 },
    })).rejects.toThrow("flowControlKey");
  });
  it("preserves the exact legacy Production key", async () => {
    const { scopedFlowControlKey } = await loadScope("");
    expect(scopedFlowControlKey("analysis.same-job.worker")).toBe("analysis.same-job.worker");
  });

  it.each(["quality-20261111", "qa", "qa-a", "a".repeat(48)])("keeps namespace %s distinct and SDK wire-safe", async label => {
    const scope = await loadScope(`preview:${label}`);
    const jobId = "pv_quality-20261111_rvHC3C6bgz5NabRN__5RyQ";
    const key = scope.scopedFlowControlKey(`analysis.${jobId}.worker`);
    expect(key).toBe(`preview.${label}.analysis.${jobId}.worker`);
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    // Redis and queue payload namespace must NOT migrate with this wire-only fix.
    expect(scope.scope.namespace).toBe(`preview:${label}`);
    expect(scope.scopedRedisKey("job:same-job")).toBe(`preview:${label}:job:same-job`);

    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push(headers);
      const sentKey = headers.get("upstash-flow-control-key") ?? "";
      const valid = /^[A-Za-z0-9._-]+$/.test(sentKey);
      return new Response(JSON.stringify(valid ? { messageId: "synthetic-message" } : {
        error: "flowControlKey must be alphanumeric, hyphen, underscore, or period",
      }), { status: valid ? 200 : 400, headers: { "content-type": "application/json" } });
    }));
    const client = new Client({ token: "synthetic-offline-only", baseUrl: "https://qstash.example.test" });
    await expect(client.publishJSON({
      url: "https://wine-worker-def456abc-team.vercel.app/api/chunk-worker",
      body: { mode: "worker", jobId, workerIndex: 0, deploymentNamespace: scope.scope.namespace },
      flowControl: { key, parallelism: 1 }, retries: 3,
    })).resolves.toMatchObject({ messageId: "synthetic-message" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.get("upstash-flow-control-key")).toBe(key);
  });

  it("maps app and worker to the same key, but different namespaces/jobs to different keys", async () => {
    const app = await loadScope("preview:qa", "app");
    const key = app.scopedFlowControlKey("analysis.same-job.worker");
    const worker = await loadScope("preview:qa", "worker");
    expect(worker.scopedFlowControlKey("analysis.same-job.worker")).toBe(key);
    expect(worker.scopedFlowControlKey("analysis.other-job.worker")).not.toBe(key);
    const other = await loadScope("preview:qa-a");
    expect(other.scopedFlowControlKey("analysis.same-job.worker")).not.toBe(key);
  });

  it.each(["", "analysis:job.worker", "analysis/job.worker", "analysis job.worker", "analysis.\n.worker", "analysis.job.worker\n"])("rejects invalid base key %j before publication", async key => {
    const scope = await loadScope("preview:qa");
    expect(() => scope.scopedFlowControlKey(key)).toThrow("flow-control key");
  });
});
