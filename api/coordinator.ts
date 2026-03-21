import type {
  VercelRequestLike,
  VercelResponseLike,
} from "../apps/api/src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  const mod = await import("../apps/api/api/worker.js");
  return mod.default(req, res);
}
