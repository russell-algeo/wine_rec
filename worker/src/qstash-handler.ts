import { Receiver } from "@upstash/qstash";

import {
  getHeaderValue,
  readRawBody,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "./vercel-utils.js";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!,
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!,
});

export async function readVerifiedQStashJsonBody(
  req: VercelRequestLike,
  res: VercelResponseLike,
): Promise<unknown | null> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST", req.method);
    return null;
  }

  const rawBody = await readRawBody(req);
  const signature = getHeaderValue(req.headers["upstash-signature"]);

  if (!signature) {
    sendJson(res, 401, { error: "Invalid signature" });
    return null;
  }

  const isValid = await receiver.verify({
    signature,
    body: rawBody.toString("utf8"),
  }).catch(() => false);

  if (!isValid) {
    sendJson(res, 401, { error: "Invalid signature" });
    return null;
  }

  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON payload" });
    return null;
  }
}
