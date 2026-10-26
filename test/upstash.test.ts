import { describe, expect, it, vi } from "vitest";
import { upstashStore } from "../src/index.js";
import { storeContract } from "./contract.js";
import { fakeUpstash } from "./fake-upstash.js";

storeContract("upstash (fake REST server)", () => {
  const clock = { now: 1_000_000 };
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const fake = fakeUpstash(clock);
  return {
    store: upstashStore({ url: "https://example.upstash.io/", token: "test-token", fetch: fake.fetch }),
    advance: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
});

describe("upstashStore", () => {
  it("sends one authenticated pipeline per consume, with the prefix", async () => {
    const fake = fakeUpstash({ now: 0 });
    const store = upstashStore({
      url: "https://example.upstash.io//",
      token: "t0k",
      prefix: "app:",
      fetch: fake.fetch,
    });
    await store.consume("login:1", { window: 60, max: 5 });
    expect(fake.requests).toEqual([
      {
        url: "https://example.upstash.io/pipeline",
        auth: "Bearer t0k",
        body: [
          ["INCR", "app:login:1"],
          ["EXPIRE", "app:login:1", 60, "NX"],
          ["TTL", "app:login:1"],
        ],
      },
    ]);
  });

  it("fails open on HTTP errors and reports them", async () => {
    const onError = vi.fn();
    const store = upstashStore({
      url: "https://example.upstash.io",
      token: "t",
      onError,
      fetch: () => Promise.resolve(new Response("nope", { status: 503 })),
    });
    expect(await store.consume("k", { window: 60, max: 1 })).toEqual({ allowed: true, retryAfter: null });
    expect(await store.claim("k", { window: 60, max: 1 })).toBeNull();
    await store.release("k", "tok");
    await store.refund("k");
    expect(onError.mock.calls.map(([op]) => op as string)).toEqual(["consume", "claim", "release", "refund"]);
    expect(String(onError.mock.calls[0]?.[1])).toContain("upstash HTTP 503");
  });

  it("treats Redis errors and malformed bodies as failures", async () => {
    const onError = vi.fn();
    const respond = (body: unknown) => () => Promise.resolve(Response.json(body));
    const withBody = (body: unknown) =>
      upstashStore({ url: "https://example.upstash.io", token: "t", onError, fetch: respond(body) });
    await withBody([{ error: "WRONGTYPE" }, {}, {}]).consume("k", { window: 1, max: 1 });
    await withBody({ not: "an array" }).consume("k", { window: 1, max: 1 });
    await withBody([1, 2, 3]).consume("k", { window: 1, max: 1 });
    await withBody([]).consume("k", { window: 1, max: 1 });
    expect(onError).toHaveBeenCalledTimes(4);
    expect(String(onError.mock.calls[0]?.[1])).toContain("WRONGTYPE");
  });

  it("falls back to the window length when TTL is missing", async () => {
    const store = upstashStore({
      url: "https://example.upstash.io",
      token: "t",
      fetch: () => Promise.resolve(Response.json([{ result: 9 }, { result: 0 }, { result: -1 }])),
    });
    expect(await store.consume("k", { window: 42, max: 1 })).toEqual({ allowed: false, retryAfter: 42 });
  });

  it("logs to console.error by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = upstashStore({
      url: "https://x.example",
      token: "t",
      fetch: () => Promise.reject(new Error("down")),
    });
    await store.consume("k", { window: 1, max: 1 });
    expect(spy).toHaveBeenCalledWith("[ratelimit-stores] consume failed:", "down");
    spy.mockRestore();
  });

  it("reset is a no-op", async () => {
    const fake = fakeUpstash({ now: 0 });
    const store = upstashStore({ url: "https://example.upstash.io", token: "t", fetch: fake.fetch });
    await store.reset();
    expect(fake.requests).toHaveLength(0);
    expect(store.name).toBe("upstash");
  });
});
