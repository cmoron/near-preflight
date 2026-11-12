// The environment rule: a token whose transfers depend on anything the simulation cannot reproduce is
// not allowed. eth_simulateV1 never runs Base's per-block system update (the L1 attributes deposit that
// rewrites the L1Block predeploy, the fee vaults' credits) and cannot know a future block's fields. Rather
// than guess the next tell, three facts close the class, all in the evidence and recomputed by replay:
// - `touched`: every address the guard's own transactions read or call, at any depth (BALANCE,
//   EXTCODESIZE, EXTCODEHASH, EXTCODECOPY, CALL, STATICCALL, DELEGATECALL, CALLCODE), on the reference
//   block and the far sales (trace) and on the later side's block (traceLater). Anything outside the
//   token, its implementation, its pool, the router, WETH, the factory, the guard and the precompiles is a
//   block: L1Block, a fee vault, the coinbase, a helper contract, a library. The code that runs during
//   the guard's transactions is then only the token's, its implementation's and the Uniswap contracts'.
// - `token_calls`: what the token's own code reaches: the addresses it calls, or whose code or ETH balance
//   it reads (BALANCE, EXTCODE*), in every frame run in its context or running its code or its
//   implementation's (a plain call to its implementation runs there in another context). WETH and
//   the factory are on the list above for the router's sake, yet all of Base moves their state (measured
//   on 2026-11-12: WETH's supply moved in 160 of 600 blocks, 2 min; the factory got 16 pairs in an hour):
//   a token that reaches either one is a block, whether or not that state moved during the check.
// - `token_balances`: the addresses whose ETH balance the token's own code reads, itself aside: a block.
//   Others' balances move with all of Base, and the guard's own with the L1 fee no simulation bills.
// - `opcodes`: the opcodes of the token's and its implementation's reachable code whose value no
//   simulation can guarantee: at least a warn, the owner decides.
// TIMESTAMP and NUMBER stay allowed: the simulated blocks follow the cadence measured at the check up to
// the late sale (30 to 51 s after the buy), and the far sales' blocks (301 s, 900 s and a drawn delay
// between, on the local fork trace starts) get the number and time real ones would have; the sales there
// exercise them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes, keccak256, pad, stringToHex, toHex, type Address, type Hex } from "viem";
import { ETH_LOGS, FACTORY, ROUTER, rpc, short, WETH, type Finding, type Liquidity, type Log, type Request, type Result } from "./verifier";

/** Opcodes whose value the simulation cannot guarantee for a future real block or transaction. GAS is
 *  not one (solc emits it before every external call, and the simulation gives each transaction the
 *  guard's own gas limit); SELFBALANCE is the token's own state, as reproducible as its storage; BALANCE
 *  and EXTCODE* name an address, which `touched` judges. */
export const ENV_OPCODES: Record<number, string> = {
  0x32: "ORIGIN",
  0x3a: "GASPRICE",
  0x40: "BLOCKHASH",
  0x41: "COINBASE",
  0x44: "PREVRANDAO",
  0x45: "GASLIMIT",
  0x48: "BASEFEE",
  0x49: "BLOBHASH",
  0x4a: "BLOBBASEFEE",
};
/** STOP, JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT: what follows runs only from a JUMPDEST. */
const HALTS = new Set([0x00, 0x56, 0xf3, 0xfd, 0xfe, 0xff]);

/** ENV_OPCODES in the code execution can reach: from offset 0 and from each valid JUMPDEST (as the EVM
 *  parses them, PUSH data skipped) until an opcode that halts or jumps away. Data solc appends after the
 *  code (revert strings, constants, the CBOR metadata) is skipped while nothing can run it: read as
 *  code, "A", "D", "H" would be COINBASE, PREVRANDAO, BASEFEE. A tail shaped like metadata is not
 *  trusted: the whole code is scanned, so it is skipped only when the code before it halts and it holds
 *  no JUMPDEST. Sorted names. */
export function envOpcodes(code: Hex): string[] {
  const b = hexToBytes(code);
  const seen = new Set<string>();
  let live = true;
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x5b) live = true;
    if (live && ENV_OPCODES[op]) seen.add(ENV_OPCODES[op]);
    if (HALTS.has(op)) live = false;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return [...seen].sort();
}

