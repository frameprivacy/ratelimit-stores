import { allowed, denied, logError, type ErrorHandler, type RateLimitStore } from "./types.js";

/** Options for {@link upstashStore}. */
export interface UpstashStoreOptions {
  /** REST URL of the database, e.g. `https://<name>.upstash.io`. */
  readonly url: string;
  /** REST token. Pass it from your environment; never hard-code it. */
  readonly token: string;
  /** Prefix for every Redis key. Default `"rl:"`. */
  readonly prefix?: string;
  /** `fetch` implementation. Default the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Called when a request fails. Default: one `console.error` line. */
  readonly onError?: ErrorHandler;
}

interface PipelineItem {
  result?: unknown;
  error?: string;
}

const RELEASE_IF_OWNER =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const DECR_IF_POSITIVE =
  "if (tonumber(redis.call('get', KEYS[1]) or '0') or 0) > 0 then return redis.call('decr', KEYS[1]) else return 0 end";

function parsePipeline(body: unknown, expected: number): PipelineItem[] {
  if (!Array.isArray(body) || body.length !== expected) throw new Error("unexpected upstash response");
  return body.map((item: unknown): PipelineItem => {
    if (typeof item !== "object" || item === null) throw new Error("unexpected upstash response");
    const { result, error } = item as Record<string, unknown>;
    if (typeof error === "string") throw new Error(`upstash: ${error}`);
    return { result };
  });
}

/**
 * A store on Upstash Redis via its REST pipeline API. No SDK, works anywhere `fetch` does (serverless, edge).
 *
 * `consume` is `INCR` + `EXPIRE NX` + `TTL` in one pipeline. It **fails open** on an outage (the hit is allowed and
 * `onError` is called), so a Redis blip never locks every user out; alert on the error.
 *
 * @example
 * const store = upstashStore({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
 */
export function upstashStore(options: UpstashStoreOptions): RateLimitStore {
  const base = options.url.replace(/\/+$/, "");
  const prefix = options.prefix ?? "rl:";
  const fetchImpl = options.fetch ?? fetch;
  const onError = options.onError ?? logError;

  const call = async (commands: (string | number)[][]): Promise<PipelineItem[]> => {
    const res = await fetchImpl(`${base}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`upstash HTTP ${String(res.status)}`);
    return parsePipeline(await res.json(), commands.length);
  };

  return {
    name: "upstash",
    async consume(key, { window, max }) {
      const k = prefix + key;
      try {
        const [incr, , ttl] = await call([
          ["INCR", k],
          ["EXPIRE", k, window, "NX"],
          ["TTL", k],
        ]);
        const count = Number(incr?.result ?? 0);
        const left = Number(ttl?.result ?? window);
        return count <= max ? allowed : denied(left > 0 ? left : window);
      } catch (e) {
        onError("consume", e);
        return allowed;
      }
    },
    async claim(key, { window }) {
      const token = `${String(Date.now())}:${Math.random().toString(36).slice(2)}`;
      try {
        const [set] = await call([["SET", prefix + key, token, "NX", "EX", window]]);
        return set?.result === "OK" ? token : null;
      } catch (e) {
        onError("claim", e);
        return null;
      }
    },
    async release(key, token) {
      const k = prefix + key;
      await call(token === undefined ? [["DEL", k]] : [["EVAL", RELEASE_IF_OWNER, 1, k, token]]).catch((e: unknown) => {
        onError("release", e);
      });
    },
    async refund(key) {
      await call([["EVAL", DECR_IF_POSITIVE, 1, prefix + key]]).catch((e: unknown) => {
        onError("refund", e);
      });
    },
    reset() {
      // Buckets expire on their own; use a dedicated database or prefix for tests.
      return Promise.resolve();
    },
  };
}
