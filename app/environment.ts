// The environment rule: a token whose transfers depend on anything the simulation cannot reproduce is
// not allowed. eth_simulateV1 never runs Base's per-block system update (the L1 attributes deposit that
// rewrites the L1Block predeploy, the fee vaults' credits) and cannot know a future block's fields. Rather
// than guess the next tell, three facts close the class, all in the evidence and recomputed by replay:
// - `touched`: every address the guard's own transactions read or call, at any depth (BALANCE,
//   EXTCODESIZE, EXTCODEHASH, EXTCODECOPY, CALL, STATICCALL, DELEGATECALL, CALLCODE). Anything outside the
//   token, its implementation, its pool, the router, WETH, the factory, the guard and the precompiles is a
//   block: L1Block, a fee vault, the coinbase, a helper contract, a library. The code that runs during
//   the guard's transactions is then only the token's, its implementation's and the Uniswap contracts'.
// - `token_calls`: what the token's own code reaches: the addresses it calls, or whose code or ETH balance
//   it reads (BALANCE, EXTCODE*), in any of its frames (its implementation's run in its context). WETH and
//   the factory are on the list above for the router's sake, yet all of Base moves their state (measured
//   on 2026-11-12: WETH's supply moved in 160 of 600 blocks, 2 min; the factory got 16 pairs in an hour):
//   a token that reaches either one is a block, whether or not that state moved during the check.
// - `token_balances`: the addresses whose ETH balance the token's own code reads, itself aside: a block.
//   Others' balances move with all of Base, and the guard's own with the L1 fee no simulation bills.
// - `opcodes`: the opcodes of the token's and its implementation's reachable code whose value no
//   simulation can guarantee: at least a warn, the owner decides.
// TIMESTAMP and NUMBER stay allowed: the simulated blocks follow the cadence measured at the check up to
// the late sale (30 to 50 s after the buy, derived per check), and the sales there exercise them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes, toHex, type Address, type Hex } from "viem";
import { FACTORY, ROUTER, rpc, short, WETH, type Finding, type Liquidity, type Request } from "./verifier";

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

/** Pure: the environment findings of a check (replay rejudges them). `touched`, `token_calls` and
 *  `token_balances` are null when nothing was traced (no pool: the check stopped before any sale). */
