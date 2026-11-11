// Template reputation: template hash, index rebuilt from chain logs, farm rule. Fork tests need
// evm/fork.sh running (it launches the demo farm: five drained pools and a fresh one).
import { describe, expect, test } from "bun:test";
import { getContractAddress, keccak256, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex, indexSha256, reputationFindings, reputationOf, templateOf, type Index } from "./index";
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
  test("the demo tokens (LP burned or held, never removed) are not drained", async () => {
    const demo = index.templates[templateOf(await codeOf(tokens.safe))];
    expect(demo.length).toBe(13);
    expect(demo.every((p) => p.drained === null)).toBe(true);
  });
  test("deterministic: rebuilt from the same chain state, same sha256", async () => {
    expect(indexSha256(await buildIndex(RPC, tokens.fork_block + 1, head))).toBe(indexSha256(index));
  });
  test("reputation of the fresh token: its own pool excluded, 5 of 5 drained, median 2 blocks -> block", () => {
    const own = index.templates[farm].find((p) => p.token === tokens.farm_fresh.toLowerCase())!.pair;
    const r = reputationOf(index, farm, own);
    expect(r).toMatchObject({ template: farm, pools: 5, drained: 5, median_drain_blocks: 2, index_sha256: indexSha256(index) });
    const [f] = reputationFindings(r);
    expect(f.level).toBe("block");
    expect(f.text).toBe(`template ${farm.slice(0, 6)}..${farm.slice(-4)}: 5 of 5 earlier pools drained, median 2 blocks after creation`);
  });
});

describe("farm rule", () => {
  const index: Index = { chain_id: 8453, factory: "0x", weth: "0x", from: 1, to: 100, templates: {} };
  const pools = (drained: (number | null)[]) => drained.map((d, i) => ({ pair: `0x${i}` as Address, token: `0x${i}` as Address, created: 10, drained: d }));
  test("no index: reputation unknown, which is a warn, never a pass", () => {
    expect(reputationFindings(null)).toEqual([{ level: "warn", text: "template reputation not checked: no index for this chain" }]);
  });
  test("fewer than 3 earlier pools is an anecdote: no finding", () => {
    const t = "0xaa" as Hex;
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12]) } }, t, null))).toEqual([]);
  });
  test("3 of 4 drained (75 %) is below the farm share: no finding; 4 of 5 is a farm", () => {
    const t = "0xaa" as Hex;
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12, null]) } }, t, null))).toEqual([]);
    expect(reputationFindings(reputationOf({ ...index, templates: { [t]: pools([12, 12, 12, 13, null]) } }, t, null))[0].level).toBe("block");
  });
  test("a drain more than 1 day (43,200 blocks) after creation is not counted as a farm drain", () => {
    const t = "0xaa" as Hex;
    expect(reputationOf({ ...index, templates: { [t]: pools([12, 12, 10 + 43_201]) } }, t, null).drained).toBe(2);
  });
});
