// The sentinel's checks against the local copy of Base (run evm/fork.sh first). Each check mines the
// blocks it waits for (app/testkit.ts mine); each test then reverts the fork to where it started.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { concat, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, parseEther, parseTransaction, stringToHex, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex, type Index } from "./index";
import { CHECK_BLOCKS, localPreviews, mine, SETUP_FEES, USERS } from "./testkit";
import {
  checkExit,
  checkToken,
  deriveProbes,
  ETH_LOGS,
  FACTORY,
  FAR,
  FAR_METHOD,
  FARS,
  GUARD,
  implementationAt,
  judge,
  judgeExit,
  labelsOf,
  LATER,
  LATER_S,
  laterBlocks,
  laterFindings,
  liquidityFindings,
  plan,
  REF_MARGIN_S,
  ROUTER,
  rpc,
  saleRanges,
  secondsAfterBuy,
  short,
  specialOf,
  timeOf,
  WETH,
  type Block,
  type Cadence,
  type Context,
  type Fees,
  type Header,
  type Holder,
  type Liquidity,
  type NearFacts,
  type Probe,
  type Result,
} from "./verifier";

const TRANSFER = keccak256(stringToHex("Transfer(address,address,uint256)"));

const quoteAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
/** The guard's EVM address: the one the guard_frozen trap freezes (set by evm/fork.sh). */
const GUARD_EVM = await specialOf(RPC, tokens.guard_frozen as Address);
const rand = (): Address => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
let tickets = 0;
/** Probes and first sale derived as the sentinel does, for a fresh check of a guard. */
const probes = (head: Header, c: Cadence) => deriveProbes({ guard: "guard.test", id: ++tickets, requested_ns: "0" }, head.hash, c);
/** The local fork's cadence (evm/fork.sh, app/testkit.ts mine): a block a second. */
const CADENCE: Cadence = { blocks: 100, seconds: 100 };
/** The index the sentinel builds for a check: every pool the fork setup launched (evm/fork.sh), up to the check's block. */
const INDEX = (block: number) => buildIndex(RPC, tokens.fork_block + 1, block);
const NO_NEAR: NearFacts = { listed: [], previous: null };
/** The amount the agent states at request_check in the demo: 0.00001 ETH. */
const AMOUNT = 10_000_000_000_000n;
/** Time of the fork's latest block: a check requested now (its swap deadline is 300 s later). */
const headTime = async () => BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).timestamp);
/** What the guard would sign for a check of `token` by `guard`, requested now. */
const previews = async (token: string, guard: Address, fees: Fees = SETUP_FEES, amount = AMOUNT) =>
  localPreviews({ guard, target: token as Address, amount, requestedS: await headTime(), fees });
/** A check requested at the fork's latest block, once the blocks it waits for are mined with others'
 *  activity (`between`, if given, runs after the reference block). */
const checkNow = async (token: string, guard: Address, chosen: (head: Header, c: Cadence) => Probe, ctx: Omit<Context, "requested_ns">, between?: () => Promise<void>) => {
  const requested_ns = ((await headTime()) * 1_000_000_000n).toString();
  if (between) {
    await mine(RPC, Number(REF_MARGIN_S) + 1); // the reference block and the one after it
    await rpc(RPC, "evm_setNextBlockTimestamp", [toHex((await headTime()) + 1n)]);
    await between();
  }
  await mine(RPC, CHECK_BLOCKS);
  return checkToken(RPC, token as Address, guard, chosen, { ...ctx, requested_ns });
};
const check = async (token: string, guard: Address = GUARD_EVM, index: Context["index"] = INDEX, near: NearFacts = NO_NEAR, fees: Fees = SETUP_FEES, amount = AMOUNT) =>
  checkNow(token, guard, probes, { index, near: async () => near, amount, preview: await previews(token, guard, fees, amount) });
let snapshot: Hex;
beforeEach(async () => void (snapshot = await rpc<Hex>(RPC, "evm_snapshot", [])));
afterEach(async () => void (await rpc(RPC, "evm_revert", [snapshot])));

describe("sentinel verdict", () => {
  test("USDC, healthy witness already on Base: allow", async () => expect((await check(tokens.usdc)).verdict).toBe("allow"));
  test("healthy demo token: allow", async () => expect((await check(tokens.safe)).verdict).toBe("allow"));
  test("honest token that imposes a holding block: allow (resale simulated in a later block)", async () => {
    expect((await check(tokens.hold_one_block)).verdict).toBe("allow");
  });
  test("no V2 liquidity: warn, not block", async () => {
    const r = await check("0x60B1100000000000000000000000000000000001"); // address without a pair
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("no liquidity");
  });
  test("takeback by the owner via transferFrom: block", async () => {
    const r = await check(tokens.owner_reclaim);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("transferFrom");
    expect(r.list_target).toBe(true);
  });
  test("sale closed from the buy: block", async () => {
    const r = await check(tokens.sell_blocked);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  // Since Base mines five blocks a second, eth_simulateV1's 256 blocks reach 51 s past the reference
  // block. These two traps act at 5 minutes: the far sales, the late one again 301 s, 900 s and a drawn
  // delay between after the buy on a local fork whose clock moves, meet them.
  test("sale closed 5 minutes after the buy: block on the far sales, listed (the late sale at 51 s at most went through)", async () => {
    const r = await check(tokens.sell_blocked_later);
    expect(r.verdict).toBe("block");
    const far = secondsAfterBuy(CADENCE, r.evidence.sales.far);
    expect(far).toBeGreaterThan(300);
    const refused = (s: number) => `sale refused ${s} s after the buy (TransferHelper: TRANSFER_FROM_FAILED)`;
    expect(r.reasons).toBe([...new Set([refused(301), refused(far), refused(900)])].join(" ; "));
    expect(r.evidence.calls).toContain("sale late: ok");
    for (const f of FARS) expect(r.evidence.calls).toContain(`${f}sale late: revert`);
    expect(r.evidence.calls).toContain(`${FAR}${GUARD}sale late: revert`);
    expect(r.list_target).toBe(true);
  });
  test("90 % tax on the sale: block", async () => {
    const r = await check(tokens.sell_tax);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("90 % tax");
    expect(r.list_target).toBe(true);
  });
  test("90 % tax from 5 minutes after the buy: block on the far sale, listed", async () => {
    const r = await check(tokens.sell_tax_later);
    expect(r.verdict).toBe("block");
    const taxed = (s: number) => `90 % tax on the sale ${s} s after the buy`;
    expect(r.reasons).toBe([...new Set([taxed(301), taxed(secondsAfterBuy(CADENCE, r.evidence.sales.far)), taxed(900)])].join(" ; "));
    expect(r.list_target).toBe(true);
  });
  test("a token that freezes only the guard's public EVM address: block, but not listed (it rests on the guard's own state)", async () => {
    const r = await check(tokens.guard_frozen);
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(false);
    expect(r.reasons).toContain("guard address only, not listed: sale refused"); // the router masks the token's reason
  });
  test("a sale that needs more gas than the guard signs with (250,000): block, the simulation uses the guard's gas limit", async () => {
    const r = await check(tokens.gas_hungry);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true); // the probe's sale fails too: the token's own behaviour
  });
  test("the same token simulated with 1,000,000 gas sells: only the guard's own gas limit says what a sale will meet", async () => {
    const r = await check(tokens.gas_hungry, GUARD_EVM, INDEX, NO_NEAR, { ...SETUP_FEES, gas: 1_000_000n });
    expect(r.verdict).not.toBe("block"); // its young pool's LP sits with an EOA: a warn
    expect(r.reasons).not.toContain("sale refused");
  });
  test("the same token with another guard address: allow (only the guard is targeted)", async () => {
    expect((await check(tokens.guard_frozen, "0x000000000000000000000000000000000000bEEF")).verdict).toBe("allow");
  });
  test("sale allowed only in simulation (zero gas price or base fee): block", async () => {
    const r = await check(tokens.sim_detector);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/); // the router masks the token's reason
    expect(r.list_target).toBe(true);
  });
});

