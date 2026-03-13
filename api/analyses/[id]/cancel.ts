export default async function handler(...args: unknown[]) {
  const mod = await import("../../../apps/api/api/analyses/[id]/cancel.js");
  return mod.default(...args);
}
