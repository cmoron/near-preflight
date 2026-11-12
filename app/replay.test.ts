// Replay of a proof against the local copy of Base (run evm/fork.sh first). Each check mines the blocks
// it waits for (app/testkit.ts mine); each test then reverts the fork to where it started.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodeFunctionData, maxUint256, parseAbi, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex } from "./index";
import { replay, summary, type OnChain, type Proof } from "./replay";
import { CHECK_BLOCKS, localPreviews, mine } from "./testkit";
import { checkExit, checkToken, deriveProbes, FAR_METHOD, LATER_S, rpc, ROUTER, saleRanges, specialOf, toProof, WETH, type Cadence, type NearFacts, type Probe } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const DEPLOYER: Address = "0x60B1100000000000000000000000000000000001"; // owner() of the demo tokens (evm/fork.sh)
const TRAP = tokens.sell_blocked as Address;
/** The local fork's cadence: a block a second (evm/fork.sh, app/testkit.ts FORK_S). */
const CADENCE: Cadence = { blocks: 100, seconds: 100 };
const RANGES = saleRanges(CADENCE);
const rand = (): Address => toHexAddr(crypto.getRandomValues(new Uint8Array(20)));
const toHexAddr = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Address;

/** The guard's EVM address the guard_frozen trap freezes (evm/fork.sh). */
const GUARD_EVM = await specialOf(RPC, tokens.guard_frozen as Address);
const GUARD_INFO = { account: "guard.test", evm: GUARD_EVM };
/** The template index the sentinel builds for a check: every pool of the fork setup, up to its block. */
const INDEX = (block: number) => buildIndex(RPC, tokens.fork_block + 1, block);
const NO_NEAR: NearFacts = { listed: [], previous: null };
/** The amount the agent states at request_check in the demo: 0.00001 ETH. */
const AMOUNT = 10_000_000_000_000n;
/** Time of the fork's latest block: a check requested now (its swap deadline is 300 s later). */
const headTime = async () => BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).timestamp);
/** A proof and the request time on NEAR its check was bound to (what get_check returns). */
type Requested = Proof & { requested_ns: string };
/** Proof of check #1 requested at the fork's latest block, once the blocks it waits for are mined; its
 *  probes are derived as the sentinel does, `probe` replaces part of them (a function gets the derived one). */
const proofOf = async (token: Address = TRAP, probe?: Partial<Probe> | ((derived: Probe) => Partial<Probe>), guard: Address = GUARD_EVM, near = NO_NEAR, traded = false): Promise<Requested> => {
  const requested = await headTime();
  const requested_ns = (requested * 1_000_000_000n).toString();
  await mine(RPC, CHECK_BLOCKS, false, traded ? token : undefined); // with `traded`, third parties buy the token from its pool meanwhile
  const r = await checkToken(RPC, token, guard, (head, c) => {
    const derived = deriveProbes({ guard: GUARD_INFO.account, id: 1, requested_ns }, head.hash, c);
    return { ...derived, ...(typeof probe === "function" ? probe(derived) : probe) };
  }, {
    requested_ns,
    index: INDEX,
    near: async () => near,
    amount: AMOUNT,
    preview: localPreviews({ guard, target: token, amount: AMOUNT, requestedS: requested }),
  });
  return { ...toProof(1, token, r), requested_ns };
};
let snapshot: Hex;
beforeEach(async () => void (snapshot = await rpc<Hex>(RPC, "evm_snapshot", [])));
afterEach(async () => void (await rpc(RPC, "evm_revert", [snapshot])));
/** The calls of block `i` of request `side` (0 the guard side, 1 the probe side, 2 the synthetic calls), editable. */
const callsIn = (p: Proof, side: number, i: number) => (p.request as any)[side].params[0].blockStateCalls[i].calls as Record<string, string>[];
const failed = (lines: { ok: boolean; line: string }[]) => lines.filter((l) => !l.ok).map((l) => l.line);
const evidenceOf = (p: Proof) => JSON.parse(p.evidence);
/** Modifies the content of the evidence string (as a forger would) and reserializes it. */
const withEvidence = (p: Proof, f: (e: any) => void): Proof => {
  const e = evidenceOf(p);
  f(e);
  return { ...p, evidence: JSON.stringify(e) };
};
/** Modified request then hash recomputed: only the targeted check must fail. */
const rehashed = (p: Proof): Proof => withEvidence(p, (e) => (e.request_sha256 = sha256(stringToHex(JSON.stringify(p.request)))));
const hashOf = (s: string) => sha256(stringToHex(s)).slice(2);
const blockTime = async (block: number) =>
  Number(BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])).timestamp));