// The review's Trap2: tokens keyed on a difference between what a looser simulation did and what the
// guard signs. The guard side now runs the guard's own transactions, so each is caught as a token trap.
describe("the guard side simulates exactly what the guard signs", () => {
  test("Trap2 mode 1, a sale only after an approve of 2^256 - 1 (the guard approves the exact amount): block, listed", async () => {
    const r = await check(tokens.approve_max_only);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true); // the probe signs the same approve: the token's own behaviour
  });
  test("Trap2 mode 2, a sale only after a buy of exactly 0.01 ETH (the agent asked 0.00001 ETH): block, listed", async () => {
    const r = await check(tokens.buy_001_only);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("the guard's buy is simulated as the very transaction it signs: calldata, value, nonce, gas, fees; its hash is in the evidence", async () => {
    const p = await previews(tokens.usdc, GUARD_EVM);
    const r = await checkNow(tokens.usdc, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: p });
    const [signed] = await p.check(BigInt(r.evidence.quote)); // what buy would sign on this verdict
    expect(r.evidence.tx_hashes).toEqual([keccak256(signed)]);
    const t = parseTransaction(signed);
    const calls = (r.request[0].params[0] as { blockStateCalls: { calls: Record<string, string>[] }[] }).blockStateCalls[0].calls;
    const buy = calls.find((c) => c.from.toLowerCase() === GUARD_EVM.toLowerCase() && c.to.toLowerCase() === ROUTER.toLowerCase() && c.value)!;
    expect(buy).toEqual({ from: GUARD_EVM, to: t.to!, data: t.data!, value: toHex(t.value!), nonce: toHex(t.nonce!), gas: toHex(t.gas!), maxFeePerGas: toHex(t.maxFeePerGas!), maxPriorityFeePerGas: toHex(t.maxPriorityFeePerGas!) });
    expect(t.value).toBe(AMOUNT); // the amount the agent stated, not a fixed 0.01 ETH
    expect(r.evidence.amount_wei).toBe(AMOUNT.toString());
  });
});

