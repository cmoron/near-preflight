// Les trois controles contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import tokens from "../evm/tokens.json";
import { checkToken } from "./verifier";

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
const verdictOf = async (token: string) => (await checkToken(RPC, token as `0x${string}`)).verdict;

describe("verdict de la sentinelle", () => {
  test("USDC, temoin sain deja sur Base : allow", async () => expect(await verdictOf(tokens.usdc)).toBe("allow"));
  test("jeton sain de demonstration : allow", async () => expect(await verdictOf(tokens.safe)).toBe("allow"));
  test("reprise par le proprietaire via transferFrom : block", async () => {
    const r = await checkToken(RPC, tokens.owner_reclaim as `0x${string}`);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("transferFrom");
  });
  test("vente fermee des l'achat : block", async () => expect(await verdictOf(tokens.sell_blocked)).toBe("block"));
  test("vente fermee 1 h apres l'achat : block", async () => {
    const r = await checkToken(RPC, tokens.sell_blocked_later as `0x${string}`);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("1 h");
  });
  test("taxe de 90 % a la vente : block", async () => {
    const r = await checkToken(RPC, tokens.sell_tax as `0x${string}`);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("taxe");
  });
});
