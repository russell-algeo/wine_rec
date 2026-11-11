import { scope, scopedRedisKey } from "./deployment-scope.js";

// A deliberately small, one-off smoke-test allowance, NOT a daily resettable
// quota. Production has no behavior change. Both immutable Preview deployments
// must use the same namespace, limit and deadline. Never delete/reset this key
// during fixture cleanup or rollback: an uncertain publication stays spent.
export const MAX_PREVIEW_PUBLICATIONS = 6;
export class PreviewBudgetError extends Error {}

export function previewBudgetConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!scope.namespace) return null;
  const raw = env.WINE_REC_PREVIEW_PUBLISH_LIMIT ?? "";
  const limit = Number(raw);
  const expiresAt = env.WINE_REC_PREVIEW_EXPIRES_AT ?? "";
  const deadline = Date.parse(expiresAt);
  if (raw.length !== 1 || !/^[1-6]$/.test(raw) || limit > MAX_PREVIEW_PUBLICATIONS || !Number.isFinite(deadline)
      || new Date(deadline).toISOString() !== expiresAt) {
    throw new PreviewBudgetError("Preview requires a publication limit of 1–6 and an exact UTC expiry");
  }
  if (deadline <= Date.now() || deadline > Date.now() + 86_400_000) {
    throw new PreviewBudgetError("Preview expiry must be in the next 24 hours");
  }
  return { limit, deadline: Math.floor(deadline / 1000) };
}

// One atomic Redis operation admits a unique coordinator or sole worker. The
// server clock bounds activation; mismatched deployments cannot raise/reset the
// original allowance. No TTL: expiry stops admission but retains spent permits.
// Redis errors, lost responses and corrupt state all fail closed.
export const reservePreviewPublicationLua = `
local now = tonumber(redis.call("TIME")[1])
local limit = tonumber(ARGV[1])
local deadline = tonumber(ARGV[2])
if not limit or limit < 1 or limit > 6 or limit ~= math.floor(limit) then return -1 end
if not deadline or deadline <= now or deadline > now + 86400 then return -2 end
local key = KEYS[1]
if redis.call("EXISTS", key) == 0 then
  redis.call("HSET", key, "limit", limit, "deadline", deadline, "spent", 0)
end
local storedLimit = tonumber(redis.call("HGET", key, "limit"))
local storedDeadline = tonumber(redis.call("HGET", key, "deadline"))
local spent = tonumber(redis.call("HGET", key, "spent"))
if storedLimit ~= limit or storedDeadline ~= deadline or not spent or spent < 0
  or spent ~= math.floor(spent) then return -3 end
if redis.call("HEXISTS", key, ARGV[3]) == 1 then return 0 end
if ARGV[4] ~= "" and redis.call("HEXISTS", key, ARGV[4]) == 0 then return -4 end
if spent >= limit then return -5 end
redis.call("HSET", key, ARGV[3], 1, "spent", spent + 1)
return 1
`;

export async function reservePreviewPublication(payload: {
  mode: "coordinator" | "worker"; jobId: string; workerIndex?: number;
}): Promise<void> {
  const config = previewBudgetConfig();
  if (!config) return;
  if (payload.mode === "worker" && payload.workerIndex !== 0) {
    throw new PreviewBudgetError("Preview permits only worker zero and no timed handoffs");
  }
  const { redis } = await import("./store/redis-client.js");
  const permit = JSON.stringify([payload.mode, payload.jobId]);
  const coordinator = payload.mode === "worker" ? JSON.stringify(["coordinator", payload.jobId]) : "";
  const result = await redis.eval<(number | string)[], number>(reservePreviewPublicationLua,
    [scopedRedisKey("qstash-smoke-budget:v1")],
    [config.limit, config.deadline, permit, coordinator]);
  if (result !== 1) throw new PreviewBudgetError("Preview publication denied: spent, expired, duplicate, or mismatched budget");
}
