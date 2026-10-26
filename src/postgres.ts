import { memoryStore } from "./memory.js";
import { allowed, denied, logError, type ErrorHandler, type RateLimitStore } from "./types.js";

/**
 * The one query function the store needs. node-postgres `Pool#query` fits as is (`pool.query.bind(pool)`), and so does
 * a thin wrapper over postgres.js, Drizzle, Kysely or Neon.
 */
export type SqlQuery = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions {
  /** Runs one parameterized statement. */
  readonly query: SqlQuery;
  /** Table name (optionally schema-qualified, e.g. `"auth.rate_limits"`). Default `"rate_limits"`. */
  readonly table?: string;
  /**
   * Maps a key before it reaches the table, e.g. an HMAC so raw IPs or emails are never stored. Default: identity.
   */
  readonly hashKey?: (key: string) => string;
  /** Used when the database call fails, so a blip degrades the limit instead of failing every request. */
  readonly fallback?: RateLimitStore;
  /** Chance (0..1) that a `consume` also deletes buckets that expired over an hour ago. Default 0.005. */
  readonly sweepProbability?: number;
  /** Called when a statement fails. Default: one `console.error` line. */
  readonly onError?: ErrorHandler;
  /** Random source for the sweep. Inject in tests. Default `Math.random`. */
  readonly random?: () => number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function quoteTable(table: string): string {
  if (!IDENT.test(table)) throw new Error(`invalid table name: ${table}`);
  return table
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

/**
 * DDL for the table the Postgres store uses. Run it in a migration.
 *
 * @example
 * await pool.query(schemaSql());
 */
export function schemaSql(table = "rate_limits"): string {
  const t = quoteTable(table);
  const index = `"${table.replace(".", "_")}_reset_at_idx"`;
  return `CREATE TABLE IF NOT EXISTS ${t} (
  "key" text PRIMARY KEY,
  "count" integer NOT NULL,
  "reset_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${index} ON ${t} ("reset_at");`;
}

/**
 * A store on a Postgres table, shared by every instance of your app. Each `consume` is one statement: insert the
 * bucket or bump it, restarting the window when it has expired. The row lock taken by `ON CONFLICT DO UPDATE`
 * serializes concurrent hits on the same key, so no hit is lost and nothing is double-counted.
 *
 * Leases (`claim`) use the same table: the bucket's `reset_at` is the token, so `release(key, token)` only deletes the
 * row if it still belongs to that holder.
 *
 * @example
 * import pg from "pg";
 * const pool = new pg.Pool();
 * const store = postgresStore({ query: (text, params) => pool.query(text, params) });
 */
export function postgresStore(options: PostgresStoreOptions): RateLimitStore {
  const t = quoteTable(options.table ?? "rate_limits");
  const { query } = options;
  const hashKey = options.hashKey ?? ((key: string) => key);
  const fallback = options.fallback ?? memoryStore();
  const sweepProbability = options.sweepProbability ?? 0.005;
  const onError = options.onError ?? logError;
  const random = options.random ?? Math.random;

  const consumeSql = `
INSERT INTO ${t} AS r (key, count, reset_at)
VALUES ($1, 1, now() + make_interval(secs => $2))
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
  reset_at = CASE WHEN r.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE r.reset_at END
RETURNING count, greatest(1, ceil(extract(epoch FROM (reset_at - now()))))::int AS retry_after`;

  const claimSql = `
INSERT INTO ${t} AS r (key, count, reset_at)
VALUES ($1, 1, now() + make_interval(secs => $2))
ON CONFLICT (key) DO UPDATE SET count = 1, reset_at = now() + make_interval(secs => $2)
WHERE r.reset_at <= now()
RETURNING reset_at::text AS token`;

  return {
    name: "postgres",
    async consume(key, rule) {
      try {
        const { rows } = await query(consumeSql, [hashKey(key), rule.window]);
        const row = rows[0] as { count: unknown; retry_after: unknown } | undefined;
        if (random() < sweepProbability) {
          await query(`DELETE FROM ${t} WHERE reset_at < now() - interval '1 hour'`, []).catch(() => undefined);
        }
        return Number(row?.count ?? 1) <= rule.max ? allowed : denied(Number(row?.retry_after ?? rule.window));
      } catch (e) {
        onError("consume", e);
        return fallback.consume(key, rule);
      }
    },
    async claim(key, rule) {
      try {
        const { rows } = await query(claimSql, [hashKey(key), rule.window]);
        const row = rows[0] as { token: unknown } | undefined;
        return typeof row?.token === "string" ? row.token : null;
      } catch (e) {
        onError("claim", e);
        return fallback.claim(key, rule);
      }
    },
    async release(key, token) {
      await query(`DELETE FROM ${t} WHERE key = $1 AND ($2::text IS NULL OR reset_at::text = $2)`, [
        hashKey(key),
        token ?? null,
      ]).catch((e: unknown) => {
        onError("release", e);
      });
      await fallback.release(key, token);
    },
    async refund(key) {
      await query(`UPDATE ${t} SET count = count - 1 WHERE key = $1 AND count > 0 AND reset_at > now()`, [
        hashKey(key),
      ]).catch((e: unknown) => {
        onError("refund", e);
      });
      await fallback.refund(key);
    },
    async reset() {
      await query(`DELETE FROM ${t}`, []);
      await fallback.reset();
    },
  };
}
