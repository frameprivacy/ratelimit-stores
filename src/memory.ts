import { allowed, denied, type RateLimitStore } from "./types.js";

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** Clock in milliseconds. Inject a fake one in tests. Default `Date.now`. */
  readonly now?: () => number;
  /** When the map grows past this many buckets, expired ones are swept. Default 50,000. */
  readonly sweepAbove?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  token?: string;
}

/**
 * An in-process store. Exact and fast, but per process: use it for tests, single-instance apps, and as the fallback
 * for the shared stores.
 *
 * @example
 * const store = memoryStore();
 * const { allowed } = await store.consume(`login:${ip}`, { window: 60, max: 5 });
 */
export function memoryStore(options: MemoryStoreOptions = {}): RateLimitStore {
  const now = options.now ?? Date.now;
  const sweepAbove = options.sweepAbove ?? 50_000;
  const buckets = new Map<string, Bucket>();
  let seq = 0;

  return {
    name: "memory",
    consume(key, { window, max }) {
      const t = now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        b = { count: 0, resetAt: t + window * 1000 };
        buckets.set(key, b);
      }
      b.count += 1;
      if (buckets.size > sweepAbove) for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
      return Promise.resolve(b.count <= max ? allowed : denied(Math.ceil((b.resetAt - t) / 1000)));
    },
    claim(key, { window }) {
      const t = now();
      const b = buckets.get(key);
      if (b && b.resetAt > t) return Promise.resolve(null);
      seq += 1;
      const token = `${String(t)}:${String(seq)}`;
      buckets.set(key, { count: 1, resetAt: t + window * 1000, token });
      return Promise.resolve(token);
    },
    release(key, token) {
      const b = buckets.get(key);
      if (b && (token === undefined || b.token === token)) buckets.delete(key);
      return Promise.resolve();
    },
    refund(key) {
      const b = buckets.get(key);
      if (b && b.resetAt > now() && b.count > 0) b.count -= 1;
      return Promise.resolve();
    },
    reset() {
      buckets.clear();
      return Promise.resolve();
    },
  };
}
