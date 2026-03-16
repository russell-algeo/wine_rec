import { getProviderHealth } from "../../src/api-handlers.js";
import {
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "GET") {
    return sendMethodNotAllowed(res, "GET", req.method);
  }

  try {
    return sendJson(res, 200, await getProviderHealth());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Health check failed";
    return sendJson(res, 500, { message });
  }
}
