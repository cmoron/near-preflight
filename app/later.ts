// The later side's state: Base's real block `r`, mined 16 to 24 s after the check's reference block, with
// what the guard's buy wrote carried onto it. A slot only the buy wrote takes the buy's value. When Base
// also wrote one (someone traded the pool in between), merging values is not sound: a token decides how
// its own slots evolve (a hash chain, a "last trader"), and a merged state can be one no chain ever had.
// So the real transactions that traded the pool are re-executed after the buy instead, block by block, on
// a local anvil forked from the node: each block's trades run once on Base's own state before that block
// (they must give Base's values back: the soundness check), once on that state with the buy's footprint
// carried in; the slots where the two runs differ are the footprint carried on. Everything else (WETH,
// others' pools, the factory, L1Block) is Base's at `r`. When the re-execution cannot be built, the later
// sales run on Base's values for the slots both wrote, and the check says the resale was not verified.
// Shared with app/replay.ts, which rebuilds it all from the node. docs/sentinel.md explains it.
import { keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { forkAt, TRACE_MARGIN, type Diff } from "./environment";
import { balances, buildRequest, rpc, short, timeOf, WETH, type Block, type Cadence, type Fees, type Header, type Later, type Request } from "./verifier";

/** At most this many real transactions are re-executed per check (more: the resale is not verified). */
export const MAX_REPLAYED = 10;
const TRANSFER = keccak256(stringToHex("Transfer(address,address,uint256)"));
const GET_RESERVES = "0x0902f1ac";
/** A real transaction that traded the pool: its hash, block and receipt status. */
type Real = { hash: Hex; block: number; status: Hex };
type Receipt = { transactionHash: Hex; status: Hex; logs: { address: Address; topics: Hex[] }[] };
/** Storage values by `address:slot` (lowercase, as Diff and evidence.later.moved write them). */
type Slots = Map<string, Hex>;

/** The transactions of blocks (`ref`, `r`] that traded `token`'s pool: any log of the pair, or a Transfer
 *  of the token or of WETH to or from the pair (a donation the pair has not synced yet). In chain order,
 *  from each block's receipts (eth_getBlockReceipts: Base's public RPC refuses eth_getLogs). */
export async function poolTrades(url: string, ref: number, r: number, token: Address, pair: Address): Promise<Real[]> {
  const [p, t, w] = [pair, token, WETH].map((a) => a.toLowerCase());
  const touches = (x: Receipt) =>
    x.logs.some((l) => l.address.toLowerCase() === p || (l.topics[0] === TRANSFER && [t, w].includes(l.address.toLowerCase()) && l.topics.slice(1, 3).some((x) => `0x${x.slice(26)}` === p)));
  const out: Real[] = [];
  // one block at a time: mainnet.base.org answers 429 to ten at once (about 11 s for 100 blocks)
  for (let b = ref + 1; b <= r; b++) {
    for (const x of (await rpc<Receipt[]>(url, "eth_getBlockReceipts", [toHex(b)])).filter(touches)) out.push({ hash: x.transactionHash, block: b, status: x.status });
  }
  return out;
}

type Tx = { type: Hex; from: Address; to: Address | null; input: Hex; value: Hex; gas: Hex; nonce: Hex; gasPrice?: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex; accessList?: unknown[] };
type Prestate = { pre: Record<string, { storage?: Record<string, Hex> }>; post: Record<string, { storage?: Record<string, Hex> }> };

/** The buy's footprint carried through `trades` (poolTrades, in order), or why it cannot be: a trade
 *  type anvil cannot replay, a status other than Base's, a re-execution that does not give Base's values
 *  back, a footprint slot that moved with no trade of the pool. The footprint starts as what the buy
 *  wrote (`diff`); a slot joins it when it is the token's or the pair's and the two runs of a block give
 *  it different values, and leaves it when they give the same. Returns the footprint's values, which the
 *  later side sets on block `r`. */
export async function carry(url: string, ref: Header, r: Header, trades: Real[], diff: Diff, token: Address, pair: Address): Promise<{ state: Slots } | { error: string }> {
  const at = (key: string, block: number | "latest", where = url) => rpc<Hex>(where, "eth_getStorageAt", [...key.split(":"), typeof block === "number" ? toHex(block) : block]);
  const owned = (a: string) => a === token.toLowerCase() || a === pair.toLowerCase();
  const name = (key: string) => `slot ${short(key.split(":")[1])} of ${short(key.split(":")[0])}`;
  let footprint: Slots = new Map(Object.entries(diff.storage).flatMap(([a, slots]) => Object.entries(slots).map(([s, [, post]]) => [`${a}:${s}`, post] as [string, Hex])));
  /** Base did not move the footprint between blocks `from` and `to` (no trade of the pool there). */
  const still = async (from: number, to: number) => {
    for (const key of footprint.keys()) if (BigInt(await at(key, from)) !== BigInt(await at(key, to))) return `${name(key)} moved in blocks ${from + 1}..${to} with no trade of the pool`;
    return null;
  };
  const blocks = [...new Set(trades.map((t) => t.block))];
  if (!blocks.length) {
    const moved = await still(Number(BigInt(ref.number)), Number(BigInt(r.number)));
    return moved ? { error: moved } : { state: footprint };
  }
  const fork = await forkAt(url, blocks[0] - 1);
  const local = fork.url;
  const call = <T>(method: string, params: unknown[]) => rpc<T>(local, method, params);
  try {
    let prev = Number(BigInt(ref.number));
    for (const b of blocks) {
      const moved = await still(prev, b - 1);
      if (moved) return { error: moved };
      await call("anvil_reset", [{ forking: { jsonRpcUrl: url, blockNumber: b - 1 } }]);
      const head = await rpc<{ timestamp: Hex; baseFeePerGas: Hex; miner: Address }>(url, "eth_getBlockByNumber", [toHex(b), false]);
      const txs = await Promise.all(trades.filter((t) => t.block === b).map(async (t) => ({ real: t, tx: await rpc<Tx>(url, "eth_getTransactionByHash", [t.hash]) })));
      const odd = txs.find(({ tx }) => !["0x0", "0x1", "0x2"].includes(tx.type));
      if (odd) return { error: `${short(odd.real.hash)} is of type ${odd.tx.type}, not re-executed` };
      /** Mines block `b` with its trades, as Base did, on the state now; the slots they wrote that count. */
      const run = async (): Promise<{ written: Set<string> } | { error: string }> => {
        const hashes: Hex[] = [];
        const senders = new Set<string>();
        for (const { tx } of txs) {
          if (!senders.has(tx.from.toLowerCase())) {
            // its first trade here: its nonce, and the L1 fee anvil bills on top
            senders.add(tx.from.toLowerCase());
            await call("anvil_impersonateAccount", [tx.from]);
            await call("anvil_setBalance", [tx.from, toHex(BigInt(await call<Hex>("eth_getBalance", [tx.from, "latest"])) + TRACE_MARGIN)]);
            await call("anvil_setNonce", [tx.from, tx.nonce]);
          }
          const fees = tx.type === "0x2" ? { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : { gasPrice: tx.gasPrice };
          hashes.push(await call<Hex>("eth_sendTransaction", [{ from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.input, value: tx.value, gas: tx.gas, nonce: tx.nonce, ...fees, ...(tx.accessList ? { accessList: tx.accessList } : {}) }]));
        }
        await call("evm_setNextBlockTimestamp", [head.timestamp]);
        await call("anvil_setNextBlockBaseFeePerGas", [head.baseFeePerGas]);
        await call("anvil_setCoinbase", [head.miner]);
        await call("evm_mine", []);
        const mined = await call<{ number: Hex; transactions: unknown[] }>("eth_getBlockByNumber", ["latest", false]);
        if (Number(BigInt(mined.number)) !== b || mined.transactions.length !== txs.length) return { error: `block ${b} re-executed as ${BigInt(mined.number)} with ${mined.transactions.length} of ${txs.length} trades` };
        const written = new Set<string>();
        for (const [i, h] of hashes.entries()) {
          const status = (await call<{ status: Hex }>("eth_getTransactionReceipt", [h])).status;
          if (status !== txs[i].real.status) return { error: `${short(txs[i].real.hash)} ${status === "0x1" ? "succeeds" : "reverts"} when re-executed, unlike on Base` };
          const d = await call<Prestate>("debug_traceTransaction", [h, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
          for (const side of [d.pre, d.post]) for (const [a, acc] of Object.entries(side)) for (const s of Object.keys(acc.storage ?? {})) written.add(`${a.toLowerCase()}:${s}`);
        }
        return { written: new Set([...written].filter((k) => owned(k.split(":")[0]) || footprint.has(k))) };
      };
      const start = await call<Hex>("evm_snapshot", []);
      // Without the buy: Base's own block back, on every slot that counts.
      const bare = await run();
      if ("error" in bare) return bare;
      const without: Slots = new Map();
      for (const key of new Set([...footprint.keys(), ...bare.written])) without.set(key, await at(key, "latest", local));
      await call("evm_revert", [start]);
      // With it: the footprint set first, the same trades.
      for (const [key, v] of footprint) await call("anvil_setStorageAt", [...key.split(":"), v]);
      const carried = await run();
      if ("error" in carried) return carried;
      const next: Slots = new Map();
      for (const key of new Set([...without.keys(), ...carried.written])) {
        const real = await at(key, b);
        const bareValue = without.get(key) ?? (await at(key, b - 1)); // a slot only the carried run wrote: Base's before the block
        if (BigInt(bareValue) !== BigInt(real)) return { error: `re-executing block ${b}'s trades does not give Base's ${name(key)}` };
        const v = await at(key, "latest", local);
        if (BigInt(v) !== BigInt(real)) next.set(key, v);
      }
      footprint = next;
      prev = b;
    }
    const moved = await still(prev, Number(BigInt(r.number)));
    return moved ? { error: moved } : { state: footprint };
  } finally {
    await fork.stop();
  }
}

/** The later side's request: the guard side's approves and swaps (`blocks`, laterBlocks) on real block
 *  `r`, which Base mined after the reference block `ref`, with the buy's footprint set. When no slot the
 *  buy wrote moved on Base (`moved` empty), that is what the buy wrote. When some did, the trades of the
 *  pool in between are re-executed after the buy (carry; `replayed`); when that cannot be built
 *  (`unverified` says why), the moved slots keep Base's value and the others take the buy's. An ETH
 *  balance adds the buy's change to Base's (WETH's is its total supply); the guard gets what its own
 *  calls spend, as on the other sides. Each simulated block keeps the guard side's time, unless Base's
 *  clock ran ahead of cadence `c` (then the blocks follow `r`'s time). `reserves`: the pool's at the
 *  start, for the sales' quotes. */
export async function laterSide(url: string, r: Header, ref: Header, c: Cadence, blocks: Block[], diff: Diff, fees: Fees, guard: Address, token: Address, pair: Address): Promise<{ request: Request } & Omit<Later, "block">> {
  const moved: string[] = [];
  const bought: Slots = new Map();
  for (const [a, slots] of Object.entries(diff.storage)) {
    for (const [s, [pre, post]] of Object.entries(slots)) {
      if (BigInt(await rpc<Hex>(url, "eth_getStorageAt", [a, s, r.number])) === BigInt(pre)) bought.set(`${a}:${s}`, post);
      else moved.push(`${a}:${s}`);
    }
  }
  let footprint = bought;
  let replayed: Hex[] = [];
  let unverified: string | null = null;
  if (moved.length) {
    const trades = await poolTrades(url, Number(BigInt(ref.number)), Number(BigInt(r.number)), token, pair);
    const carried = trades.length > MAX_REPLAYED ? { error: `${trades.length} trades of the pool, more than ${MAX_REPLAYED} to re-execute` } : await carry(url, ref, r, trades, diff, token, pair);
    if ("error" in carried) unverified = carried.error;
    else [footprint, replayed] = [carried.state, trades.map((t) => t.hash)];
  }
  const state: Record<string, Record<string, Hex>> = {};
  for (const [key, v] of footprint) {
    const [a, s] = key.split(":");
    (state[a] ??= {})[s] = v;
  }
  const funds: Record<string, bigint> = {};
  for (const [a, [pre, post]] of Object.entries(diff.balance)) funds[a] = BigInt(await rpc<Hex>(url, "eth_getBalance", [a, r.number])) + BigInt(post) - BigInt(pre);
  Object.assign(funds, await balances(url, r, blocks, fees, guard, null));
  const request = buildRequest(r, c, funds, blocks, fees, state, timeOf(ref, c, BigInt(r.number)) >= BigInt(r.timestamp) ? ref : r);
  const [{ stateOverrides }] = (request.params[0] as { blockStateCalls: { stateOverrides: unknown }[] }).blockStateCalls;
  const out = await rpc<Hex>(url, "eth_call", [{ to: pair, data: GET_RESERVES }, r.number, stateOverrides]);
  return { request, moved, reserves: [BigInt(`0x${out.slice(2, 66)}`).toString(), BigInt(`0x${out.slice(66, 130)}`).toString()], replayed, unverified };
}
