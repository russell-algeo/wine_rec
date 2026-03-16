import { createAnalysisFromUrlRequestSchema } from "@wine-rec/contracts";

import {
  RequestError,
  createUrlAnalysis,
} from "../src/api-handlers.js";
import {
  readJsonBody,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "POST") {
    return sendMethodNotAllowed(res, "POST", req.method);
  }

  try {
    const parsed = createAnalysisFromUrlRequestSchema.parse(
      await readJsonBody<unknown>(req),
    );
    const response = await createUrlAnalysis({ url: parsed.url });
    return sendJson(res, 200, response);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendJson(res, error.statusCode, { message: error.message });
    }

    const message = error instanceof Error ? error.message : "Failed to start analysis";
    return sendJson(res, 500, { message });
  }
}
