// The environment rule (app/environment.ts): opcodes no simulation can match, and the addresses the
// guard's transactions touch. Real code is read from the local copy of Base (run evm/fork.sh first).
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { envOpcodes, environmentFindings, reachOf } from "./environment";
import { FACTORY, implementationAt, ROUTER, rpc, WETH } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const codeOf = (a: string) => rpc<Hex>(RPC, "eth_getCode", [a, "latest"]);

describe("opcodes no simulation can match, in reachable code only (pure)", () => {
  test("found in code: ORIGIN, GASPRICE, BASEFEE, PREVRANDAO, COINBASE, BLOCKHASH", () => {
    expect(envOpcodes("0x3250 3a50 4850 4450 4150 4050 00".replaceAll(" ", "") as Hex)).toEqual(["BASEFEE", "BLOCKHASH", "COINBASE", "GASPRICE", "ORIGIN", "PREVRANDAO"]);
  });
  test("GAS, TIMESTAMP, NUMBER, SELFBALANCE, BALANCE, EXTCODEHASH: none (GAS allowed, the others judged on what the traced transactions executed or touched)", () => {
    expect(envOpcodes("0x5a50 4250 4350 4750 5f3150 5f3f50 00".replaceAll(" ", "") as Hex)).toEqual([]);
  });
  test("a PUSH operand is data: 0x48 inside a PUSH2 is not BASEFEE", () => expect(envOpcodes("0x614848 50 00".replaceAll(" ", "") as Hex)).toEqual([]));
  test("bytes after a halt are data until a JUMPDEST: a revert string's 'H' is not BASEFEE, code after a JUMPDEST is", () => {
    expect(envOpcodes("0x00 48 44 41".replaceAll(" ", "") as Hex)).toEqual([]);
    expect(envOpcodes("0x5f5ffd 48 5b 32 00".replaceAll(" ", "") as Hex)).toEqual(["ORIGIN"]);
  });
  test("solc's CBOR metadata tail is not code", () => {
    const meta = "a1" + "48".repeat(4); // a CBOR map whose bytes read as BASEFEE
    expect(envOpcodes(`0x00${meta}0005` as Hex)).toEqual([]);
  });
  // A tail shaped like solc's metadata is skipped only when nothing can run it.
  test("a metadata-shaped tail holding a JUMPDEST the code jumps to is code", () => {
    // PUSH1 4, JUMP | tail: a1 (CBOR map), JUMPDEST, BASEFEE, STOP, then its length 0x0004
    expect(envOpcodes("0x600456 a15b4800 0004".replaceAll(" ", "") as Hex)).toEqual(["BASEFEE"]);
  });
  test("a metadata-shaped tail the code falls through into is code", () => {
    expect(envOpcodes("0x5b a148 0002".replaceAll(" ", "") as Hex)).toEqual(["BASEFEE"]);
  });
});

describe("real code (forked from Base mainnet)", () => {
  test("USDC, its implementation and WETH: no opcode no simulation can match", async () => {
    const impl = await implementationAt(RPC, tokens.usdc as Address, BigInt(await rpc<Hex>(RPC, "eth_blockNumber", [])));
    expect(impl).not.toBeNull();
    for (const a of [tokens.usdc, impl!, WETH]) expect(envOpcodes(await codeOf(a))).toEqual([]);
  });
  test("the Uniswap V2 router: none (its revert strings are data, not COINBASE or BASEFEE)", async () => expect(envOpcodes(await codeOf(ROUTER))).toEqual([]));
  test("the demo traps that read tx.origin or the fee fields are found; RedL1Trap reads none (the addresses touched catch it)", async () => {
    expect(envOpcodes(await codeOf(tokens.judge_trap))).toEqual(["ORIGIN"]);
    expect(envOpcodes(await codeOf(tokens.sim_detector))).toEqual(["BASEFEE", "GASPRICE"]);
    expect(envOpcodes(await codeOf(tokens.basefee_trap))).toEqual(["BASEFEE"]);
    expect(envOpcodes(await codeOf(tokens.red_l1_trap))).toEqual([]);
    expect(envOpcodes(await codeOf(tokens.safe))).toEqual([]); // the healthy demo token
  });
});

