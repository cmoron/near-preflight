// When did a code template's launches start? Walks back from block FROM one day at a time, lists the
// WETH pairs created that day (PairCreated, publicnode) and the template of each token's current code,
// until a whole day has none of TEMPLATE. Prints per day: WETH pairs, pools of the template, and every
// other template seen (the other families of those days). Read only, cached through proxy.ts.
// Usage: bun farmstart.ts <from block> <template> <out.json> [max days]
import { keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { proxy } from "./proxy";
const C = import.meta.dir;
const { rpc, FACTORY, WETH } = await import(`${C}/../app/verifier.ts`);
const { templateOf } = await import(`${C}/../app/index.ts`);
const [FROM, TEMPLATE, OUT, MAX] = [Number(process.argv[2]), process.argv[3].toLowerCase(), process.argv[4], Number(process.argv[5] ?? 7)];
const DAY = 432_000;
const node = proxy("https://base-rpc.publicnode.com", `${C}/cache/publicnode`, { gapMs: 250, inFlight: 2 });
const state = proxy("https://mainnet.base.org", `${C}/cache/mainnet.base.org`, { gapMs: 250, inFlight: 2 });
const CREATED = keccak256(stringToHex("PairCreated(address,address,address,uint256)"));
const weth = WETH.toLowerCase();
const days: any[] = [];
for (let d = 1; d <= MAX; d++) {
  const [from, to] = [FROM - d * DAY, FROM - (d - 1) * DAY - 1];
  const pairs: { pair: Address; token: Address; created: number; template: Hex | null }[] = [];
  for (let s = from; s <= to; s += 5000) {
    for (const l of await rpc<{ topics: Hex[]; data: Hex; blockNumber: Hex }[]>(node.url, "eth_getLogs", [{ address: FACTORY, topics: [CREATED], fromBlock: toHex(s), toBlock: toHex(Math.min(s + 4999, to)) }])) {
      const [t0, t1] = [`0x${l.topics[1].slice(26)}`, `0x${l.topics[2].slice(26)}`];
      if (t0 !== weth && t1 !== weth) continue;
      pairs.push({ pair: `0x${l.data.slice(26, 66)}` as Address, token: (t0 === weth ? t1 : t0) as Address, created: Number(BigInt(l.blockNumber)), template: null });
    }
  }
  // the token's code at the end of that day (archive state on mainnet.base.org)
  for (const p of pairs) {
    const code = await rpc<Hex>(state.url, "eth_getCode", [p.token, toHex(to)]);
    p.template = code === "0x" ? null : templateOf(code);
  }
  const farm = pairs.filter((p) => p.template === TEMPLATE);
  const others: Record<string, number> = {};
  for (const p of pairs) if (p.template !== TEMPLATE) others[p.template?.slice(0, 10) ?? "no code"] = (others[p.template?.slice(0, 10) ?? "no code"] ?? 0) + 1;
  days.push({ day: d, from, to, pairs: pairs.length, template_pools: farm.length, first_template_pool: farm[0] ?? null, others, all: pairs });
  console.error(`day -${d} (blocks ${from}..${to}): ${pairs.length} WETH pairs, ${farm.length} of the template; others ${JSON.stringify(others)}`);
  await Bun.write(OUT, JSON.stringify({ from: FROM, template: TEMPLATE, days, requests: { publicnode: node.stats, mainnet: state.stats } }, null, 1));
  if (!farm.length) break;
}
node.stop();
state.stop();
