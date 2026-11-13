// Step 3: the sentinel's check (checkToken) of each launched pool as it would have run then: requested
// DELAY_S after the launch block, so the reference block is the first block >= launch + DELAY_S + 4 s
// (REF_MARGIN_S); the later side on the real block 16 to 24 s after it; the template index over the 2 h
// before the reference block. Nothing after the later block is read. Called directly (no guard, nothing
// on NEAR), read only: every call goes through proxy.ts, simulation and state on mainnet.base.org, logs
// on base-rpc.publicnode.com. The outcome labels (pools.json) are never passed to the check.
// Usage: bun check.ts <pools.json> <checks.json> [--every K | --first <template> N] [--workers N] [--gap ms]
import type { Address, Hex } from "viem";
import { proxy } from "./proxy";
const C = import.meta.dir;
process.env.RPC_TIMEOUT_MS = "180000"; // the proxy queues and throttles: a call may wait there
process.env.TMPDIR = `${C}/tmp`; // forkAt's anvil cache directories (removed on stop) land here
await Bun.write(`${C}/tmp/.keep`, "");
const V = await import(`${C}/../app/verifier.ts`);
const { indexer } = await import(`${C}/../app/sentinel.ts`);
const { localPreviews, SETUP_FEES } = await import(`${C}/../app/testkit.ts`);
const { reputationFindings } = await import(`${C}/../app/index.ts`);

const DELAY_S = 60;
const AMOUNT = 10_000_000_000_000n; // 0.00001 ETH, as the well-known-token measurement
const GUARD = "0x177461E39Cdc121c5f72795c0B909d0bF53cf0FD" as Address; // the guard's Base address used by earlier measurements
const [poolsFile, out] = process.argv.slice(2);
const every = process.argv.includes("--every") ? Number(process.argv[process.argv.indexOf("--every") + 1]) : 1;
const workers = process.argv.includes("--workers") ? Number(process.argv[process.argv.indexOf("--workers") + 1]) : 1;
const gap = process.argv.includes("--gap") ? Number(process.argv[process.argv.indexOf("--gap") + 1]) : 60;
const sim = proxy("https://mainnet.base.org", `${C}/cache/mainnet.base.org`, { gapMs: gap, inFlight: 6 });
const logs = proxy("https://base-rpc.publicnode.com", `${C}/cache/publicnode`, { gapMs: 100, inFlight: 4 });
const ix = indexer({ EVM_RPC: sim.url, INDEX_RPC: logs.url }, (l: string) => console.error("  " + l.replace(/http:\/\/127\.0\.0\.1:\d+/, "publicnode")))!;

const { pools } = await Bun.file(poolsFile).json();
// Deterministic sample: launched pools in pair-address order, every K-th.
const launched = pools.filter((p: any) => p.launch !== null).sort((a: any, b: any) => (a.pair < b.pair ? -1 : 1));
// --first T N: instead, the N earliest launches of template T (the cold start of its reputation).
const fi = process.argv.indexOf("--first");
const sample = fi >= 0
  ? launched.filter((p: any) => p.template === process.argv[fi + 1]).sort((a: any, b: any) => a.launch - b.launch).slice(0, Number(process.argv[fi + 2]))
  : launched.filter((_: any, i: number) => i % every === 0);
const done: any[] = (await Bun.file(out).exists()) ? await Bun.file(out).json() : [];
const todo = sample.filter((p: any) => !done.some((d) => d.pair === p.pair && !d.error));
const rows = done.filter((d) => !todo.some((p: any) => p.pair === d.pair));
console.error(`${sample.length} pools in the sample (every ${every} of ${launched.length} launched), ${todo.length} to check`);
const started = Date.now();