// Judge pass 5: tokens that tell a simulation from a real trade by what the simulation does around the
// guard's own transactions. The guard-side request now holds nothing but the guard's buy, approves and
// swaps, from the block's real state; every other call runs in a request of its own.
describe("nothing but the guard's own transactions before each one it signs", () => {
  test("JudgeTrap, a sale only after a top-level balanceOf (which only a simulation sent): block, listed", async () => {
    const r = await check(tokens.judge_trap);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true); // the probe never calls balanceOf either: the token's own behaviour
  });
  test("a buyer that never called the token itself before its buy can never sell: block, listed", async () => {
    const r = await check(tokens.untouched_buyer);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("a sale keyed by a stranger's failed transferFrom (it returns false and writes state): block, listed", async () => {
    const r = await check(tokens.stranger_key);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("the guard-side request holds only the guard's buy, approves and swaps, from the block's real state", async () => {
    const r = await check(tokens.usdc);
    const [guardSide] = r.request.map((q) => (q.params[0] as { blockStateCalls: { calls: Record<string, string>[]; stateOverrides?: Record<string, unknown> }[] }).blockStateCalls);
    expect(guardSide.filter((b) => b.calls.length).map((b) => b.calls.length)).toEqual([1, 1, 1, 1, 1]); // buy; approve; swap; approve; swap
    expect(guardSide.length).toBe(r.evidence.sales.late + 1); // the blocks between the two sales are there, empty; the late swap ends it
    const calls = guardSide.flatMap((b) => b.calls);
    expect(calls.every((c) => c.from.toLowerCase() === GUARD_EVM.toLowerCase() && c.nonce !== undefined)).toBe(true);
    expect(calls.map((c) => c.data.slice(0, 10))).toEqual(["0xb6f9de95", "0x095ea7b3", "0x791ac947", "0x095ea7b3", "0x791ac947"]);
    expect(Object.keys(guardSide[0].stateOverrides ?? {}).every((a) => a.toLowerCase() === GUARD_EVM.toLowerCase())).toBe(true);
    expect(r.request.length).toBe(5); // the probe's twins, the synthetic calls, the later side and the far sale run apart
  });
});

// Red team, after the fifth judge run: RedL1Trap sells only while the L1Block predeploy is unchanged since
// the buy. Base rewrites it every block, eth_simulateV1 never does: every simulated sale passes, every
// real one fails. The rule closes the class: what the guard's transactions touch, and opcodes.
describe("a token whose transfers read what the simulation cannot reproduce", () => {
  const helperOf = async (token: string) => `0x${(await rpc<Hex>(RPC, "eth_call", [{ to: token, data: "0x63b0e66a" }, "latest"])).slice(-40)}`; // helper()
  test("RedL1Trap, every simulated sale passes: block, naming L1Block, not listed", async () => {
    const r = await check(tokens.red_l1_trap);
    expect(r.evidence.calls.filter((c) => c.includes("sale")).every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^reads 0x4200\.\.0015, .* during a transfer/); // and L1Block's implementation, behind its proxy
    expect(r.evidence.touched).toContain("0x4200000000000000000000000000000000000015");
    expect(r.list_target).toBe(false);
  });
  test("its sibling reaching L1Block through a delegatecall to a helper: block, naming both", async () => {
    const r = await check(tokens.helper_trap);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("0x4200..0015");
    expect(r.evidence.touched).toContain((await helperOf(tokens.helper_trap)).toLowerCase());
  });
  test("its sibling keyed on the base fee: warn naming BASEFEE, a block once the base fee moved before the later side's block", async () => {
    const r = await check(tokens.basefee_trap);
    expect(r.evidence.calls.filter((c) => c.startsWith(`${GUARD}sale`)).every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.reasons).toContain("code reads BASEFEE");
    expect(r.evidence.opcodes).toEqual(["BASEFEE"]);
    // the fork's base fee falls by about 2 wei a block; on Base it sits at its floor in most blocks (a warn)
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(new RegExp(`^sale refused \\d+ s after the buy on Base's state of block ${r.evidence.later!.block}`));
  });
  // Review of 967d618: the later side was not traced, so a token could act there unseen. A proxy upgraded
  // during the wait to a twin of its implementation sells as before, through an address nobody checked.
  test("USDC upgraded during the check to a copy of its implementation at a new address: the later side traced, that address touched there, block", async () => {
    const twin = rand();
    const upgrade = async () => {
      const impl = (await implementationAt(RPC, tokens.usdc as Address, BigInt(await rpc<Hex>(RPC, "eth_blockNumber", []))))!;
      await rpc(RPC, "anvil_setCode", [twin, await rpc<Hex>(RPC, "eth_getCode", [impl, "latest"])]);
      await rpc(RPC, "anvil_setStorageAt", [tokens.usdc, "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", pad(twin)]); // ZeppelinOS implementation slot
    };
    const r = await checkNow(tokens.usdc, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.usdc, GUARD_EVM) }, upgrade);
    expect(r.evidence.calls).toContain(`${LATER}${GUARD}sale late: ok`); // it sells there as before
    expect(r.evidence.touched).toContain(twin.toLowerCase());
    expect(r.verdict).toBe("block");
    expect(r.reasons).toStartWith(`reads ${short(twin.toLowerCase())} during a transfer`);
  });
  test("USDC touches its proxy, its implementation, its pool, the router and WETH only: allow", async () => {
    const r = await check(tokens.usdc);
    expect(r.verdict).toBe("allow");
    expect(r.evidence.opcodes).toEqual([]);
    const expected = [tokens.usdc, r.evidence.implementation!, r.evidence.liquidity!.pair, ROUTER, WETH, GUARD_EVM].map((a) => a.toLowerCase());
    expect(r.evidence.touched!.every((a) => expected.includes(a))).toBe(true);
    expect(r.evidence.touched).toContain(r.evidence.implementation!);
  });
});

// Judge pass 6: a check's first sale was always in the block right after the buy, where no real exit
// lands, and of exactly half the tokens bought, then the rest, where an exit sells its holding.
describe("the check's sales are where and what a token cannot expect", () => {
  test("NextBlockKey, a sale only in the block right after the buy: block, listed", async () => {
    const r = await check(tokens.next_block_key);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("AmountTrap, a sale only of half or all of the balance: block, listed", async () => {
    const r = await check(tokens.amount_trap);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("the sales are drawn in seconds and land on blocks at the cadence measured: the first 2 to 25 s after the buy, 13 % to 87 %, never a whole percent; the rest 30 to 51 s after it, and again 301 to 900 s after it (the far sale); the later side 16 to 24 s after the reference block (pure)", () => {
    const draw = (c: Cadence) => Array.from({ length: 3000 }, (_, id) => deriveProbes({ guard: "guard.test", id, requested_ns: "0" }, keccak256(toHex(id)), c));
    const range = (xs: number[]) => [Math.min(...xs), Math.max(...xs)];
    const base = draw({ blocks: 100, seconds: 20 }); // Base since November 2026: 5 blocks a second
    const sales = base.map((d) => d.sale);
    expect(range(sales.map((s) => s.first))).toEqual([10, 125]);
    expect(range(sales.map((s) => s.late))).toEqual([150, 255]); // eth_simulateV1 refuses a block 257 past the proof's: the buy is in the 1st
    expect(new Set(sales.map((s) => s.late)).size).toBe(106);
    expect([...new Set(base.map((d) => d.later))].sort((a, b) => a - b)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(saleRanges({ blocks: 100, seconds: 20 }).far).toEqual([1505, 4500]); // the far sale, 301 to 900 s after the buy: past 51 s, on a local fork
    expect(sales.every((s) => s.far >= 1505 && s.far <= 4500)).toBe(true);
    expect(new Set(sales.map((s) => s.far)).size).toBeGreaterThan(1500);
    expect(range(sales.map((s) => secondsAfterBuy({ blocks: 100, seconds: 20 }, s.far)))).toEqual([301, 900]);
    expect(sales.every((s) => s.bps > 1300 && s.bps < 8700 && s.bps % 100 !== 0)).toBe(true);
    expect(new Set(sales.map((s) => s.bps)).size).toBeGreaterThan(1000);
    const fork = draw({ blocks: 100, seconds: 100 }).map((d) => d.sale); // the local fork: a block a second
    expect([range(fork.map((s) => s.first)), range(fork.map((s) => s.late)), range(fork.map((s) => s.far))]).toEqual([[2, 25], [30, 51], [301, 900]]);
    const fast = draw({ blocks: 100, seconds: 5 }).map((d) => d.sale); // 20 blocks a second: the late sale capped at the 256th block
    expect(Math.max(...fast.map((s) => s.late))).toBe(255);
    expect(fast.every((s) => s.first <= s.late - 2)).toBe(true);
    const ticket = { guard: "guard.test", id: 1, requested_ns: "0" };
    expect(deriveProbes(ticket, keccak256("0x01"), CADENCE).sale).not.toEqual(deriveProbes(ticket, keccak256("0x02"), CADENCE).sale); // the hash of a block not mined yet
  });
  test("a simulated block has the time a real one would have at the cadence measured: at 100 blocks in 20 s, five share each second (pure)", () => {
    const head = { number: "0x64", timestamp: "0x3e8" } as unknown as Header; // block 100 at 1,000 s, the first of its second
    expect(Array.from({ length: 11 }, (_, k) => Number(timeOf(head, { blocks: 100, seconds: 20 }, 100n + BigInt(k)) - 1000n))).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2]);
    expect(Array.from({ length: 4 }, (_, k) => Number(timeOf(head, { blocks: 100, seconds: 100 }, 100n + BigInt(k)) - 1000n))).toEqual([0, 1, 2, 3]);
    expect(Array.from({ length: 4 }, (_, k) => Number(timeOf(head, { blocks: 100, seconds: 200 }, 100n + BigInt(k)) - 1000n))).toEqual([0, 2, 4, 6]);
  });
  test("the later side holds the guard side's blocks after its real block, a sale whose approve is not after it left out whole (pure)", () => {
    const at = (n: number): Block => ({ number: 100n + BigInt(n), calls: n === 20 || n === 230 ? [{ label: "approve", from: GUARD_EVM, to: WETH, data: "0x" }] : n === 21 || n === 231 ? [{ label: "swap", from: GUARD_EVM, to: WETH, data: "0x" }] : [] });
    const guardSide = Array.from({ length: 231 }, (_, i) => at(i + 1));
    const sale = { first: 20, bps: 5001, late: 230, far: 1600 };
    /** The later side's first block and the blocks holding a call, after real block `real`. */
    const after = (real: number) => {
      const blocks = laterBlocks(guardSide, 100n, sale, BigInt(real));
      expect(blocks.map((b) => Number(b.number))).toEqual(Array.from({ length: 331 - real }, (_, i) => real + 1 + i)); // no gap from the real block on
      return blocks.filter((b) => b.calls.length).map((b) => Number(b.number));
    };
    expect(after(110)).toEqual([120, 121, 330, 331]); // both sales after it
    expect(after(119)).toEqual([120, 121, 330, 331]);
    expect(after(120)).toEqual([330, 331]); // the first approve on the real block: the first sale left out, its swap's block empty
    expect(after(150)).toEqual([330, 331]); // well past the first sale (Base: about 100 blocks a check)
    expect(laterBlocks(guardSide, 100n, sale, 150n).flatMap((b) => b.calls.map((c) => c.label))).toEqual([`${LATER}approve`, `${LATER}swap`]);
  });
  test("the guard side sells the derived share first, then the rest", async () => {
    const r = await check(tokens.safe);
    const [g] = r.request.map((q) => (q.params[0] as { blockStateCalls: { calls: { data: Hex }[] }[] }).blockStateCalls.flatMap((b) => b.calls));
    const amounts = [g[1], g[3]].map((c) => decodeAbiParameters([{ type: "address" }, { type: "uint256" }], `0x${c.data.slice(10)}`)[1]); // the two approves
    const bought = amounts[0] + amounts[1];
    expect(amounts[0]).toBe((bought * BigInt(r.evidence.sales.bps)) / 10_000n);
  });
});

// Judge passes 7 and 8: tokens that sell only while WETH's supply is what their own trades left. In a
// lone simulation nobody else moves WETH; on Base others move it in most blocks. WethKey tests at the
// sale, ApproveKey at the approve, BusyTell at the sale unless a pair was created after the approve (the
// busy side's recipe). The later side runs the guard's sales on a real block mined after the reference
// block, with the buy's state change applied: whatever Base did in between, before the approve too.
describe("a token keyed on state Base moves", () => {
  for (const [name, token] of [["WethKey", tokens.weth_key], ["ApproveKey", tokens.approve_key], ["BusyTell", tokens.busy_tell]] as const) {
    test(`${name}, every sale passes on the reference block: block on Base's later state, not listed`, async () => {
      const r = await check(token);
      expect(r.evidence.calls.filter((c) => c.startsWith(`${GUARD}sale`)).every((c) => c.endsWith(": ok"))).toBe(true);
      expect(r.verdict).toBe("block");
      expect(r.reasons).toMatch(new RegExp(`^sale refused \\d+ s after the buy on Base's state of block ${r.evidence.later!.block} `));
      expect(r.evidence.later!.block - r.evidence.block).toBeGreaterThanOrEqual(LATER_S[0]); // a block a second on the fork
      expect(r.list_target).toBe(false);
    });
  }
  test("each one's code calls WETH (BusyTell the factory too): block whatever moved", async () => {
    expect((await check(tokens.weth_key)).reasons).toContain("token calls or reads WETH during a transfer");
    expect((await check(tokens.busy_tell)).reasons).toContain("token calls or reads WETH and the V2 factory during a transfer");
  });
  // Batch 9's demo: a cadence measured across a gap in the fork's clock put the later block past the late
  // sale, and the later side had no sale left (it crashed). It is capped at the block before that approve.
  test("a later block drawn past the late sale (a cadence that moved during the wait) is capped before its approve: the late sale runs again", async () => {
    const more = () => mine(RPC, 40); // blocks enough for a 60 s wait at a block a second
    const r = await checkNow(tokens.usdc, GUARD_EVM, (h, c) => ({ ...probes(h, c), later: 60 }), { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.usdc, GUARD_EVM) }, more);
    expect(r.evidence.later!.block).toBe(r.evidence.block + r.evidence.sales.late - 1);
    expect(r.evidence.calls).toContain(`${LATER}${GUARD}sale late: ok`);
    expect(r.verdict).toBe("allow");
  });
  test("USDC sells the same on Base's later state: both sales run again, allow", async () => {
    const r = await check(tokens.usdc);
    const again = r.evidence.calls.filter((c) => c.startsWith(`${LATER}${GUARD}sale`)); // the first sale too, when its approve comes after the later block
    expect(again).toContain(`${LATER}${GUARD}sale late: ok`);
    expect(again.every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.evidence.later!.moved).toEqual([]);
    expect(r.verdict).toBe("allow");
  });
});

// Batch 9: a slot both the buy and Base wrote (someone traded the pool during the wait) kept Base's value
// and capped the verdict at warn, so a token whose pool trades every few seconds was never allowed. The
// trades of the pool in between are now re-executed after the buy, block by block (app/later.ts).
describe("others trade the token's pool while the check waits", () => {
  /** A check requested now while third parties buy `token` from its pool in the blocks it waits for. */
  const traded = async (token: string) => {
    const requested_ns = ((await headTime()) * 1_000_000_000n).toString();
    await mine(RPC, CHECK_BLOCKS, false, token as Address);
    return checkToken(RPC, token as Address, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(token, GUARD_EVM), requested_ns });
  };
  test("USDC: their trades re-executed after the buy, the resale verified on Base's later state, allow", async () => {
    const r = await traded(tokens.usdc);
    expect(r.evidence.later!.moved.length).toBeGreaterThan(0);
    expect(r.evidence.later!.replayed.length).toBeGreaterThan(0);
    expect(r.evidence.later!.unverified).toBeNull();
    const again = r.evidence.calls.filter((c) => c.startsWith(`${LATER}${GUARD}sale`));
    expect(again).toContain(`${LATER}${GUARD}sale late: ok`);
    expect(again.every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.verdict).toBe("allow");
  });
  test("a honeypot whose pool others buy from: their trades re-executed, its sale refused there too, block", async () => {
    const r = await traded(tokens.sell_blocked);
    expect(r.evidence.later!.replayed.length).toBeGreaterThan(0);
    expect(r.evidence.later!.unverified).toBeNull();
    expect(r.evidence.calls).toContain(`${LATER}${GUARD}sale late: revert`); // judged on the frozen side's refusal already
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(true); // the probe's sale on the frozen side
  });
  // Their state follows WETH's supply, which others' deposits move in the same blocks: re-executing the
  // pool's trades alone does not give Base's values back, so nothing is carried; the rule on WETH blocks.
  for (const [name, token] of [["WethKey", tokens.weth_key], ["ApproveKey", tokens.approve_key]] as const) {
    test(`${name}, its pool traded too: still a block, never an allow`, async () => {
      const r = await traded(token);
      expect(r.verdict).toBe("block");
      expect(r.reasons).toContain("token calls or reads WETH during a transfer");
      expect(r.evidence.calls.some((c) => c.startsWith(`${LATER}${GUARD}sale`) && c.endsWith("revert"))).toBe(true);
    });
  }
  // Review of 100ceaf: dust sent to the guard was merged as a sum (Base's change plus the buy's), exact for
  // a balance only. A transfer to or from the guard is now re-executed after the buy, like a trade.
  /** A check of `token` while USERS[0], holding some since before the check, sends 1 unit to the guard. */
  const dusted = async (token: string) => {
    const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
    const swap = parseAbi(["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"]);
    await rpc(RPC, "anvil_impersonateAccount", [USERS[0]]);
    await rpc(RPC, "eth_sendTransaction", [{ from: USERS[0], to: ROUTER, data: encodeFunctionData({ abi: swap, args: [0n, [WETH, token as Address], USERS[0], 9_999_999_999n] }), value: toHex(parseEther("0.1")) }]);
    await mine(RPC, 2); // before the check: not in its wait
    const dust = async () => {
      await rpc(RPC, "anvil_impersonateAccount", [USERS[0]]);
      await rpc(RPC, "eth_sendTransaction", [{ from: USERS[0], to: token, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [GUARD_EVM, 1n] }) }]);
    };
    return checkNow(token, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(token, GUARD_EVM) }, dust);
  };
  test("USDC sent to the guard's address during the check: that transfer re-executed after the buy, the resale verified, allow", async () => {
    const r = await dusted(tokens.usdc);
    expect(r.evidence.later!.moved.length).toBeGreaterThan(0);
    expect(r.evidence.later!.replayed.length).toBe(1);
    expect(r.evidence.later!.unverified).toBeNull();
    expect(r.evidence.calls).toContain(`${LATER}${GUARD}sale late: ok`);
    expect(r.verdict).toBe("allow");
  });
  // The same dust on a trap whose sale is refused on Base's later state: still a block.
  test("dust sent to the guard during WethKey's check: re-executed, its refusal on Base's later state still a block, not listed", async () => {
    const r = await dusted(tokens.weth_key);
    expect(r.evidence.later!.replayed.length).toBe(1);
    expect(r.evidence.later!.unverified).toBeNull();
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ s after the buy on Base's state of block \d+ \(/);
    expect(r.list_target).toBe(false);
  });
  // A slot the buy wrote, moved by no transaction the check can re-execute (here the guard's balance of the
  // healthy demo token, as an owner's write without a Transfer log): the sales run on Base's value of it,
  // never on a sum of two changes, a state no chain had. Its sale is refused there: a block, not listed.
  test("the guard's balance moved during the check with no transfer at all: Base's value kept, its sale refused there, block, not listed", async () => {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [GUARD_EVM, 4n])); // DemoToken's balanceOf: slot 4
    const seize = async () => void (await rpc(RPC, "anvil_setStorageAt", [tokens.safe, slot, toHex(1n, { size: 32 })]));
    const r = await checkNow(tokens.safe, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.safe, GUARD_EVM) }, seize);
    expect(r.evidence.later!.moved).toEqual([`${tokens.safe.toLowerCase()}:${slot}`]);
    expect(r.evidence.later!.unverified).toMatch(/moved in blocks \d+\.\.\d+ with no trade of the pool nor transfer of the guard's$/);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ s after the buy on Base's state of block \d+ \(.*\), merged with the buy's values: slot /);
    expect(r.list_target).toBe(false);
  });
  // Judge pass 9: J9ImplMark marks the previous buyer through a plain call to its implementation, in the
  // implementation's own storage, which the later side did not carry: allow, and the real sale failed.
  test("J9ImplMark, others buy after the guard and mark it in the implementation's own storage: re-executed, the mark carried, its sale refused there, block, not listed", async () => {
    const swap = parseAbi(["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"]);
    const buys = async () => {
      for (const from of USERS.slice(1, 3)) {
        await rpc(RPC, "anvil_impersonateAccount", [from]);
        await rpc(RPC, "eth_sendTransaction", [{ from, to: ROUTER, data: encodeFunctionData({ abi: swap, args: [0n, [WETH, tokens.impl_mark as Address], from, 9_999_999_999n] }), value: toHex(parseEther("0.05")), gas: toHex(400_000) }]);
      }
    };
    const r = await checkNow(tokens.impl_mark, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.impl_mark, GUARD_EVM) }, buys);
    expect(r.evidence.later!.replayed.length).toBe(2);
    expect(r.evidence.later!.unverified).toBeNull();
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(new RegExp(`^sale refused \\d+ s after the buy on Base's state of block ${r.evidence.later!.block} `));
    expect(r.list_target).toBe(false);
  });
  // Review of 73a7ad2: a trap could force the fallback and turn its refusal there into a warn. More
  // trades of its pool than can be re-executed: the refusal on the merged state stays a block.
  test("WethKey with more trades of its pool than can be re-executed: its refusal there is still a block, not listed", async () => {
    const swap = parseAbi(["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"]);
    const busy = async () => {
      await rpc(RPC, "evm_setAutomine", [false]);
      try {
        for (let i = 0; i < 11; i++) {
          const from = USERS[i % USERS.length];
          await rpc(RPC, "anvil_impersonateAccount", [from]);
          await rpc(RPC, "eth_sendTransaction", [{ from, to: ROUTER, data: encodeFunctionData({ abi: swap, args: [0n, [WETH, tokens.weth_key as Address], from, 9_999_999_999n] }), value: toHex(parseEther("0.01")) }]);
        }
        await rpc(RPC, "evm_mine", []);
      } finally {
        await rpc(RPC, "evm_setAutomine", [true]);
      }
    };
    const r = await checkNow(tokens.weth_key, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.weth_key, GUARD_EVM) }, busy);
    expect(r.evidence.later!.unverified).toMatch(/^1[1-9] trades of the pool, more than 10 to re-execute$/);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ s after the buy on Base's state of block \d+ \(.*\), merged with the buy's values: 1[1-9] trades of the pool, more than 10 to re-execute/);
    expect(r.list_target).toBe(false);
  });
});