describe("addresses the guard's transactions touch (pure)", () => {
  const w = { token: "0x00000000000000000000000000000000000000a1" as Address, guard: "0x00000000000000000000000000000000000000a2" as Address };
  const pair = "0x00000000000000000000000000000000000000a3" as Address;
  const liquidity = { pair, supply: "1", supply_before: "1", created: null, candidates: 0, holders: null };
  const facts = (touched: string[] | null, opcodes: string[] = [], token_calls: string[] | null = [], token_balances: string[] | null = [], token_opcodes: string[] | null = []) => ({ opcodes, touched, token_calls, token_balances, token_opcodes, implementation: null as Address | null, liquidity });
  test("token, pool, router, WETH, guard and precompiles: no finding", () => {
    expect(environmentFindings(facts([w.token, pair, ROUTER.toLowerCase(), WETH.toLowerCase(), w.guard, "0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000100"]), w)).toEqual([]);
  });
  test("the L1Block predeploy: block, naming it", () => {
    expect(environmentFindings(facts([w.token, "0x4200000000000000000000000000000000000015"]), w)).toEqual([{ level: "block", text: "reads 0x4200..0015 during a transfer: state no simulation reproduces" }]);
  });
  test("the coinbase (Base's sequencer fee vault) is not expected: its balance moves every block", () => {
    expect(environmentFindings(facts(["0x4200000000000000000000000000000000000011"]), w)[0]?.level).toBe("block");
  });
  test("an opcode: warn, naming it", () => {
    expect(environmentFindings(facts([], ["BASEFEE", "ORIGIN"]), w)).toEqual([{ level: "warn", text: "code reads BASEFEE, ORIGIN: values no simulation can match" }]);
  });
  test("a pool but no trace: warn, never a pass", () => expect(environmentFindings(facts(null), w)[0]?.level).toBe("warn"));
  // Judge pass 8: WETH and the factory are on the list for the router's sake; the token's own code
  // calling either reads state all of Base moves, which a check's window may not see move.
  test("the token's code calls or reads WETH, or the factory: block, naming them", () => {
    expect(environmentFindings(facts([w.token, WETH.toLowerCase()], [], [WETH.toLowerCase()]), w)).toEqual([{ level: "block", text: "token calls or reads WETH during a transfer: state all of Base moves" }]);
    expect(environmentFindings(facts([w.token], [], [WETH.toLowerCase(), FACTORY.toLowerCase()]), w)[0]?.text).toBe("token calls or reads WETH and the V2 factory during a transfer: state all of Base moves");
  });
  // Review of 47bbf28: the later side no longer moves the guard's ETH balance, and no simulation bills
  // its L1 fee; others' balances move with all of Base. Reading any is a block.
  test("the token's code reads an ETH balance, the guard's or another's: block, naming it", () => {
    expect(environmentFindings(facts([w.token], [], [w.guard], [w.guard]), w)).toEqual([{ level: "block", text: "token reads the ETH balance of the guard during a transfer: a value no simulation can match" }]);
    expect(environmentFindings(facts([w.token], [], [WETH.toLowerCase()], [WETH.toLowerCase()]), w).map((f) => f.text)).toEqual([
      "token calls or reads WETH during a transfer: state all of Base moves",
      "token reads the ETH balance of 0x4200..0006 during a transfer: a value no simulation can match",
    ]);
  });
  // The step-up, rule 1: the token's own code may call its implementation and the precompiles, nothing
  // else. Its pool gives it reserves any trade moves, and a clock (sync, then getReserves).
  test("the token's code calls its implementation: no finding", () => {
    const impl = "0x00000000000000000000000000000000000000a4" as Address;
    expect(environmentFindings({ ...facts([w.token, impl], [], [impl]), implementation: impl }, w)).toEqual([]);
  });
  test("the token's code calls or reads its pool, the router or the guard: warn, naming them", () => {
    expect(environmentFindings(facts([w.token, pair], [], [pair]), w)).toEqual([{ level: "warn", text: "token calls or reads its pool during a transfer: reserves and a clock any trade moves" }]);
    expect(environmentFindings(facts([w.token], [], [pair, ROUTER.toLowerCase(), w.guard]), w)[0]?.text).toBe("token calls or reads its pool, the router, the guard during a transfer: reserves and a clock any trade moves");
    expect(environmentFindings(facts([w.token], [], [w.guard]), w)).toEqual([{ level: "warn", text: "token calls or reads the guard during a transfer: outside its implementation and the precompiles" }]);
  });
  // Rule 2: what its code executed on the guard's transactions, not what its bytecode holds.
  test("the token's code executes TIMESTAMP, NUMBER or SELFBALANCE there: warn, naming them", () => {
    expect(environmentFindings(facts([w.token], [], [], [], ["NUMBER", "TIMESTAMP"]), w)).toEqual([{ level: "warn", text: "token reads NUMBER, TIMESTAMP during a transfer: it can act otherwise after the check's last sale" }]);
    expect(environmentFindings(facts([w.token], [], [], [], ["SELFBALANCE"]), w)[0]?.level).toBe("warn");
  });
  // Init code runs at a new address, outside the token's frames and outside any access list.
  test("the token's code creates a contract there: block, beside the warn for what it read", () => {
    expect(environmentFindings(facts([w.token], [], [], [], ["CREATE"]), w)).toEqual([{ level: "block", text: "token creates a contract during a transfer: code no rule reads" }]);
    expect(environmentFindings(facts([w.token], [], [], [], ["CREATE2", "NUMBER"]), w).map((f) => f.level)).toEqual(["warn", "block"]);
  });
});

