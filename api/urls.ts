export default async function handler(...args: unknown[]) {
  const mod = await import("../apps/api/api/urls.js");
  return mod.default(...args);
}