// Judge pass 7: an honest token with a 30-block cooldown was listed whenever the first sale was drawn
// within it. A refusal the late sale does not share clears with time: it blocks the check, never lists.
describe("a sale refused only early never lists", () => {
  const checkFirst = async (token: string, first: number) =>
    checkNow(token, GUARD_EVM, (h, c) => {
      const p = probes(h, c);
      return { ...p, sale: { ...p.sale, first, late: Math.max(p.sale.late, first + 8) } };
    }, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(token, GUARD_EVM) });
  // Cooldown60's 30 blocks are 6 s on Base, 30 s on the fork: its first sale (2 to 25 s) is refused
  // there, its late one (30 to 50 s) goes through.
  test("Cooldown60, first sale 10 blocks after the buy: block, not listed (the late and far sales go through)", async () => {
    const r = await checkFirst(tokens.cooldown_60, 10);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toBe("sale refused 10 s after the buy (TransferHelper: TRANSFER_FROM_FAILED)"); // nothing from the later side
    expect(r.list_target).toBe(false);
  });
  test("Cooldown60, first sale 40 blocks after the buy: allow", async () => {
    expect((await checkFirst(tokens.cooldown_60, 40)).verdict).toBe("allow");
  });
  test("a trap whose late sale is refused too still lists, whatever the first sale's block", async () => {
    const r = await checkFirst(tokens.sell_blocked, 10);
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(true);
  });
});

