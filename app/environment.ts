// The environment rule: a token whose transfers depend on anything the simulation cannot reproduce is
// not allowed. eth_simulateV1 never runs Base's per-block system update (the L1 attributes deposit that
// rewrites the L1Block predeploy, the fee vaults' credits) and cannot know a future block's fields. Rather
// than guess the next tell, two facts close the class, both in the evidence and recomputed by replay:
// - `touched`: every address the guard's own transactions read or call, at any depth (BALANCE,
//   EXTCODESIZE, EXTCODEHASH, EXTCODECOPY, CALL, STATICCALL, DELEGATECALL, CALLCODE). Anything outside the
//   token, its implementation, its pool, the router, WETH, the factory, the guard and the precompiles is a
//   block: L1Block, a fee vault, the coinbase, a helper contract, a library. The code that runs during
//   the guard's transactions is then only the token's, its implementation's and the Uniswap contracts'.
// - `opcodes`: the opcodes of the token's and its implementation's reachable code whose value no
//   simulation can guarantee: at least a warn, the owner decides.
// TIMESTAMP and NUMBER stay allowed: the simulated blocks follow Base's cadence up to the late sale (400 to
// 510 s after the buy, derived per check), and the sales there exercise them.
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

/** Pure: the environment findings of a check (replay rejudges them). `touched` is null when nothing was
 *  traced (no pool: the check stopped before any sale). */
export function environmentFindings(f: { opcodes: string[]; touched: string[] | null; implementation: Address | null; liquidity: Liquidity }, w: { token: Address; guard: Address }): Finding[] {
  const out: Finding[] = [];
  if (f.opcodes.length) out.push({ level: "warn", text: `code reads ${f.opcodes.join(", ")}: values no simulation can match` });
  if (f.liquidity && !f.touched) out.push({ level: "warn", text: "the guard's transactions were not traced" });
  const expected = new Set([w.token, f.implementation, f.liquidity?.pair, ROUTER, WETH, FACTORY, w.guard].filter((a) => a).map((a) => a!.toLowerCase()));
  const odd = (f.touched ?? []).filter((a) => !expected.has(a) && !PRECOMPILES.has(a as Hex));
  if (odd.length) {
    const named = odd.slice(0, 3).map(short).join(", ") + (odd.length > 3 ? ` and ${odd.length - 3} more` : "");
    out.push({ level: "block", text: `reads ${named} during a transfer: state no simulation reproduces` });
  }
  return out;
}

type SimCall = { from: Address; to: Address; data: Hex; value?: Hex; nonce?: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type SimBlock = { blockOverrides: { number: Hex; time: Hex; baseFeePerGas: Hex; feeRecipient: Address }; stateOverrides?: Record<string, { balance: Hex }>; calls: SimCall[] };
/** Balance the trace adds to each sender beyond the simulation's: the local fork bills Base's L1 data fee
 *  on top of the gas, which eth_simulateV1 does not ask a balance for. */
const TRACE_MARGIN = 10n ** 18n;

/** Every address the guard side's transactions touch (eth_createAccessList), lowercase, sorted. `guard`
 *  is the guard-side eth_simulateV1 request as sent (app/verifier.ts buildRequest), `block` its base
 *  block. A throwaway anvil forks `url` at that block and replays the request for real: before each
 *  block, its time, base fee and coinbase; each call's access list taken at "pending" (the state after
 *  the calls before it, in that block), then the call sent as is (calldata, value, gas, fees);
 *  the empty blocks in between mined at 2 s. So the sales run at their simulated block numbers and times
 *  on the state the buy left. Not reproduced, and read only through ENV_OPCODES: the prevrandao, the
 *  gas price an access list sees, block hashes. */
export async function touched(url: string, guard: Request, block: number): Promise<Address[]> {
  const [{ blockStateCalls: blocks }] = guard.params as [{ blockStateCalls: SimBlock[] }];
  const port = freePort();
  const anvil = Bun.spawn(["anvil", "--fork-url", url, "--fork-block-number", String(block), "--port", String(port), "--no-mining", "--order", "fifo", "--no-storage-caching", "--silent"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const local = `http://127.0.0.1:${port}`;
  const call = <T>(method: string, params: unknown[]) => rpc<T>(local, method, params);
  try {
    await ready(local, anvil);
    const set = new Map(Object.entries(blocks[0].stateOverrides ?? {}).map(([a, o]) => [a.toLowerCase(), o.balance]));
    const calls = blocks.flatMap((b) => b.calls);
    for (const s of new Set(calls.map((c) => c.from.toLowerCase()))) {
      const balance = BigInt(set.get(s) ?? (await call<Hex>("eth_getBalance", [s, "latest"])));
      await call("anvil_setBalance", [s, toHex(balance + TRACE_MARGIN)]);
      await call("anvil_impersonateAccount", [s]);
      const first = calls.find((c) => c.from.toLowerCase() === s)?.nonce;
      if (first) await call("anvil_setNonce", [s, first]);
    }
    const out = new Set<string>();
    let at = BigInt(block);
    for (const b of blocks) {
      if (!b.calls.length) continue;
      const n = BigInt(b.blockOverrides.number);
      if (n - at > 1n) {
        // the empty blocks before this one, 2 s apart, ending 2 s before it
        await call("evm_setNextBlockTimestamp", [toHex(BigInt(b.blockOverrides.time) - 2n * (n - at - 1n))]);
        await call("anvil_mine", [toHex(n - at - 1n), "0x2"]);
      }
      await call("evm_setNextBlockTimestamp", [b.blockOverrides.time]);
      await call("anvil_setNextBlockBaseFeePerGas", [b.blockOverrides.baseFeePerGas]);
      await call("anvil_setCoinbase", [b.blockOverrides.feeRecipient]);
      for (const c of b.calls) {
        // Nonces run on from the first: the previews build the sales at the buy's (nothing is signed
        // before the buy), which only a node that checks them sees; no opcode reads a nonce.
        const tx = { from: c.from, to: c.to, data: c.data, value: c.value ?? "0x0", gas: c.gas, maxFeePerGas: c.maxFeePerGas, maxPriorityFeePerGas: c.maxPriorityFeePerGas };
        // A reverting call still returns the access list of what it ran, with an `error` field.
        const r = await call<{ accessList: { address: Address }[] }>("eth_createAccessList", [tx, "pending"]);
        for (const e of r.accessList) out.add(e.address.toLowerCase());
        await call("eth_sendTransaction", [tx]);
      }
      await call("evm_mine", []);
      const mined = await call<{ number: Hex; transactions: unknown[] }>("eth_getBlockByNumber", ["latest", false]);
      if (BigInt(mined.number) !== n || mined.transactions.length !== b.calls.length) {
        throw new Error(`trace: block ${n} mined as ${BigInt(mined.number)} with ${mined.transactions.length} of ${b.calls.length} transactions`);
      }
      at = n;
    }
    return [...out].sort() as Address[];
  } finally {
    anvil.kill();
    await anvil.exited;
  }
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