/** The precompiles (0x01 to 0x11, and P256VERIFY at 0x100 on Base): pure functions of their input. */
const PRECOMPILES = new Set([...Array.from({ length: 0x11 }, (_, i) => i + 1), 0x100].map((n) => toHex(n, { size: 20 })));

/** The addresses whose state the token's own code may read with no finding, lowercase: itself, its
 *  implementation, its pool, the router (no storage) and the guard (no code). The rule expects them, and
 *  WETH and the factory, which only the router may reach; any other address touched is a block. So a
 *  token keeps what it reads in these alone: the later side carries every slot of theirs that others'
 *  transactions, re-executed after the buy, leave different (app/later.ts carry). */
export const ownedBy = (token: Address, implementation: Address | null, pair: Address | null, guard: Address) =>
  new Set([token, implementation, pair, ROUTER, guard].filter((a) => a).map((a) => a!.toLowerCase()));

/** Pure: the environment findings of a check (replay rejudges them). `touched`, `token_calls` and
 *  `token_balances` are null when nothing was traced (no pool: the check stopped before any sale). */
export function environmentFindings(
  f: { opcodes: string[]; touched: string[] | null; token_calls: string[] | null; token_balances: string[] | null; implementation: Address | null; liquidity: Liquidity },
  w: { token: Address; guard: Address },
): Finding[] {
  const out: Finding[] = [];
  if (f.opcodes.length) out.push({ level: "warn", text: `code reads ${f.opcodes.join(", ")}: values no simulation can match` });
  if (f.liquidity && !f.touched) out.push({ level: "warn", text: "the guard's transactions were not traced" });
  const expected = new Set([...ownedBy(w.token, f.implementation, f.liquidity?.pair ?? null, w.guard), WETH.toLowerCase(), FACTORY.toLowerCase()]);
  const odd = (f.touched ?? []).filter((a) => !expected.has(a) && !PRECOMPILES.has(a as Hex));
  if (odd.length) {
    const named = odd.slice(0, 3).map(short).join(", ") + (odd.length > 3 ? ` and ${odd.length - 3} more` : "");
    out.push({ level: "block", text: `reads ${named} during a transfer: state no simulation reproduces` });
  }
  const shared = (f.token_calls ?? []).filter((a) => a === WETH.toLowerCase() || a === FACTORY.toLowerCase());
  if (shared.length) out.push({ level: "block", text: `token calls or reads ${shared.map((a) => (a === WETH.toLowerCase() ? "WETH" : "the V2 factory")).join(" and ")} during a transfer: state all of Base moves` });
  const read = f.token_balances ?? [];
  if (read.length) out.push({ level: "block", text: `token reads the ETH balance of ${read.slice(0, 3).map((a) => (a === w.guard.toLowerCase() ? "the guard" : short(a))).join(", ")} during a transfer: a value no simulation can match` });
  return out;
}

