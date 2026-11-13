/**
 * Operator tool: mark one job whose delivery was rejected before the worker
 * started (and is now in the QStash DLQ) as failed. Dry run by default.
 *
 *   WINE_REC_NAMESPACE=preview:shared UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... QSTASH_TOKEN=... \
 *   npx tsx scripts/reconcile-stalled-delivery.ts --job <jobId> --message <qstashMessageId> [--apply]
 *
 * It never replays the delivery, deletes the DLQ entry or Blob, or extends the TTL.
 */
import { Redis } from "@upstash/redis";
import { Client } from "@upstash/qstash";
import { planStalledDeliveryRecovery, RECONCILE_STALLED_JOB_LUA, type StallSnapshot } from "../src/store/stall-recovery.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const jobId = arg("job");
  const messageId = arg("message");
  const apply = process.argv.includes("--apply");
  const namespace = process.env.WINE_REC_NAMESPACE ?? "";
  if (!jobId || !messageId) throw new Error("--job and --message are required");
  if (namespace && !/^preview:[a-z0-9][a-z0-9-]{0,47}$/.test(namespace)) throw new Error("invalid WINE_REC_NAMESPACE");
  const key = (suffix: string) => (namespace ? `${namespace}:` : "") + `job:${jobId}${suffix}`;

  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN!, automaticDeserialization: false });
  const jobRaw = await redis.get<string>(key(""));
  const job = jobRaw ? JSON.parse(jobRaw) as { workerCount?: number; candidates?: Array<{ id: string }> } : null;
  const workerCount = Number(job?.workerCount ?? 0);
  const workers = await Promise.all(Array.from({ length: workerCount }, (_, i) => redis.get<string>(key(`:worker:${i}`)).then((raw) => ({ raw }))));
  const candidateWork = await Promise.all((job?.candidates ?? []).map((c) => redis.get<string>(key(`:candidate:${c.id}`)).then((raw) => ({ raw }))));
  const snapshot: StallSnapshot = {
    jobRaw,
    workers,
    candidateWork,
    leaseCount: Number(await redis.zcard(key(":candidate-leases"))),
    recommendationCount: Number(await redis.llen(key(":recommendations"))),
    progressRaw: await redis.get<string>(key(":progress")),
  };

  const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
  const { messages } = await qstash.dlq.listMessages({ filter: { messageId } });
  const hit = messages.find((m) => m.messageId === messageId);
  const plan = planStalledDeliveryRecovery({
    jobId, namespace, expectedMessageId: messageId, snapshot,
    dlq: hit ? { messageId: hit.messageId, dlqId: hit.dlqId, url: hit.url, body: hit.body, responseStatus: hit.responseStatus } : null,
    now: new Date().toISOString(),
  });
  if (!plan.ok) {
    console.log(`REFUSED: ${plan.reason}`);
    process.exitCode = 2;
    return;
  }
  console.log(`PLAN: ${plan.summary}`);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }
  const result = await redis.eval(RECONCILE_STALLED_JOB_LUA, [key("")], [plan.expectedRaw, plan.nextRaw]);
  console.log(`RESULT: ${String(result)}`);
  if (result !== "applied") process.exitCode = 3;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
