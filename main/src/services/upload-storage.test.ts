import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { putMock, getMock } = vi.hoisted(() => ({ putMock: vi.fn(), getMock: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put: putMock, get: getMock }));
import { isPrivateUploadReference, readPrivateUpload, storeUpload, uploadAccessMode, uploadBlobPathname } from "./upload-storage.js";

describe("upload storage isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("BLOB_UPLOAD_ACCESS", undefined); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("keeps legacy public uploads as the unset default", () => { expect(uploadAccessMode()).toBe("public"); });
  it.each(["public", "private"] as const)("accepts explicit %s mode", mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode); expect(uploadAccessMode()).toBe(mode);
  });
  it.each(["", "PRIVATE", " private", "invalid"])("rejects invalid mode %j without uploading", async mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode);
    await expect(storeUpload("job-1", Buffer.from("fixture"), "image/png")).rejects.toThrow("BLOB_UPLOAD_ACCESS");
    expect(putMock).not.toHaveBeenCalled();
  });
  it.each(["", "../job", ".", "job/a", "job%2Fa", "job?x", "a".repeat(129)])("rejects malformed ID %j before storage", async id => {
    expect(() => uploadBlobPathname(id)).toThrow("Invalid upload job ID");
    expect(isPrivateUploadReference(id, `uploads/${id}`)).toBe(false);
    await expect(storeUpload(id, Buffer.from("fixture"), "image/png")).rejects.toThrow("Invalid upload job ID");
    expect(putMock).not.toHaveBeenCalled();
  });
  it("allows the complete generated-ID alphabet and boundary length", () => {
    expect(uploadBlobPathname("a".repeat(128))).toBe("uploads/" + "a".repeat(128));
    expect(uploadBlobPathname("abc-_123")).toBe("uploads/abc-_123");
  });
  it("retains the legacy public URL without changing suffix policy", async () => {
    putMock.mockResolvedValue({ pathname: "uploads/job-1-random", url: "https://example.invalid/public-fixture" });
    expect(await storeUpload("job-1", Buffer.from("fixture"), "image/png")).toEqual({ fileBlobUrl: "https://example.invalid/public-fixture" });
    expect(putMock).toHaveBeenCalledWith("uploads/job-1", Buffer.from("fixture"), { access: "public", contentType: "image/png" });
  });
  it("queues only a job-bound pathname for private uploads", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    putMock.mockResolvedValue({ pathname: "uploads/job-1", url: "https://example.invalid/private-not-for-queue" });
    expect(await storeUpload("job-1", Buffer.from("fixture"), "image/png")).toEqual({ privateBlobPathname: "uploads/job-1" });
    expect(putMock).toHaveBeenCalledWith("uploads/job-1", Buffer.from("fixture"), { access: "private", contentType: "image/png", addRandomSuffix: false });
  });
  it("fails closed if storage returns a different private pathname", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    putMock.mockResolvedValue({ pathname: "uploads/another-job", url: "https://example.invalid/unexpected" });
    await expect(storeUpload("job-1", Buffer.from("fixture"), "image/png")).rejects.toThrow("unexpected pathname");
  });
  it("propagates private storage failures without public fallback", async () => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", "private");
    putMock.mockRejectedValue(new Error("storage denied"));
    await expect(storeUpload("job-1", Buffer.from("fixture"), "image/png")).rejects.toThrow("storage denied");
    expect(putMock).toHaveBeenCalledTimes(1);
  });
  it.each(["public", "private"])("authenticates an in-flight private read even when new uploads use %s", async mode => {
    vi.stubEnv("BLOB_UPLOAD_ACCESS", mode);
    getMock.mockResolvedValue({ statusCode: 200, stream: new Response("private fixture").body });
    expect(await readPrivateUpload("job-1", "uploads/job-1")).toEqual(Buffer.from("private fixture"));
    expect(getMock).toHaveBeenCalledWith("uploads/job-1", { access: "private" });
  });
  it.each(["uploads/another-job", "https://example.invalid/private", "uploads/job-1/../other", "uploads/job-1%2Fother"])("rejects mismatched private reference %j before storage", async value => {
    await expect(readPrivateUpload("job-1", value)).rejects.toThrow("Invalid private upload reference");
    expect(getMock).not.toHaveBeenCalled();
  });
  it.each([null, { statusCode: 304, stream: null }, { statusCode: 200, stream: null }])("rejects missing private content %# without a public retry", async value => {
    getMock.mockResolvedValue(value);
    await expect(readPrivateUpload("job-1", "uploads/job-1")).rejects.toThrow("unavailable");
    expect(getMock).toHaveBeenCalledTimes(1);
  });
  it("propagates denied private reads without a public retry", async () => {
    getMock.mockRejectedValue(new Error("private access denied"));
    await expect(readPrivateUpload("job-1", "uploads/job-1")).rejects.toThrow("private access denied");
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