type SimCall = { from: Address; to: Address; data: Hex; value?: Hex; nonce?: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type SimBlock = { blockOverrides: { number: Hex; time: Hex; baseFeePerGas: Hex; feeRecipient: Address }; stateOverrides?: Record<string, { balance?: Hex; stateDiff?: Record<string, Hex> }>; calls: SimCall[] };
/** Balance the trace adds to each sender beyond the simulation's: the local fork bills Base's L1 data fee
 *  on top of the gas, which eth_simulateV1 does not ask a balance for. */
export const TRACE_MARGIN = 10n ** 18n;

/** What the guard's buy wrote, as the trace mined it: each storage slot it changed (before, after) by
 *  contract, and each ETH balance it changed among the addresses it touched but the guard's (the later
 *  side gives the guard what its own calls spend); addresses lowercase, keys sorted. */
export type Diff = { storage: Record<string, Record<string, [Hex, Hex]>>; balance: Record<string, [Hex, Hex]> };
/** `touched`: every address the guard's transactions read or call; `calls`: what the token's own code
 *  reaches in them (REACH); `balances`: the addresses whose ETH balance it reads, itself aside; `diff`:
 *  what its buy wrote. */
export type Trace = { touched: Address[]; calls: Address[]; balances: Address[]; diff: Diff };
/** What a run's calls touch and what the token's code reaches in them (Trace without the buy's diff). */
export type Reach = Pick<Trace, "touched" | "calls" | "balances">;
type Account = { balance?: Hex; storage?: Record<string, Hex> };
/** A JS tracer (anvil runs geth's API) of what the token's code reaches: the target of each CALL,
 *  CALLCODE, DELEGATECALL, STATICCALL ("c:"), EXTCODESIZE, EXTCODECOPY, EXTCODEHASH ("c:") and BALANCE
 *  ("b:"), in every frame run in TOKEN's context (a proxy's implementation runs there) or running TOKEN's
 *  or IMPL's code, whatever its context: a plain call from the token to its implementation (an expected
 *  address) runs the implementation in its own. `code` holds each depth's code address: a frame's first
 *  step is one level below the step before it, and runs the code of the frame entered last (`next`, the
 *  transaction's own target at the top). A frame that runs no code (an EOA, a precompile, a call that
 *  fails before it starts, a SELFDESTRUCT) has no step: its `next` is dropped at the next step, and no
 *  enter without an exit can shift what the reads after it are charged to. */
const REACH = `{seen: {}, code: {}, next: null, last: -1, enter: function (f) { this.next = toHex(f.getTo()); }, exit: function () {}, step: function (log) {
  var depth = log.getDepth();
  if (depth > this.last) this.code[depth] = this.next === null ? toHex(log.contract.getAddress()) : this.next;
  this.last = depth;
  this.next = null;
  var op = log.op.toNumber();
  var at = op == 0x31 || op == 0x3b || op == 0x3c || op == 0x3f ? 0 : op == 0xf1 || op == 0xf2 || op == 0xf4 || op == 0xfa ? 1 : -1;
  if (at < 0) return;
  var context = toHex(log.contract.getAddress());
  var code = this.code[depth];
  if (context != "TOKEN" && code != "TOKEN" && code != "IMPL") return;
  this.seen[(op == 0x31 ? "b:" : "c:") + toHex(toAddress(log.stack.peek(at).toString(16)))] = true;
}, fault: function () {}, result: function () { return Object.keys(this.seen); }}`;
/** What the code of `token` and of its `implementation` reaches in mined transaction `hash` (REACH):
 *  [address, balance read]. */
export async function reachOf(url: string, hash: Hex, token: Address, implementation: Address | null): Promise<[string, boolean][]> {
  const tracer = REACH.replaceAll("TOKEN", token.toLowerCase()).replaceAll("IMPL", (implementation ?? token).toLowerCase());
  const seen = await rpc<string[]>(url, "debug_traceTransaction", [hash, { tracer }]);
  return seen.map((k) => [k.slice(2), k.startsWith("b:")]);
}

/** The far sales' runs (app/verifier.ts farBlocks, farRequest): the probe-side request, the far
 *  request, and `until`, the block of the late sale's approve: each side's blocks before it run first. */
export type FarRuns = { probe: Request; far: Request; until: number };

const blocksOf = (q: Request) => (q.params as [{ blockStateCalls: SimBlock[] }])[0].blockStateCalls;
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

/** Runs eth_simulateV1 blocks for real on the throwaway fork at `local`, recording what they touch and
 *  what the code of `token` and of its `implementation` reaches (Reach, `reach()`). */
function runner(local: string, token: Address, implementation: Address | null) {
  const call = <T>(method: string, params: unknown[]) => rpc<T>(local, method, params);
  const touched = new Set<string>();
  const [called, balances] = [new Set<string>(), new Set<string>()];
  /** Mines `run` on the fork from where it stands, its senders funded and impersonated as `side`'s first
   *  block says; a gap before a block is mined at once, empty. With `own`, records what each call touches
   *  and what the token's code reaches. Returns each call sent, in order, with the addresses it accessed,
   *  and a snapshot taken before block `pause` (a revert there keeps the state fetched before it). */
  const mine = async (run: SimBlock[], side: SimBlock[], own: boolean, pause = -1n) => {
    const set = new Map(Object.entries(side[0].stateOverrides ?? {}).map(([a, o]) => [a.toLowerCase(), o.balance]));
    const calls = run.flatMap((b) => b.calls);
    for (const s of new Set(calls.map((c) => c.from.toLowerCase()))) {
      const balance = BigInt(set.get(s) ?? (await call<Hex>("eth_getBalance", [s, "latest"])));
      await call("anvil_setBalance", [s, toHex(balance + TRACE_MARGIN)]);
      await call("anvil_impersonateAccount", [s]);
      const first = calls.find((c) => c.from.toLowerCase() === s)?.nonce;
      if (first) await call("anvil_setNonce", [s, first]);
    }
    const sent: { hash: Hex; accessed: Set<string> }[] = [];
    let paused: Hex | null = null;
    let at = BigInt((await call<{ number: Hex }>("eth_getBlockByNumber", ["latest", false])).number);
    for (const b of run) {
      const n = BigInt(b.blockOverrides.number);
      if (n <= at) throw new Error(`trace: block ${n} does not follow block ${at}`);
      if (n === pause) paused = await call<Hex>("evm_snapshot", []);
      // a far sale's gap: empty blocks, mined at once, their times the clock's (only BLOCKHASH, a
      // flagged opcode, sees them); the next block gets its own time below
      if (n > at + 1n) await call("anvil_mine", [toHex(n - at - 1n), "0x0"]);
      at = n;
      await call("evm_setNextBlockTimestamp", [b.blockOverrides.time]);
      if (!b.calls.length) {
        await call("evm_mine", []);
        continue;
      }
      await call("anvil_setNextBlockBaseFeePerGas", [b.blockOverrides.baseFeePerGas]);
      await call("anvil_setCoinbase", [b.blockOverrides.feeRecipient]);
      const hashes: Hex[] = [];
      for (const c of b.calls) {
        // Nonces run on from the first: the previews build the sales at the buy's (nothing is signed
        // before the buy), which only a node that checks them sees; no opcode reads a nonce.
        const tx = { from: c.from, to: c.to, data: c.data, value: c.value ?? "0x0", gas: c.gas, maxFeePerGas: c.maxFeePerGas, maxPriorityFeePerGas: c.maxPriorityFeePerGas };
        // A reverting call still returns the access list of what it ran, with an `error` field.
        const accessed = new Set<string>();
        if (own) for (const e of (await call<{ accessList: { address: Address }[] }>("eth_createAccessList", [tx, "pending"])).accessList) accessed.add(e.address.toLowerCase());
        for (const a of accessed) touched.add(a);
        hashes.push(await call<Hex>("eth_sendTransaction", [tx]));
        sent.push({ hash: hashes.at(-1)!, accessed });
      }
      await call("evm_mine", []);
      const mined = await call<{ number: Hex; transactions: unknown[] }>("eth_getBlockByNumber", ["latest", false]);
      if (BigInt(mined.number) !== n || mined.transactions.length !== b.calls.length) {
        throw new Error(`trace: block ${n} mined as ${BigInt(mined.number)} with ${mined.transactions.length} of ${b.calls.length} transactions`);
      }
      if (!own) continue;
      for (const h of hashes) {
        for (const [a, balance] of await reachOf(local, h, token, implementation)) if (!same(a, token)) (balance ? balances : called).add(a);
      }
    }
    return { sent, paused };
  };
  const reach = (): Reach => ({ touched: [...touched].sort() as Address[], calls: [...new Set([...called, ...balances])].sort() as Address[], balances: [...balances].sort() as Address[] });
  return { call, mine, reach };
}

/** The guard side's transactions run for real on a throwaway fork. `guard` is the guard-side
 *  eth_simulateV1 request as sent (app/verifier.ts buildRequest), `block` its base block, `token` the
 *  target and `implementation` its own. A throwaway anvil forks `url` at that block and replays the
 *  request: before each block, its time, base fee and coinbase; each call's access list taken at
 *  "pending" (the state after the calls before it, in that block), then the call sent as is (calldata,
 *  value, gas, fees) and what the token's code reaches traced (REACH); every block mined at its listed
 *  time, the empty ones too. So the sales run at their simulated block numbers and times on the state the
 *  buy left. The buy's own state change comes from prestateTracer's diff, its values read before and after
 *  its block. Not reproduced, and read only through ENV_OPCODES: the prevrandao, the gas price an access
 *  list sees, block hashes.
 *  With `far`, the far sales on the same fork, each from where its run starts: for the guard, back before
 *  its late approve, the empty blocks up to the far sale mined at once (anvil_mine: in memory, the last
 *  300 states kept), then its far approve and swap at their numbers and times, traced as above; then back
 *  at `block`, the probe side's buy and first sale at their blocks and times, and from there each of its
 *  far approves and swaps after its gap, not traced. `far` holds their results in farBlocks' order, as
 *  eth_simulateV1 gives them (resultOf). */
export async function trace(url: string, guard: Request, block: number, token: Address, implementation: Address | null, far?: FarRuns): Promise<Trace & { far: Result[] | null }> {
  const blocks = blocksOf(guard);
  const fork = await forkAt(url, block);
  const local = fork.url;
  const { call, mine, reach } = runner(local, token, implementation);
  try {
    const start = await call<Hex>("evm_snapshot", []);
    const guardSide = await mine(blocks, blocks, true, far ? BigInt(far.until) : -1n);
    const [buy] = guardSide.sent;
    if (!buy) throw new Error("trace: no transaction in the guard-side request");
    const sender = blocks[0].calls[0].from;
    // The buy is alone in the first block after `block`: its diff is that block's.
    const d = await call<{ pre: Record<string, Account>; post: Record<string, Account> }>("debug_traceTransaction", [buy.hash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }]);
    const [before, after] = [toHex(block), toHex(block + 1)];
    const diff: Diff = { storage: {}, balance: {} };
    for (const a of [...new Set([...Object.keys(d.pre), ...Object.keys(d.post)].map((x) => x.toLowerCase()))].sort()) {
      const of = (side: Record<string, Account>) => Object.entries(side).find(([x]) => same(x, a))?.[1] ?? {};
      for (const s of [...new Set([...Object.keys(of(d.pre).storage ?? {}), ...Object.keys(of(d.post).storage ?? {})])].sort()) {
        const [x, y] = await Promise.all([before, after].map((t) => call<Hex>("eth_getStorageAt", [a, s, t])));
        if (x !== y) (diff.storage[a] ??= {})[s] = [x, y];
      }
      if (same(sender, a) || !buy.accessed.has(a)) continue;
      const [x, y] = await Promise.all([before, after].map((t) => call<Hex>("eth_getBalance", [a, t])));
      if (BigInt(x) !== BigInt(y)) diff.balance[a] = [x, y];
    }
    let results: Result[] | null = null;
    if (far) {
      results = [];
      const all = blocksOf(far.far);
      const pairs = (bs: SimBlock[]) => bs.flatMap((b, i) => (i % 2 ? [] : [bs.slice(i, i + 2)])); // an approve, its swap
      const [guardFar, probeFar] = [pairs(all.slice(0, all.length / 2)), pairs(all.slice(all.length / 2))]; // farBlocks' order
      // The guard: back before its late approve (the state fetched so far kept), each far sale after a gap.
      let mark = guardSide.paused;
      for (const run of guardFar) {
        await call("evm_revert", [mark]);
        mark = await call<Hex>("evm_snapshot", []);
        for (const { hash } of (await mine(run, blocks, true)).sent) results.push(await resultOf(local, hash));
      }
      // The probe: back at `block`, its buy and first sale at their blocks, then each far sale from there.
      const probe = blocksOf(far.probe);
      await call("evm_revert", [start]);
      await mine(probe.filter((b) => b.calls.length && BigInt(b.blockOverrides.number) < BigInt(far.until)), probe, false);
      for (const run of probeFar) {
        mark = await call<Hex>("evm_snapshot", []);
        for (const { hash } of (await mine(run, probe, false)).sent) results.push(await resultOf(local, hash));
        await call("evm_revert", [mark]);
      }
    }
    return { ...reach(), diff, far: results };
  } finally {
    await fork.stop();
  }
}

