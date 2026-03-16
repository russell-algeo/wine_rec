import { RequestError, getPreview } from "../src/api-handlers.js";
import {
  getRequestUrl,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "GET") {
    return sendMethodNotAllowed(res, "GET", req.method);
  }

  const url = getRequestUrl(req).searchParams.get("url");
  if (!url) {
    return sendJson(res, 400, { error: "url query parameter is required" });
  }

  try {
    const preview = await getPreview(url);
    return sendJson(res, 200, preview);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    const message = error instanceof Error ? error.message : "Preview failed";
    return sendJson(res, 500, { error: message });
  }
}
