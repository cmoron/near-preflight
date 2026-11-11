// Template reputation: template hash, index rebuilt from chain logs, farm rule. Fork tests need
// evm/fork.sh running (it launches the demo farm: five drained pools and a fresh one).
import { afterAll, describe, expect, test } from "bun:test";
import { getContractAddress, keccak256, pad, parseEther, stringToHex, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { beforeBlock, buildIndex, indexSha256, reputationFindings, reputationOf, templateOf, type Index } from "./index";
import { FACTORY, rpc, WETH } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const head = Number(BigInt(await rpc<Hex>(RPC, "eth_blockNumber", [])));
const codeOf = (a: string) => rpc<Hex>(RPC, "eth_getCode", [a, "latest"]);
/** FarmToken deployed by the i-th farm creator of evm/fork.sh (its first transaction). */
const farmToken = (i: number) => getContractAddress({ from: `0xfa4300000000000000000000000000000000000${i}`, nonce: 0n });

describe("template hash", () => {
  test("PUSH32 operands (where solc writes immutables) and the CBOR metadata tail are masked", () => {
    const meta = "a1646970667358" + "11".repeat(4) + "000b"; // map(1) "ipfs" ... then its length (11 bytes)
    const a = `0x7f${"aa".repeat(32)}5b${"a1646970667358"}${"22".repeat(4)}000b` as Hex;
    const b = `0x7f${"bb".repeat(32)}5b${meta}` as Hex;
    expect(keccak256(a)).not.toBe(keccak256(b));
    expect(templateOf(a)).toBe(templateOf(b));
  });
  test("other push operands are code, not masked (a minimal proxy's implementation address stays)", () => {
    expect(templateOf(`0x73${"aa".repeat(20)}5b`)).not.toBe(templateOf(`0x73${"bb".repeat(20)}5b`));
  });
  test("two farm tokens from different creators: different keccak256 (immutable creator), same template", async () => {
    const [a, b] = await Promise.all([codeOf(farmToken(1)), codeOf(farmToken(2))]);
    expect(a.length).toBeGreaterThan(100);
    expect(keccak256(a)).not.toBe(keccak256(b));
    expect(templateOf(a)).toBe(templateOf(b));
    expect(templateOf(a)).toBe(templateOf(await codeOf(tokens.farm_fresh)));
    expect(templateOf(a)).not.toBe(templateOf(await codeOf(tokens.safe))); // DemoToken: another template
  });
});

describe("index rebuilt from chain logs", async () => {
  const index = await buildIndex(RPC, tokens.fork_block + 1, head);
  const farm = templateOf(await codeOf(tokens.farm_fresh));
  test("the farm template: 6 pools, 5 drained 2 blocks after their funding, the fresh one not drained", () => {
    const pools = index.templates[farm];
    expect(pools.length).toBe(6);
    expect(pools.filter((p) => p.drained !== null).map((p) => p.drained! - p.funded!)).toEqual([2, 2, 2, 2, 2]);
    expect(pools.find((p) => p.token === tokens.farm_fresh.toLowerCase())?.drained).toBeNull();
  });
  test("each farm pool is funded (1 ETH, at least 0.5 ETH, from its Mint log) in the block that created it", () => {
    expect(index.templates[farm].every((p) => p.funded === p.created)).toBe(true);
  });
  test("a pair created with dust and funded 2000 blocks later is dated by its funding (late_liquidity)", () => {
    const late = Object.values(index.templates).flat().find((p) => p.token === tokens.late_liquidity.toLowerCase())!;
    expect(late.funded! - late.created).toBeGreaterThanOrEqual(2000);
  });
  test("the demo tokens (LP burned or held, never removed) are not drained", async () => {
    const demo = index.templates[templateOf(await codeOf(tokens.safe))];
    expect(demo.length).toBe(14);
    expect(demo.every((p) => p.drained === null)).toBe(true);
  });
  test("deterministic: rebuilt from the same chain state, same sha256", async () => {
    expect(indexSha256(await buildIndex(RPC, tokens.fork_block + 1, head))).toBe(indexSha256(index));
  });
  test("reputation of the fresh token: only pools before its own, 5 of 5 drained, median 2 blocks -> block", async () => {
    const own = index.templates[farm].find((p) => p.token === tokens.farm_fresh.toLowerCase())!;
    const r = reputationOf(index, farm, beforeBlock(index, own.pair));
    expect(r).toMatchObject({ template: farm, before_block: own.funded, pools: 5, drained: 5, median_drain_blocks: 2, index_sha256: indexSha256(index) });
    const [f] = reputationFindings(r);
    expect(f.level).toBe("block");
    expect(f.text).toBe(`template ${farm.slice(0, 6)}..${farm.slice(-4)}: 5 of 5 earlier pools drained, median 2 blocks after funding`);
  });
  test("own pool outside the index window: the whole window counts", async () => {
    const own = index.templates[farm].find((p) => p.token === tokens.farm_fresh.toLowerCase())!;
    const before = await buildIndex(RPC, tokens.fork_block + 1, own.created - 1); // the fresh pool is not in it
    expect(beforeBlock(before, own.pair)).toBe(before.to + 1);
    expect(reputationOf(before, farm, before.to + 1)).toMatchObject({ pools: 5, drained: 5 });
  });
});

describe("farm rule", () => {
  const index: Index = { chain_id: 8453, factory: "0x", weth: "0x", from: 1, to: 100, templates: {} };
  const pools = (drained: (number | null)[], created = 10) =>
    drained.map((d, i) => ({ pair: `0x${created}${i}` as Address, token: `0x${created}${i}` as Address, created, funded: created, drained: d }));
  /** No own pool: every pool of the index counts. */
  const ALL = index.to + 1;
  test("no index: reputation unknown, which is a warn, never a pass", () => {
    expect(reputationFindings(null)).toEqual([{ level: "warn", text: "template reputation not checked: no index for this chain" }]);
  });
  test("fewer than 3 earlier pools is an anecdote: no finding", () => {
    const t = "0xaa" as Hex;
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12]) } }, t, ALL))).toEqual([]);
  });
  test("3 of 4 drained (75 %) is below the farm share: no finding; 4 of 5 is a farm", () => {
    const t = "0xaa" as Hex;
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12, null]) } }, t, ALL))).toEqual([]);
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12, 13, null]) } }, t, ALL))[0].level).toBe("block");
  });
  test("a drain more than 1 day (43,200 blocks) after creation is not counted as a farm drain", () => {
    const t = "0xaa" as Hex;
    expect(reputationOf({ ...index, templates: { [t]: pools([12, 12, 10 + 43_201]) } }, t, ALL).drained).toBe(2);
  });
  test("pools funded after the target's own pool are not counted (copies drained later cannot poison it)", async () => {
    const t = "0xaa" as Hex;
    const [own] = pools([null], 20);
    const i = { ...index, templates: { [t]: [...pools([22], 10), own, ...pools([22, 22, 22], 30)] } };
    const before = beforeBlock(i, own.pair);
    expect(before).toBe(20);
    expect(reputationOf(i, t, before)).toMatchObject({ before_block: 20, pools: 1, drained: 1 });
    expect(reputationFindings(reputationOf(i, t, before))).toEqual([]);
  });
  test("a pool never funded to MIN_POOL_WETH (0.5 ETH) is not counted: dust decoys are free", () => {
    const t = "0xaa" as Hex;
    const dust = { ...pools([12], 11)[0], funded: null };
    const r = reputationOf({ ...index, templates: { [t]: [...pools([12, 12]), dust] } }, t, ALL);
    expect(r).toMatchObject({ pools: 2, drained: 2 });
    expect(reputationFindings(r)).toEqual([]);
  });
  test("a target pair created empty before the farm and funded after it is dated by its funding: the farm counts", async () => {
    const t = "0xaa" as Hex;
    const own = { pair: "0x0e" as Address, token: "0x0e" as Address, created: 5, funded: 40, drained: null };
    const farm = [10, 20, 30].map((b) => ({ pair: `0x${b}` as Address, token: `0x${b}` as Address, created: b, funded: b, drained: b + 2 }));
    const i = { ...index, templates: { [t]: [own, ...farm] } };
    const before = beforeBlock(i, own.pair);
    expect(before).toBe(40);
    expect(reputationFindings(reputationOf(i, t, before))[0]?.level).toBe("block");
  });
  test("own pool not in the index, or never funded to the minimum: all history counts, no chain read", async () => {
    const t = "0xaa" as Hex;
    const dust = { pair: "0x0d" as Address, token: "0x0d" as Address, created: 5, funded: null, drained: null };
    const i = { ...index, templates: { [t]: [dust] } };
    expect(beforeBlock(i, "0x00000000000000000000000000000000000000ff")).toBe(ALL);
    expect(beforeBlock(i, dust.pair)).toBe(ALL);
  });
  test("with no own pool (no V2 WETH pair) every pool of the index counts", async () => {
    const t = "0xaa" as Hex;
    expect(beforeBlock(index, null)).toBe(ALL);
    expect(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12], 100) } }, t, ALL)).toMatchObject({ before_block: ALL, pools: 3, drained: 3 });
  });
});

