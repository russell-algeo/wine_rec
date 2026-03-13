export default async function handler(...args: unknown[]) {
  const mod = await import("../apps/api/api/worker.js");
  return mod.default(...args);
}
