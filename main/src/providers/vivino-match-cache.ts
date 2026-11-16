import { createHash } from "node:crypto";
import type { WineCandidate } from "@wine-rec/contracts";
import { scopedRedisKey } from "../deployment-scope.js";

// Vivino's search does not always return the same wines for the same query
// (its "include wines you can't buy" listing is honoured only some of the
// time), so two runs of one menu could match different bottles. Remembering
// each confident match makes repeat lookups of the same menu row identical,
// and skips Vivino entirely for rows it has already matched.
//
// Only matches are remembered, never misses: a miss may just be an unlucky
// search, and should get a fresh chance next time. Bump the version whenever
// matching rules change so older decisions are not reused.
export const VIVINO_MATCH_CACHE_VERSION = 1;
const TTL_SECONDS = 30 * 24 * 60 * 60;

export function vivinoMatchCacheKey(candidate: Pick<WineCandidate, "rawText" | "menuSection" | "varietal" | "vintage">): string {
  const normalise = (value: string | null | undefined) => (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const identity = JSON.stringify([
    VIVINO_MATCH_CACHE_VERSION,
    normalise(candidate.rawText),
    normalise(candidate.menuSection),
    normalise(candidate.varietal),
    candidate.vintage ?? null,
  ]);
  return scopedRedisKey(`vivino-match:v${VIVINO_MATCH_CACHE_VERSION}:${createHash("sha256").update(identity).digest("hex")}`);
}

interface CacheClient {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options: { ex: number }): Promise<unknown>;
}

let clientPromise: Promise<CacheClient | null> | null = null;
async function cacheClient(): Promise<CacheClient | null> {
  if (process.env.VIVINO_MATCH_CACHE === "off") return null;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  clientPromise ??= import("../store/redis-client.js")
    .then(module => module.redis as unknown as CacheClient)
    .catch(() => null);
  return clientPromise;
}

export async function readVivinoMatch<T>(candidate: WineCandidate): Promise<T | null> {
  try {
    const client = await cacheClient();
    return client ? await client.get<T>(vivinoMatchCacheKey(candidate)) : null;
  } catch (error) {
    console.log("[vivino-direct] Match memory unavailable: %s", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function rememberVivinoMatch(candidate: WineCandidate, value: unknown): Promise<void> {
  try {
    const client = await cacheClient();
    if (client) await client.set(vivinoMatchCacheKey(candidate), value, { ex: TTL_SECONDS });
  } catch (error) {
    console.log("[vivino-direct] Could not remember match: %s", error instanceof Error ? error.message : String(error));
  }
}