/** Request as get_check returns it, consistent with the proof except `over`. */
const onChain = (p: Proof, over: Partial<NonNullable<OnChain>> = {}) => async (): Promise<OnChain> => ({
  target: p.target,
  verdict: p.verdict,
  reasons: p.reasons,
  evidence_sha256: hashOf(p.evidence),
  quote: evidenceOf(p).quote,
  requested_ns: (p as Partial<Requested>).requested_ns ?? "0",
  judged_ns: "0",
  code: "code_hash" in evidenceOf(p) ? { code_hash: evidenceOf(p).code_hash, implementation: evidenceOf(p).implementation } : null,
  exit_amount: evidenceOf(p).amount ?? null,
  amount_wei: evidenceOf(p).amount_wei ?? "0",
  tx_hashes: evidenceOf(p).tx_hashes.map((h: string) => h.slice(2)),
  signed_tx: null,
  list_target: evidenceOf(p).list_target ?? false,
  ...over,
});

describe("replay", () => {
  test("an intact proof replays identically (block verdict)", async () => {
    const proof = await proofOf();
    expect(proof.verdict).toBe("block");
    expect(typeof proof.evidence).toBe("string");
    const lines = await replay(proof, RPC);
    expect(failed(lines)).toEqual([]);
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });
  test("a tampered verdict (block -> allow) is detected", async () => {
    const proof = await proofOf();
    const bad = failed(await replay({ ...proof, verdict: "allow" }, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("verdict");
  });
  test("a tampered calldata in the request is detected (hash)", async () => {
    const proof = structuredClone(await proofOf());
    const [buy] = callsIn(proof, 0, 0);
    buy.data = buy.data.slice(0, -2) + "ff";
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true);
  });
  test("two swapped labels in evidence.calls are detected", async () => {
    const proof = withEvidence(await proofOf(), (e) => {
      const i = e.calls.findIndex((x: string) => x.startsWith("sale late:"));
      [e.calls[0], e.calls[i]] = [e.calls[i], e.calls[0]];
    });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("labels");
  });
  test("a request whose shape is not checkToken's is detected (token, buyer)", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const [swap] = callsIn(proof, 1, evidenceOf(proof).sales.late); // the late swap, in the last block
    swap.from = "0x" + "11".repeat(20); // the probe's late sale comes from another address than the buyer
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true); // hash and shape fail together
    expect(bad.some((l) => l.includes("request shape"))).toBe(true);
  });
  test("another RPC method is refused without any request being sent", async () => {
    const proof = structuredClone(await proofOf());
    (proof.request as any)[1].method = "anvil_setBalance";
    const real = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => (sent++, real(...a))) as typeof fetch;
    try {
      const bad = failed(await replay(proof, RPC));
      expect(bad.some((l) => l.includes("request shape"))).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toBe(0);
  });
  test("a block number different from evidence.block is refused without a request", async () => {
    const proof = structuredClone(await proofOf());
    (proof.request as any)[2].params[1] = "0x1";
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("request shape"))).toBe(true);
  });
  test("without --check, the summary says nothing is tied to the chain", () => {
    expect(summary([{ ok: true, line: "x" }], false, "block")).toContain("not checked against any on-chain verdict");
    expect(summary([{ ok: true, line: "x" }], true, "block")).toContain("same as on chain");
    expect(summary([{ ok: false, line: "x" }], true, "block")).not.toContain("same as on chain");
  });
});