// Judge pass 9: J9GuardLater closes the guard's sales 8 minutes after its buy. A block for the guard's
// address alone lists nothing and nothing remembers it, so an agent could request checks until the far
// sale was drawn before 8 minutes. The late sale also runs at both ends of the far range, 301 and 900 s.
describe("a sale closed for the guard alone, minutes after its buy", () => {
  test("J9GuardLater, the far sale drawn at 301 s: block on the sale 900 s after the buy, not listed", async () => {
    const r = await checkNow(tokens.guard_later, GUARD_EVM, (h, c) => {
      const p = probes(h, c);
      return { ...p, sale: { ...p.sale, far: saleRanges(c).far[0] } };
    }, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: await previews(tokens.guard_later, GUARD_EVM) });
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("guard address only, not listed: sale refused 900 s after the buy (");
    expect(r.list_target).toBe(false);
  });
  test("J9GuardLater, four checks, each with its own draws: block at every one", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await check(tokens.guard_later);
      expect(`${r.verdict}: ${r.reasons}`).toStartWith("block: guard address only, not listed: sale refused ");
    }
  }, 120_000);
});

describe("a sale's tax is what the seller receives", () => {
  test("a token that swaps 90 % of each sale into the pool itself and sends that WETH to its owner: block", async () => {
    const r = await check(tokens.pair_pull_tax);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/\d+ % tax on the sale \d+ s after the buy/);
    expect(r.reasons).toContain("the pool paid out more WETH than the seller received");
    expect(r.list_target).toBe(true);
  });
});

// The agent picks its check's amount (request_check): an outcome that amount decides blocks that check
// and lists nothing, or any armed agent could get an honest token listed for the price of a check.
describe("what the agent's amount decides never lists the token", () => {
  const abi = parseAbi(["function getPair(address,address) view returns (address)", "function balanceOf(address) view returns (uint256)"]);
  const read = (to: string, functionName: "getPair" | "balanceOf", args: unknown[]) =>
    rpc<Hex>(RPC, "eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]) }, "latest"]);
  /** The WETH in `token`'s Uniswap V2 pool. */
  const reserve = async (token: string) => BigInt(await read(WETH, "balanceOf", [`0x${(await read(FACTORY, "getPair", [token, WETH])).slice(-40)}`]));
  const at = (token: string, amount: bigint) => check(token, GUARD_EVM, INDEX, NO_NEAR, SETUP_FEES, amount);
  for (const [name, token] of [["USDC", tokens.usdc], ["the healthy demo token", tokens.safe]] as const) {
    test(`${name}, dust (1 wei, 10,000 wei): not listed`, async () => {
      for (const amount of [1n, 10_000n]) expect((await at(token, amount)).list_target).toBe(false);
    });
    test(`${name}, twice its pool's WETH: not listed`, async () => {
      expect((await at(token, 2n * (await reserve(token)))).list_target).toBe(false);
    });
    test(`${name}, 2^112 wei (more than a V2 pair holds): block, the buy fails, not listed`, async () => {
      const r = await at(token, 2n ** 112n);
      expect(r.verdict).toBe("block");
      expect(r.reasons).toContain("simulated buy failed");
      expect(r.list_target).toBe(false);
    });
  }
  test("USDC, 10,000 wei: block, the pair refuses a buy that would pay out 0, not listed", async () => {
    const r = await at(tokens.usdc, 10_000n);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("simulated buy failed");
    expect(r.list_target).toBe(false);
  });
  test("the healthy demo token, 1 wei: block, the pool would pay 0 wei for its sale, not listed", async () => {
    const r = await at(tokens.safe, 1n);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ s after the buy/);
    expect(r.list_target).toBe(false);
  });
});