export function environmentFindings(
  f: { opcodes: string[]; touched: string[] | null; token_calls: string[] | null; token_balances: string[] | null; implementation: Address | null; liquidity: Liquidity },
  w: { token: Address; guard: Address },
): Finding[] {
  const out: Finding[] = [];
  if (f.opcodes.length) out.push({ level: "warn", text: `code reads ${f.opcodes.join(", ")}: values no simulation can match` });
  if (f.liquidity && !f.touched) out.push({ level: "warn", text: "the guard's transactions were not traced" });
  const expected = new Set([w.token, f.implementation, f.liquidity?.pair, ROUTER, WETH, FACTORY, w.guard].filter((a) => a).map((a) => a!.toLowerCase()));
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
type SimBlock = { blockOverrides: { number: Hex; time: Hex; baseFeePerGas: Hex; feeRecipient: Address }; stateOverrides?: Record<string, { balance: Hex }>; calls: SimCall[] };
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
type Account = { balance?: Hex; storage?: Record<string, Hex> };
/** A JS tracer (anvil runs geth's API) of what code running in TOKEN's context reaches: the target of
 *  each CALL, CALLCODE, DELEGATECALL, STATICCALL ("c:"), EXTCODESIZE, EXTCODECOPY, EXTCODEHASH ("c:") and
 *  BALANCE ("b:"). An implementation's code runs in its proxy's context: the token's own. */
const REACH = `{seen: {}, step: function (log) {
  var op = log.op.toNumber();
  var at = op == 0x31 || op == 0x3b || op == 0x3c || op == 0x3f ? 0 : op == 0xf1 || op == 0xf2 || op == 0xf4 || op == 0xfa ? 1 : -1;
  if (at < 0 || toHex(log.contract.getAddress()) != "TOKEN") return;
  this.seen[(op == 0x31 ? "b:" : "c:") + toHex(toAddress(log.stack.peek(at).toString(16)))] = true;
}, fault: function () {}, result: function () { return Object.keys(this.seen); }}`;
/** What the code in `token`'s context reaches in mined transaction `hash` (REACH): [address, balance read]. */
export async function reachOf(url: string, hash: Hex, token: Address): Promise<[string, boolean][]> {
  const seen = await rpc<string[]>(url, "debug_traceTransaction", [hash, { tracer: REACH.replace("TOKEN", token.toLowerCase()) }]);
  return seen.map((k) => [k.slice(2), k.startsWith("b:")]);
}

/** The guard side's transactions run for real on a throwaway fork. `guard` is the guard-side
 *  eth_simulateV1 request as sent (app/verifier.ts buildRequest), `block` its base block, `token` the
 *  target. A throwaway anvil forks `url` at that block and replays the request: before each block, its
 *  time, base fee and coinbase; each call's access list taken at "pending" (the state after the calls
 *  before it, in that block), then the call sent as is (calldata, value, gas, fees) and what the token's
 *  code reaches traced (REACH); every block mined at its listed time, the empty ones too. So the sales run
 *  at their simulated block numbers and times on the state the buy left. The buy's own state change comes from prestateTracer's
 *  diff, its values read before and after its block. Not reproduced, and read only through ENV_OPCODES:
 *  the prevrandao, the gas price an access list sees, block hashes. */
export async function trace(url: string, guard: Request, block: number, token: Address): Promise<Trace> {
  const [{ blockStateCalls: blocks }] = guard.params as [{ blockStateCalls: SimBlock[] }];
  const fork = await forkAt(url, block);
  const local = fork.url;
  const call = <T>(method: string, params: unknown[]) => rpc<T>(local, method, params);
  const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  try {
    const set = new Map(Object.entries(blocks[0].stateOverrides ?? {}).map(([a, o]) => [a.toLowerCase(), o.balance]));
    const calls = blocks.flatMap((b) => b.calls);
    const sender = calls[0].from;
    for (const s of new Set(calls.map((c) => c.from.toLowerCase()))) {
      const balance = BigInt(set.get(s) ?? (await call<Hex>("eth_getBalance", [s, "latest"])));
      await call("anvil_setBalance", [s, toHex(balance + TRACE_MARGIN)]);
      await call("anvil_impersonateAccount", [s]);
      const first = calls.find((c) => c.from.toLowerCase() === s)?.nonce;
      if (first) await call("anvil_setNonce", [s, first]);
    }
    const touched = new Set<string>();
    const [called, balances] = [new Set<string>(), new Set<string>()];
    let buy: { hash: Hex; accessed: Set<string> } | null = null;
    let at = BigInt(block);
    for (const b of blocks) {
      const n = BigInt(b.blockOverrides.number);
      if (n !== at + 1n) throw new Error(`trace: block ${n} does not follow block ${at}`);
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
        const r = await call<{ accessList: { address: Address }[] }>("eth_createAccessList", [tx, "pending"]);
        for (const e of r.accessList) touched.add(e.address.toLowerCase());
        hashes.push(await call<Hex>("eth_sendTransaction", [tx]));
        buy ??= { hash: hashes[0], accessed: new Set(r.accessList.map((e) => e.address.toLowerCase())) };
      }
      await call("evm_mine", []);
      const mined = await call<{ number: Hex; transactions: unknown[] }>("eth_getBlockByNumber", ["latest", false]);
      if (BigInt(mined.number) !== n || mined.transactions.length !== b.calls.length) {
        throw new Error(`trace: block ${n} mined as ${BigInt(mined.number)} with ${mined.transactions.length} of ${b.calls.length} transactions`);
      }
      for (const h of hashes) {
        for (const [a, balance] of await reachOf(local, h, token)) if (!same(a, token)) (balance ? balances : called).add(a);
      }
    }
    if (!buy) throw new Error("trace: no transaction in the guard-side request");
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
    return { touched: [...touched].sort() as Address[], calls: [...new Set([...called, ...balances])].sort() as Address[], balances: [...balances].sort() as Address[], diff };
  } finally {
    await fork.stop();
  }
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