// Review of 47bbf28: the token's frames were read from callTracer, which shows calls only; a token can
// read WETH's or the guard's state without a call (BALANCE, EXTCODE*). Two contracts set on the fork: an
// implementation that reads its caller's balance and WETH's code hash, and a proxy delegating to it.
describe("what the token's own code reaches, in its context, implementation included", () => {
  const impl = "0x00000000000000000000000000000000000c0de1" as Address;
  const proxy = "0x00000000000000000000000000000000000c0de2" as Address;
  const caller = "0x00000000000000000000000000000000000ca11e" as Address;
  test("BALANCE of the caller and EXTCODEHASH of WETH, run by the implementation in the proxy's context", async () => {
    const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
    try {
      await rpc(RPC, "anvil_setCode", [impl, `0x333150${"73"}${WETH.slice(2)}3f5000`]); // BALANCE(CALLER), EXTCODEHASH(WETH)
      await rpc(RPC, "anvil_setCode", [proxy, `0x6000600060006000${"73"}${impl.slice(2)}5af45000`]); // DELEGATECALL(impl)
      await rpc(RPC, "anvil_setBalance", [caller, toHex(parseEther("1"))]);
      await rpc(RPC, "anvil_impersonateAccount", [caller]);
      const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from: caller, to: proxy, data: "0x", gas: toHex(100_000) }]);
      for (let i = 0; i < 50 && !(await rpc<unknown>(RPC, "eth_getTransactionReceipt", [hash])); i++) await Bun.sleep(100);
      const sorted = (x: [string, boolean][]) => x.map(([a, b]) => `${a}:${b}`).sort();
      expect(sorted((await reachOf(RPC, hash, proxy, impl)).reads)).toEqual(sorted([[impl, false], [caller, true], [WETH.toLowerCase(), false]]));
    } finally {
      await rpc(RPC, "evm_revert", [snapshot]);
    }
  });
  // Review of 73a7ad2: the tracer read only frames in the token's context, so a token could do the read in
  // its implementation's own context, with a plain call to it (an expected address). Its code counts
  // wherever it runs.
  test("the same reads by the implementation in its own context, after a STATICCALL from the proxy: recorded", async () => {
    const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
    try {
      await rpc(RPC, "anvil_setCode", [impl, `0x73${caller.slice(2)}315073${WETH.slice(2)}3f5000`]); // BALANCE(caller), EXTCODEHASH(WETH)
      await rpc(RPC, "anvil_setCode", [proxy, `0x6000600060006000${"73"}${impl.slice(2)}5afa5000`]); // STATICCALL(impl)
      await rpc(RPC, "anvil_setBalance", [caller, toHex(parseEther("1"))]);
      await rpc(RPC, "anvil_impersonateAccount", [caller]);
      const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from: caller, to: proxy, data: "0x", gas: toHex(100_000) }]);
      for (let i = 0; i < 50 && !(await rpc<unknown>(RPC, "eth_getTransactionReceipt", [hash])); i++) await Bun.sleep(100);
      const sorted = (x: [string, boolean][]) => x.map(([a, b]) => `${a}:${b}`).sort();
      expect(sorted((await reachOf(RPC, hash, proxy, impl)).reads)).toEqual(sorted([[impl, false], [caller, true], [WETH.toLowerCase(), false]]));
    } finally {
      await rpc(RPC, "evm_revert", [snapshot]);
    }
  });
  // Automated review of 100ceaf: a stack of code addresses pushed on enter and popped on exit loses its
  // place if a frame enters without exiting (a call that fails before it runs, a SELFDESTRUCT); the reads
  // after it would be charged to the wrong code. Frames are now told apart by their depth.
  test("the same reads by the implementation in its own context, after a call that fails early, one to a precompile or an EOA, a SELFDESTRUCT or a failed CREATE: recorded", async () => {
    const dier = "0x00000000000000000000000000000000000c0de3" as Address;
    const bad = "0x0000000000000000000000000000000000000bad";
    /** CALL(gas, to, value, 0, 0, 0, 0), POP; `value` a PUSH. */
    const callTo = (to: string, value: string) => `6000600060006000${value}73${to.slice(2).padStart(40, "0")}5af150`;
    const before = {
      "value above the balance": callTo(bad, "68010000000000000000"), // PUSH9 2^64 wei: fails before it runs
      precompile: callTo("0x0000000000000000000000000000000000000001", "6000"),
      EOA: callTo(bad, "6000"),
      "SELFDESTRUCT in a sub-call": callTo(dier, "6000"),
      "CREATE above the balance": "6000600068010000000000000000f050",
      "CREATE2 collision": "6000600060006000f5506000600060006000f550",
    };
    for (const [name, prefix] of Object.entries(before)) {
      const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
      try {
        await rpc(RPC, "anvil_setCode", [impl, `0x${prefix}73${caller.slice(2)}315073${WETH.slice(2)}3f5000`]); // ..., BALANCE(caller), EXTCODEHASH(WETH)
        await rpc(RPC, "anvil_setCode", [dier, `0x73${caller.slice(2)}ff`]); // SELFDESTRUCT(caller)
        await rpc(RPC, "anvil_setCode", [proxy, `0x6000600060006000600073${impl.slice(2)}5af15000`]); // CALL(impl): its own context
        await rpc(RPC, "anvil_setBalance", [caller, toHex(parseEther("1"))]);
        await rpc(RPC, "anvil_impersonateAccount", [caller]);
        const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from: caller, to: proxy, data: "0x", gas: toHex(200_000) }]);
        for (let i = 0; i < 50 && !(await rpc<unknown>(RPC, "eth_getTransactionReceipt", [hash])); i++) await Bun.sleep(100);
        const seen = (await reachOf(RPC, hash, proxy, impl)).reads.map(([a, b]) => `${a}:${b}`);
        expect([name, seen.includes(`${caller}:true`) && seen.includes(`${WETH.toLowerCase()}:false`)]).toEqual([name, true]);
      } finally {
        await rpc(RPC, "evm_revert", [snapshot]);
      }
    }
  });
  // The step-up, rule 2: TIMESTAMP, NUMBER and SELFBALANCE the token's own frames execute, in its context
  // or its implementation's own; code that holds one in a branch the transaction never takes ran none.
  const ran = async (implCode: string, proxyCode: string) => {
    const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
    try {
      await rpc(RPC, "anvil_setCode", [impl, `0x${implCode}`]);
      await rpc(RPC, "anvil_setCode", [proxy, `0x${proxyCode}`]);
      await rpc(RPC, "anvil_setBalance", [caller, toHex(parseEther("1"))]);
      await rpc(RPC, "anvil_impersonateAccount", [caller]);
      const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from: caller, to: proxy, data: "0x", gas: toHex(100_000) }]);
      for (let i = 0; i < 50 && !(await rpc<unknown>(RPC, "eth_getTransactionReceipt", [hash])); i++) await Bun.sleep(100);
      return await reachOf(RPC, hash, proxy, impl);
    } finally {
      await rpc(RPC, "evm_revert", [snapshot]);
    }
  };
  const delegate = `6000600060006000${"73"}${impl.slice(2)}5af45000`; // DELEGATECALL(impl)
  const plain = `6000600060006000600073${impl.slice(2)}5af15000`; // CALL(impl): its own context
  test("TIMESTAMP, NUMBER and SELFBALANCE run by the implementation, in the proxy's context or its own: recorded, sorted", async () => {
    expect((await ran("425043504750" + "00", delegate)).opcodes.sort()).toEqual(["NUMBER", "SELFBALANCE", "TIMESTAMP"]);
    expect((await ran("4250" + "00", plain)).opcodes).toEqual(["TIMESTAMP"]);
  });
  test("BALANCE of its own address, or of the proxy from the implementation's own context: SELFBALANCE by another opcode", async () => {
    expect(await ran("303150" + "00", delegate)).toEqual({ reads: [[impl, false]], opcodes: ["SELFBALANCE"] }); // BALANCE(ADDRESS)
    expect((await ran(`73${proxy.slice(2)}3150` + "00", plain)).opcodes).toEqual(["SELFBALANCE"]); // BALANCE(proxy)
  });
  // A CREATE whose init code reads the time and reverts with it: the token learns it from the revert data,
  // and no TIMESTAMP ran in its own frames. The CREATE itself is what is recorded.
  test("a CREATE whose init code runs TIMESTAMP and reverts with it: CREATE recorded, not TIMESTAMP (the init code is not the token's frame)", async () => {
    // init code: TIMESTAMP, PUSH0, MSTORE, PUSH1 32, PUSH0, REVERT (8 bytes), stored at memory 0 then CREATE(0, 0, 8)
    const create = "67" + "425f5260205ffd" + "00" + "5f52" + "6008" + "6018" + "5f" + "f0" + "50" + "00";
    expect((await ran(create, delegate)).opcodes).toEqual(["CREATE"]);
  });
  test("a TIMESTAMP in a branch the transaction does not take, or run by another contract: not recorded", async () => {
    // PUSH1 1, PUSH1 6, JUMPI, TIMESTAMP, STOP, JUMPDEST, STOP: the jump skips the TIMESTAMP
    expect((await ran("6001600657" + "4200" + "5b00", delegate)).opcodes).toEqual([]);
    // the caller's own code is not the token's: a proxy that is neither token nor implementation
    const other = "0x00000000000000000000000000000000000c0de4" as Address;
    const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
    try {
      await rpc(RPC, "anvil_setCode", [other, "0x425000"]);
      await rpc(RPC, "anvil_setBalance", [caller, toHex(parseEther("1"))]);
      await rpc(RPC, "anvil_impersonateAccount", [caller]);
      const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from: caller, to: other, data: "0x", gas: toHex(100_000) }]);
      for (let i = 0; i < 50 && !(await rpc<unknown>(RPC, "eth_getTransactionReceipt", [hash])); i++) await Bun.sleep(100);
      expect((await reachOf(RPC, hash, proxy, impl)).opcodes).toEqual([]);
    } finally {
      await rpc(RPC, "evm_revert", [snapshot]);
    }
  });
});

