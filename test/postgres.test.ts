import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memoryStore, postgresStore, schemaSql, type SqlQuery } from "../src/index.js";
import { storeContract } from "./contract.js";

/** Integration tests run against a throwaway database, e.g. the `postgres` service container in CI. */
const url = process.env.RATELIMIT_TEST_PG_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 10 }) : undefined;
const query: SqlQuery = async (text, params) => {
  if (!pool) throw new Error("no database");
  return pool.query(text, params);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (pool) await pool.query(schemaSql("rl_test.rate_limits").replace(/^/, "CREATE SCHEMA IF NOT EXISTS rl_test;\n"));
});
afterAll(async () => {
  if (pool) {
    await pool.query("DROP SCHEMA IF EXISTS rl_test CASCADE");
    await pool.end();
  }
});

storeContract(
  "postgres",
  () => ({ store: postgresStore({ query, table: "rl_test.rate_limits", fallback: memoryStore() }), advance: sleep }),
  { skip: !pool },
);

describe.skipIf(!pool)("postgresStore against a real database", () => {
  it("stores only the hashed key", async () => {
    const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
    const store = postgresStore({ query, table: "rl_test.rate_limits", hashKey });
    await store.consume("login:203.0.113.7", { window: 60, max: 5 });
    const { rows } = await query("SELECT key FROM rl_test.rate_limits WHERE key = $1", [hashKey("login:203.0.113.7")]);
    expect(rows).toHaveLength(1);
    const raw = await query("SELECT 1 FROM rl_test.rate_limits WHERE key = $1", ["login:203.0.113.7"]);
    expect(raw.rows).toHaveLength(0);
  });

  it("sweeps long-expired buckets when the dice say so", async () => {
    await query("INSERT INTO rl_test.rate_limits VALUES ('old', 1, now() - interval '2 hours')", []);
    const store = postgresStore({ query, table: "rl_test.rate_limits", random: () => 0 });
    await store.consume("trigger", { window: 60, max: 5 });
    const { rows } = await query("SELECT 1 FROM rl_test.rate_limits WHERE key = 'old'", []);
    expect(rows).toHaveLength(0);
  });

  it("reset empties the table", async () => {
    const store = postgresStore({ query, table: "rl_test.rate_limits" });
    await store.consume("x", { window: 60, max: 5 });
    await store.reset();
    const { rows } = await query("SELECT 1 FROM rl_test.rate_limits", []);
    expect(rows).toHaveLength(0);
  });
});

describe("postgresStore without a database", () => {
  const broken: SqlQuery = () => Promise.reject(new Error("connection refused"));

  it("falls back to the fallback store and reports each failure", async () => {
    const onError = vi.fn();
    const fallback = memoryStore();
    const store = postgresStore({ query: broken, fallback, onError });
    expect((await store.consume("k", { window: 60, max: 1 })).allowed).toBe(true);
    expect((await store.consume("k", { window: 60, max: 1 })).allowed).toBe(false);
    const token = await store.claim("lease", { window: 60, max: 1 });
    expect(token).not.toBeNull();
    expect(await store.claim("lease", { window: 60, max: 1 })).toBeNull();
    await store.release("lease", token ?? undefined);
    expect(await fallback.claim("lease", { window: 60, max: 1 })).not.toBeNull();
    await store.refund("k");
    expect(onError.mock.calls.map(([op]) => op as string)).toEqual([
      "consume",
      "consume",
      "claim",
      "claim",
      "release",
      "refund",
    ]);
  });

  it("does not swallow reset errors", async () => {
    await expect(postgresStore({ query: broken, onError: () => undefined }).reset()).rejects.toThrow(
      "connection refused",
    );
  });

  it("uses safe, quoted table names and rejects anything else", () => {
    expect(schemaSql()).toContain('CREATE TABLE IF NOT EXISTS "rate_limits"');
    expect(schemaSql("auth.limits")).toContain('"auth"."limits"');
    expect(schemaSql("auth.limits")).toContain('"auth_limits_reset_at_idx"');
    for (const bad of ["rate limits", "x; DROP TABLE users", "a.b.c", '"q"', ""]) {
      expect(() => postgresStore({ query: broken, table: bad })).toThrow("invalid table name");
    }
  });

  it("sends parameterized statements with the hashed key", async () => {
    const calls: [string, unknown[]][] = [];
    const spy: SqlQuery = (text, params) => {
      calls.push([text, params]);
      return Promise.resolve({ rows: [{ count: 6, retry_after: 17 }] });
    };
    const store = postgresStore({ query: spy, hashKey: (k) => `h(${k})`, random: () => 1 });
    expect(await store.consume("k", { window: 60, max: 5 })).toEqual({ allowed: false, retryAfter: 17 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(["h(k)", 60]);
    expect(store.name).toBe("postgres");
  });
});
