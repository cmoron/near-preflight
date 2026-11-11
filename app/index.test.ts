// Template reputation: template hash, index rebuilt from chain logs, farm rule. Fork tests need
// evm/fork.sh running (it launches the demo farm: five drained pools and a fresh one).
import { describe, expect, test } from "bun:test";
import { getContractAddress, keccak256, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { beforeBlock, buildIndex, indexSha256, reputationFindings, reputationOf, templateOf, type Index } from "./index";
import { rpc } from "./verifier";

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
  test("the farm template: 6 pools, 5 drained 2 blocks after creation, the fresh one not drained", () => {
    const pools = index.templates[farm];
    expect(pools.length).toBe(6);
    expect(pools.filter((p) => p.drained !== null).map((p) => p.drained! - p.created)).toEqual([2, 2, 2, 2, 2]);
    expect(pools.find((p) => p.token === tokens.farm_fresh.toLowerCase())?.drained).toBeNull();
  });
  test("each pool records the WETH its liquidity provider added (Mint logs): 1 ETH for every farm pool", () => {
    expect(index.templates[farm].map((p) => p.weth_added)).toEqual(Array(6).fill("1000000000000000000"));
  });
  test("the demo tokens (LP burned or held, never removed) are not drained", async () => {
    const demo = index.templates[templateOf(await codeOf(tokens.safe))];
    expect(demo.length).toBe(13);
    expect(demo.every((p) => p.drained === null)).toBe(true);
  });
  test("deterministic: rebuilt from the same chain state, same sha256", async () => {
    expect(indexSha256(await buildIndex(RPC, tokens.fork_block + 1, head))).toBe(indexSha256(index));
  });
  test("reputation of the fresh token: only pools before its own, 5 of 5 drained, median 2 blocks -> block", async () => {
    const own = index.templates[farm].find((p) => p.token === tokens.farm_fresh.toLowerCase())!;
    const r = reputationOf(index, farm, await beforeBlock(RPC, index, own.pair));
    expect(r).toMatchObject({ template: farm, before_block: own.created, pools: 5, drained: 5, median_drain_blocks: 2, index_sha256: indexSha256(index) });
    const [f] = reputationFindings(r);
    expect(f.level).toBe("block");
    expect(f.text).toBe(`template ${farm.slice(0, 6)}..${farm.slice(-4)}: 5 of 5 earlier pools drained, median 2 blocks after creation`);
  });
  test("own pool outside the index: one eth_getCode at `from` says whether it predates the window (none earlier) or came after it (all earlier)", async () => {
    const own = index.templates[farm].find((p) => p.token === tokens.farm_fresh.toLowerCase())!;
    const old = index.templates[farm][0]; // farm 1's pool, created before the fresh one
    const later = await buildIndex(RPC, own.created, head); // only the fresh pool; farm 1's pair already has code at `from`
    expect(await beforeBlock(RPC, later, old.pair)).toBe(later.from);
    expect(reputationOf(later, farm, later.from).pools).toBe(0);
    const before = await buildIndex(RPC, tokens.fork_block + 1, own.created - 1); // no code at `from` yet
    expect(await beforeBlock(RPC, before, own.pair)).toBe(before.to + 1);
    expect(reputationOf(before, farm, before.to + 1)).toMatchObject({ pools: 5, drained: 5 });
  });
});

describe("farm rule", () => {
  const index: Index = { chain_id: 8453, factory: "0x", weth: "0x", from: 1, to: 100, templates: {} };
  const ONE_ETH = "1000000000000000000";
  const pools = (drained: (number | null)[], created = 10) =>
    drained.map((d, i) => ({ pair: `0x${created}${i}` as Address, token: `0x${created}${i}` as Address, created, drained: d, weth_added: ONE_ETH }));
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
  test("pools created after the target's own pool are not counted (copies drained later cannot poison it)", async () => {
    const t = "0xaa" as Hex;
    const [own] = pools([null], 20);
    const i = { ...index, templates: { [t]: [...pools([22], 10), own, ...pools([22, 22, 22], 30)] } };
    const before = await beforeBlock("http://unused.invalid", i, own.pair); // own pool in the index: no RPC read
    expect(before).toBe(20);
    expect(reputationOf(i, t, before)).toMatchObject({ before_block: 20, pools: 1, drained: 1 });
    expect(reputationFindings(reputationOf(i, t, before))).toEqual([]);
  });
  test("a pool seeded with less than MIN_POOL_WETH (0.5 ETH) is not counted: dust decoys are free", () => {
    const t = "0xaa" as Hex;
    const dust = { ...pools([12], 11)[0], weth_added: "499999999999999999" };
    const r = reputationOf({ ...index, templates: { [t]: [...pools([12, 12]), dust] } }, t, ALL);
    expect(r).toMatchObject({ pools: 2, drained: 2 });
    expect(reputationFindings(r)).toEqual([]);
  });
  test("with no own pool (no V2 WETH pair) every pool of the index counts", async () => {
    const t = "0xaa" as Hex;
    expect(await beforeBlock("http://unused.invalid", index, null)).toBe(ALL);
    expect(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12], 100) } }, t, ALL)).toMatchObject({ before_block: ALL, pools: 3, drained: 3 });
  });
});
