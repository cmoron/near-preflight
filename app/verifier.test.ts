// Les controles de la sentinelle contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import { keccak256 } from "viem";
import tokens from "../evm/tokens.json";
import { checkToken } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const check = (token: string) => checkToken(RPC, token as `0x${string}`);

describe("verdict de la sentinelle", () => {
  test("USDC, temoin sain deja sur Base : allow", async () => expect((await check(tokens.usdc)).verdict).toBe("allow"));
  test("jeton sain de demonstration : allow", async () => expect((await check(tokens.safe)).verdict).toBe("allow"));
  test("jeton honnete qui impose un bloc de detention : allow (revente simulee au bloc suivant)", async () => {
    expect((await check(tokens.hold_one_block)).verdict).toBe("allow");
  });
  test("pas de liquidite V2 : warn, pas block", async () => {
    const r = await check("0x60B1100000000000000000000000000000000001"); // adresse sans paire
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("no liquidity");
  });
  test("reprise par le proprietaire via transferFrom : block", async () => {
    const r = await check(tokens.owner_reclaim);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("transferFrom");
  });
  test("vente fermee des l'achat : block", async () => {
    const r = await check(tokens.sell_blocked);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("next block");
  });
  test("vente fermee 1 h apres l'achat : block", async () => {
    const r = await check(tokens.sell_blocked_later);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("1 h after");
    expect(r.reasons).not.toContain("next block");
  });
  test("taxe de 90 % a la vente : block", async () => {
    const r = await check(tokens.sell_tax);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("90 % tax");
  });
  test("taxe de 90 % seulement sur la vente tardive : block", async () => {
    const r = await check(tokens.sell_tax_later);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("1 h after");
  });
});

describe("preuve", () => {
  test("porte l'empreinte du code de la cible au bloc du controle", async () => {
    const r = await check(tokens.safe);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [tokens.safe, `0x${r.evidence.block.toString(16)}`] }),
    });
    const { result: code } = (await res.json()) as { result: `0x${string}` };
    expect(r.evidence.code_hash).toBe(keccak256(code));
  });
  test("porte l'implementation d'un proxy (USDC)", async () => {
    const r = await check(tokens.usdc);
    expect(r.evidence.implementation).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