// Judge pass 6: dust was judged on the tokens the buy delivered, which the token decides, so a token that
// delivers almost nothing was never listed. Dust is now the pool's quote for the agent's amount.
describe("dust is the pool's quote for the amount, not what the token delivers (pure)", () => {
  const [token, buyer, stranger, pair] = ["0xa1", "0xa2", "0xa3", "0xa4"].map((a) => pad(a as Hex, { size: 20 })) as Address[];
  const w = { token, guard: GUARD_EVM, buyer, stranger };
  const transfer = (to: Address, value: bigint) => ({ address: token, topics: [TRANSFER, pad(pair), pad(to)], data: pad(toHex(value)) });
  const okWith = (logs: Result["logs"] = [], returnData: Hex = "0x"): Result => ({ status: "0x1", returnData, logs });
  /** judge on a check where the pool quotes `quoted` tokens for the amount and each buy delivers `got`;
   *  the takebacks revert, the sales succeed without logs (their tax is not measurable: never listed). */
  const judged = async (quoted: bigint, got: bigint) => {
    const p = localPreviews({ guard: w.guard, target: token, amount: AMOUNT });
    const txs = { buy: (await p.check(0n))[0], sales: [await p.sale(1n, 0n), await p.sale(1n, 0n)] as [Hex[], Hex[]] };
    const sales = { first: 10, bps: 5001, late: 40, far: 400 };
    const full = got >= 10n ? { amounts: { guard: got, probe: got }, owner: null, sale: sales } : undefined; // under 10 units the check stops at the buy
    const labels = labelsOf(plan(token, w, 100n, AMOUNT, txs, full));
    const results = labels.map((l): Result => {
      if (l === "buy quote") return okWith([], encodeAbiParameters([{ type: "uint256[]" }], [[AMOUNT, quoted]]));
      if (l === "buy" || l === "buy before takebacks") return okWith([transfer(buyer, got)]);
      if (l === `${GUARD}buy` || l === `${GUARD}buy before takebacks`) return okWith([transfer(w.guard, got)]);
      return l.includes("transferFrom") ? { status: "0x0", returnData: "0x" } : okWith();
    });
    const liquidity = { pair, supply: "1", supply_before: "1", created: null, candidates: 0, holders: null }; // old: no finding
    return judge(labels, results, { block: 100, cadence: CADENCE, code_hash: `0x${"00".repeat(32)}`, implementation: null, liquidity, reputation: null, near: NO_NEAR, opcodes: [], touched: [], token_calls: [], token_balances: [], sales, later: null }, w);
  };
  test("a buy that delivers 500 units where the pool quotes 10^18: block, listed", async () => {
    const r = await judged(10n ** 18n, 500n);
    expect(r.reasons).toMatch(/^100 % tax on the buy/);
    expect(r.list_target).toBe(true);
  });
  test("a buy that delivers nothing where the pool quotes 10^18: block, listed", async () => {
    const r = await judged(10n ** 18n, 0n);
    expect(r.reasons).toStartWith("simulated buy received no tokens");
    expect(r.list_target).toBe(true);
  });
  test("the same where the pool quotes under 1,000 units for the amount (dust): block, not listed", async () => {
    for (const got of [0n, 100n]) {
      const r = await judged(999n, got);
      expect(r.verdict).toBe("block");
      expect(r.list_target).toBe(false);
    }
  });
});

// Review of 73a7ad2: when others' trades could not be re-executed, a sale refused on the merged state was
// a warn, so a trap could force that fallback to escape a block. It is a block now; dust sent to the guard
// no longer refuses an honest token's sale there (app/later.ts gives that lone slot both changes).
describe("a resale not verified on Base's later state (pure)", () => {
  const [token, buyer, stranger, pair] = ["0xa1", "0xa2", "0xa3", "0xa4"].map((a) => pad(a as Hex, { size: 20 })) as Address[];
  const w = { token, guard: GUARD_EVM, buyer, stranger };
  const ok: Result = { status: "0x1", returnData: "0x", logs: [] };
  const refused: Result = { status: "0x0", returnData: "0x" };
  const sales = { first: 10, bps: 5001, late: 40, far: 400 };
  /** The later side's findings when the late sale passed on the reference block, and `sale` there. */
  const of = (unverified: string | null, sale: Result = refused) =>
    laterFindings(
      { [`${GUARD}buy`]: ok, [`${GUARD}approve router late`]: ok, [`${GUARD}sale late`]: ok, [`${LATER}${GUARD}approve router late`]: ok, [`${LATER}${GUARD}sale late`]: sale },
      w,
      sales,
      { block: 120, moved: [`${pair}:${toHex(8, { size: 32 })}`], reserves: ["1", "1"], replayed: [], unverified },
      pair,
      CADENCE,
    );
  test("more trades of the pool than can be re-executed, the sale refused there: block, not listed", () => {
    expect(of("11 trades of the pool, more than 10 to re-execute")).toEqual([
      { level: "block", text: "sale refused 40 s after the buy on Base's state of block 120 (revert without reason), merged with the buy's values: 11 trades of the pool, more than 10 to re-execute" },
    ]);
  });
  test("a slot the buy wrote moved with no transaction to re-execute, the sales refused on Base's value of it: block", () => {
    expect(of("slot 0x0000..0008 of 0x0000..00a1 moved in blocks 101..120 with no trade of the pool nor transfer of the guard's")[0]?.level).toBe("block");
  });
  test("not verified, the sale going through there: warn, as before", () => {
    expect(of("11 trades of the pool, more than 10 to re-execute", ok)).toEqual([{ level: "warn", text: "resale not verified on Base's state of block 120: 11 trades of the pool, more than 10 to re-execute" }]);
  });
  test("verified, the sale refused there: block", () => {
    expect(of(null)).toEqual([{ level: "block", text: "sale refused 40 s after the buy on Base's state of block 120 (revert without reason)" }]);
  });
});

describe("removable liquidity (Uniswap V2 pair of the target)", () => {
  test("a young pool whose whole LP sits with one EOA: warn, naming the EOA and the removable share", async () => {
    const r = await check(tokens.lp_held);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("100 % of the LP removable now");
    expect(r.reasons).toContain("EOA 0x60b1");
    expect(r.evidence.liquidity?.holders?.some((h) => h.kind === "eoa")).toBe(true);
  });
  test("pair created long ago with dust, deep liquidity added within the window: the age is the liquidity's, warn", async () => {
    const r = await check(tokens.late_liquidity);
    const l = r.evidence.liquidity!;
    expect(l.created).toBeNull(); // the pair contract is older than the window
    expect(BigInt(l.supply_before) * 10n).toBeLessThan(BigInt(l.supply)); // but its liquidity is not
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("% of the LP removable now (EOA 0x60b1");
  });
  test("a young pool whose LP is burned (0x0, 0xdead): no liquidity finding, allow", async () => {
    const r = await check(tokens.lp_burned);
    expect(r.verdict).toBe("allow");
    expect(r.evidence.liquidity?.holders?.every((h) => h.kind === "burned")).toBe(true);
  });
  test("WETH/USDC: at least 90 % of its LP existed an hour ago, holders not read, allow", async () => {
    const r = await check(tokens.usdc);
    expect(r.verdict).toBe("allow");
    const l = r.evidence.liquidity!;
    expect(l.holders).toBeNull();
    expect(BigInt(l.supply_before) * 10n).toBeGreaterThanOrEqual(BigInt(l.supply) * 9n);
  });
});

