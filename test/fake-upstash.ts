/** A tiny in-memory stand-in for the Upstash REST pipeline endpoint, covering the commands the store sends. */
export function fakeUpstash(clock: { now: number }) {
  const data = new Map<string, { value: string; expiresAt: number | null }>();
  const requests: { url: string; auth: string | null; body: unknown }[] = [];

  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.expiresAt !== null && e.expiresAt <= clock.now) {
      data.delete(k);
      return undefined;
    }
    return e;
  };

  const run = (cmd: (string | number)[]): { result?: unknown; error?: string } => {
    const [op, ...args] = cmd.map(String);
    const k = args[0] ?? "";
    switch (op) {
      case "INCR": {
        const e = live(k);
        const n = e ? Number(e.value) : 0;
        if (!Number.isInteger(n)) return { error: "ERR value is not an integer or out of range" };
        data.set(k, { value: String(n + 1), expiresAt: e?.expiresAt ?? null });
        return { result: n + 1 };
      }
      case "EXPIRE": {
        const e = live(k);
        if (!e || (args[2] === "NX" && e.expiresAt !== null)) return { result: 0 };
        e.expiresAt = clock.now + Number(args[1]) * 1000;
        return { result: 1 };
      }
      case "TTL": {
        const e = live(k);
        if (!e) return { result: -2 };
        return { result: e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - clock.now) / 1000) };
      }
      case "SET": {
        if (args.includes("NX") && live(k)) return { result: null };
        const ex = args.indexOf("EX");
        data.set(k, { value: args[1] ?? "", expiresAt: ex >= 0 ? clock.now + Number(args[ex + 1]) * 1000 : null });
        return { result: "OK" };
      }
      case "DEL":
        return { result: data.delete(k) ? 1 : 0 };
      case "EVAL": {
        const [script, , key = "", arg] = args;
        const e = live(key);
        if (script?.includes("redis.call('del'")) {
          if (e?.value === arg) {
            data.delete(key);
            return { result: 1 };
          }
          return { result: 0 };
        }
        if (script?.includes("redis.call('decr'")) {
          const n = Number(e?.value ?? 0);
          if (e && n > 0) {
            e.value = String(n - 1);
            return { result: n - 1 };
          }
          return { result: 0 };
        }
        return { error: "ERR unknown script" };
      }
      default:
        return { error: `ERR unknown command ${String(op)}` };
    }
  };

  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as (string | number)[][];
    const headers = new Headers(init?.headers);
    requests.push({ url: input as string, auth: headers.get("authorization"), body });
    return Promise.resolve(Response.json(body.map(run)));
  };

  return { fetch: fetchImpl, data, requests };
}
