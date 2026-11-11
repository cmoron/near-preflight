// Template reputation ("farm" detection, reduced version). Rebuilds, from chain logs only, an index
// of the Uniswap V2 WETH pools created in a block window, keyed by the template of the token's code:
// pools launched, pools drained, delay between creation and drain. Anyone gets the same file (same
// sha256) from the same chain state; the sentinel consults it, replay rebuilds it.
// Definitions: a pool is funded at the block where the WETH its providers added first reaches 0.5 ETH;
// it is drained once at least 90 % of the LP ever minted has been burned after that (its liquidity
// removed); a template is the token code with immutables and metadata masked (templateOf); a farm is
// a template whose earlier pools were almost all drained shortly after their funding.
// Usage: bun app/index.ts <rpc> <from block> <to block> <out.json> [--pace-ms N]
import { hexToBytes, keccak256, parseEther, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { FACTORY, LOG_CHUNK, rpc, short, WETH, type Finding } from "./verifier";

/** At least this many earlier pools of the template: fewer is an anecdote, not a pattern. */
const MIN_POOLS = 3;
/** "Almost all": at least 4 in 5 earlier pools drained. An honest template (a popular token
 *  factory) loses some pools to abandonment, rarely 4 in 5 within a day of creation. A very common
 *  template (a standard ERC-20 with many pools, honest and not) has a mixed history: this share,
 *  not a comparison of creators, is what keeps it from blocking. */
const FARM_SHARE = 0.8;
/** A pool counts only once its liquidity providers added at least this much WETH: a dust pool costs a
 *  decoy maker nothing, while a farm seeds real liquidity to look tradable (the demo farm: 1 ETH).
 *  Pools are dated by that funding, not by the pair's creation: a pair created empty long before
 *  says nothing about when its token became tradable. */
const MIN_POOL_WETH = parseEther("0.5");
/** "Shortly after funding": within 1 day (43,200 blocks of 2 s on Base). An honest project does not
 *  remove 90 % of its liquidity on its first day. */
const SHORT_BLOCKS = 43_200;
/** Drained: at least 90 % of the LP minted has been burned (our definition, in basis points). */
const DRAIN_BPS = 9_000n;
/** Pairs per eth_getLogs address filter (publicnode allows 10). */
const PAIRS_PER_QUERY = 10;
const PAIR_CREATED = keccak256(stringToHex("PairCreated(address,address,address,uint256)"));
const TRANSFER = keccak256(stringToHex("Transfer(address,address,uint256)"));
const MINT = keccak256(stringToHex("Mint(address,uint256,uint256)"));
const ZERO = "0x0000000000000000000000000000000000000000";

/** `funded`: block where the WETH added by the pair's `Mint`s first reached MIN_POOL_WETH, null if it
 *  never did within the window; `drained`: first block after that where 90 % of the LP was burned. */
export type Pool = { pair: Address; token: Address; created: number; funded: number | null; drained: number | null };
/** Pools by template, templates and pools in a fixed order: the JSON (and its sha256) depends only
 *  on the chain state and the window. Addresses lowercase. */
export type Index = { chain_id: number; factory: Address; weth: Address; from: number; to: number; templates: Record<string, Pool[]> };
/** What the sentinel took from the index for one target; replay rebuilds the index and compares. */
export type Reputation = {
  template: Hex;
  from: number;
  to: number;
  /** Only pools funded before this block count (beforeBlock). */
  before_block: number;
  index_sha256: Hex;
  pools: number;
  drained: number;
  median_drain_blocks: number | null;
};

/** keccak256 of the runtime code with the CBOR metadata tail removed and every PUSH32 operand
 *  zeroed. solc writes each immutable (here a token's `creator`, often an owner or a launch
 *  parameter) into a PUSH32 of the runtime code, so the raw keccak256 differs per deployment of
 *  the same source; the metadata hash differs with any change of comments or file names. Other
 *  operands stay: a minimal proxy (EIP-1167) keeps its implementation address (PUSH20). */
export function templateOf(code: Hex): Hex {
  const b = hexToBytes(code);
  let end = b.length;
  if (end >= 2) {
    const meta = (b[end - 2] << 8) | b[end - 1];
    const head = b[end - 2 - meta];
    if (meta + 2 <= end && head >= 0xa1 && head <= 0xa5) end -= meta + 2; // CBOR map header
  }
  const out = b.slice(0, end);
  for (let i = 0; i < out.length; i++) {
    const op = out[i];
    if (op < 0x60 || op > 0x7f) continue;
    if (op === 0x7f) out.fill(0, i + 1, i + 33);
    i += op - 0x5f;
  }
  return keccak256(out);
}

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex };
const word = (t: Hex) => `0x${t.slice(26)}` as Address;

