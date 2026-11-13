// Step 1 and 2: every Uniswap V2 pair created against WETH on Base in blocks FROM..TO, its launch (first
// liquidity add) and its outcome over the 24 h after that launch, from public logs only. Outcome facts
// (labels) are AFTER the launch and never reach the checker; they are written apart from it.
// Usage: bun pools.ts <from> <to> <out.json> [--skip-template T]   (T: leave out the pairs whose token's
// code at <to> has template T, e.g. a farm already measured; they are counted, not labelled)
import { keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { proxy } from "./proxy";
const C = import.meta.dir;
const { rpc, FACTORY, WETH } = await import(`${C}/../app/verifier.ts`);
const { templateOf } = await import(`${C}/../app/index.ts`);

const [FROM, TO] = [Number(process.argv[2]), Number(process.argv[3])];
const OUT = process.argv[4];
const DAY = 432_000; // blocks in 24 h: Base mined exactly 5 a second over the window (checked at its ends)
const CHUNK = 5_000;
const logsNode = proxy("https://base-rpc.publicnode.com", `${C}/cache/publicnode`, { gapMs: 100, inFlight: 4 });
const stateNode = proxy("https://mainnet.base.org", `${C}/cache/mainnet.base.org`, { gapMs: 60, inFlight: 6 });
const topic = (s: string) => keccak256(stringToHex(s));
const T = {
  created: topic("PairCreated(address,address,address,uint256)"),
  mint: topic("Mint(address,uint256,uint256)"),
  burn: topic("Burn(address,uint256,uint256,address)"),
  swap: topic("Swap(address,uint256,uint256,uint256,uint256,address)"),
  sync: topic("Sync(uint112,uint112)"),
  transfer: topic("Transfer(address,address,uint256)"),
};
type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex };
const weth = WETH.toLowerCase();
const word = (t: Hex) => `0x${t.slice(26)}` as Address;
const u = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i)}`);

async function logs(filter: Record<string, unknown>, from: number, to: number): Promise<Log[]> {
  const out: Log[] = [];
  for (let s = from; s <= to; s += CHUNK) out.push(...(await rpc<Log[]>(logsNode.url, "eth_getLogs", [{ ...filter, fromBlock: toHex(s), toBlock: toHex(Math.min(s + CHUNK - 1, to)) }])));
  return out;
}
const fromOf = new Map<string, Address>();
const txFrom = async (h: Hex) => fromOf.get(h) ?? (fromOf.set(h, (await rpc<{ from: Address }>(stateNode.url, "eth_getTransactionByHash", [h])).from.toLowerCase() as Address), fromOf.get(h)!);

const started = Date.now();
const listed = (await logs({ address: FACTORY, topics: [T.created] }, FROM, TO)).flatMap((l) => {
  const [t0, t1] = [word(l.topics[1]), word(l.topics[2])];
  if (t0 !== weth && t1 !== weth) return [];
  return [{ pair: `0x${l.data.slice(26, 66)}` as Address, token: (t0 === weth ? t1 : t0) as Address, wethIs0: t0 === weth, created: Number(BigInt(l.blockNumber)), created_tx: l.transactionHash }];
});
const skip = process.argv.includes("--skip-template") ? process.argv[process.argv.indexOf("--skip-template") + 1].toLowerCase() : null;
const created = [];
let skipped = 0;
for (const p of listed) {
  if (skip && templateOf(await rpc<Hex>(stateNode.url, "eth_getCode", [p.token, toHex(TO)])) === skip) skipped++;
  else created.push(p);
}
console.error(`${listed.length} WETH pairs created in ${FROM}..${TO}${skip ? `, ${skipped} of template ${skip} left out` : ""}`);

// Every log of each pair from its creation to 24 h after the window's end (the last launch's horizon).
const byPair = new Map<string, Log[]>(created.map((p) => [p.pair, []]));
for (let i = 0; i < created.length; i += 10) {
  const group = created.slice(i, i + 10);
  for (const l of await logs({ address: group.map((p) => p.pair) }, group[0].created, TO + DAY)) byPair.get(l.address.toLowerCase())?.push(l);
  console.error(`pair logs: ${Math.min(i + 10, created.length)} of ${created.length}`);
}

const rows = [];
for (const p of created) {
  const all = byPair.get(p.pair)!;
  const wethOf = (l: Log, i: number) => u(l.data, p.wethIs0 ? i : i + 1); // (token0, token1) amounts at i, i+1
  const tokOf = (l: Log, i: number) => u(l.data, p.wethIs0 ? i + 1 : i);
  const firstMint = all.find((l) => l.topics[0] === T.mint);
  const row: any = { pair: p.pair, token: p.token, created: p.created, created_tx: p.created_tx };
  if (!firstMint || Number(BigInt(firstMint.blockNumber)) > TO) {
    rows.push({ ...row, launch: null, label: "no-liquidity", label_reason: "no liquidity added within the window" });
    continue;
  }
  const launch = Number(BigInt(firstMint.blockNumber));
  const horizon = launch + DAY;
  const day = all.filter((l) => Number(BigInt(l.blockNumber)) <= horizon);
  const launcher = await txFrom(firstMint.transactionHash);
  const code = await rpc<Hex>(stateNode.url, "eth_getCode", [p.token, toHex(launch)]);
  // LP: minted (Transfer from 0x0) and burned (Transfer pair -> 0x0); pulled once 90 % of the LP minted so far is burned.
  let [minted, burned, net, funded, pulled] = [0n, 0n, 0n, null as number | null, null as number | null];
  let [peak, wethNow, initial] = [0n, 0n, wethOf(firstMint, 0)];
  let pulledWeth = 0n;
  const syncs: [number, bigint, bigint][] = [];
  for (const l of day) {
    const b = Number(BigInt(l.blockNumber));
    if (l.topics[0] === T.transfer) {
      if (word(l.topics[1]) === "0x0000000000000000000000000000000000000000") minted += BigInt(l.data);
      else if (word(l.topics[2]) === "0x0000000000000000000000000000000000000000" && word(l.topics[1]) === p.pair) burned += BigInt(l.data);
      if (pulled === null && minted > 0n && burned * 10_000n >= minted * 9_000n) pulled = b;
    } else if (l.topics[0] === T.mint) {
      net += wethOf(l, 0);
      if (funded === null && net >= 5n * 10n ** 17n) funded = b;
    } else if (l.topics[0] === T.burn) {
      net = net > wethOf(l, 0) ? net - wethOf(l, 0) : 0n;
      if (pulled === null || b <= pulled) pulledWeth += wethOf(l, 0);
    } else if (l.topics[0] === T.sync) {
      wethNow = wethOf(l, 0);
      if (wethNow > peak) peak = wethNow;
      syncs.push([b, wethNow, tokOf(l, 0)]);
    }
  }
  // Trades before the LP was pulled (after it, nothing is tradable): buys (WETH in, token out) by
  // recipient, sells (token in, WETH out) by the sender of their transaction.
  const cutoff = pulled ?? horizon;
  const swaps = day.filter((l) => l.topics[0] === T.swap && Number(BigInt(l.blockNumber)) <= cutoff);
  const buys = swaps.filter((l) => wethOf(l, 0) > 0n && tokOf(l, 2) > 0n);
  const sells = swaps.filter((l) => tokOf(l, 0) > 0n && wethOf(l, 2) > 0n);
  const buyers = new Set(buys.map((l) => word(l.topics[2])).filter((a) => a !== launcher));
  const sellers = new Set<Address>();
  let looked = 0;
  for (const h of [...new Set(sells.map((l) => l.transactionHash))]) {
    if (sellers.size >= 2 || looked >= 40) break; // two outside sellers settle the question
    looked++;
    const f = await txFrom(h);
    if (f !== launcher) sellers.add(f);
  }
  const firstSell = sells.find((l) => fromOf.get(l.transactionHash) && fromOf.get(l.transactionHash) !== launcher);
  // Price in WETH per token at launch, at the peak WETH reserve and at +24 h (reserves ratio).
  const price = (s: [number, bigint, bigint] | undefined) => (s && s[2] > 0n ? Number(s[1]) / Number(s[2]) : null);
  const last = syncs.at(-1);
  const facts = {
    launch_weth: initial.toString(),
    funded_05: funded,
    lp_pulled: pulled,
    lp_pulled_after_s: pulled === null ? null : (pulled - launch) / 5,
    weth_removed_by_burns: pulledWeth.toString(),
    weth_peak: peak.toString(),
    weth_24h: (last ? last[1] : 0n).toString(),
    price_launch: price(syncs[0]),
    price_24h: price(last),
    buys: buys.length,
    buyers: buyers.size,
    sells: sells.length,
    outside_sellers_found: sellers.size,
    sell_txs_looked_up: looked,
    first_outside_sell_after_s: firstSell ? (Number(BigInt(firstSell.blockNumber)) - launch) / 5 : null,
    observed_s: (cutoff - launch) / 5,
  };
  // Labels, in this order of precedence (definitions in README.md and corpus.md).
  const w24 = last ? last[1] : 0n;
  const label =
    buyers.size >= 5 && sellers.size === 0 && cutoff - launch >= 30 * 60 * 5
      ? ["honeypot-like", `${buyers.size} outside buyers, no sale by anyone but the launcher in ${Math.round((cutoff - launch) / 300)} min`]
      : pulled !== null
        ? ["drained", `90 % of the LP burned ${Math.round((pulled - launch) / 5)} s after launch`]
        : w24 * 10n < initial
          ? ["dumped", `WETH reserve at +24 h is ${((Number(w24) / Number(initial)) * 100).toFixed(1)} % of the launch's, LP not removed`]
          : sellers.size > 0 && w24 * 2n >= initial
            ? ["alive", `LP in place, outside sellers sold, WETH reserve at +24 h ${((Number(w24) / Number(initial)) * 100).toFixed(0)} % of the launch's`]
            : ["unclear", sellers.size === 0 ? `${buyers.size} outside buyers, no outside sale observed` : `WETH reserve at +24 h ${((Number(w24) / Number(initial)) * 100).toFixed(0)} % of the launch's`];
  rows.push({ ...row, launch, launch_tx: firstMint.transactionHash, launcher, template: code === "0x" ? null : templateOf(code), code_bytes: (code.length - 2) / 2, label: label[0], label_reason: label[1], outcome: facts });
}
await Bun.write(OUT, JSON.stringify({ window: { from: FROM, to: TO }, pairs_listed: listed.length, skipped_template: skip, skipped, day_blocks: DAY, built: new Date().toISOString(), seconds: (Date.now() - started) / 1000, nodes: { logs: { url: "https://base-rpc.publicnode.com", ...logsNode.stats }, state: { url: "https://mainnet.base.org", ...stateNode.stats } }, pools: rows }, null, 1));
const n = (l: string) => rows.filter((r) => r.label === l).length;
console.error(`${rows.length} pairs: ${["no-liquidity", "drained", "honeypot-like", "dumped", "alive", "unclear"].map((l) => `${n(l)} ${l}`).join(", ")}; ${((Date.now() - started) / 1000).toFixed(0)} s; logs node ${logsNode.stats.upstream} requests (${logsNode.stats.hits} cached), state node ${stateNode.stats.upstream} (${stateNode.stats.hits} cached)`);
logsNode.stop();
stateNode.stop();