describe("replay: the evidence string is the one posted on chain", () => {
  test("a file where evidence is not a string (old format) is refused without a request", async () => {
    const proof = await proofOf();
    const bad = failed(await replay({ ...proof, evidence: evidenceOf(proof) }, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("evidence");
  });
  test("an extra key in evidence is refused (content not rechecked)", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.note = "audited"));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("evidence"))).toBe(true);
  });
  test("evidence.tx_hashes other than the hash of the guard's buy simulated is detected", async () => {
    const forged = withEvidence(await proofOf(), (e) => (e.tx_hashes = [`0x${"00".repeat(32)}`]));
    expect(failed(await replay(forged, RPC))).toEqual([expect.stringContaining("the guard's buy simulated hashes to")]);
  });
  test("a guard buy simulated at another nonce than evidence.tx_hashes says is detected", async () => {
    const proof = structuredClone(await proofOf());
    const [buy] = callsIn(proof, 0, 0);
    buy.nonce = "0x7";
    callsIn(proof, 2, 0)[2].nonce = "0x7"; // its copy before the takebacks too: a consistent forgery
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("the guard's buy simulated hashes to"))).toBe(true);
  });
  test("a guard sale simulated with an approve of 2^256 - 1 instead of the exact amount is refused (request shape)", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const [approve] = callsIn(proof, 0, evidenceOf(proof).sales.first - 1); // the first sale's approve
    approve.data = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), args: [ROUTER, maxUint256] });
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("request shape: sale 1: not approve(router"))).toBe(true);
  });
  test("a tampered code_hash in evidence is detected", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.code_hash = `0x${"00".repeat(32)}`));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("code hash");
  });
  test("a tampered chain (chain_id) in evidence is detected", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.chain_id = 1));
    const bad = failed(await replay(proof, RPC));
    expect(bad[0]).toContain("chain id");
    expect(bad[1]).toContain("the guard's buy simulated hashes to"); // the chain id is in the signed transaction
    expect(bad.length).toBe(2);
  });
  test("a tampered quote in evidence is detected (replayed from the response)", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.quote = "1"));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("quote");
  });
  test("a forged LP holder fact (kind eoa -> burned) is detected, and the rejudged verdict differs", async () => {
    const proof = withEvidence(await proofOf(tokens.lp_held as Address), (e) => {
      for (const h of e.liquidity.holders) h.kind = "burned";
    });
    expect(proof.verdict).toBe("warn");
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("liquidity facts"))).toBe(true);
  });
  test("the farm block replays identically: index rebuilt from the node, same sha256, same reputation", async () => {
    const proof = await proofOf(tokens.farm_fresh as Address);
    expect(proof.verdict).toBe("block");
    const lines = await replay(proof, RPC);
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("rebuilt from the node: same sha256"))).toBe(true);
  });
  test("a forged reputation (0 of 5 drained, verdict warn) is detected", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => (e.reputation.drained = 0));
    const bad = failed(await replay({ ...proof, verdict: "warn" }, RPC));
    expect(bad.some((l) => l.includes("reputation"))).toBe(true);
  });
  test("a forged before_block (pools launched after the target counted too) is detected", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => (e.reputation.before_block = e.reputation.to + 1));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("template reputation differs"))).toBe(true);
  });
  test("a reputation without before_block (old format) is refused before anything is sent", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => delete e.reputation.before_block);
    expect(failed(await replay(proof, RPC))).toEqual(["MISMATCH evidence fields have unexpected types (nothing sent to the node)"]);
  });
  test("a forged template hash is detected", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => (e.template = `0x${"00".repeat(32)}`));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("template"))).toBe(true);
  });
  test("a tampered proxy implementation in evidence is detected (USDC)", async () => {
    const proof = withEvidence(await proofOf(tokens.usdc as Address), (e) => (e.implementation = DEPLOYER.toLowerCase()));
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("proxy implementation"))).toBe(true);
    // and the real implementation the trace touched is no longer expected: the rejudged verdict differs
    expect(bad.some((l) => l.includes("verdict/reasons differ"))).toBe(true);
  });
});

// The environment rule: what the guard's transactions touch and the opcodes in the code are facts of
// the evidence, recomputed by replay; a proof that leaves one out cannot pass.
describe("replay of the environment facts", () => {
  test("RedL1Trap's block replays identically: the guard's transactions traced again touch L1Block", async () => {
    const proof = await proofOf(tokens.red_l1_trap as Address);
    expect(proof.verdict).toBe("block");
    const lines = await replay(proof, RPC);
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("traced again on a local fork"))).toBe(true);
  });
  test("evidence that omits L1Block from the addresses touched, verdict rejudged allow: detected", async () => {
    const forged = withEvidence(await proofOf(tokens.red_l1_trap as Address), (e) => {
      e.touched = e.touched.filter((a: string) => a.startsWith("0x4752") || a === e.liquidity.pair || a === tokens.red_l1_trap.toLowerCase() || a.startsWith("0x4200000000000000000000000000000000000006"));
    });
    const lines = await replay({ ...forged, verdict: "allow", reasons: "buy, takeback probes and sales simulated without anomaly" }, RPC);
    expect(failed(lines).length).toBe(1);
    expect(failed(lines)[0]).toContain("addresses touched: evidence");
  });
  test("evidence that omits BASEFEE from the opcodes, reasons rejudged without it: detected", async () => {
    const proof = await proofOf(tokens.basefee_trap as Address);
    expect(proof.reasons).toContain("code reads BASEFEE");
    const forged = withEvidence(proof, (e) => (e.opcodes = []));
    const reasons = proof.reasons.split(" ; ").filter((f) => !f.startsWith("code reads BASEFEE")).join(" ; ");
    const lines = await replay({ ...forged, reasons }, RPC);
    expect(failed(lines)).toEqual([expect.stringContaining("opcodes in the code: BASEFEE, evidence says none")]);
  });
  test("an opcode name that is not one of the rule's: refused before anything is sent", async () => {
    const forged = withEvidence(await proofOf(tokens.basefee_trap as Address), (e) => (e.opcodes = ["SSTORE"]));
    expect(failed(await replay(forged, RPC))).toEqual(["MISMATCH evidence fields have unexpected types (nothing sent to the node)"]);
  });
});