describe("pool funding: net WETH, from a fixture of logs served by a fake node", async () => {
  const topic = (sig: string) => keccak256(stringToHex(sig));
  const [PAIR_CREATED, MINT, BURN] = ["PairCreated(address,address,address,uint256)", "Mint(address,uint256,uint256)", "Burn(address,uint256,uint256,address)"].map(topic);
  const data = (...words: bigint[]) => `0x${words.map((w) => pad(toHex(w)).slice(2)).join("")}` as Hex;
  const eth = (x: string) => parseEther(x);
  const at = (block: number) => toHex(block);
  // [token, pair]: a token below WETH's address is token0 (its pair's WETH amount is amount1), above it token1.
  const CHURN = ["0x1111111111111111111111111111111111111111", "0x00000000000000000000000000000000000000a1"] as const;
  const PARTIAL = ["0x9999999999999999999999999999999999999999", "0x00000000000000000000000000000000000000a2"] as const;
  const RICH_BURN = ["0x2222222222222222222222222222222222222222", "0x00000000000000000000000000000000000000a3"] as const;
  const created = ([token, pair]: readonly [string, string], block: number) => {
    const [t0, t1] = token < WETH.toLowerCase() ? [token, WETH] : [WETH, token];
    return { address: FACTORY, topics: [PAIR_CREATED, pad(t0 as Hex), pad(t1 as Hex)], data: data(BigInt(pair), 1n), blockNumber: at(block) };
  };
  /** A Mint or Burn of `weth` WETH and 1,000 times as many tokens on the pair, in the pair's token order. */
  const lp = (event: Hex, [token, pair]: readonly [string, string], weth: bigint, block: number) => ({
    address: pair,
    topics: event === MINT ? [MINT, pad(pair as Hex)] : [BURN, pad(pair as Hex), pad(pair as Hex)],
    data: token < WETH.toLowerCase() ? data(1000n * weth, weth) : data(weth, 1000n * weth),
    blockNumber: at(block),
  });
  const logs = [
    created(CHURN, 10),
    created(PARTIAL, 11),
    created(RICH_BURN, 12),
    // 0.1 ETH added and removed 5 times: 0.5 ETH of cumulative Mints, never more than 0.1 ETH in the pool.
    ...[0, 1, 2, 3, 4].flatMap((k) => [lp(MINT, CHURN, eth("0.1"), 20 + 2 * k), lp(BURN, CHURN, eth("0.1"), 21 + 2 * k)]),
    // 0.4 in, 0.2 out, 0.2 in (cumulative Mints 0.6, net 0.4), 0.1 in: net 0.5 at block 23.
    lp(MINT, PARTIAL, eth("0.4"), 20),
    lp(BURN, PARTIAL, eth("0.2"), 21),
    lp(MINT, PARTIAL, eth("0.2"), 22),
    lp(MINT, PARTIAL, eth("0.1"), 23),
    // 0.2 in, 0.6 out (the burn also returns WETH buyers swapped in): net floored at 0, then 0.5 in.
    lp(MINT, RICH_BURN, eth("0.2"), 20),
    lp(BURN, RICH_BURN, eth("0.6"), 21),
    lp(MINT, RICH_BURN, eth("0.5"), 22),
  ];
  const node = Bun.serve({
    port: 0,
    async fetch(req) {
      const { method, params } = (await req.json()) as { method: string; params: [Record<string, unknown>] };
      const filter = params[0] ?? {};
      const addresses = [filter.address].flat().map((a) => String(a).toLowerCase());
      const first = [(filter.topics as unknown[] | undefined)?.[0]].flat();
      const inRange = (b: Hex) => Number(b) >= Number(filter.fromBlock) && Number(b) <= Number(filter.toBlock);
      const result =
        method === "eth_chainId" ? "0x2105"
        : method === "eth_getCode" ? "0x6001"
        : logs.filter((l) => addresses.includes(l.address.toLowerCase()) && first.includes(l.topics[0]) && inRange(l.blockNumber));
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    },
  });
  afterAll(() => node.stop());
  const index = await buildIndex(`http://127.0.0.1:${node.port}`, 1, 100);
  const funded = (pair: string) => Object.values(index.templates).flat().find((p) => p.pair === pair)?.funded;
  test("liquidity added and removed 5 times (0.5 ETH of Mints, 0.1 ETH at most in the pool) never funds the pool", () => {
    expect(funded(CHURN[1])).toBeNull();
  });
  test("a pool is funded when Mints minus Burns reach 0.5 ETH (WETH as token0), not when Mints alone do", () => {
    expect(funded(PARTIAL[1])).toBe(23);
  });
  test("a burn returning more WETH than was added floors the net at 0: 0.5 ETH added afterwards funds the pool", () => {
    expect(funded(RICH_BURN[1])).toBe(22);
  });
});
