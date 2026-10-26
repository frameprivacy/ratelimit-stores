import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/index.js";
import { storeContract } from "./contract.js";

storeContract("memory", () => {
  const clock = { now: 1_000_000 };
  return {
    store: memoryStore({ now: () => clock.now }),
    advance: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
});

describe("memoryStore", () => {
  it("reports retryAfter rounded up to whole seconds", async () => {
    const clock = { now: 0 };
    const store = memoryStore({ now: () => clock.now });
    await store.consume("k", { window: 60, max: 1 });
    clock.now = 30_500;
    expect(await store.consume("k", { window: 60, max: 1 })).toEqual({ allowed: false, retryAfter: 30 });
    clock.now = 59_999;
    expect((await store.consume("k", { window: 60, max: 1 })).retryAfter).toBe(1);
  });

  it("sweeps expired buckets once it grows past the threshold", async () => {
    const clock = { now: 0 };
    const store = memoryStore({ now: () => clock.now, sweepAbove: 2 });
    await store.consume("a", { window: 1, max: 1 });
    await store.consume("b", { window: 1, max: 1 });
    clock.now = 5_000;
    await store.consume("c", { window: 1, max: 1 });
    // "a" was swept and starts over rather than inheriting a stale count
    expect((await store.consume("a", { window: 1, max: 1 })).allowed).toBe(true);
  });

  it("reset forgets everything", async () => {
    const store = memoryStore();
    await store.consume("k", { window: 60, max: 1 });
    await store.reset();
    expect((await store.consume("k", { window: 60, max: 1 })).allowed).toBe(true);
    expect(store.name).toBe("memory");
  });

  it("does not refund into an expired window", async () => {
    const clock = { now: 0 };
    const store = memoryStore({ now: () => clock.now });
    await store.consume("k", { window: 1, max: 1 });
    clock.now = 2_000;
    await store.refund("k");
    await store.consume("k", { window: 1, max: 1 });
    expect((await store.consume("k", { window: 1, max: 1 })).allowed).toBe(false);
  });
});
