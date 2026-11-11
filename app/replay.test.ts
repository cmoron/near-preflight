// Le rejeu d'une preuve contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import { sha256, stringToHex, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { replay, summary, type OnChain, type Proof } from "./replay";
import { checkToken, rpc, ROUTER, toProof, WETH, type Probe } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const DEPLOYER: Address = "0x60B1100000000000000000000000000000000001"; // owner() des jetons de demo (evm/fork.sh)
const TRAP = tokens.sell_blocked_later as Address;
const rand = (): Address => toHexAddr(crypto.getRandomValues(new Uint8Array(20)));
const toHexAddr = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Address;

const proofOf = async (token: Address = TRAP, probe?: Partial<Probe>): Promise<Proof> =>
  toProof(1, token, await checkToken(RPC, token, { buyer: rand(), stranger: rand(), ...probe }));
const failed = (lines: { ok: boolean; line: string }[]) => lines.filter((l) => !l.ok).map((l) => l.line);
const evidenceOf = (p: Proof) => JSON.parse(p.evidence);
/** Modifie le contenu de la chaine evidence (comme le ferait un faussaire) et la reserialise. */
const withEvidence = (p: Proof, f: (e: any) => void): Proof => {
  const e = evidenceOf(p);
  f(e);
  return { ...p, evidence: JSON.stringify(e) };
};
/** Requete modifiee puis empreinte recalculee : seul le controle vise doit tomber. */
const rehashed = (p: Proof): Proof => withEvidence(p, (e) => (e.request_sha256 = sha256(stringToHex(JSON.stringify(p.request)))));
const hashOf = (s: string) => sha256(stringToHex(s)).slice(2);
const blockTime = async (block: number) =>
  Number(BigInt((await rpc<{ timestamp: Hex }>(RPC, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])).timestamp));
/** Demande telle que get_check la renvoie, concordante avec la preuve sauf `over`. */
const onChain = (p: Proof, over: Partial<NonNullable<OnChain>> = {}) => async (): Promise<OnChain> => ({
  target: p.target,
  verdict: p.verdict,
  reasons: p.reasons,
  evidence_sha256: hashOf(p.evidence),
  quote: evidenceOf(p).quote,
  requested_ns: "0",
  judged_ns: "0",
  ...over,
});

