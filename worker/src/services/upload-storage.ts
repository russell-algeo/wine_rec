import { get, put } from "@vercel/blob";

export type StoredUpload =
  | { fileBlobUrl: string; privateBlobPathname?: never }
  | { privateBlobPathname: string; fileBlobUrl?: never };

// Job IDs are generated locally. Never allow a queue payload to choose another
// pathname, URL, encoded path, or traversal through the private-store credential.
export function uploadBlobPathname(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error("Invalid upload job ID");
  }
  return `uploads/${jobId}`;
}

export function uploadAccessMode(): "public" | "private" {
  const value = process.env.BLOB_UPLOAD_ACCESS;
  if (value === undefined || value === "public") return "public";
  if (value === "private") return "private";
  throw new Error("BLOB_UPLOAD_ACCESS must be public or private");
}

export function isPrivateUploadReference(jobId: string, pathname: string): boolean {
  try {
    return pathname === uploadBlobPathname(jobId);
  } catch {
    return false;
  }
}

export async function storeUpload(
  jobId: string,
  buffer: Buffer,
  contentType: string,
): Promise<StoredUpload> {
  const pathname = uploadBlobPathname(jobId);
  const access = uploadAccessMode();
  const blob = await put(pathname, buffer, {
    access,
    contentType,
    ...(access === "private" ? { addRandomSuffix: false } : {}),
  });
  if (access === "private") {
    if (blob.pathname !== pathname) {
      throw new Error("Private upload storage returned an unexpected pathname");
    }
    return { privateBlobPathname: pathname };
  }
  return { fileBlobUrl: blob.url };
}

export async function readPrivateUpload(jobId: string, pathname: string): Promise<Buffer> {
  if (!isPrivateUploadReference(jobId, pathname)) {
    throw new Error("Invalid private upload reference");
  }
  // Deliberately independent of current upload mode: queued private jobs must
  // remain readable during rollback, using this deployment's matching credential.
  const blob = await get(pathname, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw new Error("Private upload is unavailable");
  }
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}