/** The later side's request (app/later.ts laterSide) run for real like the guard side, on a throwaway
 *  fork of `url` at its base block, its state overrides set first (the buy's footprint, the balances):
 *  what its sales touch on Base's later state and what the token's code reaches there, joined to `seen`
 *  (the guard side's and the far sales'). A token that acts otherwise on that state alone is judged by
 *  the same rule. */
export async function traceLater(url: string, later: Request, token: Address, implementation: Address | null, seen: Reach): Promise<Reach> {
  const blocks = blocksOf(later);
  const fork = await forkAt(url, Number(BigInt(later.params[1] as Hex)));
  try {
    const { call, mine, reach } = runner(fork.url, token, implementation);
    for (const [a, o] of Object.entries(blocks[0].stateOverrides ?? {})) {
      if (o.balance) await call("anvil_setBalance", [a, o.balance]);
      for (const [s, v] of Object.entries(o.stateDiff ?? {})) await call("anvil_setStorageAt", [a, s, v]);
    }
    await mine(blocks, blocks, true);
    const r = reach();
    const join = (x: Address[], y: Address[]) => [...new Set([...x, ...y])].sort() as Address[];
    return { touched: join(seen.touched, r.touched), calls: join(seen.calls, r.calls), balances: join(seen.balances, r.balances) };
  } finally {
    await fork.stop();
  }
}

