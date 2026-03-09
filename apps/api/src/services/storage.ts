import fs from "node:fs/promises";
import path from "node:path";

import { appConfig } from "../config.js";

export async function ensureUploadRoot(): Promise<void> {
  await fs.mkdir(appConfig.uploadRoot, { recursive: true });
}

export async function saveUpload(
  analysisId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureUploadRoot();
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const folder = path.join(appConfig.uploadRoot, analysisId);
  await fs.mkdir(folder, { recursive: true });
  const fullPath = path.join(folder, safeFilename);
  await fs.writeFile(fullPath, bytes);
  return fullPath;
}
