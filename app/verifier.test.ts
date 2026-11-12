// The sentinel's checks against the local copy of Base (run evm/fork.sh first).
import { describe, expect, test } from "bun:test";
import { concat, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, parseEther, parseTransaction, stringToHex, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex, type Index } from "./index";
import { localPreviews, SETUP_FEES } from "./testkit";
import { checkExit, checkToken, deriveProbes, ETH_LOGS, FACTORY, GUARD, judge, judgeExit, labelsOf, liquidityFindings, plan, ROUTER, rpc, specialOf, WETH, type Fees, type Header, type Holder, type Liquidity, type NearFacts, type Result } from "./verifier";

const TRANSFER = keccak256(stringToHex("Transfer(address,address,uint256)"));

const quoteAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
/** The guard's EVM address: the one the guard_frozen trap freezes (set by evm/fork.sh). */
const GUARD_EVM = await specialOf(RPC, tokens.guard_frozen as Address);
const rand = (): Address => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
let tickets = 0;
/** Probes and first sale derived as the sentinel does, for a fresh check of a guard. */
const probes = (head: Header) => deriveProbes({ guard: "guard.test", id: ++tickets, requested_ns: "0" }, head.hash);
/** Index of every pool the fork setup launched (evm/fork.sh), as the sentinel would load it. */
const INDEX = await buildIndex(RPC, tokens.fork_block + 1, Number(BigInt(await rpc<Hex>(RPC, "eth_blockNumber", []))));
const NO_NEAR: NearFacts = { listed: [], previous: null };
/** The amount the agent states at request_check in the demo: 0.00001 ETH. */
const AMOUNT = 10_000_000_000_000n;
/** Time of the fork's latest block: a check requested now (its swap deadline is 300 s later). */
const headTime = async () => BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).timestamp);
/** What the guard would sign for a check of `token` by `guard`, requested now. */
const previews = async (token: string, guard: Address, fees: Fees = SETUP_FEES, amount = AMOUNT) =>
  localPreviews({ guard, target: token as Address, amount, requestedS: await headTime(), fees });
const check = async (token: string, guard: Address = GUARD_EVM, index: Index | null = INDEX, near: NearFacts = NO_NEAR, fees: Fees = SETUP_FEES, amount = AMOUNT) =>
  checkToken(RPC, token as Address, guard, probes, { index, near: async () => near, amount, preview: await previews(token, guard, fees, amount) });

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
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("sale closed 5 minutes after the buy: block on the late sale, 200 to 255 blocks after the buy", async () => {
    const r = await check(tokens.sell_blocked_later);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain(`sale refused ${r.evidence.sales.late} blocks after the buy`);
    expect(r.reasons).not.toContain(`sale refused ${r.evidence.sales.first} blocks after the buy`);
    expect(r.list_target).toBe(true);
  });
  test("90 % tax on the sale: block", async () => {
    const r = await check(tokens.sell_tax);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("90 % tax");
    expect(r.list_target).toBe(true);
  });
  test("90 % tax only on the late sale: block", async () => {
    const r = await check(tokens.sell_tax_later);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain(`tax on the sale ${r.evidence.sales.late} blocks after the buy`);
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
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
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
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/); // the router masks the token's reason
    expect(r.list_target).toBe(true);
  });
});

