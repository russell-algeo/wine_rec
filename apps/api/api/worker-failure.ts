import { Receiver } from "@upstash/qstash";

import { processWorkerFailure } from "../src/api-handlers.js";
import {
  getHeaderValue,
  readRawBody,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../src/vercel-utils.js";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "POST") {
    return sendMethodNotAllowed(res, "POST", req.method);
  }

  const rawBody = await readRawBody(req);
  const signature = getHeaderValue(req.headers["upstash-signature"]);

  if (!signature) {
    return sendJson(res, 401, { error: "Invalid signature" });
  }

  const isValid = await receiver.verify({
    signature,
    body: rawBody.toString("utf8"),
  }).catch(() => false);

  if (!isValid) {
    return sendJson(res, 401, { error: "Invalid signature" });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON payload" });
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