describe("replay --check: on-chain verdict", () => {
  test("everything matches: hash, target (case ignored), verdict, reasons", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { target: proof.target.toLowerCase() }) });
    expect(failed(lines)).toEqual([]);
    expect(summary(lines, true, proof.verdict)).toContain("same as on chain");
  });
  test("on-chain hash different from sha256(evidence): refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { evidence_sha256: "00".repeat(32) }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("evidence_sha256");
  });
  test("tampered evidence: its hash no longer matches the contract's", async () => {
    const proof = await proofOf();
    const forged = withEvidence(proof, (e) => (e.code_hash = `0x${"00".repeat(32)}`));
    const bad = failed(await replay(forged, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }));
    expect(bad.some((l) => l.includes("evidence_sha256"))).toBe(true);
    expect(bad.some((l) => l.includes("code hash"))).toBe(true);
  });
  test("different on-chain target: refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { target: tokens.safe }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("target");
  });
  test("different on-chain verdict: refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { verdict: "allow" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("on-chain");
  });
  test("different on-chain reasons: refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { reasons: "nothing" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("on-chain");
  });
  test("on-chain tx hashes other than the simulated transaction's: refused (the guard would sign another)", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { tx_hashes: ["11".repeat(32)] }) }));
    expect(bad).toEqual([expect.stringContaining("on-chain tx hashes of #1")]);
  });
  test("on-chain amount other than the one simulated: refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { amount_wei: "1" }) }));
    expect(bad).toEqual([expect.stringContaining("on-chain amount 1 wei")]);
  });
  test("a buy NEAR signed that is not the simulated transaction: refused", async () => {
    const proof = await proofOf(tokens.usdc as Address);
    const signed = (await import("viem/accounts")).privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
    const other = await signed.signTransaction({ type: "eip1559", chainId: 8453, nonce: 9, to: ROUTER, value: 1n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { signed_tx: Buffer.from(other.slice(2), "hex").toString("base64") }) }));
    expect(bad).toEqual([expect.stringContaining("the buy NEAR signed for #1 hashes to")]);
  });
  test("on-chain quote different from the proof's: refused", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { quote: "1" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("quote");
  });
  test("request absent or without an on-chain verdict: refused", async () => {
    const proof = await proofOf();
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: async () => null })).length).toBe(1);
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { verdict: null }) })).length).toBe(1);
  });
});

describe("replay --check: NEAR facts the verdict rests on", () => {
  const SHA = "ab".repeat(32);
  const entry = (reporter: string) => async () => ({ reporter, evidence_sha256: SHA });
  test("a listing claimed in the evidence is found on the guard: confirmed", async () => {
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, { listed: [{ key: tokens.usdc.toLowerCase(), reporter: "b.testnet", evidence_sha256: SHA }], previous: null });
    expect(proof.verdict).toBe("block");
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof), entry: entry("b.testnet") });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("blocklist entry of"))).toBe(true);
  });
  test("a listing invented by the sentinel (another reporter on the guard) is refused", async () => {
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, { listed: [{ key: tokens.usdc.toLowerCase(), reporter: "b.testnet", evidence_sha256: SHA }], previous: null });
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof), entry: entry("c.testnet") })).some((l) => l.includes("blocklist entry"))).toBe(true);
  });
  test("a previous code that is not the one the guard stored for that check is refused", async () => {
    const proof = await proofOf(tokens.lp_burned as Address, {}, GUARD_EVM, { listed: [], previous: { id: 9, code_hash: `0x${"00".repeat(32)}`, implementation: null } });
    expect(proof.verdict).toBe("warn");
    const chain = async (id: number) => (id === 9 ? { ...(await onChain(proof)())!, code: { code_hash: `0x${"11".repeat(32)}`, implementation: null } } : onChain(proof)());
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain })).some((l) => l.includes("last check #9"))).toBe(true);
  });
  test("without --check the NEAR facts are reported as not verified", async () => {
    const lines = await replay(await proofOf(), RPC);
    expect(lines.some((l) => l.skipped && l.line.includes("NEAR facts"))).toBe(true);
  });
});