type Frame = { type: string; from: Address; to?: Address; value?: Hex; output?: Hex; error?: string; calls?: Frame[] };
const TRANSFER = keccak256(stringToHex("Transfer(address,address,uint256)"));
/** A mined transaction as eth_simulateV1 with traceTransfers reports a call: its status, its return (or
 *  revert) data, its logs, then each ETH transfer of a frame that did not revert as a Transfer log of
 *  ETH_LOGS (every frame type but DELEGATECALL, as geth's). */
export async function resultOf(url: string, hash: Hex): Promise<Result> {
  const receipt = await rpc<{ status: Hex; logs: Log[] }>(url, "eth_getTransactionReceipt", [hash]);
  const top = await rpc<Frame>(url, "debug_traceTransaction", [hash, { tracer: "callTracer" }]);
  const eth: Log[] = [];
  const walk = (f: Frame) => {
    if (f.error) return; // a frame that reverted moved nothing
    if (f.type !== "DELEGATECALL" && f.to && BigInt(f.value ?? "0x0") > 0n) eth.push({ address: ETH_LOGS, topics: [TRANSFER, pad(f.from), pad(f.to)], data: toHex(BigInt(f.value!), { size: 32 }) });
    for (const c of f.calls ?? []) walk(c);
  };
  walk(top);
  return { status: receipt.status, returnData: top.output ?? "0x", logs: [...receipt.logs.map(({ address, topics, data }) => ({ address, topics, data })), ...eth] };
}

