import { del, get, put } from "@vercel/blob";

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

/**
 * Private uploads use their own store credential (BLOB_PRIVATE_READ_WRITE_TOKEN,
 * injected by the private store's project connection) so the public store's
 * BLOB_READ_WRITE_TOKEN keeps working for public mode and rollback.
 */
function privateStoreToken(): string | undefined {
  return process.env.BLOB_PRIVATE_READ_WRITE_TOKEN?.trim() || undefined;
}

export async function deleteStoredUpload(stored: StoredUpload): Promise<void> {
  if (stored.privateBlobPathname) {
    const token = privateStoreToken();
    if (token) await del(stored.privateBlobPathname, { token });
    else await del(stored.privateBlobPathname);
  } else if (stored.fileBlobUrl) {
    await del(stored.fileBlobUrl);
  }
}

export async function storeUpload(
  jobId: string,
  buffer: Buffer,
  contentType: string,
): Promise<StoredUpload> {
  const pathname = uploadBlobPathname(jobId);
  const access = uploadAccessMode();
  const token = access === "private" ? privateStoreToken() : undefined;
  const blob = await put(pathname, buffer, {
    access,
    contentType,
    ...(access === "private" ? { addRandomSuffix: false } : {}),
    ...(token ? { token } : {}),
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
  const token = privateStoreToken();
  const blob = await get(pathname, { access: "private", ...(token ? { token } : {}) });
  if (!blob || blob.statusCode !== 200 || !blob.stream) {
    throw new Error("Private upload is unavailable");
  }
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}
