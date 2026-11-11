// Les controles de la sentinelle contre la copie locale de Base (lancer evm/fork.sh d'abord).
import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseEther, type Address, type Hex } from "viem";
import tokens from "../evm/tokens.json";
import { buildIndex, type Index } from "./index";
import { checkExit, checkToken, liquidityFindings, ROUTER, rpc, specialOf, WETH, type Holder, type Liquidity, type NearFacts } from "./verifier";

const quoteAbi = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);

const RPC = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
/** The guard's EVM address: the one the guard_frozen trap freezes (set by evm/fork.sh). */
const GUARD_EVM = await specialOf(RPC, tokens.guard_frozen as Address);
const rand = (): Address => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}`;
/** Index of every pool the fork setup launched (evm/fork.sh), as the sentinel would load it. */
const INDEX = await buildIndex(RPC, tokens.fork_block + 1, Number(BigInt(await rpc<Hex>(RPC, "eth_blockNumber", []))));
const NO_NEAR: NearFacts = { listed: [], previous: null };
/** The gas limit the guard signs with at setup (app/setup.ts): every simulated call gets it. */
const GAS = 250_000n;
const check = (token: string, guard: Address = GUARD_EVM, index: Index | null = INDEX, near: NearFacts = NO_NEAR, gas = GAS) =>
  checkToken(RPC, token as `0x${string}`, guard, () => ({ buyer: rand(), stranger: rand() }), { index, near: async () => near, gas });

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
    expect(r.reasons).toContain("256 blocks (timestamp +1 h) after the buy");
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
    expect(r.reasons).toContain("256 blocks (timestamp +1 h) after the buy");
  });
  test("a token that freezes only the guard's public EVM address: block, but not listed (it rests on the guard's own state)", async () => {
    const r = await check(tokens.guard_frozen);
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(false);
    expect(r.reasons).toContain("guard address only, not listed: sale refused"); // the router masks the token's reason
  });
  test("a sale that needs more gas than the guard signs with (250,000): block, the simulation uses the guard's gas limit", async () => {
    const r = await check(tokens.gas_hungry);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("sale refused in the next block");
    expect(r.list_target).toBe(true); // the probe's sale fails too: the token's own behaviour
    expect(r.evidence.gas_limit).toBe(250_000);
  });
  test("the same token simulated with 1,000,000 gas sells: only the guard's own gas limit says what a sale will meet", async () => {
    const r = await check(tokens.gas_hungry, GUARD_EVM, INDEX, NO_NEAR, 1_000_000n);
    expect(r.verdict).not.toBe("block"); // its young pool's LP sits with an EOA: a warn
    expect(r.reasons).not.toContain("sale refused");
  });
  test("the same token with another guard address: allow (only the guard is targeted)", async () => {
    expect((await check(tokens.guard_frozen, "0x000000000000000000000000000000000000bEEF")).verdict).toBe("allow");
  });
  test("vente permise seulement en simulation (prix du gaz ou base fee nuls) : block", async () => {
    const r = await check(tokens.sim_detector);
    expect(r.verdict).toBe("block");
    expect(r.reasons).toContain("sale refused in the next block"); // le routeur masque la raison du jeton
  });
});

describe("removable liquidity (Uniswap V2 pair of the target)", () => {
  test("a young pool whose whole LP sits with one EOA: warn, naming the EOA and the removable share", async () => {
    const r = await check(tokens.lp_held);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("100 % of the LP removable now");
    expect(r.reasons).toContain("EOA 0x60b1");
    expect(r.evidence.liquidity?.holders?.some((h) => h.kind === "eoa")).toBe(true);
  });
  test("pair created long ago with dust, deep liquidity added within the window: the age is the liquidity's, warn", async () => {
    const r = await check(tokens.late_liquidity);
    const l = r.evidence.liquidity!;
    expect(l.created).toBeNull(); // the pair contract is older than the window
    expect(BigInt(l.supply_before) * 10n).toBeLessThan(BigInt(l.supply)); // but its liquidity is not
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("% of the LP removable now (EOA 0x60b1");
  });
  test("a young pool whose LP is burned (0x0, 0xdead): no liquidity finding, allow", async () => {
    const r = await check(tokens.lp_burned);
    expect(r.verdict).toBe("allow");
    expect(r.evidence.liquidity?.holders?.every((h) => h.kind === "burned")).toBe(true);
  });
  test("WETH/USDC: at least 90 % of its LP existed 1800 blocks ago, holders not read, allow", async () => {
    const r = await check(tokens.usdc);
    expect(r.verdict).toBe("allow");
    const l = r.evidence.liquidity!;
    expect(l.holders).toBeNull();
    expect(BigInt(l.supply_before) * 10n).toBeGreaterThanOrEqual(BigInt(l.supply) * 9n);
  });
});

describe("liquidity rule (pure)", () => {
  const pair = "0x00000000000000000000000000000000000000aa" as Address;
  const eoa = (a: string, balance: bigint): Holder => ({ address: a as Address, balance: balance.toString(), kind: "eoa" });
  const burned: Holder = { address: "0x000000000000000000000000000000000000dead", balance: "40", kind: "burned" };
  const young = (holders: Holder[] | null, candidates = holders?.length ?? 99): Liquidity => ({ pair, supply: "100", supply_before: "0", created: 90, candidates, holders });
  test("holders that cannot be read (too many candidates): warn, never a pass", () => {
    expect(liquidityFindings(young(null, 25), 100)[0]).toMatchObject({ level: "warn", text: "pool 10 blocks old: LP spread over 25 addresses, holders not read" });
  });
  test("LP not all accounted for by the holders read: warn", () => {
    expect(liquidityFindings(young([burned]), 100)[0]?.level).toBe("warn");
  });
  test("LP split across several EOAs is summed: 60 % removable is a warn", () => {
    expect(liquidityFindings(young([burned, eoa("0x01", 30n), eoa("0x02", 30n)]), 100)[0]?.text).toContain("60 % of the LP removable now");
  });
  test("LP held by a contract (lock terms not read) counts as removable", () => {
    const locker: Holder = { address: "0x00000000000000000000000000000000000000cc", balance: "60", kind: "contract" };
    expect(liquidityFindings(young([burned, locker]), 100)[0]?.text).toContain("(contract 0x0000..00cc holds 60 %)");
  });
  test("less than half removable: no finding", () => {
    expect(liquidityFindings(young([{ ...burned, balance: "60" }, eoa("0x01", 40n)]), 100)).toEqual([]);
  });
  test("an old pair whose LP grew by more than 10 % within the window is read, not passed on its age", () => {
    const l: Liquidity = { pair, supply: "100", supply_before: "89", created: null, candidates: 1, holders: [eoa("0x01", 11n)] };
    expect(liquidityFindings(l, 100)[0]?.text).toContain("11 % of the LP minted in the last 1800 blocks: LP holders not all accounted for");
  });
});

describe("template reputation", () => {
  test("fresh token of a farm template: every simulation step passes, yet block by reputation", async () => {
    const r = await check(tokens.farm_fresh);
    const sales = r.evidence.calls.filter((c) => c.includes("buy") || c.includes("sale"));
    expect(sales.every((c) => c.endsWith(": ok"))).toBe(true);
    expect(r.verdict).toBe("block");
    // only the reputation and the removable LP: no simulation finding (tax, sale refused, takeback)
    expect(r.reasons.split(" ; ").map((f) => f.split(" ")[0])).toEqual(["template", "pool"]);
    expect(r.reasons).toMatch(/^template 0x[0-9a-f]{4}\.\.[0-9a-f]{4}: 5 of 5 earlier pools drained, median 2 blocks after funding/);
    expect(r.evidence.reputation).toMatchObject({ pools: 5, drained: 5, median_drain_blocks: 2 });
    expect(r.list_target).toBe(false); // a block on the template's reputation alone: the guard does not list the token
  });
  test("a simulation trap (sale refused): block resting on the token's own simulation, so list_target", async () => {
    const r = await check(tokens.sell_blocked);
    expect(r.verdict).toBe("block");
    expect(r.list_target).toBe(true);
  });
  test("without an index the reputation is unknown: warn, never allow", async () => {
    const r = await check(tokens.safe, GUARD_EVM, null);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("template reputation not checked");
  });
});

describe("shared blocklist and code changes read from NEAR", () => {
  const listed = (key: string): NearFacts => ({ listed: [{ key, reporter: "agent-b.testnet", evidence_sha256: "ab".repeat(32) }], previous: null });
  test("a token listed by another reporter: block, even with a clean simulation", async () => {
    const r = await check(tokens.usdc, GUARD_EVM, INDEX, listed(tokens.usdc.toLowerCase()));
    expect(r.verdict).toBe("block");
    expect(r.reasons).toStartWith("listed on NEAR by agent-b.testnet");
    expect(r.evidence.near.listed.length).toBe(1);
    expect(r.list_target).toBe(false); // already listed: nothing of its own to list it for
  });
  test("code changed since the last check (another code hash): warn, the human decides", async () => {
    const before = { id: 7, code_hash: `0x${"00".repeat(32)}` as const, implementation: null };
    const r = await check(tokens.lp_burned, GUARD_EVM, INDEX, { listed: [], previous: before });
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain("code changed since the last check #7");
  });
  test("same code as at the last check: no finding", async () => {
    const first = await check(tokens.lp_burned);
    const previous = { id: 7, code_hash: first.evidence.code_hash, implementation: first.evidence.implementation };
    expect((await check(tokens.lp_burned, GUARD_EVM, INDEX, { listed: [], previous })).verdict).toBe("allow");
  });
  test("the sentinel asks NEAR about the target only (the guard lists tokens, never templates)", async () => {
    const asked: string[] = [];
    await checkToken(RPC, tokens.farm_fresh as Address, GUARD_EVM, () => ({ buyer: rand(), stranger: rand() }), {
      index: INDEX,
      near: async (target) => (asked.push(target), NO_NEAR),
      gas: GAS,
    });
    expect(asked).toEqual([tokens.farm_fresh as Address]);
  });
});

describe("exit quote (the agent's floor comes from it)", () => {
  const HOLDER = "0x60B1100000000000000000000000000000000001" as Address; // holds the demo tokens (evm/fork.sh)
  test("sale of tokens the address holds: allow, quote = WETH out of the simulated sale", async () => {
    const r = await checkExit(RPC, tokens.lp_burned as Address, HOLDER, parseEther("1000"), GAS);
    expect(r.verdict).toBe("allow");
    expect(BigInt(r.evidence.quote)).toBeGreaterThan(0n);
    expect(r.evidence.kind).toBe("exit");
  });
  test("sale of more than the address holds: no quote, block (the owner's own exit stays open)", async () => {
    const r = await checkExit(RPC, tokens.lp_burned as Address, rand(), parseEther("1000"), GAS);
    expect(r.verdict).toBe("block");
    expect(r.evidence.quote).toBe("0");
  });
});

describe("devis poste avec le verdict", () => {
  test("USDC, sans taxe : jetons recus par l'achat simule de 0,01 ETH = sortie du pool au bloc", async () => {
    const r = await check(tokens.usdc);
    const out = await rpc<Hex>(RPC, "eth_call", [
      { to: ROUTER, data: encodeFunctionData({ abi: quoteAbi, args: [parseEther("0.01"), [WETH, tokens.usdc as Address]] }) },
      `0x${r.evidence.block.toString(16)}`,
    ]);
    const [amounts] = decodeAbiParameters([{ type: "uint256[]" }], out);
    expect(r.evidence.quote).toBe(amounts[1].toString());
    expect(BigInt(r.evidence.quote)).toBeGreaterThan(0n);
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
  test("la simulation reprend l'environnement du bloc reel (gaz, base fee, prevrandao, coinbase, numero)", async () => {
    const r = await check(tokens.safe);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [`0x${r.evidence.block.toString(16)}`, false] }),
    });
    const { result: h } = (await res.json()) as { result: { baseFeePerGas: string; mixHash: string; miner: string } };
    const blocks = (r.request.params[0] as { blockStateCalls: { blockOverrides: Record<string, string>; calls: Record<string, string>[] }[] }).blockStateCalls;
    for (const b of blocks) {
      expect(b.blockOverrides).toMatchObject({ baseFeePerGas: h.baseFeePerGas, prevRandao: h.mixHash, feeRecipient: h.miner });
      for (const c of b.calls) {
        expect(BigInt(c.maxPriorityFeePerGas)).toBeGreaterThan(0n);
        expect(BigInt(c.maxFeePerGas)).toBeGreaterThan(BigInt(h.baseFeePerGas));
        expect(c.gas).toBe("0x3d090"); // the guard's 250,000, not the block's limit
      }
    }
    expect(BigInt(blocks[2].blockOverrides.number)).toBe(BigInt(r.evidence.block) + 256n); // vente +1 h : dernier bloc permis
  });
  test("porte l'implementation d'un proxy (USDC)", async () => {
    const r = await check(tokens.usdc);
    expect(r.evidence.implementation).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
