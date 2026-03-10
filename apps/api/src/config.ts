import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  return Math.max(1, Math.floor(parseNumber(value, fallback)));
}

const defaultWebOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const configuredWebOrigins = (process.env.WEB_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const appConfig = {
  port: parseNumber(process.env.PORT, 3001),
  host: process.env.HOST ?? "127.0.0.1",
  webOrigins: [...new Set([...defaultWebOrigins, ...configuredWebOrigins])],
  uploadRoot: path.resolve(process.cwd(), process.env.UPLOAD_ROOT ?? "../../uploads"),
  databaseUrl: path.resolve(
    process.cwd(),
    process.env.DATABASE_URL ?? "./data/wine-rec.sqlite",
  ),
  workerPollIntervalMs: parseNumber(process.env.WORKER_POLL_INTERVAL_MS, 1500),
  workerConcurrency: parsePositiveInteger(process.env.WORKER_CONCURRENCY, 2),
  analysisCandidateConcurrency: parsePositiveInteger(
    process.env.ANALYSIS_CANDIDATE_CONCURRENCY,
    3,
  ),
  ocrProvider: process.env.OCR_PROVIDER ?? "mock",
  ocrSpaceApiKey: process.env.OCR_SPACE_API_KEY ?? "",
  providerOrder: (process.env.WINE_PROFILE_PROVIDER_ORDER ?? "vivino-direct,rule-based")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean),
  enableVivinoDirect: parseBoolean(process.env.ENABLE_VIVINO_DIRECT, true),
  vivinoDirectUserAgent:
    process.env.VIVINO_DIRECT_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  vivinoDirectDelayMs: parseNumber(process.env.VIVINO_DIRECT_DELAY_MS, 500),
  /** Maximum retries on HTTP 429 before giving up. */
  vivinoDirectMaxRetries: parseNumber(process.env.VIVINO_DIRECT_MAX_RETRIES, 3),
  /** Base backoff in ms for 429 retry (doubles each attempt). */
  vivinoDirectBackoffMs: parseNumber(process.env.VIVINO_DIRECT_BACKOFF_MS, 2000),
  /** Whether to fetch the secondary /api/wines/{id}/tastes endpoint for richer taste data. */
  vivinoDirectFetchTastes: parseBoolean(process.env.VIVINO_DIRECT_FETCH_TASTES, true),
  /** Run Playwright browser headless (default true). Set false for debugging. */
  vivinoDirectHeadless: parseBoolean(process.env.VIVINO_DIRECT_HEADLESS, true),
  /** Optional path to Chrome/Chromium executable. Playwright bundled Chromium is used if unset. */
  vivinoDirectChromeExecutable: process.env.VIVINO_DIRECT_CHROME_EXECUTABLE ?? "",
};
