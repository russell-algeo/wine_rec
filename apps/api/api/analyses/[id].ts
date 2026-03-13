import { getAnalysisRun } from "../../src/api-handlers.js";
import {
  getRequestUrl,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "GET") {
    return sendMethodNotAllowed(res, "GET", req.method);
  }

  const pathSegments = getRequestUrl(req).pathname.split("/").filter(Boolean);
  const id = pathSegments[pathSegments.length - 1];

  if (!id) {
    return sendJson(res, 400, { message: "Analysis id is required" });
  }

  const analysis = await getAnalysisRun(id);
  if (!analysis) {
    return sendJson(res, 404, { message: "Analysis not found" });
  }

  return sendJson(res, 200, analysis);
}
