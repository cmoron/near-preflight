// Fork-only harness. localPreviews: a stand-in for the guard's previews (preview_check and preview_sale
// in src/lib.rs), built with viem: the sentinel reads them from the guard, the fork tests cannot;
// app/relay.test.ts checks these bytes against the Rust test vectors, so it cannot drift from the
// contract unnoticed. mine: Base's activity. Real Base mines five blocks a second, most with others'
// WETH and ETH transfers; a local fork mines nothing on its own. The fork mines a block a second (FORK_S):
// anvil's eth_simulateV1 refuses two blocks with one timestamp, which Base's whole-second clock gives
// five blocks; the checker measures that cadence as it measures Base's (app/verifier.ts cadenceAt). The
// tests mine the blocks a check waits for, each with a few third-party transactions drawn at random
// (and trades of a token's pool, if asked), and `bun app/testkit.ts live` (demo.sh) mines one every
// second of wall-clock time: the checker waits for them as it waits for Base.
import { encodeFunctionData, pad, parseAbi, serializeTransaction, toHex, type Address, type Hex } from "viem";
import { CADENCE_BLOCKS, LATER_S, REF_MARGIN_S, ROUTER, rpc, WETH, type Fees, type Previews } from "./verifier";

/** The fork's block time, in seconds: the shortest anvil's eth_simulateV1 accepts. */
export const FORK_S = 1n;

/** Gas and fees app/setup.ts gives the guard: 250,000 gas, 0.05 gwei at most, 0.001 gwei tip. */
export const SETUP_FEES: Fees = { gas: 250_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 1_000_000n };
const abi = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
  "function approve(address,uint256) returns (bool)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);

/** What the guard would sign for a check of `target` requested at `requestedS` (its swap deadline is
 *  300 s later), at `nonce`, slippage 3 %: a buy of `amount` wei, or with `exitAmount` an exit quote. */
export function localPreviews(o: { guard: Address; target: Address; amount: bigint; requestedS?: bigint; nonce?: number; fees?: Fees; exitAmount?: bigint }): Previews {
  const fees = o.fees ?? SETUP_FEES;
  const nonce = o.nonce ?? 0;
  const deadline = (o.requestedS ?? 0n) + 300n;
  const floor = (quote: bigint) => (quote * 9_700n) / 10_000n;
  const tx = (n: number, to: Address, data: Hex, value = 0n): Hex =>
    serializeTransaction({ type: "eip1559", chainId: 8453, nonce: n, to, value, data, gas: fees.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, accessList: [] });
  const exit = (amount: bigint, min: bigint, by: bigint) => [
    tx(nonce, o.target, encodeFunctionData({ abi, functionName: "approve", args: [ROUTER, amount] })),
    tx(nonce + 1, ROUTER, encodeFunctionData({ abi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amount, min, [o.target, WETH], o.guard, by] })),
  ];
  return {
    check: async (quote) =>
      o.exitAmount !== undefined
        ? exit(o.exitAmount, floor(quote), deadline)
        : [tx(nonce, ROUTER, encodeFunctionData({ abi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [floor(quote), [WETH, o.target], o.guard, deadline] }), o.amount)],
    sale: async (amount, by) => exit(amount, 0n, by),
  };
}

/** Users without a key whose transactions fill the fork's blocks; evm/fork.sh gives each 1,000 ETH. */
export const USERS = [1, 2, 3, 4, 5].map((i) => pad(toHex(0xb10c00 + i), { size: 20 }));
const weth = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)", "function transfer(address,uint256) returns (bool)"]);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

/** One third-party transaction drawn at random: a WETH deposit, withdrawal or transfer, or an ETH
 *  transfer, between USERS, of 0.001 to 0.1 ETH. */
async function activity(url: string): Promise<Record<string, Hex>> {
  const from = pick(USERS);
  const to = pick(USERS.filter((u) => u !== from));
  const value = 10n ** 15n + BigInt(Math.floor(Math.random() * 1e17));
  const held = BigInt(await rpc<Hex>(url, "eth_call", [{ to: WETH, data: encodeFunctionData({ abi: weth, functionName: "balanceOf", args: [from] }) }, "latest"]));
  const part = held / BigInt(2 + Math.floor(Math.random() * 5));
  switch (pick(part ? (["deposit", "withdraw", "eth", "weth"] as const) : (["deposit", "eth"] as const))) {
    case "deposit":
      return { from, to: WETH, data: "0xd0e30db0", value: toHex(value) };
    case "withdraw":
      return { from, to: WETH, data: encodeFunctionData({ abi: weth, functionName: "withdraw", args: [part] }) };
    case "weth":
      return { from, to: WETH, data: encodeFunctionData({ abi: weth, functionName: "transfer", args: [to, part] }) };
    case "eth":
      return { from, to, data: "0x", value: toHex(value) };
  }
}

