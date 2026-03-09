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
  ocrProvider: process.env.OCR_PROVIDER ?? "mock",
  ocrSpaceApiKey: process.env.OCR_SPACE_API_KEY ?? "",
  providerOrder: (process.env.WINE_PROFILE_PROVIDER_ORDER ??
    "apify-vivino,wine-searcher,spoonacular-style,rule-based")
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean),
  enableUnofficialVivino: parseBoolean(process.env.ENABLE_UNOFFICIAL_VIVINO, true),
  apifyToken: process.env.APIFY_TOKEN ?? "",
  apifyVivinoActorId: process.env.APIFY_VIVINO_ACTOR_ID ?? "",
  apifyVivinoEndpoint: process.env.APIFY_VIVINO_ENDPOINT ?? "",
  wineSearcherApiKey: process.env.WINE_SEARCHER_API_KEY ?? "",
  wineSearcherEndpoint: process.env.WINE_SEARCHER_ENDPOINT ?? "",
  spoonacularApiKey: process.env.SPOONACULAR_API_KEY ?? "",
};