/** Rebuilds the index of [from, to] from eth_getLogs (in LOG_CHUNK windows) and eth_getCode. `pace`
 *  runs before every request (the CLI waits there to stay polite with public RPCs). */
export async function buildIndex(url: string, from: number, to: number, pace: () => Promise<void> = async () => {}): Promise<Index> {
  const call = async <T>(method: string, params: unknown[]) => (await pace(), rpc<T>(url, method, params));
  const logs = async (filter: Record<string, unknown>, first = from) => {
    const out: Log[] = [];
    for (let start = BigInt(first); start <= BigInt(to); start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n < BigInt(to) ? start + LOG_CHUNK - 1n : BigInt(to);
      out.push(...(await call<Log[]>("eth_getLogs", [{ ...filter, fromBlock: toHex(start), toBlock: toHex(end) }])));
    }
    return out;
  };
  const chain_id = Number(await call<Hex>("eth_chainId", []));
  const weth = WETH.toLowerCase() as Address;
  const pools: Pool[] = [];
  const wethIs0 = new Set<Address>(); // pairs whose token0 is WETH: its Mint amount is amount0
  for (const l of await logs({ address: FACTORY, topics: [PAIR_CREATED] })) {
    const [t0, t1] = [word(l.topics[1]), word(l.topics[2])];
    const token = t0 === weth ? t1 : t1 === weth ? t0 : null;
    const pair = `0x${l.data.slice(26, 66)}` as Address;
    if (token) pools.push({ pair, token, created: Number(BigInt(l.blockNumber)), funded: null, drained: null });
    if (t0 === weth) wethIs0.add(pair);
  }
  const byPair = new Map(pools.map((p) => [p.pair, { pool: p, minted: 0n, burned: 0n, weth: 0n }]));
  for (let i = 0; i < pools.length; i += PAIRS_PER_QUERY) {
    const group = pools.slice(i, i + PAIRS_PER_QUERY); // in creation order: no LP log before the first one
    for (const l of await logs({ address: group.map((p) => p.pair), topics: [[TRANSFER, MINT]] }, group[0].created)) {
      const s = byPair.get(l.address.toLowerCase() as Address);
      if (!s) continue;
      const block = Number(BigInt(l.blockNumber));
      if (l.topics[0] === MINT) {
        s.weth += BigInt(`0x${wethIs0.has(s.pool.pair) ? l.data.slice(2, 66) : l.data.slice(66, 130)}`);
        if (s.pool.funded === null && s.weth >= MIN_POOL_WETH) s.pool.funded = block;
        continue;
      }
      const value = BigInt(l.data);
      if (word(l.topics[1]) === ZERO) s.minted += value;
      else if (word(l.topics[2]) === ZERO && word(l.topics[1]) === s.pool.pair) s.burned += value;
      if (s.pool.funded !== null && s.pool.drained === null && s.burned * 10_000n >= s.minted * DRAIN_BPS) s.pool.drained = block;
    }
  }
  const templates: Record<string, Pool[]> = {};
  for (const p of pools) {
    const code = await call<Hex>("eth_getCode", [p.token, toHex(to)]);
    if (code === "0x") continue; // no code left: no template
    (templates[templateOf(code)] ??= []).push(p);
  }
  const sorted: Record<string, Pool[]> = {};
  for (const t of Object.keys(templates).sort()) sorted[t] = templates[t].sort((a, b) => a.created - b.created || (a.pair < b.pair ? -1 : 1));
  return { chain_id, factory: FACTORY.toLowerCase() as Address, weth, from, to, templates: sorted };
}