describe("liquidity rule (pure)", () => {
  const pair = "0x00000000000000000000000000000000000000aa" as Address;
  const eoa = (a: string, balance: bigint): Holder => ({ address: a as Address, balance: balance.toString(), kind: "eoa" });
  const burned: Holder = { address: "0x000000000000000000000000000000000000dead", balance: "40", kind: "burned" };
  const young = (holders: Holder[] | null, candidates = holders?.length ?? 99): Liquidity => ({ pair, supply: "100", supply_before: "0", created: 90, candidates, holders });
  test("holders that cannot be read (too many candidates): warn, never a pass", () => {
    expect(liquidityFindings(young(null, 25), 100)[0]).toMatchObject({ level: "warn", text: "pool 10 blocks old: LP spread over 25 addresses, holders not read" });
  });
  test("LP not all accounted for by the holders read: warn", () => {
    expect(liquidityFindings(young([burned]), 100)[0]?.level).toBe("warn");
  });
  test("LP split across several EOAs is summed: 60 % removable is a warn", () => {
    expect(liquidityFindings(young([burned, eoa("0x01", 30n), eoa("0x02", 30n)]), 100)[0]?.text).toContain("60 % of the LP removable now");
  });
  test("LP held by a contract (lock terms not read) counts as removable", () => {
    const locker: Holder = { address: "0x00000000000000000000000000000000000000cc", balance: "60", kind: "contract" };
    expect(liquidityFindings(young([burned, locker]), 100)[0]?.text).toContain("(contract 0x0000..00cc holds 60 %)");
  });
  test("less than half removable: no finding", () => {
    expect(liquidityFindings(young([{ ...burned, balance: "60" }, eoa("0x01", 40n)]), 100)).toEqual([]);
  });
  test("an old pair whose LP grew by more than 10 % within the window is read, not passed on its age", () => {
    const l: Liquidity = { pair, supply: "100", supply_before: "89", created: null, candidates: 1, holders: [eoa("0x01", 11n)] };
    expect(liquidityFindings(l, 100)[0]?.text).toContain("11 % of the LP minted in the last hour: LP holders not all accounted for");
  });
});

describe("template reputation", () => {
  test("fresh token of a farm template: every simulation step passes, yet block by reputation", async () => {
    const r = await check(tokens.farm_fresh);
    const sales = r.evidence.calls.filter((c) => c.includes("buy") || c.includes("sale"));
    expect(sales.every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.verdict).toBe("block");
    // only the reputation and the removable LP: no simulation finding (tax, sale refused, takeback)
    expect(r.reasons.split(" ; ").map((f) => f.split(" ")[0])).toEqual(["template", "pool"]);
    expect(r.reasons).toMatch(/^template 0x[0-9a-f]{4}\.\.[0-9a-f]{4}: 5 of 5 earlier pools drained, median 2 blocks after funding/);
    expect(r.evidence.reputation).toMatchObject({ pools: 5, drained: 5, median_drain_blocks: 2 });
    expect(r.list_target).toBe(false); // a block on the template's reputation alone: the guard does not list the token
  });
  test("a simulation trap (sale refused): block resting on the token's own simulation, so list_target", async () => {
    const r = await check(tokens.sell_blocked);
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(true);
  });
  // review's poisoning (evm/fork.sh deploys it): three copies of USDC's code, each pool funded with
  // 0.6 ETH and drained the next block, are in the index under USDC's template
  test("copies of a token's code cannot get it blocked: USDC stays allow, its pool predates the window", async () => {
    const r = await check(tokens.usdc);
    expect(r.verdict).toBe("allow");
    expect(r.reasons).toContain("template reputation not applied: the token's own pool was funded before the index window");
    expect(r.evidence.reputation?.before_block).toBeNull();
    expect((await INDEX(r.evidence.block)).templates[r.evidence.template].filter((p) => p.drained !== null).length).toBe(3);
  });
  // Judge passes 7 and 8: a sentinel judged a farm copy on a window that missed its earlier pools, or
  // ended up to 300 blocks before the check, which drops a farm's newest pools.
  test("an index window that misses the farm's earlier pools, or ends before the check's block: refused, no verdict", async () => {
    await expect(check(tokens.farm_fresh, GUARD_EVM, (b) => buildIndex(RPC, b - 3, b))).rejects.toThrow("template index window");
    await expect(check(tokens.farm_fresh, GUARD_EVM, (b) => buildIndex(RPC, tokens.fork_block + 1, b - 1))).rejects.toThrow("is not bound to block");
  });
  test("without an index the reputation is unknown: warn, never allow", async () => {
    const r = await check(tokens.safe, GUARD_EVM, null);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("template reputation not checked");
  });
});

describe("shared blocklist and code changes read from NEAR", () => {
  const listed = (key: string): NearFacts => ({ listed: [{ key, reporter: "agent-b.testnet", evidence_sha256: "ab".repeat(32) }], previous: null });
  test("a token listed by another reporter: block, even with a clean simulation", async () => {
    const r = await check(tokens.usdc, GUARD_EVM, INDEX, listed(tokens.usdc.toLowerCase()));
    expect(r.verdict).toBe("block");
    expect(r.reasons).toStartWith("listed on NEAR by agent-b.testnet");
    expect(r.evidence.near.listed.length).toBe(1);
    expect(r.list_target).toBe(false); // already listed: nothing of its own to list it for
  });
  test("code changed since the last check (another code hash): warn, the human decides", async () => {
    const before = { id: 7, code_hash: `0x${"00".repeat(32)}` as const, implementation: null };
    const r = await check(tokens.lp_burned, GUARD_EVM, INDEX, { listed: [], previous: before });
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("code changed since the last check #7");
  });
  test("same code as at the last check: no finding", async () => {
    const first = await check(tokens.lp_burned);
    const previous = { id: 7, code_hash: first.evidence.code_hash, implementation: first.evidence.implementation };
    expect((await check(tokens.lp_burned, GUARD_EVM, INDEX, { listed: [], previous })).verdict).toBe("allow");
  });
  test("the sentinel asks NEAR about the target only (the guard lists tokens, never templates)", async () => {
    const asked: string[] = [];
    await checkNow(tokens.farm_fresh, GUARD_EVM, probes, {
      index: INDEX,
      near: async (target) => (asked.push(target), NO_NEAR),
      amount: AMOUNT,
      preview: await previews(tokens.farm_fresh, GUARD_EVM),
    });
    expect(asked).toEqual([tokens.farm_fresh as Address]);
  });
});