describe("replay", () => {
  test("une preuve intacte se rejoue a l'identique (verdict block)", async () => {
    const proof = await proofOf();
    expect(proof.verdict).toBe("block");
    expect(typeof proof.evidence).toBe("string");
    const lines = await replay(proof, RPC);
    expect(failed(lines)).toEqual([]);
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });
  test("un verdict altere (block -> allow) est detecte", async () => {
    const proof = await proofOf();
    const bad = failed(await replay({ ...proof, verdict: "allow" }, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("verdict");
  });
  test("un calldata altere dans la requete est detecte (hash)", async () => {
    const proof = structuredClone(await proofOf());
    const calls = (proof.request as any).params[0].blockStateCalls[0].calls;
    calls[2].data = calls[2].data.slice(0, -2) + "ff";
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true);
  });
  test("deux libelles echanges dans evidence.calls sont detectes", async () => {
    const proof = withEvidence(await proofOf(), (e) => {
      const i = e.calls.findIndex((x: string) => x.startsWith("sale +1 h:"));
      [e.calls[0], e.calls[i]] = [e.calls[i], e.calls[0]];
    });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("labels");
  });
  test("une requete dont la forme n'est pas celle de checkToken est detectee (jeton, acheteur)", async () => {
    const proof = structuredClone(await proofOf());
    const calls = (proof.request as any).params[0].blockStateCalls[2].calls;
    calls[1].from = "0x" + "11".repeat(20); // la vente +1 h part d'une autre adresse que l'acheteur
    const bad = failed(await replay(proof, RPC));
    expect(bad.some((l) => l.includes("request hash"))).toBe(true); // hash et forme tombent ensemble
    expect(bad.some((l) => l.includes("request shape"))).toBe(true);
  });
  test("une autre methode RPC est refusee sans qu'aucune requete ne parte", async () => {
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
  test("un numero de bloc different de evidence.block est refuse sans requete", async () => {
    const proof = structuredClone(await proofOf());
    (proof.request as any).params[1] = "0x1";
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("request shape"))).toBe(true);
  });
  test("sans --check, le resume dit que rien n'est lie a la chaine", () => {
    expect(summary([{ ok: true, line: "x" }], false, "block")).toContain("not checked against any on-chain verdict");
    expect(summary([{ ok: true, line: "x" }], true, "block")).toContain("same as on chain");
    expect(summary([{ ok: false, line: "x" }], true, "block")).not.toContain("same as on chain");
  });
});

describe("replay : la chaine evidence est celle postee en chaine", () => {
  test("un fichier ou evidence n'est pas une chaine (ancien format) est refuse sans requete", async () => {
    const proof = await proofOf();
    const bad = failed(await replay({ ...proof, evidence: evidenceOf(proof) }, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("evidence");
  });
  test("une cle en trop dans evidence est refusee (contenu non reverifie)", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.note = "audited"));
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("evidence"))).toBe(true);
  });
  test("un code_hash altere dans evidence est detecte", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.code_hash = `0x${"00".repeat(32)}`));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("code hash");
  });
  test("une chaine (chain_id) alteree dans evidence est detectee", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.chain_id = 1));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("chain id");
  });
  test("un devis altere dans evidence est detecte (rejoue depuis la reponse)", async () => {
    const proof = withEvidence(await proofOf(), (e) => (e.quote = "1"));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("quote");
  });
  test("une implementation de proxy alteree dans evidence est detectee (USDC)", async () => {
    const proof = withEvidence(await proofOf(tokens.usdc as Address), (e) => (e.implementation = DEPLOYER.toLowerCase()));
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("implementation");
  });
});

describe("replay --check : verdict en chaine", () => {
  test("tout concorde : empreinte, cible (casse ignoree), verdict, raisons", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, chain: onChain(proof, { target: proof.target.toLowerCase() }) });
    expect(failed(lines)).toEqual([]);
    expect(summary(lines, true, proof.verdict)).toContain("same as on chain");
  });
  test("empreinte en chaine differente de sha256(evidence) : refus", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { evidence_sha256: "00".repeat(32) }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("evidence_sha256");
  });
  test("evidence alteree : son empreinte ne concorde plus avec celle du contrat", async () => {
    const proof = await proofOf();
    const forged = withEvidence(proof, (e) => (e.code_hash = `0x${"00".repeat(32)}`));
    const bad = failed(await replay(forged, RPC, { check: true, chain: onChain(proof) }));
    expect(bad.some((l) => l.includes("evidence_sha256"))).toBe(true);
    expect(bad.some((l) => l.includes("code hash"))).toBe(true);
  });
  test("cible en chaine differente : refus", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { target: tokens.safe }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("target");
  });
  test("verdict en chaine different : refus", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { verdict: "allow" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("on-chain");
  });
  test("raisons en chaine differentes : refus", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { reasons: "nothing" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("on-chain");
  });
  test("devis en chaine different de celui de la preuve : refus", async () => {
    const proof = await proofOf();
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { quote: "1" }) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("quote");
  });
  test("demande absente ou sans verdict en chaine : refus", async () => {
    const proof = await proofOf();
    expect(failed(await replay(proof, RPC, { check: true, chain: async () => null })).length).toBe(1);
    expect(failed(await replay(proof, RPC, { check: true, chain: onChain(proof, { verdict: null }) })).length).toBe(1);
  });
});