const swap = parseAbi(["function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable"]);
/** A third party's trade of `token`'s pool: a USERS address buys 0.01 to 0.5 ETH of it through the router,
 *  with 400,000 gas, a wallet's margin over the estimate. A trade re-executed after the guard's buy keeps
 *  its gas limit: one estimated to the unit (anvil's default) can run out where the token does more after
 *  the buy, and the resale is then not verified (app/later.ts). */
function trade(token: Address): Record<string, Hex> {
  const from = pick(USERS);
  const value = 10n ** 16n + BigInt(Math.floor(Math.random() * 49e16));
  return { from, to: ROUTER, data: encodeFunctionData({ abi: swap, args: [0n, [WETH, token], from, 9_999_999_999n] }), value: toHex(value), gas: toHex(400_000n) };
}

/** Mines `n` blocks on the fork at `url`, each FORK_S after the one before (no sooner than now with
 *  `realTime`), each holding one to three transactions of `activity`, and with `trades`, a third party's
 *  buy of that token's pool in about one block in three, among them, in no fixed place; always in one of
 *  the 6th to 15th blocks, which a check requested before the first waits for (CHECK_BLOCKS). */
export async function mine(url: string, n: number, realTime = false, trades?: Address): Promise<void> {
  for (const u of USERS) await rpc(url, "anvil_impersonateAccount", [u]);
  await rpc(url, "evm_setAutomine", [false]);
  const forced = 5 + Math.floor(Math.random() * 10);
  try {
    for (let i = 0; i < n; i++) {
      const last = BigInt((await rpc<{ timestamp: Hex }>(url, "eth_getBlockByNumber", ["latest", false])).timestamp) + FORK_S;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const txs = [];
      for (let k = 1 + Math.floor(Math.random() * 3); k > 0; k--) txs.push(await activity(url));
      if (trades && (i === forced || Math.random() < 1 / 3)) txs.splice(Math.floor(Math.random() * (txs.length + 1)), 0, trade(trades));
      for (const tx of txs) await rpc(url, "eth_sendTransaction", [tx]);
      await rpc(url, "evm_mine", [Number(realTime && now > last ? now : last)]);
    }
  } finally {
    await rpc(url, "evm_setAutomine", [true]);
  }
}

/** Blocks, FORK_S apart, a check requested at the fork's latest block waits for: its reference block
 *  REF_MARGIN_S later, then the later side's, at most LATER_S[1] after it. */
export const CHECK_BLOCKS = Number((REF_MARGIN_S + BigInt(LATER_S[1])) / FORK_S);

if (import.meta.main && process.argv[2] === "live") {
  // demo.sh: a block a second, until stopped. A fork whose clock is behind first mines the blocks up to
  // now at that pace, at most CADENCE_BLOCKS of them, so the cadence a check measures holds no jump.
  const url = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
  let stop = false;
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => (stop = true));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const behind = (now - BigInt((await rpc<{ timestamp: Hex }>(url, "eth_getBlockByNumber", ["latest", false])).timestamp)) / FORK_S;
  const n = behind < BigInt(CADENCE_BLOCKS) ? behind - 1n : BigInt(CADENCE_BLOCKS);
  if (n > 0n) {
    await rpc(url, "evm_setNextBlockTimestamp", [toHex(now - n * FORK_S)]);
    await rpc(url, "anvil_mine", [toHex(n), toHex(FORK_S)]);
  }
  console.log(`    [fork] mining a block every ${FORK_S} s on ${url}, with others' WETH and ETH transfers`);
  while (!stop) {
    // A fork that answers late (it fetches state it does not hold yet from its upstream node) costs a
    // block, not the miner: every check of the demo waits for the blocks it mines.
    await mine(url, 1, true).catch((e) => console.log(`    [fork] block not mined, next try in ${FORK_S} s (${e instanceof Error ? e.message.split("\n")[0] : e})`));
    await Bun.sleep(Number(FORK_S) * 1000);
  }
}