describe("exit quote (the agent's floor comes from it)", () => {
  const HOLDER = "0x60B1100000000000000000000000000000000001" as Address; // holds the demo tokens (evm/fork.sh)
  /** The approve and swap the guard would sign for an exit quote of `amount` by `seller`. */
  const exitPreview = async (seller: Address, amount: bigint) =>
    localPreviews({ guard: seller, target: tokens.lp_burned as Address, amount: 0n, requestedS: await headTime(), exitAmount: amount }).check;
  test("sale of tokens the address holds: allow, quote = ETH out of the simulated sale, simulated as the guard signs it", async () => {
    const amount = parseEther("1000");
    const preview = await exitPreview(HOLDER, amount);
    const r = await checkExit(RPC, tokens.lp_burned as Address, HOLDER, amount, preview);
    expect(r.verdict).toBe("allow");
    expect(BigInt(r.evidence.quote)).toBeGreaterThan(0n);
    expect(r.evidence.kind).toBe("exit");
    // the approve and swap simulated are those sell_quoted signs on this quote (floor = quote - 3 %)
    expect(r.evidence.tx_hashes).toEqual((await preview(BigInt(r.evidence.quote))).map((t) => keccak256(t)));
  });
  test("the quote is the ETH the seller receives, not the WETH that left the pool (pure)", () => {
    const [seller, pair, token] = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Address[];
    const transfer = (asset: Address, from: Address, to: Address, value: bigint) => ({ address: asset, topics: [TRANSFER, pad(from), pad(to)], data: pad(toHex(value)) });
    const sale = { status: "0x1" as Hex, returnData: "0x" as Hex, logs: [transfer(WETH, pair, ROUTER, 100n), transfer(ETH_LOGS, ROUTER, seller, 10n)] };
    const r = judgeExit(["approve router", "exit sale"], [{ status: "0x1", returnData: "0x", logs: [] }, sale], { token, seller, pair });
    expect(r).toMatchObject({ verdict: "allow", quote: 10n });
  });
  test("sale of more than the address holds: no quote, block (the owner's own exit stays open)", async () => {
    const seller = rand();
    const r = await checkExit(RPC, tokens.lp_burned as Address, seller, parseEther("1000"), await exitPreview(seller, parseEther("1000")));
    expect(r.verdict).toBe("block");
    expect(r.evidence.quote).toBe("0");
  });
});

describe("quote posted with the verdict", () => {
  test("USDC, no tax: tokens the guard received for the amount stated = pool output at the block", async () => {
    const r = await check(tokens.usdc);
    const out = await rpc<Hex>(RPC, "eth_call", [
      { to: ROUTER, data: encodeFunctionData({ abi: quoteAbi, args: [AMOUNT, [WETH, tokens.usdc as Address]] }) },
      `0x${r.evidence.block.toString(16)}`,
    ]);
    const [amounts] = decodeAbiParameters([{ type: "uint256[]" }], out);
    expect(r.evidence.quote).toBe(amounts[1].toString());
    expect(BigInt(r.evidence.quote)).toBeGreaterThan(0n);
  });
});

describe("proof", () => {
  test("carries the hash of the target's code at the check's block", async () => {
    const r = await check(tokens.safe);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [tokens.safe, `0x${r.evidence.block.toString(16)}`] }),
    });
    const { result: code } = (await res.json()) as { result: `0x${string}` };
    expect(r.evidence.code_hash).toBe(keccak256(code));
  });
  test("simulated blocks follow the cadence measured (the fork's 100 blocks in 100 s), the real base fee and coinbase, one prevrandao per L1 epoch of 12 s", async () => {
    const r = await check(tokens.safe);
    expect(r.evidence.cadence).toEqual(CADENCE);
    /** Each request's base block: the reference block, the later side's real block for the 4th; the far
     *  sale's blocks (5th) count from the reference block too. */
    const bases = [r.evidence.block, r.evidence.block, r.evidence.block, r.evidence.later!.block, r.evidence.block];
    for (const [i, q] of r.request.entries()) {
      const block = BigInt(bases[i]);
      expect(q.params[1]).toBe(toHex(block));
      const h = await rpc<{ baseFeePerGas: string; mixHash: Hex; miner: string; timestamp: string }>(RPC, "eth_getBlockByNumber", [toHex(block), false]);
      const seq = BigInt(await rpc<Hex>(RPC, "eth_call", [{ to: "0x4200000000000000000000000000000000000015", data: "0x64ca23ef" }, toHex(block)])); // L1Block.sequenceNumber()
      const epochOf = (n: bigint) => (seq + n - block) / 12n;
      const blocks = (q.params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: Record<string, string>[] }[] }).blockStateCalls;
      for (const b of blocks) {
        const n = BigInt(b.blockOverrides.number);
        expect(BigInt(b.blockOverrides.time) - BigInt(h.timestamp)).toBe(n - block); // number and time agree, a second a block
        expect(b.blockOverrides).toMatchObject({ baseFeePerGas: h.baseFeePerGas, feeRecipient: h.miner });
        // as on Base, the L1 origin's for the rest of the base block's epoch, then one per later epoch
        expect(b.blockOverrides.prevRandao).toBe(epochOf(n) === 0n ? h.mixHash : keccak256(concat([h.mixHash, toHex(epochOf(n), { size: 32 })])));
        for (const c of b.calls) {
          expect(BigInt(c.maxPriorityFeePerGas)).toBeGreaterThan(0n);
          expect(BigInt(c.maxFeePerGas)).toBeGreaterThan(BigInt(h.baseFeePerGas));
          expect(c.gas).toBe("0x3d090"); // the guard's 250,000, not the block's limit
        }
      }
    }
    const later = (r.request[3].params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: unknown[] }[] }).blockStateCalls;
    expect(BigInt(later[0].blockOverrides.number)).toBeGreaterThan(BigInt(r.evidence.later!.block)); // after the real block, the guard side's blocks
    expect(BigInt(later.at(-1)!.blockOverrides.number)).toBe(BigInt(r.evidence.block + r.evidence.sales.late + 1));
    const block = BigInt(r.evidence.block);
    const seq = BigInt(await rpc<Hex>(RPC, "eth_call", [{ to: "0x4200000000000000000000000000000000000015", data: "0x64ca23ef" }, toHex(block)]));
    const epochOf = (n: bigint) => (seq + n - block) / 12n;
    const guardSide = (r.request[0].params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: unknown[] }[] }).blockStateCalls;
    const [first, late] = [BigInt(r.evidence.sales.first), BigInt(r.evidence.sales.late)];
    // buy; each sale's approve, then its swap `first` and `late` blocks after the buy; nothing after the late swap
    expect(guardSide.filter((b) => b.calls.length).map((b) => BigInt(b.blockOverrides.number) - block)).toEqual([1n, first, first + 1n, late, late + 1n]);
    expect(guardSide.map((b) => BigInt(b.blockOverrides.number) - block)).toEqual(Array.from({ length: Number(late) + 1 }, (_, i) => BigInt(i + 1))); // no gap for the node to fill
    expect(new Set(guardSide.map((b) => b.blockOverrides.prevRandao)).size).toBe(Number(epochOf(block + late + 1n)) + 1);
    // the far sales: the guard's late approve and swap 301 s, `far` blocks and 900 s after the buy, then the
    // probe's, mined on a local fork at those numbers and times (a block a second here), past eth_simulateV1's 256
    expect(r.request[4].method).toBe(FAR_METHOD);
    const far = (r.request[4].params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: { from: string; data: string }[] }[] }).blockStateCalls;
    const f = BigInt(r.evidence.sales.far);
    const side = [301n, 302n, f, f + 1n, 900n, 901n];
    expect(far.map((b) => BigInt(b.blockOverrides.number) - block)).toEqual([...side, ...side]);
    expect(f).toBeGreaterThan(256n);
    expect(far.map((b) => b.calls.map((c) => c.data.slice(0, 10)))).toEqual(Array(6).fill([["0x095ea7b3"], ["0x791ac947"]]).flat());
    expect(far[0].calls[0] as unknown).toEqual(guardSide[Number(late) - 1].calls[0]); // the late sale's very approve
  });
  test("carries a proxy's implementation (USDC)", async () => {
    const r = await check(tokens.usdc);
    expect(r.evidence.implementation).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
