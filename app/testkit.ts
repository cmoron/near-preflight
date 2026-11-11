// Test stand-in for the guard's previews (preview_check and preview_sale in src/lib.rs), built with
// viem: the sentinel reads them from the guard, the fork tests cannot. app/relay.test.ts checks these
// bytes against the Rust test vectors, so the stand-in cannot drift from the contract unnoticed.
import { encodeFunctionData, parseAbi, serializeTransaction, type Address, type Hex } from "viem";
import { ROUTER, WETH, type Fees, type Previews } from "./verifier";

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