describe("replay : adresses de sonde", () => {
  // Preuve falsifiee mais coherente : la simulation est rejouee a l'identique, seule la regle d'adresse la refuse.
  const known: [string, () => Address][] = [
    ["router", () => ROUTER],
    ["WETH", () => WETH],
    ["target", () => TRAP],
    ["owner()", () => DEPLOYER],
  ];
  for (const role of ["buyer", "stranger"] as const) {
    for (const [name, addr] of known) {
      test(`${role} = ${name} : refus`, async () => {
        const proof = await proofOf(TRAP, { [role]: addr() });
        const bad = failed(await replay(proof, RPC));
        expect(bad.length).toBe(1);
        expect(bad[0]).toContain(`${role} ${addr()} is the ${name}`);
      });
    }
  }
  test("l'owner comme acheteur obtiendrait un allow sur un piege : la preuve est refusee", async () => {
    const proof = await proofOf(TRAP, { buyer: DEPLOYER });
    expect(proof.verdict).toBe("allow"); // le piege exempte son proprietaire
    expect(failed(await replay(proof, RPC)).some((l) => l.includes("is the owner()"))).toBe(true);
  });
  test("acheteur avec du code au bloc : refus", async () => {
    const proof = await proofOf(TRAP, { buyer: tokens.usdc as Address });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("has code");
  });
  test("inconnu avec du code au bloc : refus", async () => {
    const proof = await proofOf(TRAP, { stranger: tokens.usdc as Address });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("has code");
  });
  test("acheteur = inconnu : refus", async () => {
    const same = rand();
    const proof = await proofOf(TRAP, { buyer: same, stranger: same });
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("buyer and stranger");
  });
  test("pas de sonde inconnu dans la requete : refus explicite, pas de repli sur l'acheteur", async () => {
    const proof = structuredClone(await proofOf());
    const calls = (proof.request as any).params[0].blockStateCalls[0].calls;
    calls.splice(5); // garde l'achat (5 appels), retire les sondes transferFrom et l'approbation
    const bad = failed(await replay(rehashed(proof), RPC));
    expect(bad.some((l) => l.includes("no stranger probe"))).toBe(true);
  });
});

describe("replay : heure du premier bloc simule", () => {
  test("heure du premier bloc simule != horodatage de evidence.block + 2 : refus", async () => {
    const block = Number(BigInt((await rpc<{ number: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).number));
    const proof = await proofOf(TRAP, { time: BigInt(await blockTime(block)) + 86_400n }); // un jour plus tard
    const bad = failed(await replay(proof, RPC));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("first simulated block time");
  });
  test("--check sur un noeud dont l'horloge n'est pas l'heure reelle : controle dit non verifiable", async () => {
    const proof = await proofOf();
    const lines = await replay(proof, RPC, { check: true, chain: onChain(proof), clock: () => 4_000_000_000 });
    expect(failed(lines)).toEqual([]);
    expect(lines.some((l) => l.skipped && l.line.includes("not verifiable"))).toBe(true);
    expect(summary(lines, true, proof.verdict)).toContain("not verified");
  });
  test("--check sur un noeud a l'heure : bloc EVM entre la demande et le verdict NEAR", async () => {
    const proof = await proofOf();
    const ts = await blockTime(evidenceOf(proof).block);
    const head = await blockTime(Number(BigInt((await rpc<{ number: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).number)));
    const ns = (s: number) => (BigInt(s) * 1_000_000_000n).toString();
    const live = { check: true, clock: () => head };
    const good = await replay(proof, RPC, { ...live, chain: onChain(proof, { requested_ns: ns(ts - 5), judged_ns: ns(ts + 5) }) });
    expect(failed(good)).toEqual([]);
    expect(good.some((l) => l.skipped)).toBe(false);
    const stale = failed(await replay(proof, RPC, { ...live, chain: onChain(proof, { requested_ns: ns(ts + 3600), judged_ns: ns(ts + 3610) }) }));
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain("EVM block time");
  });
});
