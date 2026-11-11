// Le rejeu d'une preuve contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import tokens from "../evm/tokens.json";
import { replay, summary } from "./replay";
import { checkToken } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const proofOf = async () => ({ id: 1, target: tokens.sell_blocked_later, ...(await checkToken(RPC, tokens.sell_blocked_later as `0x${string}`)) });
const failed = (lines: { ok: boolean; line: string }[]) => lines.filter((l) => !l.ok).map((l) => l.line);

describe("replay", () => {
  test("une preuve intacte se rejoue a l'identique (verdict block)", async () => {
    const proof = await proofOf();
    expect(proof.verdict).toBe("block");
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
    const proof = structuredClone(await proofOf());
    const c = proof.evidence.calls;
    const i = c.findIndex((x) => x.startsWith("sale +1 h:"));
    [c[0], c[i]] = [c[i], c[0]];
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
  test("--check : la cible en chaine doit etre proof.target (casse ignoree)", async () => {
    const proof = await proofOf();
    const onChain = (target: string) => async () => ({ target, verdict: proof.verdict, reasons: proof.reasons });
    const good = await replay(proof, RPC, { check: true, chain: onChain(proof.target.toLowerCase()) });
    expect(failed(good)).toEqual([]);
    const bad = failed(await replay(proof, RPC, { check: true, chain: onChain(tokens.safe) }));
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("target");
  });
  test("sans --check, le resume dit que rien n'est lie a la chaine", () => {
    expect(summary([{ ok: true, line: "x" }], false, "block")).toContain("not checked against any on-chain verdict");
    expect(summary([{ ok: true, line: "x" }], true, "block")).not.toContain("not checked");
  });
});