async function checkOne(p: any) {
  const row: any = { pair: p.pair, token: p.token, launch: p.launch };
  const launchTs = BigInt((await V.rpc(sim.url, "eth_getBlockByNumber", [`0x${p.launch.toString(16)}`, false]) as { timestamp: Hex }).timestamp);
  const requestedS = launchTs + BigInt(DELAY_S);
  row.requested_s = Number(requestedS);
  let probe: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = performance.now();
    try {
      const preview = localPreviews({ guard: GUARD, target: p.token, amount: AMOUNT, requestedS, fees: SETUP_FEES });
      const r = await V.checkToken(sim.url, p.token, GUARD, (h: any, c: any) => (probe = V.deriveProbes({ guard: "corpus", id: 1, requested_ns: "0" }, h.hash, c)), { requested_ns: (requestedS * 1_000_000_000n).toString(), index: ix.build, indexRpc: ix.rpc, near: async () => ({ listed: [], previous: null }), amount: AMOUNT, preview });
      const e = r.evidence;
      // The verdict split by rule: the reputation finding, the liquidity finding, and the rest (simulation
      // and code) judged with those two neutralised, on the same results.
      const labels = e.calls.map((c: string) => c.replace(/: (ok|revert)$/, ""));
      const w = { token: p.token, guard: GUARD, buyer: probe.buyer, stranger: probe.stranger };
      const neutral = { ...e, reputation: e.reputation && { ...e.reputation, pools: 0, drained: 0 }, liquidity: e.liquidity && { ...e.liquidity, supply_before: e.liquidity.supply } };
      const rest = V.judge(labels, r.response.flat(), neutral, w);
      const liq = V.liquidityFindings(e.liquidity, e.block);
      Object.assign(row, {
        attempt,
        seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
        block: e.block,
        later_block: e.later?.block ?? null,
        verdict: r.verdict,
        reasons: r.reasons,
        list_target: r.list_target,
        by_rule: {
          reputation: reputationFindings(e.reputation).map((f: any) => `${f.level}: ${f.text}`),
          liquidity: liq.map((f: any) => `${f.level}: ${f.text}`),
          simulation_and_code: { verdict: rest.verdict, reasons: rest.reasons },
        },
        template: e.template,
        reputation: e.reputation,
        liquidity: e.liquidity && { supply: e.liquidity.supply, created: e.liquidity.created, candidates: e.liquidity.candidates, holders: e.liquidity.holders?.map((h: any) => ({ kind: h.kind, share: Number((BigInt(h.balance) * 10000n) / BigInt(e.liquidity.supply)) / 100 })) ?? null },
        quote: e.quote,
        calls: e.calls,
        opcodes: e.opcodes,
        token_calls: e.token_calls,
        token_opcodes: e.token_opcodes,
        later: e.later && { block: e.later.block, moved: e.later.moved.length, replayed: e.later.replayed.length, unverified: e.later.unverified },
        sales: e.sales,
      });
      delete row.error;
      return row;
    } catch (err) {
      row.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      row.attempt = attempt;
      row.seconds = Number(((performance.now() - t0) / 1000).toFixed(1));
      console.error(`  attempt ${attempt} failed: ${row.error}`);
    }
  }
  return row; // three failures: the sentinel would post a block (fail closed)
}

let next = 0;
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const row = await checkOne(p);
      rows.push(row);
      console.log(JSON.stringify({ pair: row.pair, verdict: row.verdict ?? "ERROR", seconds: row.seconds, reasons: row.reasons ?? row.error }));
      await Bun.write(out, JSON.stringify(rows, null, 1));
      await Bun.write(out.replace(/\.json$/, "") + "-stats.json", JSON.stringify({ when: new Date().toISOString(), seconds: (Date.now() - started) / 1000, checked: rows.length, sim: sim.stats, logs: logs.stats }, null, 1));
    }
  }),
);
console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)} s; mainnet.base.org ${sim.stats.upstream} requests (${sim.stats.hits} cached, ${sim.stats.r429} HTTP 429), publicnode ${logs.stats.upstream} (${logs.stats.hits} cached, ${logs.stats.r429} HTTP 429)`);
sim.stop();
logs.stop();
