import { cancelAnalysis } from "../../../src/api-handlers.js";
import {
  getRequestUrl,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../../../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "POST") {
    return sendMethodNotAllowed(res, "POST", req.method);
  }

  const pathSegments = getRequestUrl(req).pathname.split("/").filter(Boolean);
  const cancelIndex = pathSegments.lastIndexOf("cancel");
  const id = cancelIndex > 0 ? pathSegments[cancelIndex - 1] : undefined;

  if (!id) {
    return sendJson(res, 400, { message: "Analysis id is required" });
  }

  const analysis = await cancelAnalysis(id);
  if (!analysis) {
    return sendJson(res, 404, { message: "Analysis not found" });
  }

  return sendJson(res, 200, analysis);
}
