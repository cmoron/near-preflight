// Le rejeu d'une preuve contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import tokens from "../evm/tokens.json";
import { replay } from "./replay";
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
});
