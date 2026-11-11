// Namespaces prevent accidental collisions. They are NOT an access-control
// boundary when Preview and Production share an Upstash full-access token.
export function deploymentScope(env: NodeJS.ProcessEnv = process.env) {
  const namespace = env.WINE_REC_NAMESPACE ?? "";
  if (namespace && !/^preview:[a-z0-9][a-z0-9-]{0,47}$/.test(namespace)) {
    throw new Error("WINE_REC_NAMESPACE must be a fixed preview:<lowercase-label> namespace");
  }
  if (env.VERCEL_ENV === "production" && namespace) throw new Error("Production must retain its legacy unprefixed namespace");
  if (env.VERCEL_ENV === "preview" && !namespace) throw new Error("Preview requires WINE_REC_NAMESPACE; refusing unprefixed shared Redis access");
  const role = env.WINE_REC_PREVIEW_ROLE;
  if (namespace && role !== "app" && role !== "worker") throw new Error("Namespaced Preview requires WINE_REC_PREVIEW_ROLE=app or worker");
  return { namespace, role: role === "worker" ? "worker" as const : "app" as const };
}

export const scope = deploymentScope();
export function scopedRedisKey(key: string): string { return scope.namespace ? `${scope.namespace}:${key}` : key; }
export function scopedAnalysisId(id: string): string {
  return scope.namespace ? `pv_${scope.namespace.slice("preview:".length)}_${id}` : id;
}
export function scopedFlowControlKey(key: string): string {
  if (!key || /[^A-Za-z0-9._-]/.test(key)) {
    throw new Error("QStash flow-control key must contain only alphanumeric, hyphen, underscore, or period characters");
  }
  // QStash rejects the colon used in Redis namespaces. The fixed namespace
  // grammar allows only lowercase alphanumerics/hyphens in the label, so this
  // wire-only representation is injective and leaves Redis/payload scope intact.
  return scope.namespace ? `preview.${scope.namespace.slice("preview:".length)}.${key}` : key;
}

export function previewDeploymentOrigin(input: string | undefined): string {
  let url: URL;
  try { url = new URL(input?.startsWith("https://") ? input : `https://${input ?? ""}`); }
  catch { throw new Error("Preview requires an immutable Vercel deployment URL"); }
  // Reject production aliases and mutable branch URLs. Syntax is not proof of
  // Preview ownership: the deployment's environment/project/SHA must also be
  // verified through Vercel metadata before configuration and fixture testing.
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== "/" || !/^[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/.test(url.hostname)
      || url.hostname.includes("-git-")) {
    throw new Error("Preview requires an immutable Vercel deployment URL");
  }
  return url.origin;
}

// Fail before job creation, upload or queue publication, not after an upload
// has already been stored. VERCEL_URL is Vercel's immutable self deployment.
if (scope.namespace) {
  previewDeploymentOrigin(process.env.VERCEL_URL);
  if (scope.role === "app") previewDeploymentOrigin(process.env.CHUNK_WORKER_BASE_URL);
}
