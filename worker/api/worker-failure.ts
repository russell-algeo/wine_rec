import { processWorkerFailure } from "../src/api-handlers.js";
import {
  sendJson,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../src/vercel-utils.js";

import { readVerifiedQStashJsonBody } from "../src/qstash-handler.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  const body = await readVerifiedQStashJsonBody(req, res);
  if (body === null) {
    return;
  }

  const sourceBody =
    typeof body === "object" && body !== null && "sourceBody" in body
      ? String((body as { sourceBody: unknown }).sourceBody)
      : null;

  if (!sourceBody) {
    return sendJson(res, 400, { error: "Missing sourceBody" });
  }

  await processWorkerFailure(sourceBody);
  return sendJson(res, 200, { ok: true });
}