export const indexSha256 = (i: Index): Hex => sha256(stringToHex(JSON.stringify(i)));

/** The block before which an index pool is earlier than the target's own pool (`ownPair`, its V2
 *  WETH pair): the block where that pool was funded, when the index saw it funded. Otherwise (no own
 *  pair, own pair not in the index or never funded within it) every pool of the index counts
 *  (`to + 1`). Copies funded and drained after the target cannot poison it. Pure: no chain read. */
export function beforeBlock(index: Index, ownPair: Address | null): number {
  const own = ownPair && Object.values(index.templates).flat().find((p) => p.pair === ownPair.toLowerCase());
  return own && own.funded !== null ? own.funded : index.to + 1;
}

/** The template's pools funded before `before` (beforeBlock); a drain counts within SHORT_BLOCKS of
 *  the funding. */
export function reputationOf(index: Index, template: Hex, before: number): Reputation {
  const earlier = (index.templates[template] ?? []).filter((p) => p.funded !== null && p.funded < before);
  const delays = earlier.flatMap((p) => (p.drained !== null && p.drained - p.funded! <= SHORT_BLOCKS ? [p.drained - p.funded!] : [])).sort((a, b) => a - b);
  const mid = delays.length >> 1;
  const median = delays.length ? (delays.length % 2 ? delays[mid] : (delays[mid - 1] + delays[mid]) / 2) : null;
  return { template, from: index.from, to: index.to, before_block: before, index_sha256: indexSha256(index), pools: earlier.length, drained: delays.length, median_drain_blocks: median };
}

/** The farm rule. No index: the reputation is unknown, which is never a pass. */
export function reputationFindings(r: Reputation | null): Finding[] {
  if (!r) return [{ level: "warn", text: "template reputation not checked: no index for this chain" }];
  if (r.pools < MIN_POOLS || r.drained / r.pools < FARM_SHARE) return [];
  return [{ level: "block", text: `template ${short(r.template)}: ${r.drained} of ${r.pools} earlier pools drained, median ${r.median_drain_blocks} blocks after funding` }];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--pace-ms");
  const paceMs = i >= 0 ? Number(args.splice(i, 2)[1]) : 0;
  const [url, from, to, out] = args;
  if (!url || !from || !to || !out) {
    console.error("usage: bun app/index.ts <rpc> <from block> <to block> <out.json> [--pace-ms N]");
    process.exit(2);
  }
  let requests = 0;
  const pace = async () => {
    requests++;
    if (paceMs) await Bun.sleep(paceMs);
  };
  const started = Date.now();
  const index = await buildIndex(url, Number(from), Number(to), pace);
  await Bun.write(out, JSON.stringify(index));
  const rows = Object.entries(index.templates).map(([t, ps]) => ({ t, n: ps.length, d: ps.filter((p) => p.drained !== null).length }));
  const pools = rows.reduce((n, r) => n + r.n, 0);
  const drained = rows.reduce((n, r) => n + r.d, 0);
  console.log(`index of blocks ${from}..${to} (chain ${index.chain_id}): ${pools} WETH pools in ${rows.length} templates, ${drained} drained; ${requests} requests in ${((Date.now() - started) / 1000).toFixed(1)} s; sha256 ${indexSha256(index)} -> ${out}`);
  for (const r of rows.sort((a, b) => b.d - a.d || b.n - a.n).slice(0, 5)) console.log(`  template ${short(r.t)}: ${r.d} of ${r.n} pools drained`);
}
