// A local JSON-RPC proxy in front of a public node: throttled (one request every `gapMs`, at most
// `inFlight` at once), HTTP 429 waited out, and every answer that cannot change (a call pinned to a block
// number) cached on disk under `dir`, so a re-run sends nothing upstream. Everything goes through it:
// the checker's own calls and the upstream fetches of the throwaway anvil forks (forkAt forks the URL it
// is given). Calls on "latest"/"pending" and eth_blockNumber are never cached. Errors are never cached.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

type Req = { jsonrpc?: string; id?: unknown; method: string; params?: unknown[] };
export type Stats = { upstream: number; hits: number; badCache: number; errors: number; r429: number; byMethod: Record<string, number> };

export function proxy(upstream: string, dir: string, o: { gapMs: number; inFlight: number }) {
  mkdirSync(dir, { recursive: true });
  const stats: Stats = { upstream: 0, hits: 0, badCache: 0, errors: 0, r429: 0, byMethod: {} };
  let active = 0;
  let next = 0;
  const queue: (() => void)[] = [];
  const take = async () => {
    while (active >= o.inFlight) await new Promise<void>((r) => queue.push(r));
    active++;
    const at = Math.max(Date.now(), next);
    next = at + o.gapMs;
    if (at > Date.now()) await Bun.sleep(at - Date.now());
  };
  const give = () => {
    active--;
    queue.shift()?.();
  };
  const volatile = (r: Req) => r.method === "eth_blockNumber" || /"(latest|pending|safe|finalized|earliest)"/.test(JSON.stringify(r.params ?? []));

  async function one(r: Req): Promise<unknown> {
    const key = createHash("sha256").update(JSON.stringify([r.method, r.params ?? []])).digest("hex");
    const file = `${dir}/${key.slice(0, 2)}/${key}.json`;
    const pinned = !volatile(r);
    if (pinned && (await Bun.file(file).exists())) {
      // Another run may be writing this very file (two runs share the cache): an unreadable entry is
      // counted and fetched again, never served.
      const cached = await Bun.file(file).json().catch(() => null);
      if (cached) {
        stats.hits++;
        return { jsonrpc: "2.0", id: r.id, result: cached.result };
      }
      stats.badCache++;
    }
    await take();
    try {
      stats.upstream++;
      stats.byMethod[r.method] = (stats.byMethod[r.method] ?? 0) + 1;
      for (const wait of [0, 1000, 2000, 4000, 8000, 16000, 32000, 64000]) {
        if (wait) await Bun.sleep(wait);
        let res: Response;
        try {
          res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: r.method, params: r.params ?? [] }), signal: AbortSignal.timeout(60_000) });
        } catch (e) {
          stats.errors++;
          if (wait === 64000) return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: `proxy: ${e instanceof Error ? e.message : e}` } };
          continue; // a timeout or reset: tried again after the next wait
        }
        if (res.status === 429) {
          stats.r429++;
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        let body: { result?: unknown; error?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          stats.errors++;
          return { jsonrpc: "2.0", id: r.id, error: { code: -32603, message: `proxy: HTTP ${res.status} ${text.slice(0, 120)}` } };
        }
        if (body.result !== undefined && body.result !== null && pinned) {
          mkdirSync(`${dir}/${key.slice(0, 2)}`, { recursive: true });
          await Bun.write(file, JSON.stringify({ method: r.method, params: r.params ?? [], result: body.result }));
        }
        if (body.error) stats.errors++;
        return { ...body, jsonrpc: "2.0", id: r.id };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "proxy: still rate limited after 127 s" } };
    } finally {
      give();
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const body = (await req.json()) as Req | Req[];
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      return Response.json(out);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stats, stop: () => server.stop(true) };
}