describe("replay of an exit quote", () => {
  const HOLDER = "0x60B1100000000000000000000000000000000001" as Address; // holds the demo tokens
  const exitProof = async () =>
    toProof(2, tokens.lp_burned, await checkExit(RPC, tokens.lp_burned as Address, HOLDER, 10n ** 21n, localPreviews({ guard: HOLDER, target: tokens.lp_burned as Address, amount: 0n, requestedS: await headTime(), exitAmount: 10n ** 21n }).check));
  test("an intact exit quote replays: same request, same quote", async () => {
    const proof = await exitProof();
    expect(proof.verdict).toBe("allow");
    const lines = await replay(proof, RPC);
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("exit quote"))).toBe(true);
  });
  test("a lowered exit quote (a lower floor for the agent) is detected", async () => {
    const proof = withEvidence(await exitProof(), (e) => (e.quote = "1"));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("quote"))).toBe(true);
  });
  test("an exit simulated with other transactions than its evidence.tx_hashes is detected", async () => {
    const forged = withEvidence(await exitProof(), (e) => (e.tx_hashes = [e.tx_hashes[1], e.tx_hashes[0]]));
    expect(failed(await replay(forged, RPC))).toEqual([expect.stringContaining("the approve and swap simulated hash to")]);
  });
  test("--check: the seller must be the guard's derived address", async () => {
    const proof = await exitProof();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }));
    expect(bad.some((l) => l.includes("not the guard's derived EVM address"))).toBe(true);
  });
});

describe("replay: probe addresses", () => {
  // Forged but consistent proof: the simulation is replayed identically, only the address rule refuses it.
  const known: [string, () => Address][] = [
    ["router", () => ROUTER],
    ["WETH", () => WETH],
    ["target", () => TRAP],
    ["owner()", () => DEPLOYER],
  ];
  for (const role of ["buyer", "stranger"] as const) {
    for (const [name, addr] of known) {
      test(`${role} = ${name}: refused`, async () => {
        const proof = await proofOf(TRAP, { [role]: addr() });
        const bad = failed(await replay(proof, RPC));
        expect(bad.length).toBe(1);
        expect(bad[0]).toContain(`${role} ${addr()} is the ${name}`);
      });
    }
  }
  test("the owner as buyer would get an allow on a trap: the proof is refused", async () => {
    const proof = await proofOf(TRAP, { buyer: DEPLOYER }, DEPLOYER); // guard side faked as the owner too
    expect(proof.verdict).toBe("allow"); // the trap exempts its owner
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("is the owner()"))).toBe(true);
  });
  test("buyer with code at the block: refused", async () => {
    const proof = await proofOf(TRAP, { buyer: tokens.usdc as Address });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("has code");
  });
  test("stranger with code at the block: refused", async () => {
    const proof = await proofOf(TRAP, { stranger: tokens.usdc as Address });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("has code");
  });
  test("buyer = stranger: refused", async () => {
    const same = rand();
    const proof = await proofOf(TRAP, { buyer: same, stranger: same });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("buyer and stranger");
  });
  test("no stranger probe in the request: explicit refusal, no fallback on the buyer", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    callsIn(proof, 2, 0).splice(4); // keeps the quote, owner() and both buys, drops the takebacks
    const bad = failed(await replay(rehashed(proof), RPC));
    expect(bad.some((l) => l.includes("no stranger probe"))).toBe(true);
  });
});

// Judge pass 5's JudgeTrap was let through by a top-level balanceOf the simulation sent from the guard's
// address before its buy. Replay refuses a guard-side request holding anything but the guard's buy,
// approves and swaps, in that order and at consecutive nonces.
describe("replay: the guard-side request holds only the guard's own transactions", () => {
  const balanceOf = (who: Address, token: string) => ({ from: who, to: token, data: encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), args: [who] }) });
  const guardBlocks = (p: Proof) => (p.request as any)[0].params[0].blockStateCalls as { calls: Record<string, string>[] }[];
  test("an intact proof says so", async () => {
    const lines = await replay(await proofOf(tokens.safe as Address), RPC);
    expect(lines.some((l) => l.ok && l.line.includes("guard-side request holds only the guard's"))).toBe(true);
  });
  test("a top-level balanceOf from the guard before its buy: refused", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const [b1] = guardBlocks(proof);
    b1.calls.unshift({ ...b1.calls[0], ...balanceOf(GUARD_EVM, tokens.safe) });
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("guard-side request"))).toBe(true);
  });
  test("a read between the guard's approve and its swap: refused", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const approve = guardBlocks(proof).findIndex((b, i) => i > 0 && b.calls.length); // the first sale's
    const b = guardBlocks(proof)[approve + 1]; // its swap's block
    b.calls.unshift({ ...b.calls[0], ...balanceOf(GUARD_EVM, tokens.safe) });
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("guard-side request"))).toBe(true);
  });
  test("a probe call moved into the guard-side request: refused", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const probeBuy = (proof.request as any)[1].params[0].blockStateCalls[0].calls[0];
    guardBlocks(proof)[0].calls.unshift(probeBuy);
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("guard-side request"))).toBe(true);
  });
});