// The review's Trap2: tokens keyed on a difference between what a looser simulation did and what the
// guard signs. The guard side now runs the guard's own transactions, so each is caught as a token trap.
describe("the guard side simulates exactly what the guard signs", () => {
  test("Trap2 mode 1, a sale only after an approve of 2^256 - 1 (the guard approves the exact amount): block, listed", async () => {
    const r = await check(tokens.approve_max_only);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true); // the probe signs the same approve: the token's own behaviour
  });
  test("Trap2 mode 2, a sale only after a buy of exactly 0.01 ETH (the agent asked 0.00001 ETH): block, listed", async () => {
    const r = await check(tokens.buy_001_only);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("the guard's buy is simulated as the very transaction it signs: calldata, value, nonce, gas, fees; its hash is in the evidence", async () => {
    const p = await previews(tokens.usdc, GUARD_EVM);
    const r = await checkToken(RPC, tokens.usdc as Address, GUARD_EVM, probes, { index: INDEX, near: async () => NO_NEAR, amount: AMOUNT, preview: p });
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
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true); // the probe never calls balanceOf either: the token's own behaviour
  });
  test("a buyer that never called the token itself before its buy can never sell: block, listed", async () => {
    const r = await check(tokens.untouched_buyer);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("a sale keyed by a stranger's failed transferFrom (it returns false and writes state): block, listed", async () => {
    const r = await check(tokens.stranger_key);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
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
    expect(r.request.length).toBe(3); // the probe's twins and the synthetic calls run apart
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
  test("its sibling keyed on the base fee, which the simulation keeps constant: warn naming BASEFEE, never allow", async () => {
    const r = await check(tokens.basefee_trap);
    expect(r.evidence.calls.filter((c) => c.includes("sale")).every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("code reads BASEFEE");
    expect(r.evidence.opcodes).toEqual(["BASEFEE"]);
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
    expect(r.reasons).toMatch(/^sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("AmountTrap, a sale only of half or all of the balance: block, listed", async () => {
    const r = await check(tokens.amount_trap);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/^sale refused \d+ blocks after the buy/);
    expect(r.list_target).toBe(true);
  });
  test("the sales derive from the ticket and the block hash: the first 5 to 150 blocks after the buy, 13 % to 87 %, never a whole percent; the rest 200 to 255 blocks after the buy (pure)", () => {
    const sales = Array.from({ length: 3000 }, (_, id) => deriveProbes({ guard: "guard.test", id, requested_ns: "0" }, keccak256(toHex(id))).sale);
    expect(Math.min(...sales.map((s) => s.first))).toBe(5);
    expect(Math.max(...sales.map((s) => s.first))).toBe(150);
    expect(Math.min(...sales.map((s) => s.late))).toBe(200);
    expect(Math.max(...sales.map((s) => s.late))).toBe(255); // eth_simulateV1 refuses a block 256 past the proof's: the buy is in the 1st
    expect(new Set(sales.map((s) => s.late)).size).toBe(56);
    expect(sales.every((s) => s.bps > 1300 && s.bps < 8700 && s.bps % 100 !== 0)).toBe(true);
    expect(new Set(sales.map((s) => s.bps)).size).toBeGreaterThan(1000);
    const ticket = { guard: "guard.test", id: 1, requested_ns: "0" };
    expect(deriveProbes(ticket, keccak256("0x01")).sale).not.toEqual(deriveProbes(ticket, keccak256("0x02")).sale); // the hash of a block not mined yet
  });
  test("the guard side sells the derived share first, then the rest", async () => {
    const r = await check(tokens.safe);
    const [g] = r.request.map((q) => (q.params[0] as { blockStateCalls: { calls: { data: Hex }[] }[] }).blockStateCalls.flatMap((b) => b.calls));
    const amounts = [g[1], g[3]].map((c) => decodeAbiParameters([{ type: "address" }, { type: "uint256" }], `0x${c.data.slice(10)}`)[1]); // the two approves
    const bought = amounts[0] + amounts[1];
    expect(amounts[0]).toBe((bought * BigInt(r.evidence.sales.bps)) / 10_000n);
  });
});

describe("a sale's tax is what the seller receives", () => {
  test("a token that swaps 90 % of each sale into the pool itself and sends that WETH to its owner: block", async () => {
    const r = await check(tokens.pair_pull_tax);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toMatch(/\d+ % tax on the sale \d+ blocks after the buy/);
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
    expect(r.reasons).toMatch(/sale refused \d+ blocks after the buy/);
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
    const sales = { first: 5, bps: 5001, late: 230 };
    const full = got >= 10n ? { amounts: { guard: got, probe: got }, owner: null, sale: sales } : undefined; // under 10 units the check stops at the buy
    const labels = labelsOf(plan(token, w, 100n, AMOUNT, txs, full));
    const results = labels.map((l): Result => {
      if (l === "buy quote") return okWith([], encodeAbiParameters([{ type: "uint256[]" }], [[AMOUNT, quoted]]));
      if (l === "buy" || l === "buy before takebacks") return okWith([transfer(buyer, got)]);
      if (l === `${GUARD}buy` || l === `${GUARD}buy before takebacks`) return okWith([transfer(w.guard, got)]);
      return l.includes("transferFrom") ? { status: "0x0", returnData: "0x" } : okWith();
    });
    const liquidity = { pair, supply: "1", supply_before: "1", created: null, candidates: 0, holders: null }; // old: no finding
    return judge(labels, results, { block: 100, code_hash: `0x${"00".repeat(32)}`, implementation: null, liquidity, reputation: null, near: NO_NEAR, opcodes: [], touched: [], sales }, w);
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
  test("WETH/USDC: at least 90 % of its LP existed 1800 blocks ago, holders not read, allow", async () => {
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
    expect(liquidityFindings(l, 100)[0]?.text).toContain("11 % of the LP minted in the last 1800 blocks: LP holders not all accounted for");
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
    expect(INDEX.templates[r.evidence.template].filter((p) => p.drained !== null).length).toBe(3);
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
    await checkToken(RPC, tokens.farm_fresh as Address, GUARD_EVM, probes, {
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
  test("simulated blocks follow Base's cadence: 2 s per block, the real base fee and coinbase, one prevrandao per L1 epoch of 6 blocks", async () => {
    const r = await check(tokens.safe);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [`0x${r.evidence.block.toString(16)}`, false] }),
    });
    const { result: h } = (await res.json()) as { result: { baseFeePerGas: string; mixHash: Hex; miner: string; timestamp: string } };
    const block = BigInt(r.evidence.block);
    const seq = BigInt(await rpc<Hex>(RPC, "eth_call", [{ to: "0x4200000000000000000000000000000000000015", data: "0x64ca23ef" }, toHex(block)])); // L1Block.sequenceNumber()
    const epochOf = (n: bigint) => (seq + n - block) / 6n;
    for (const q of r.request) {
      const blocks = (q.params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: Record<string, string>[] }[] }).blockStateCalls;
      for (const b of blocks) {
        const n = BigInt(b.blockOverrides.number);
        expect(BigInt(b.blockOverrides.time) - BigInt(h.timestamp)).toBe(2n * (n - block)); // number and time agree
        expect(b.blockOverrides).toMatchObject({ baseFeePerGas: h.baseFeePerGas, feeRecipient: h.miner });
        // as on Base, the L1 origin's for the rest of the proof block's epoch, then one per later epoch
        expect(b.blockOverrides.prevRandao).toBe(epochOf(n) === 0n ? h.mixHash : keccak256(concat([h.mixHash, toHex(epochOf(n), { size: 32 })])));
        for (const c of b.calls) {
          expect(BigInt(c.maxPriorityFeePerGas)).toBeGreaterThan(0n);
          expect(BigInt(c.maxFeePerGas)).toBeGreaterThan(BigInt(h.baseFeePerGas));
          expect(c.gas).toBe("0x3d090"); // the guard's 250,000, not the block's limit
        }
      }
    }
    const guardSide = (r.request[0].params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: unknown[] }[] }).blockStateCalls;
    const [first, late] = [BigInt(r.evidence.sales.first), BigInt(r.evidence.sales.late)];
    // buy; each sale's approve, then its swap `first` and `late` blocks after the buy; nothing after the late swap
    expect(guardSide.filter((b) => b.calls.length).map((b) => BigInt(b.blockOverrides.number) - block)).toEqual([1n, first, first + 1n, late, late + 1n]);
    expect(guardSide.map((b) => BigInt(b.blockOverrides.number) - block)).toEqual(Array.from({ length: Number(late) + 1 }, (_, i) => BigInt(i + 1))); // no gap for the node to fill
    expect(new Set(guardSide.map((b) => b.blockOverrides.prevRandao)).size).toBe(Number(epochOf(block + late + 1n)) + 1);
  });
  test("carries a proxy's implementation (USDC)", async () => {
    const r = await check(tokens.usdc);
    expect(r.evidence.implementation).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
