// Who bought the farm's pools: buy recipients (Swap `to`) per pool, and in how many pools each appears.
// Same eth_getLogs requests as pools.ts, so answered from cache/ (no new upstream request when cached).
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import { proxy } from "./proxy";
const C = import.meta.dir;
const { rpc, FACTORY, WETH } = await import(`${C}/../app/verifier.ts`);
const P = await Bun.file(process.argv[2]).json();
const node = proxy("https://base-rpc.publicnode.com", `${C}/cache/publicnode`, { gapMs: 100, inFlight: 4 });
const SWAP = keccak256(stringToHex("Swap(address,uint256,uint256,uint256,uint256,address)"));
const created = P.pools; // pools.ts order: PairCreated order
const all = new Map<string, any[]>(created.map((p: any) => [p.pair, []]));
for (let i = 0; i < created.length; i += 10) {
  const group = created.slice(i, i + 10);
  for (let s = group[0].created; s <= P.window.to + 432_000; s += 5000)
    for (const l of await rpc<any[]>(node.url, "eth_getLogs", [{ address: group.map((p: any) => p.pair), fromBlock: toHex(s), toBlock: toHex(Math.min(s + 4999, P.window.to + 432_000)) }])) all.get(l.address.toLowerCase())?.push(l);
}
const weth = WETH.toLowerCase();
const seen = new Map<string, number>();
const cls = new Map<string, Set<string>>();
const farm = created.filter((p: any) => p.template === process.argv[3]);
for (const p of farm) {
  const wethIs0 = BigInt(weth) < BigInt(p.token);
  const cut = p.outcome.lp_pulled ?? p.launch + 432_000;
  const rec = new Set<string>();
  for (const l of all.get(p.pair)!) {
    if (l.topics[0] !== SWAP || Number(BigInt(l.blockNumber)) > cut) continue;
    const a = (i: number) => BigInt(`0x${l.data.slice(2 + 64 * i, 66 + 64 * i)}`);
    const tokenOut = wethIs0 ? a(3) : a(2);
    if (tokenOut > 0n) rec.add(`0x${l.topics[2].slice(26)}`);
  }
  for (const r of rec) { seen.set(r, (seen.get(r) ?? 0) + 1); (cls.get(r) ?? cls.set(r, new Set()).get(r)!).add(`${Number(p.outcome.launch_weth) / 1e18} ETH ${p.label}`); }
}
const top = [...seen.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${farm.length} farm pools, ${seen.size} distinct buy recipients; recipients in at least half the pools: ${top.filter(([, n]) => n >= farm.length / 2).length}; in only one pool: ${top.filter(([, n]) => n === 1).length}`);
console.log("pools per recipient (top 15):", top.slice(0, 15).map(([, n]) => n).join(" "));
console.log(`upstream ${node.stats.upstream}, cached ${node.stats.hits}`);
node.stop();
const byClass: Record<string, number> = {};
for (const [r, n] of top) if (n > 1) { const k = [...cls.get(r)!].sort().join(" + "); byClass[`${k} (${n} pools)`] = (byClass[`${k} (${n} pools)`] ?? 0) + 1; }
console.log("recipients seen in more than one pool, by the launch sizes and labels of their pools:");
for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${n} recipients: ${k}`);
const one: Record<string, number> = {};
for (const [r, n] of top) if (n === 1) { const k = [...cls.get(r)!][0]; one[k] = (one[k] ?? 0) + 1; }
console.log("recipients seen in one pool only, by its launch size and label:", JSON.stringify(one));