describe("replay: time of the first simulated block", () => {
  test("time of the first simulated block other than block + 1's at the cadence measured: refused", async () => {
    const proof = structuredClone(await proofOf());
    const first = (proof.request as any)[0].params[0].blockStateCalls[0].blockOverrides;
    first.time = toHex(BigInt(first.time) + 86_400n); // one day later
    const bad = failed(await replay(rehashed(proof), RPC));
    expect(bad.some((l) => l.includes("first simulated block time"))).toBe(true); // the node refuses it too: not in order
  });
  // Base went from 2 s to 0.2 s a block: a cadence the sentinel states, not the one measured at the
  // block, would let it space the simulated blocks as no real block is.
  test("a cadence other than the one the node shows at the block: MISMATCH", async () => {
    const proof = withEvidence(await proofOf(tokens.safe as Address), (e) => (e.cadence = { blocks: 100, seconds: 99 }));
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes(`cadence at block ${evidenceOf(proof).block}: 100 blocks in 100 s, evidence says 99 s`))).toBe(true);
  });
});

// Judge pass 8: the sentinel could simulate on any block from 60 s before the request to 60 s after its
// verdict, and pick one whose hash draws friendly sales. The reference block is bound to the request.
describe("replay --check: the reference block is the request's", () => {
  test("the proof's block is the first block 4 s after the request on NEAR: confirmed", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes(`block ${evidenceOf(proof).block} is the reference block of the request`))).toBe(true);
  });
  test("a proof simulated on a later block than the request's reference block: MISMATCH", async () => {
    const proof = await proofOf();
    const earlier = (BigInt(proof.requested_ns) - 6_000_000_000n).toString(); // the request 6 s (6 blocks) earlier
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { requested_ns: earlier }) }));
    expect(bad.some((l) => l.includes(`the reference block of the request at ${earlier} ns on NEAR is`))).toBe(true);
  });
});

describe("replay --check: probe addresses derived from on-chain data", () => {
  test("probes chosen by the sentinel instead of derived: refused", async () => {
    const proof = await proofOf(TRAP, { buyer: rand(), stranger: rand() });
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("not derived");
  });
  test("guard side simulated as another address than the guard's derived one: refused", async () => {
    const proof = await proofOf(TRAP, {}, "0x000000000000000000000000000000000000bEEF");
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) })).some((l) => l.includes("guard side"))).toBe(true);
  });
  test("probes derived as the sentinel does and the guard's derived address: both confirmed", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("probe addresses derived from guard.test, #1"))).toBe(true);
    expect(lines.some((l) => l.ok && l.line.includes(`guard side simulated as guard.test's derived EVM address ${GUARD_EVM}`))).toBe(true);
  });
  test("without --check the probes are reported as not verified", async () => {
    const lines = await replay(await proofOf(), RPC);
    expect(lines.some((l) => l.skipped && l.line.includes("probe addresses not verified"))).toBe(true);
  });
});

// Tampered environment facts and amount on a clean token, where the verdict does not move.
describe("replay rejects altered evidence on a clean token", () => {
  test("one touched address removed (the pool), verdict unchanged: detected", async () => {
    const proof = await proofOf(tokens.safe as Address);
    const forged = withEvidence(proof, (e) => (e.touched = e.touched.filter((a: string) => a !== e.liquidity.pair)));
    const out = failed(await replay(forged, RPC));
    expect(out.length).toBe(1);
    expect(out[0]).toContain("addresses touched: evidence");
  });
  test("evidence.amount_wei other than the amount simulated: detected", async () => {
    const proof = await proofOf(tokens.safe as Address);
    const forged = withEvidence(proof, (e) => (e.amount_wei = (BigInt(e.amount_wei) * 2n).toString()));
    expect(failed(await replay(forged, RPC)).length).toBeGreaterThan(0);
  });
});

