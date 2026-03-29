import fs from "node:fs/promises";
import path from "node:path";

import { appConfig } from "../config.js";

export type AnalysisMetadata = {
  mimeType?: string;
  sourceUrl?: string;
};

export async function ensureUploadRoot(): Promise<void> {
  await fs.mkdir(appConfig.uploadRoot, { recursive: true });
}

function getAnalysisFolder(analysisId: string): string {
  return path.join(appConfig.uploadRoot, analysisId);
}

export async function saveUpload(
  analysisId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureUploadRoot();
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const folder = getAnalysisFolder(analysisId);
  await fs.mkdir(folder, { recursive: true });
  const fullPath = path.join(folder, safeFilename);
  await fs.writeFile(fullPath, bytes);
  return fullPath;
}

export async function saveUrlSource(analysisId: string, url: string): Promise<string> {
  await ensureUploadRoot();
  const folder = getAnalysisFolder(analysisId);
  await fs.mkdir(folder, { recursive: true });
  const fullPath = path.join(folder, "source.url");
  await fs.writeFile(fullPath, `${url}\n`, "utf8");
  return fullPath;
}

export async function writeAnalysisMetadata(
  analysisId: string,
  storagePath: string,
  metadata: AnalysisMetadata,
): Promise<void> {
  const metadataPath = path.join(path.dirname(storagePath), `${analysisId}.meta.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

export async function readAnalysisMetadata(
  analysisId: string,
  storagePath: string,
): Promise<AnalysisMetadata> {
  const metadataPath = path.join(path.dirname(storagePath), `${analysisId}.meta.json`);

  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as AnalysisMetadata;
  } catch {
    return {};
  }
}
