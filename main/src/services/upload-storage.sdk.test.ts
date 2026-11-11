import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { readPrivateUpload, storeUpload } from "./upload-storage.js";

// The installed real SDK is exercised only against in-process interceptors.
// This is synthetic local data and a deliberately fake credential; real egress is disabled.
const token = "vercel_blob_rw_winefixture_FAKE_LOCAL_TEST_ONLY";
describe("private upload real SDK request contract (no network)", () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", token);
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    vi.stubEnv("VERCEL_BLOB_API_URL", "https://blob-sdk-test.invalid");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_BLOB_API_URL", undefined);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    vi.unstubAllEnvs();
    await agent.close();
  });
  it("sends private access and deterministic path on PUT, retaining no URL in queue data", async () => {
    agent.get("https://blob-sdk-test.invalid")
      .intercept({ path: "/?pathname=uploads%2Fjob-sdk", method: "PUT",
        headers: { authorization: `Bearer ${token}`, "x-vercel-blob-access": "private", "x-add-random-suffix": "0" } })
      .reply(200, {
        pathname: "uploads/job-sdk",
        url: "https://winefixture.private.blob.vercel-storage.com/uploads/job-sdk",
        downloadUrl: "https://winefixture.private.blob.vercel-storage.com/uploads/job-sdk?download=1",
        contentType: "image/png", contentDisposition: "attachment", etag: "test-etag",
      }, { headers: { "content-type": "application/json" } });
    expect(await storeUpload("job-sdk", Buffer.from("synthetic fixture"), "image/png"))
      .toEqual({ privateBlobPathname: "uploads/job-sdk" });
    agent.assertNoPendingInterceptors();
  });
  it("authenticates GET to the private hostname derived from the credential", async () => {
    agent.get("https://winefixture.private.blob.vercel-storage.com")
      .intercept({ path: "/uploads/job-sdk", method: "GET", headers: { authorization: `Bearer ${token}` } })
      .reply(200, "synthetic fixture", { headers: { "content-type": "image/png", "content-length": "17" } });
    expect(await readPrivateUpload("job-sdk", "uploads/job-sdk")).toEqual(Buffer.from("synthetic fixture"));
    agent.assertNoPendingInterceptors();
  });
  it("propagates a denied authenticated GET without any public-host fallback", async () => {
    agent.get("https://winefixture.private.blob.vercel-storage.com")
      .intercept({ path: "/uploads/job-sdk", method: "GET", headers: { authorization: `Bearer ${token}` } })
      .reply(403, "denied");
    await expect(readPrivateUpload("job-sdk", "uploads/job-sdk")).rejects.toThrow("403");
    agent.assertNoPendingInterceptors();
  });
});
