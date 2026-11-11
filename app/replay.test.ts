// Replay of a proof against the local copy of Base (run evm/fork.sh first).
import { describe, expect, test } from "bun:test";
import { sha256, stringToHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex } from "./index";
import { replay, summary, type OnChain, type Proof } from "./replay";
import { checkExit, checkToken, deriveProbes, rpc, ROUTER, specialOf, toProof, WETH, type NearFacts, type Probe } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const DEPLOYER: Address = "0x60B1100000000000000000000000000000000001"; // owner() of the demo tokens (evm/fork.sh)
const TRAP = tokens.sell_blocked_later as Address;
const rand = (): Address => toHexAddr(crypto.getRandomValues(new Uint8Array(20)));
const toHexAddr = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Address;

/** The guard's EVM address the guard_frozen trap freezes (evm/fork.sh). */
const GUARD_EVM = await specialOf(RPC, tokens.guard_frozen as Address);
const GUARD_INFO = { account: "guard.test", evm: GUARD_EVM };
/** Proof of check #1 whose probes are derived as the sentinel does, from a request at `requested_ns`. */
/** The template index the sentinel would load: every pool of the fork setup. */
const INDEX = await buildIndex(RPC, tokens.fork_block + 1, Number(BigInt(await rpc<Hex>(RPC, "eth_blockNumber", []))));
const NO_NEAR: NearFacts = { listed: [], previous: null };
/** The guard's gas limit at setup (app/setup.ts): the sentinel simulates every call with it. */
const GAS = 250_000n;
const proofOf = async (token: Address = TRAP, probe?: Partial<Probe>, guard: Address = GUARD_EVM, requested_ns = "0", near = NO_NEAR): Promise<Proof> =>
  toProof(
    1,
    token,
    await checkToken(RPC, token, guard, (head) => ({ ...deriveProbes({ guard: GUARD_INFO.account, id: 1, requested_ns }, head.hash), ...probe }), {
      index: INDEX,
      near: async () => near,
      gas: GAS,
    }),
  );
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
  requested_ns: "0",
  judged_ns: "0",
  code: "code_hash" in evidenceOf(p) ? { code_hash: evidenceOf(p).code_hash, implementation: evidenceOf(p).implementation } : null,
  exit_amount: evidenceOf(p).amount ?? null,
  gas_limit: evidenceOf(p).gas_limit,
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
    const calls = (proof.request as any).params[0].blockStateCalls[0].calls;
    calls[2].data = calls[2].data.slice(0, -2) + "ff";
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true);
  });
  test("two swapped labels in evidence.calls are detected", async () => {
    const proof = withEvidence(await proofOf(), (e) => {
      const i = e.calls.findIndex((x: string) => x.startsWith("sale +256 blocks:"));
      [e.calls[0], e.calls[i]] = [e.calls[i], e.calls[0]];
    });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("labels");
  });
  test("a request whose shape is not checkToken's is detected (token, buyer)", async () => {
    const proof = structuredClone(await proofOf());
    const calls = (proof.request as any).params[0].blockStateCalls[2].calls;
    calls[1].from = "0x" + "11".repeat(20); // the +1 h sale comes from another address than the buyer
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true); // hash and shape fail together
    expect(bad.some((l) => l.includes("request shape"))).toBe(true);
  });
  test("another RPC method is refused without any request being sent", async () => {
    const proof = structuredClone(await proofOf());
    (proof.request as any).method = "anvil_setBalance";
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
    (proof.request as any).params[1] = "0x1";
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
  test("evidence.gas_limit other than the gas the request was simulated with is detected", async () => {
    const forged = withEvidence(await proofOf(), (e) => (e.gas_limit = 1_000_000));
    expect(failed(await replay(forged, RPC)).some((l) => l.includes("request is not the one checkToken builds"))).toBe(true);
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
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("chain id");
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
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("implementation");
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
  test("a gas limit on chain other than the one simulated with: refused (the guard would sign with another)", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof, { gas_limit: 600_000 }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("gas limit");
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
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, "0", { listed: [{ key: tokens.usdc.toLowerCase(), reporter: "b.testnet", evidence_sha256: SHA }], previous: null });
    expect(proof.verdict).toBe("block");
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof), entry: entry("b.testnet") });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.ok && l.line.includes("blocklist entry of"))).toBe(true);
  });
  test("a listing invented by the sentinel (another reporter on the guard) is refused", async () => {
    const proof = await proofOf(tokens.usdc as Address, {}, GUARD_EVM, "0", { listed: [{ key: tokens.usdc.toLowerCase(), reporter: "b.testnet", evidence_sha256: SHA }], previous: null });
    expect(failed(await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof), entry: entry("c.testnet") })).some((l) => l.includes("blocklist entry"))).toBe(true);
  });
  test("a previous code that is not the one the guard stored for that check is refused", async () => {
    const proof = await proofOf(tokens.lp_burned as Address, {}, GUARD_EVM, "0", { listed: [], previous: { id: 9, code_hash: `0x${"00".repeat(32)}`, implementation: null } });
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
  const exitProof = async () => toProof(2, tokens.lp_burned, await checkExit(RPC, tokens.lp_burned as Address, HOLDER, 10n ** 21n, GAS));
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
  test("an exit quote simulated with another gas limit than its evidence says is detected", async () => {
    const forged = withEvidence(await exitProof(), (e) => (e.gas_limit = 1_000_000));
    expect(failed(await replay(forged, RPC)).some((l) => l.includes("request is not the exit sale"))).toBe(true);
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
    const proof = structuredClone(await proofOf());
    const calls = (proof.request as any).params[0].blockStateCalls[0].calls;
    calls.splice(10); // keeps both buys (5 calls each), drops the transferFrom probes and the approvals
    const bad = failed(await replay(rehashed(proof), RPC));
    expect(bad.some((l) => l.includes("no stranger probe"))).toBe(true);
  });
});

describe("replay: time of the first simulated block", () => {
  test("time of the first simulated block != timestamp of evidence.block + 2: refused", async () => {
    const block = Number(BigInt((await rpc<{ number: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).number));
    const proof = await proofOf(TRAP, { time: BigInt(await blockTime(block)) + 86_400n }); // one day later
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("first simulated block time");
  });
  test("--check on a node whose clock is not real time: check reported as not verifiable", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, guard: GUARD_INFO, chain: onChain(proof), clock: () => 4_000_000_000 });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.skipped && l.line.includes("not verifiable"))).toBe(true);
    expect(summary(lines, true, proof.verdict)).toContain("not verified");
  });
  test("--check on a node on time: EVM block between the NEAR request and verdict", async () => {
    const ts = await blockTime(Number(BigInt((await rpc<{ number: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).number)));
    const ns = (s: number) => (BigInt(s) * 1_000_000_000n).toString();
    const live = { check: true, guard: GUARD_INFO, clock: () => ts };
    const proof = await proofOf(TRAP, {}, GUARD_EVM, ns(ts - 5));
    expect(await blockTime(evidenceOf(proof).block)).toBe(ts);
    const good = await replay(proof, RPC, { ...live, chain: onChain(proof, { requested_ns: ns(ts - 5), judged_ns: ns(ts + 5) }) });
    expect(failed(good)).toEqual([]);
    expect(good.some((l) => l.skipped)).toBe(false);
    const late = await proofOf(TRAP, {}, GUARD_EVM, ns(ts + 3600));
    const stale = failed(await replay(late, RPC, { ...live, chain: onChain(late, { requested_ns: ns(ts + 3600), judged_ns: ns(ts + 3610) }) }));
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain("EVM block time");
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