// Judge pass 6: both sales' blocks and the first one's share are derived like the probes, and
// list_target is in the evidence; a sentinel could otherwise choose a friendly sale, or list a token
// its proof clears.
describe("replay: the sales and list_target", () => {
  test("a first sale chosen by the sentinel replays, but --check refuses it: not derived from on-chain data", async () => {
    const proof = await proofOf(tokens.safe as Address, (d) => ({ sale: { ...d.sale, first: d.sale.first === RANGES.first[0] ? RANGES.first[0] + 1 : RANGES.first[0], bps: 5001 } }));
    expect(failed(await replay(proof, RPC))).toEqual([]);
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }));
    expect(bad).toEqual([expect.stringContaining("sales not derived from on-chain data")]);
  });
  test("a late sale chosen by the sentinel (its block fixed) replays, but --check refuses it", async () => {
    const proof = await proofOf(tokens.safe as Address, (d) => ({ sale: { ...d.sale, late: d.sale.late === RANGES.late[1] ? RANGES.late[1] - 1 : RANGES.late[1] } }));
    expect(failed(await replay(proof, RPC))).toEqual([]);
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }));
    expect(bad).toEqual([expect.stringContaining("sales not derived from on-chain data")]);
  });
  test("an evidence.sales other than the one simulated: refused", async () => {
    const proof = await proofOf(tokens.safe as Address);
    const first = withEvidence(proof, (e) => (e.sales.first = e.sales.first === RANGES.first[0] ? RANGES.first[0] + 1 : RANGES.first[0]));
    expect(failed(await replay(first, RPC)).some((l) => l.includes("the guard's sales are not where evidence.sales puts them"))).toBe(true);
    const late = withEvidence(proof, (e) => (e.sales.late = e.sales.late === RANGES.late[0] ? RANGES.late[0] + 1 : RANGES.late[0]));
    expect(failed(await replay(late, RPC)).some((l) => l.includes("the guard's sales are not where evidence.sales puts them"))).toBe(true);
  });
  test("a first sale of exactly half (a whole percent), a late sale past 51 s, a far sale before 301 s, or a cadence not measured over 100 blocks, is refused before anything is sent", async () => {
    const proof = await proofOf(tokens.safe as Address);
    for (const forge of [(e: any) => (e.sales.bps = 5000), (e: any) => (e.sales.late = RANGES.late[1] + 1), (e: any) => (e.sales.far = RANGES.far[0] - 1), (e: any) => (e.cadence = { blocks: 30, seconds: 30 })]) {
      expect(failed(await replay(withEvidence(proof, forge), RPC))).toEqual(["MISMATCH evidence fields have unexpected types (nothing sent to the node)"]);
    }
  });
  test("evidence.list_target flipped: the rejudged one differs", async () => {
    const proof = await proofOf(tokens.usdc as Address);
    expect(evidenceOf(proof).list_target).toBe(false);
    const forged = withEvidence(proof, (e) => (e.list_target = true));
    expect(failed(await replay(forged, RPC))).toEqual([expect.stringContaining("evidence.list_target true != rejudged false")]);
  });
  test("an honest proof posted with list_target true (judge pass 6's lie): --check refuses it", async () => {
    const proof = await proofOf(tokens.farm_fresh as Address); // a reputation block: never listed
    expect(proof.verdict).toBe("block");
    expect(evidenceOf(proof).list_target).toBe(false);
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { list_target: true }) }));
    expect(bad).toEqual([expect.stringContaining("on-chain list_target true != evidence.list_target false")]);
  });
  test("a listed trap's proof: list_target true in the evidence, rejudged and on chain alike", async () => {
    const proof = await proofOf(tokens.next_block_key as Address);
    expect(evidenceOf(proof).list_target).toBe(true);
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }))).toEqual([]);
  });
});

// Since Base mines five blocks a second, eth_simulateV1 reaches 51 s past a real block: the far sale runs
// the late sale again 5 to 15 min after the buy on a local fork whose clock moves. Replay re-runs it.
describe("replay: the far sale", () => {
  test("a sale closed 5 minutes after the buy: its block replays identically, with --check, the far sale re-run on a local fork and its delay derived like the probes", async () => {
    const proof = await proofOf(tokens.sell_blocked_later as Address);
    expect(proof.verdict).toBe("block");
    expect(proof.request[4].method).toBe(FAR_METHOD);
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("far sale re-run on a local fork"))).toBe(true);
  });
  test("a far sale's result forged (refused into a pass): MISMATCH", async () => {
    const proof = structuredClone(await proofOf(tokens.sell_blocked_later as Address));
    proof.response[4] = proof.response[4].map((r) => ({ ...r, status: "0x1" as Hex }));
    expect(failed(await replay(proof, RPC))).toEqual([expect.stringContaining("far sale re-run on a local fork")]);
  });
  test("a far sale moved off the late sale's own transactions: refused", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const [approve] = (proof.request as any)[4].params[0].blockStateCalls[0].calls;
    approve.data = approve.data.slice(0, -2) + "00"; // another amount approved
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("request shape: the far sale is not the late sale"))).toBe(true);
  });
  test("a far request sent as eth_simulateV1: refused before anything is sent", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    (proof.request as any)[4].method = "eth_simulateV1";
    expect(failed(await replay(rehashed(proof), RPC))).toEqual([expect.stringContaining("(nothing sent to the node)")]);
  });
  test("a far sale drawn by the sentinel: replays, but --check refuses it", async () => {
    const proof = await proofOf(tokens.safe as Address, (d) => ({ sale: { ...d.sale, far: d.sale.far === RANGES.far[1] ? RANGES.far[0] : RANGES.far[1] } }));
    expect(failed(await replay(proof, RPC))).toEqual([]);
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }))).toEqual([expect.stringContaining("sales not derived from on-chain data")]);
  });
});

