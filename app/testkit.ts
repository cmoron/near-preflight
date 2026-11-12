// Fork-only harness. localPreviews: a stand-in for the guard's previews (preview_check and preview_sale
// in src/lib.rs), built with viem: the sentinel reads them from the guard, the fork tests cannot;
// app/relay.test.ts checks these bytes against the Rust test vectors, so it cannot drift from the
// contract unnoticed. mine: Base's activity. Real Base mines a block every 2 s, most with others' WETH
// and ETH transfers; a local fork mines nothing on its own. The tests mine the blocks a check waits for,
// each with a few third-party transactions drawn at random, and `bun app/testkit.ts live` (demo.sh)
// mines one every 2 s of wall-clock time: the checker waits for them as it waits for Base.
import { encodeFunctionData, pad, parseAbi, serializeTransaction, toHex, type Address, type Hex } from "viem";
import { LATER_S, NEXT_S, REF_MARGIN_S, ROUTER, rpc, WETH, type Fees, type Previews } from "./verifier";

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

/** Mines `n` blocks on the fork at `url`, each 2 s after the one before (no sooner than now with
 *  `realTime`), each holding one to three transactions of `activity`. */
export async function mine(url: string, n: number, realTime = false): Promise<void> {
  for (const u of USERS) await rpc(url, "anvil_impersonateAccount", [u]);
  await rpc(url, "evm_setAutomine", [false]);
  try {
    for (let i = 0; i < n; i++) {
      const last = BigInt((await rpc<{ timestamp: Hex }>(url, "eth_getBlockByNumber", ["latest", false])).timestamp) + NEXT_S;
      const now = BigInt(Math.floor(Date.now() / 1000));
      for (let k = 1 + Math.floor(Math.random() * 3); k > 0; k--) await rpc(url, "eth_sendTransaction", [await activity(url)]);
      await rpc(url, "evm_mine", [Number(realTime && now > last ? now : last)]);
    }
  } finally {
    await rpc(url, "evm_setAutomine", [true]);
  }
}

/** Blocks, 2 s apart, a check requested at the fork's latest block waits for: its reference block
 *  REF_MARGIN_S later, then the later side's, at most LATER_S[1] after it. */
export const CHECK_BLOCKS = Number((REF_MARGIN_S + BigInt(LATER_S[1])) / NEXT_S);

if (import.meta.main && process.argv[2] === "live") {
  // demo.sh: a block every 2 s, the fork's clock brought to now first, until stopped.
  const url = process.env.EVM_RPC ?? "http://127.0.0.1:8545";
  let stop = false;
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => (stop = true));
  console.log(`    [fork] mining a block every 2 s on ${url}, with others' WETH and ETH transfers`);
  while (!stop) {
    await mine(url, 1, true);
    await Bun.sleep(2000);
  }
}
