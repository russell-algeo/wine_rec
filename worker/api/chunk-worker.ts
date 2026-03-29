import { ZodError } from "zod";

import { parseWorkerJobPayload, processWorkerJob } from "../src/api-handlers.js";
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

  try {
    const payload = parseWorkerJobPayload(body);
    if (payload.mode !== "worker") {
      return sendJson(res, 400, { error: "Expected worker payload" });
    }

    await processWorkerJob(payload);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof ZodError) {
      return sendJson(res, 400, { error: "Invalid worker payload" });
    }

    throw error;
  }
}