// Judges 7 and 8: the guard's sales run again on a real block mined after the reference block (a fourth
// request, on its own base block), and the template index window is bound to the check's block.
describe("replay: the later side and the index window", () => {
  for (const [name, token] of [["WethKey", tokens.weth_key], ["ApproveKey", tokens.approve_key]] as const) {
    test(`${name}'s block replays identically, with --check: the later side's block derived like the probes`, async () => {
      const proof = await proofOf(token as Address);
      expect(proof.verdict).toBe("block");
      expect(proof.request.length).toBe(5);
      const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) });
      expect(failed(lines)).toEqual([]);
      expect(lines.some((l) => l.ok && l.line.includes("later side's request rebuilt on block"))).toBe(true);
      expect(lines.some((l) => l.ok && l.line.includes("after the reference block (at most the one before the late sale's approve), as derived"))).toBe(true);
    });
  }
  test("a later side on a block the sentinel chose: replays, but --check refuses it", async () => {
    const proof = await proofOf(tokens.safe as Address, (d) => ({ later: d.later === LATER_S[1] ? LATER_S[0] : LATER_S[1] }));
    expect(failed(await replay(proof, RPC))).toEqual([]);
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) }))).toEqual([expect.stringContaining("later side's block not derived from on-chain data")]);
  });
  test("a later side without the buy's state change (WethKey then sells): refused", async () => {
    const proof = structuredClone(await proofOf(tokens.weth_key as Address));
    const [first] = (proof.request as any)[3].params[0].blockStateCalls;
    for (const o of Object.values(first.stateOverrides) as { stateDiff?: unknown }[]) delete o.stateDiff;
    expect(failed(await replay(rehashed(proof), RPC)).some((l) => l.includes("request shape: the later side is not the guard's sales on block"))).toBe(true);
  });
  test("a later side on the reference block itself, not after it: refused before anything is sent", async () => {
    const proof = withEvidence(await proofOf(tokens.safe as Address), (e) => (e.later.block = e.block));
    expect(failed(await replay(proof, RPC))).toEqual(["MISMATCH evidence fields have unexpected types (nothing sent to the node)"]);
  });
  test("a node that does not serve the later block's state: an ERROR line and REPLAY FAILED, never OK", async () => {
    const proof = structuredClone(await proofOf(tokens.safe as Address));
    const missing = evidenceOf(proof).later.block + 1_000_000; // a block this node does not have, as a pruned one would answer
    (proof.request as any)[3].params[1] = toHex(missing);
    const lines = await replay(rehashed(withEvidence(proof, (e) => (e.later.block = missing))), RPC);
    expect(lines.some((l) => l.line.startsWith(`ERROR    resending the requests at block ${evidenceOf(proof).block} and block ${missing}`))).toBe(true);
    expect(summary(lines, false, proof.verdict)).toStartWith("REPLAY FAILED");
  });
  test("USDC's pool traded while the check waited: replays identically, the trades fetched again from the node and re-executed after the buy", async () => {
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, NO_NEAR, true);
    expect(evidenceOf(proof).later.replayed.length).toBeGreaterThan(0);
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof) });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes(`trades of the pool re-executed after the buy: ${evidenceOf(proof).later.replayed.length}`))).toBe(true);
  });
  test("a sentinel that leaves out a trade of the pool: MISMATCH", async () => {
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, NO_NEAR, true);
    const forged = withEvidence(proof, (e) => (e.later.replayed = e.later.replayed.slice(1)));
    expect(failed(await replay(forged, RPC))).toEqual([expect.stringContaining("is not what the node gives")]);
  });
  test("a proof judged on an index window that does not cover the 2 h before its block: MISMATCH", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => (e.reputation.from = e.block - 100));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("template index window"))).toBe(true);
  });
  test("a proof judged on an index window ending before its block (a farm's newest pools dropped): MISMATCH", async () => {
    const proof = withEvidence(await proofOf(tokens.farm_fresh as Address), (e) => (e.reputation.to = e.block - 1));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes(`is not bound to block`))).toBe(true);
  });
});
