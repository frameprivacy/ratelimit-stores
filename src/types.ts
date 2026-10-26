/** A fixed-window limit: at most `max` hits per `window` seconds. */
export interface Rule {
  /** Window length in seconds. */
  readonly window: number;
  /** Hits allowed per window. */
  readonly max: number;
}

/** Result of {@link RateLimitStore.consume}. `retryAfter` is in seconds, or `null` when allowed. */
export interface Verdict {
  readonly allowed: boolean;
  readonly retryAfter: number | null;
}

/** Called when a backend call fails. The store has already degraded gracefully; this is for logging and alerting. */
export type ErrorHandler = (operation: "consume" | "claim" | "release" | "refund", error: unknown) => void;

/**
 * A rate-limit backend. Every method is safe to call concurrently from many processes (for the shared backends).
 *
 * The shape is structurally compatible with Better Auth's `rateLimit.customStorage`, so a store can be passed there
 * directly.
 */
export interface RateLimitStore {
  /** Backend name, for logs and diagnostics. */
  readonly name: string;
  /**
   * Records one hit against `key` and reports whether it is within `rule`, in a single atomic step (no separate
   * read-then-write, so concurrent requests cannot all slip past a stale count).
   */
  consume(key: string, rule: Rule): Promise<Verdict>;
  /**
   * Takes a single-holder lease on `key` for `rule.window` seconds. Returns an opaque token, or `null` if someone else
   * holds it. The lease expires on its own, so a crashed holder never blocks the key forever.
   */
  claim(key: string, rule: Pick<Rule, "window">): Promise<string | null>;
  /**
   * Drops the bucket or lease for `key`. With a `token`, only if that holder still owns it, so a slow holder whose
   * lease expired and was re-claimed cannot release the new holder's lease.
   */
  release(key: string, token?: string): Promise<void>;
  /** Gives back one hit taken by `consume` in the current window (for attempts that never reached the limited thing). */
  refund(key: string): Promise<void>;
  /** Forgets every bucket. Meant for tests. */
  reset(): Promise<void>;
}

/** Default error handler: one `console.error` line per failure. */
export const logError: ErrorHandler = (operation, error) => {
  console.error(`[ratelimit-stores] ${operation} failed:`, error instanceof Error ? error.message : error);
};

export const allowed: Verdict = Object.freeze({ allowed: true, retryAfter: null });
export const denied = (retryAfter: number): Verdict => ({ allowed: false, retryAfter });
