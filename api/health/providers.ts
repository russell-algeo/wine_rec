export default async function handler(...args: unknown[]) {
  const mod = await import("../../apps/api/api/health/providers.js");
  return mod.default(...args);
}