/** A throwaway anvil forking `url` at `block`, mining only when asked, transactions in the order sent.
 *  Nothing on disk: block states stay in memory (--prune-history, the last 300: the trace reads the buy's,
 *  up to 256 blocks back), the fork's RPC cache is off, and the directory anvil would keep states in is
 *  ours, removed by `stop` (anvil leaves its own behind when killed). */
export async function forkAt(url: string, block: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = freePort();
  const dir = await mkdtemp(join(tmpdir(), "goblin-anvil-"));
  const anvil = Bun.spawn(
    ["anvil", "--fork-url", url, "--fork-block-number", String(block), "--port", String(port), "--no-mining", "--order", "fifo", "--no-storage-caching", "--prune-history", "300", "--cache-path", dir, "--silent"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stop = async () => {
    anvil.kill();
    await anvil.exited;
    await rm(dir, { recursive: true, force: true });
  };
  const local = `http://127.0.0.1:${port}`;
  try {
    await ready(local, anvil);
  } catch (e) {
    await stop();
    throw e;
  }
  return { url: local, stop };
}

/** A port nobody listens on now. */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Waits until the local anvil answers (forking a remote node can take seconds), or throws with its error. */
async function ready(url: string, anvil: { exitCode: number | null; stderr: ReadableStream<Uint8Array> }): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < 120; i++) {
    if (anvil.exitCode !== null) throw new Error(`trace: anvil exited (${(await new Response(anvil.stderr).text()).trim().split("\n")[0]})`);
    try {
      await rpc<Hex>(url, "eth_chainId", []);
      return;
    } catch (e) {
      last = e; // not listening yet: retried, and reported if it never does
      await Bun.sleep(250);
    }
  }
  throw new Error(`trace: anvil did not answer within 30 s (${last instanceof Error ? last.message : String(last)})`);
}
