import { ZodError } from "zod";

import { getProviderCanary } from "../../src/api-handlers.js";
import {
  readJsonBody,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../../src/vercel-utils.js";

function readSingleHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isProviderCanaryAllowed(headers: VercelRequestLike["headers"]): boolean {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }

  const enabled = process.env.WINE_REC_PROVIDER_CANARY_ENABLED === "true";
  const configuredSecret = process.env.WINE_REC_PROVIDER_CANARY_SECRET?.trim();
  const suppliedSecret = readSingleHeader(headers["x-provider-canary-secret"]).trim();

  return Boolean(enabled && configuredSecret && suppliedSecret === configuredSecret);
}

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "POST") {
    return sendMethodNotAllowed(res, "POST", req.method);
  }

  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.WINE_REC_PROVIDER_CANARY_ENABLED !== "true" ||
    !process.env.WINE_REC_PROVIDER_CANARY_SECRET?.trim()
  ) {
    return sendJson(res, 404, { message: "Provider canary is disabled" });
  }

  if (!isProviderCanaryAllowed(req.headers)) {
    return sendJson(res, 403, { message: "Provider canary access denied" });
  }

  try {
    return sendJson(res, 200, await getProviderCanary(await readJsonBody<unknown>(req)));
  } catch (error) {
    if (error instanceof ZodError) {
      return sendJson(res, 400, { message: "Invalid provider canary request" });
    }

    const message = error instanceof Error ? error.message : "Provider canary failed";
    return sendJson(res, 500, { message });
  }
}
