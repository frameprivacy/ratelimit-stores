import { describe, expect, it } from "vitest";
import type { RateLimitStore } from "../src/index.js";

export interface Harness {
  store: RateLimitStore;
  /** Moves time forward (fake clock, or a real sleep). */
  advance: (ms: number) => Promise<void>;
}

/** Behaviour every store must share. Windows are 1 second so the real-clock Postgres run stays quick. */
export function storeContract(name: string, make: () => Promise<Harness> | Harness, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`${name}: shared contract`, () => {
    const rule = { window: 1, max: 3 };
    let n = 0;
    const key = () => `contract-${String(Date.now())}-${String((n += 1))}`;

    it("allows up to max hits, then denies with a retryAfter", async () => {
      const { store } = await make();
      const k = key();
      for (let i = 0; i < 3; i++) expect(await store.consume(k, rule)).toEqual({ allowed: true, retryAfter: null });
      const v = await store.consume(k, rule);
      expect(v.allowed).toBe(false);
      expect(v.retryAfter).toBeGreaterThanOrEqual(1);
      expect(v.retryAfter).toBeLessThanOrEqual(1);
    });

    it("keeps keys independent", async () => {
      const { store } = await make();
      const a = key();
      const b = key();
      for (let i = 0; i < 3; i++) await store.consume(a, rule);
      expect((await store.consume(a, rule)).allowed).toBe(false);
      expect((await store.consume(b, rule)).allowed).toBe(true);
    });

    it("starts a fresh window once the old one expires", async () => {
      const { store, advance } = await make();
      const k = key();
      for (let i = 0; i < 4; i++) await store.consume(k, rule);
      expect((await store.consume(k, rule)).allowed).toBe(false);
      await advance(1100);
      expect((await store.consume(k, rule)).allowed).toBe(true);
    });

    it("refund gives one hit back, never below zero", async () => {
      const { store } = await make();
      const k = key();
      for (let i = 0; i < 3; i++) await store.consume(k, rule);
      await store.refund(k);
      expect((await store.consume(k, rule)).allowed).toBe(true);
      expect((await store.consume(k, rule)).allowed).toBe(false);
      const fresh = key();
      await store.refund(fresh);
      await store.refund(fresh);
      for (let i = 0; i < 3; i++) expect((await store.consume(fresh, rule)).allowed).toBe(true);
      expect((await store.consume(fresh, rule)).allowed).toBe(false);
    });

    it("counts every concurrent hit exactly once", async () => {
      const { store } = await make();
      const k = key();
      const wide = { window: 1, max: 10 };
      const results = await Promise.all(Array.from({ length: 25 }, () => store.consume(k, wide)));
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
    });

    it("claim is single-holder until released", async () => {
      const { store } = await make();
      const k = key();
      const token = await store.claim(k, { window: 1 });
      expect(token).toEqual(expect.any(String));
      expect(await store.claim(k, { window: 1 })).toBeNull();
      await store.release(k, token ?? undefined);
      expect(await store.claim(k, { window: 1 })).toEqual(expect.any(String));
    });

    it("only one of many concurrent claims wins", async () => {
      const { store } = await make();
      const k = key();
      const tokens = await Promise.all(Array.from({ length: 10 }, () => store.claim(k, { window: 1 })));
      expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    });

    it("a stale holder cannot release a newer holder's lease", async () => {
      const { store, advance } = await make();
      const k = key();
      const first = await store.claim(k, { window: 1 });
      await advance(1100);
      const second = await store.claim(k, { window: 1 });
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      await store.release(k, first ?? undefined);
      expect(await store.claim(k, { window: 1 })).toBeNull();
      await store.release(k);
      expect(await store.claim(k, { window: 1 })).not.toBeNull();
    });

    it("leases expire on their own", async () => {
      const { store, advance } = await make();
      const k = key();
      expect(await store.claim(k, { window: 1 })).not.toBeNull();
      await advance(1100);
      expect(await store.claim(k, { window: 1 })).not.toBeNull();
    });

    it("release without a token clears a consumed bucket", async () => {
      const { store } = await make();
      const k = key();
      for (let i = 0; i < 4; i++) await store.consume(k, rule);
      await store.release(k);
      expect((await store.consume(k, rule)).allowed).toBe(true);
    });
  });
}
