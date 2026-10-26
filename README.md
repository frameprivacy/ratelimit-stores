# ratelimit-stores

[![CI](https://github.com/frameprivacy/ratelimit-stores/actions/workflows/ci.yml/badge.svg)](https://github.com/frameprivacy/ratelimit-stores/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Atomic fixed-window rate limiting and single-holder leases, on Postgres, Upstash Redis, or memory, behind one tiny interface.**

Zero runtime dependencies. Works with any Postgres client. Structurally compatible with Better Auth's
`rateLimit.customStorage`.

## Why this exists

Rate limiting looks like five lines until it runs on more than one server:

- A `SELECT count` followed by an `UPDATE` lets a burst of concurrent requests all read the old count and all get in.
- An in-memory `Map` limits each serverless instance separately, so the real limit is "max × however many instances
  are warm".
- "Only one of these at a time" (one AI turn per user, one export job per account) needs a lock that expires on its
  own if the holder crashes, and that a slow, expired holder cannot release out from under the next one.

This package is the version of that code you write once and stop touching: every hit is **one atomic statement**,
leases are **token-checked**, and the shared stores **degrade gracefully** when their backend has a blip.

## Install

```sh
npm install ratelimit-stores
```

Requires Node.js 22+ (or any runtime with `fetch` for the Upstash store). ESM only.

## Usage

```ts
import pg from "pg";
import { postgresStore, schemaSql } from "ratelimit-stores";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(schemaSql()); // or put it in a migration

const limits = postgresStore({ query: (text, params) => pool.query(text, params) });

const verdict = await limits.consume(`signin:${ip}`, { window: 60, max: 5 });
if (!verdict.allowed) {
  return new Response("Too many attempts", { status: 429, headers: { "Retry-After": String(verdict.retryAfter) } });
}
```

### Leases: "one at a time, but never stuck"

```ts
const token = await limits.claim(`assistant-turn:${userId}`, { window: 120 });
if (!token) return busy();
try {
  await runTurn();
} finally {
  // Only releases if this caller still holds it. If the lease expired and someone else claimed it, this is a no-op.
  await limits.release(`assistant-turn:${userId}`, token);
}
```

### Refunds: don't charge for attempts that never happened

```ts
const v = await limits.consume(`export:${userId}`, { window: 3600, max: 3 });
if (!v.allowed) return tooMany(v.retryAfter);
if (!(await queueHasCapacity())) {
  await limits.refund(`export:${userId}`); // the user never got an export, so give the hit back
  return tryLater();
}
```

### With Better Auth

```ts
import { betterAuth } from "better-auth";
import { upstashStore } from "ratelimit-stores";

const store = upstashStore({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });

export const auth = betterAuth({
  rateLimit: { enabled: true, customStorage: store },
});
```

### Keep raw IPs and emails out of the table

```ts
import { createHmac } from "node:crypto";

const limits = postgresStore({
  query: (text, params) => pool.query(text, params),
  hashKey: (key) => createHmac("sha256", process.env.RATE_LIMIT_KEY!).update(key).digest("hex"),
});
```

## API

All three factories return the same `RateLimitStore`:

| Method                          | Description                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `consume(key, { window, max })` | Records one hit and returns `{ allowed, retryAfter }` (`retryAfter` in seconds, `null` when allowed). Atomic. |
| `claim(key, { window })`        | Takes a single-holder lease for `window` seconds. Returns a token, or `null` if held.                         |
| `release(key, token?)`          | Drops the bucket/lease. With a token, only if that holder still owns it.                                      |
| `refund(key)`                   | Gives back one hit from the current window (never below zero, never into an expired window).                  |
| `reset()`                       | Forgets every bucket. For tests.                                                                              |
| `name`                          | `"postgres"`, `"upstash"` or `"memory"`.                                                                      |

### `postgresStore(options)`

| Option             | Default         | Description                                                                                                    |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `query`            | (required)      | `(text, params) => Promise<{ rows }>`. node-postgres, postgres.js, Drizzle, Kysely or Neon wrappers all fit.   |
| `table`            | `"rate_limits"` | Optionally schema-qualified. Validated and quoted; anything else throws.                                       |
| `hashKey`          | identity        | Transform keys before storage (e.g. HMAC).                                                                     |
| `fallback`         | `memoryStore()` | Used when a statement fails, so a database blip degrades the limit to per-process instead of failing requests. |
| `sweepProbability` | `0.005`         | Chance per `consume` of deleting buckets that expired over an hour ago.                                        |
| `onError`          | `console.error` | `(operation, error) => void`, for logging and alerts.                                                          |

`schemaSql(table?)` returns the `CREATE TABLE` / `CREATE INDEX` statements.

### `upstashStore(options)`

| Option    | Default         | Description                                 |
| --------- | --------------- | ------------------------------------------- |
| `url`     | (required)      | Upstash REST URL.                           |
| `token`   | (required)      | Upstash REST token (from your environment). |
| `prefix`  | `"rl:"`         | Prefix for every Redis key.                 |
| `fetch`   | global `fetch`  | Custom `fetch` (tests, proxies).            |
| `onError` | `console.error` | `(operation, error) => void`.               |

Uses the REST pipeline API directly: no SDK, works on serverless and edge runtimes.

### `memoryStore(options?)`

| Option       | Default    | Description                                             |
| ------------ | ---------- | ------------------------------------------------------- |
| `now`        | `Date.now` | Clock in milliseconds. Inject a fake one in tests.      |
| `sweepAbove` | `50000`    | Sweep expired buckets once the map is larger than this. |

## How it works

**Postgres `consume`** is a single upsert. `ON CONFLICT DO UPDATE` takes a row lock, so concurrent hits on the same
key serialize and none is lost; an expired window restarts in place:

```sql
INSERT INTO rate_limits AS r (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
ON CONFLICT (key) DO UPDATE SET
  count    = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
  reset_at = CASE WHEN r.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE r.reset_at END
RETURNING count, ...
```

**Postgres `claim`** is the same upsert with `WHERE r.reset_at <= now()`, so it only succeeds when the key is free
or expired; the new `reset_at` doubles as the holder's token.

**Upstash `consume`** pipelines `INCR`, `EXPIRE … NX` and `TTL`. **`claim`** is `SET NX EX`, and token-checked
`release` / non-negative `refund` are small Lua scripts so each is atomic on the server.

The test suite runs one shared behavioural contract (limits, window reset, refunds, 25 concurrent hits counted
exactly once, one winner among 10 concurrent claims, stale-holder release) against all three stores, with Postgres
tested against a real database in CI.

## Limitations

- **Fixed windows, not sliding.** A client can make up to `2 × max` requests across a window boundary. That is
  usually fine for abuse protection; use a sliding-window or token-bucket limiter if you need smooth rates.
- **Different failure policies by design.** Upstash **fails open** (a Redis outage allows the hit and calls
  `onError`); Postgres **falls back to per-process memory**. Alert on `onError` either way.
- **Don't mix `consume` and `claim` on the same key.** Use separate key prefixes for counters and leases.
- **Upstash `reset()` is a no-op.** Use a dedicated database or prefix for tests.
- Leases are advisory and time-bounded: if work can outlive `window`, pick a longer window or re-claim.
- Postgres keys are stored as given unless you pass `hashKey`.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
# Postgres integration tests run when a throwaway database URL is provided:
RATELIMIT_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/ratelimit_test npm test
```

## License

[MIT](LICENSE) © 2026 Frame
