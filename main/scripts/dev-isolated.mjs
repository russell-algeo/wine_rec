// Separate, opt-in entry point. Never selected by Vercel or the hosted API.
if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
  throw new Error("Isolated development mode cannot run in a hosted deployment");
}
process.env.WINE_REC_ISOLATED = "true";
process.env.HOST = "127.0.0.1";
process.env.ENABLE_VIVINO_DIRECT = "false";
process.env.WINE_PROFILE_PROVIDER_ORDER = "rule-based";
process.env.OCR_PROVIDER = "tesseract-js";
process.env.TSX_TSCONFIG_PATH = new URL("../tsconfig.runtime.json", import.meta.url).pathname;
const { register } = await import("tsx/esm/api");
register();
await import("../src/isolated-server.ts");