// What the simulation cannot see, on the fork's real chain: an EOA buys and sells as a user would.
describe("the real sale fails where the simulation's passes", () => {
  const routerAbi = parseAbi([
    "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
  ]);
  const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const L1_BLOCK = "0x4200000000000000000000000000000000000015";
  const send = async (from: Address, to: Address, data: Hex, value = 0n): Promise<boolean> => {
    const hash = await rpc<Hex>(RPC, "eth_sendTransaction", [{ from, to, data, value: toHex(value), gas: toHex(500_000) }]);
    for (let i = 0; i < 50; i++) {
      const r = await rpc<{ status: Hex } | null>(RPC, "eth_getTransactionReceipt", [hash]); // null until mined
      if (r) return r.status === "0x1";
      await Bun.sleep(100);
    }
    throw new Error(`${hash} not mined within 5 s`);
  };
  /** A fresh EOA buys `token`, approves, `between()` runs, then it sells: the sale's receipt status.
   *  `each()` runs before each of the three transactions (each is a block of its own), `between()` last. */
  const buyThenSell = async (token: Address, between: () => Promise<void>, each = async () => {}): Promise<boolean> => {
    const eoa = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` as Address;
    await rpc(RPC, "anvil_setBalance", [eoa, toHex(parseEther("1"))]);
    await rpc(RPC, "anvil_impersonateAccount", [eoa]);
    const far = 9_999_999_999n;
    await each();
    expect(await send(eoa, ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, [WETH, token], eoa, far] }), parseEther("0.001"))).toBe(true);
    const got = BigInt(await rpc<Hex>(RPC, "eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [eoa] }) }, "latest"]));
    await each();
    expect(await send(eoa, token, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, got] }))).toBe(true);
    await each();
    await between();
    return send(eoa, ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [got, 0n, [token, WETH], eoa, far] }));
  };
  /** One real Base block as anvil never makes it: the L1 attributes deposit advances L1Block's sequence
   *  number (slot 3, low 64 bits; red team's red/sequencer.sh). */
  const sequencer = async () => {
    const word = await rpc<Hex>(RPC, "eth_getStorageAt", [L1_BLOCK, "0x3", "latest"]);
    const seq = BigInt(`0x${word.slice(-16)}`) + 1n;
    await rpc(RPC, "anvil_setStorageAt", [L1_BLOCK, "0x3", `${word.slice(0, 50)}${seq.toString(16).padStart(16, "0")}`]);
  };
  test("RedL1Trap: the sale goes through while L1Block is unchanged, as in any simulation, and fails after one real block", async () => {
    expect(await buyThenSell(tokens.red_l1_trap as Address, async () => {})).toBe(true);
    expect(await buyThenSell(tokens.red_l1_trap as Address, sequencer)).toBe(false);
  });
  test("its sibling through a helper's delegatecall: the same", async () => {
    expect(await buyThenSell(tokens.helper_trap as Address, async () => {})).toBe(true);
    expect(await buyThenSell(tokens.helper_trap as Address, sequencer)).toBe(false);
  });
  test("BaseFeeTrap: the sale goes through at the buy's base fee, as in the simulation, and fails once it moves", async () => {
    const pin = (fee: bigint) => async () => void (await rpc(RPC, "anvil_setNextBlockBaseFeePerGas", [toHex(fee)]));
    expect(await buyThenSell(tokens.basefee_trap as Address, async () => {}, pin(1_000_000n))).toBe(true);
    expect(await buyThenSell(tokens.basefee_trap as Address, pin(1_000_001n), pin(1_000_000n))).toBe(false);
  });
  /** Another user wraps 1 wei: on Base, WETH's supply moved in 160 of 600 blocks (2 min) measured on 2026-11-12. */
  const wraps = async () => {
    const other = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` as Address;
    await rpc(RPC, "anvil_setBalance", [other, toHex(parseEther("1"))]);
    await rpc(RPC, "anvil_impersonateAccount", [other]);
    expect(await send(other, WETH, "0xd0e30db0", 1n)).toBe(true);
  };
  test("WethKey: the sale goes through while nobody else touches WETH, as in any simulation, and fails after one other deposit", async () => {
    expect(await buyThenSell(tokens.weth_key as Address, async () => {})).toBe(true);
    expect(await buyThenSell(tokens.weth_key as Address, wraps)).toBe(false);
  });
  test("BusyTell: the same after a deposit between the approve and the sale", async () => {
    expect(await buyThenSell(tokens.busy_tell as Address, async () => {})).toBe(true);
    expect(await buyThenSell(tokens.busy_tell as Address, wraps)).toBe(false);
  });
  // The step-up: LateClose's sales close 20 minutes after its owner arms it, past a check's last sale.
  for (const name of ["late_close", "pool_clock"] as const) {
    test(`${name}: armed, a sale goes through at once, as every sale a check draws, and fails 20 minutes later`, async () => {
      const token = tokens[name] as Address;
      const owner = "0x60B1100000000000000000000000000000000001" as Address; // evm/fork.sh DEPLOYER
      const snapshot = await rpc<Hex>(RPC, "evm_snapshot", []);
      try {
        await rpc(RPC, "anvil_impersonateAccount", [owner]);
        expect(await send(owner, token, encodeFunctionData({ abi: parseAbi(["function arm(uint256)"]), args: [1200n] }))).toBe(true);
        expect(await buyThenSell(token, async () => {})).toBe(true);
        const later = async () => void (await rpc(RPC, "evm_setNextBlockTimestamp", [toHex(BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).timestamp) + 1200n)]));
        expect(await buyThenSell(token, later)).toBe(false);
      } finally {
        await rpc(RPC, "evm_revert", [snapshot]);
      }
    });
  }
  test("ApproveKey: the approve itself fails after another user's deposit", async () => {
    const token = tokens.approve_key as Address;
    const eoa = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` as Address;
    await rpc(RPC, "anvil_setBalance", [eoa, toHex(parseEther("1"))]);
    await rpc(RPC, "anvil_impersonateAccount", [eoa]);
    expect(await send(eoa, ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, [WETH, token], eoa, 9_999_999_999n] }), parseEther("0.001"))).toBe(true);
    await wraps();
    expect(await send(eoa, token, encodeFunctionData({ abi: erc20, functionName: "approve", args: [ROUTER, 1n] }))).toBe(false);
  });
});
