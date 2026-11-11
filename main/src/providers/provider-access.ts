export class ProviderRequestStoppedError extends Error {
  constructor(message = "Provider requests stopped.") {
    super(message);
    this.name = "ProviderRequestStoppedError";
  }
}

/** An access boundary, not a transient transport failure. Never retry or infer around it. */
export class ProviderAccessBlockedError extends ProviderRequestStoppedError {
  constructor(readonly provider = "vivino-direct") {
    super("The wine data provider blocked automated access. Analysis stopped.");
    this.name = "ProviderAccessBlockedError";
  }
}

export type ProviderRequestGuard = (() => Promise<void> | void) & {
  /** Latch the boundary synchronously, before async error propagation unwinds. */
  onAccessBlocked?: (error: ProviderAccessBlockedError) => void;
};

export function assertProviderAccessAllowed(input: {
  status?: number | undefined;
  headers?: Record<string, string> | undefined;
  hasChallenge?: boolean | undefined;
  onAccessBlocked?: ((error: ProviderAccessBlockedError) => void) | undefined;
}): void {
  const action = Object.entries(input.headers ?? {}).find(([name]) => name.toLowerCase() === "x-amzn-waf-action")?.[1] ?? "";
  if (input.hasChallenge || input.status === 401 || input.status === 403 || /challenge|captcha/i.test(action)) {
    const error = new ProviderAccessBlockedError();
    input.onAccessBlocked?.(error);
    throw error;
  }
}

// Do not classify an ordinary AWS WAF integration script as an interstitial.
// These are conservative observed markers, not an exhaustive challenge detector.
export const PROVIDER_CHALLENGE_SCRIPT_PATTERN = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\bchallenge\.js(?:[?"']|$)[^>]*>/i;
export const PROVIDER_CHALLENGE_TITLE_PATTERN = /\b(?:access\s+denied|captcha|security\s+check|verify\s+(?:that\s+)?you\s+are\s+human)\b/i;

export function isProviderChallengeTitle(title: string | undefined): boolean {
  return PROVIDER_CHALLENGE_TITLE_PATTERN.test(title ?? "");
}

export function isProviderChallengeDocument(body: string): boolean {
  const title = body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  return isProviderChallengeTitle(title) || PROVIDER_CHALLENGE_SCRIPT_PATTERN.test(body);
}

export async function assertProviderResponseAllowed(response: Response, onAccessBlocked?: (error: ProviderAccessBlockedError) => void): Promise<void> {
  assertProviderAccessAllowed({ onAccessBlocked, status: response.status, headers: { "x-amzn-waf-action": response.headers.get("x-amzn-waf-action") ?? "" } });
  // Inspect the existing body even when an interstitial is mislabeled as JSON
  // or omits Content-Type. Cloning does not issue another provider request.
  const body = await response.clone().text();
  assertProviderAccessAllowed({ onAccessBlocked, hasChallenge: isProviderChallengeDocument(body) });
}
