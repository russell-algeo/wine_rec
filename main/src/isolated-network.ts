/** Developer-only guard: source HTML may be served locally; no hosted services. */
export function assertLoopbackUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password) {
    throw new Error("Isolated mode accepts only local HTTP fixture URLs");
  }
  // Resolve localhost without DNS and reject all other hostnames.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

export function installIsolatedFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let url = assertLoopbackUrl(input instanceof Request ? input.url : String(input));
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await original(url, { ...init, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel();
      url = assertLoopbackUrl(new URL(location, url).href);
    }
    throw new Error("Too many local fixture redirects");
  };
  return () => { globalThis.fetch = original; };
}
