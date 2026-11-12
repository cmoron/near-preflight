// The environment rule (app/environment.ts): opcodes no simulation can match, and the addresses the
// guard's transactions touch. Real code is read from the local copy of Base (run evm/fork.sh first).
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, parseAbi, parseEther, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { envOpcodes, environmentFindings } from "./environment";
import { FACTORY, implementationAt, ROUTER, rpc, WETH } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const codeOf = (a: string) => rpc<Hex>(RPC, "eth_getCode", [a, "latest"]);

describe("opcodes no simulation can match, in reachable code only (pure)", () => {
  test("found in code: ORIGIN, GASPRICE, BASEFEE, PREVRANDAO, COINBASE, BLOCKHASH", () => {
    expect(envOpcodes("0x3250 3a50 4850 4450 4150 4050 00".replaceAll(" ", "") as Hex)).toEqual(["BASEFEE", "BLOCKHASH", "COINBASE", "GASPRICE", "ORIGIN", "PREVRANDAO"]);
  });
  test("GAS, TIMESTAMP, NUMBER, SELFBALANCE, BALANCE, EXTCODEHASH: none (allowed, or judged by the addresses touched)", () => {
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
  const facts = (touched: string[] | null, opcodes: string[] = [], token_calls: string[] | null = []) => ({ opcodes, touched, token_calls, implementation: null, liquidity });
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
  test("the token's code calls WETH, or the factory: block, naming them", () => {
    expect(environmentFindings(facts([w.token, WETH.toLowerCase()], [], [WETH.toLowerCase()]), w)).toEqual([{ level: "block", text: "token calls WETH during a transfer: state all of Base moves" }]);
    expect(environmentFindings(facts([w.token], [], [WETH.toLowerCase(), FACTORY.toLowerCase()]), w)[0]?.text).toBe("token calls WETH and the V2 factory during a transfer: state all of Base moves");
  });
  test("the token's code calls its pool or its implementation: no finding", () => {
    expect(environmentFindings(facts([w.token, pair], [], [pair]), w)).toEqual([]);
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
