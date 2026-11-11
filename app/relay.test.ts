// Off-chain verification of the transaction signed by NEAR, no network. Same vectors as the
// Rust tests of src/lib.rs: viem produces them, the contract produces the same bytes.
import { expect, test } from "bun:test";
import { createPublicClient, encodeFunctionData, http, keccak256, maxUint256, parseAbi, serializeTransaction, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { broadcast, verifyBuy, verifyExit } from "./relay";
import { localPreviews } from "./testkit";
import { ROUTER, WETH } from "./verifier";

const signer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const intruder = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const ADDR = signer.address; // stands in for the guard's derived address
const TARGET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const HASH0 = "0x77f64e70df6935239916ccdd2ab75716323a4429d486e44e45d33123fafabce2";
const RAW0 =
  "0x02f9015782210580830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de95000000000000000000000000000000000000000000000000000000000000303900000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000025800000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c080a0bf93c409439f99904f5f934ce623933abc8dbb7d5668c4697f1c9ffdcb92ac37a0104b962a6f1920aa60d690cf6b391ec5a12bfde960bb3b43f8a8812383345119";

const swap = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);

/** The swap of the Rust tests (nonce 0, 1e13 wei, minimum 12345, deadline 600 s), fields overridable. */
function tx(o: { to?: Address; token?: Address; recipient?: Address; chainId?: number } = {}) {
  const data = encodeFunctionData({ abi: swap, args: [12_345n, [WETH, o.token ?? TARGET], o.recipient ?? ADDR, 600n] });
  return {
    type: "eip1559",
    chainId: o.chainId ?? 8453,
    nonce: 0,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 50_000_000n,
    gas: 250_000n,
    to: o.to ?? ROUTER,
    value: 10_000_000_000_000n,
    data,
    accessList: [],
  } as const;
}

test("viem produces the bytes the contract has signed then assembles", async () => {
  expect(keccak256(serializeTransaction(tx()))).toBe(HASH0);
  expect(await signer.signTransaction(tx())).toBe(RAW0);
});

test("the contract's transaction decodes to the router, the target and the derived address", async () => {
  expect(await verifyBuy(RAW0, TARGET, ADDR)).toMatchObject({
    nonce: 0,
    value: 10_000_000_000_000n,
    minOut: 12_345n,
    gas: 250_000n,
    maxFeePerGas: 50_000_000n,
  });
});

test("refused: other router, other token, other recipient, other signer, other chain", async () => {
  await expect(verifyBuy(await signer.signTransaction(tx({ to: OTHER })), TARGET, ADDR)).rejects.toThrow("router");
  await expect(verifyBuy(RAW0, OTHER, ADDR)).rejects.toThrow("path");
  await expect(verifyBuy(await signer.signTransaction(tx({ recipient: OTHER })), TARGET, ADDR)).rejects.toThrow("recipient");
  await expect(verifyBuy(await intruder.signTransaction(tx()), TARGET, ADDR)).rejects.toThrow("signer");
  await expect(verifyBuy(await signer.signTransaction(tx({ chainId: 1 })), TARGET, ADDR)).rejects.toThrow("chain id");
});

// Against the local fork (evm/fork.sh): running the relay again on a mined transaction reports it.
test("a transaction already broadcast is reported with its receipt, not as a nonce error", async () => {
  const client = createPublicClient({ transport: http(process.env.EVM_RPC ?? "http://127.0.0.1:8545") });
  const fresh = privateKeyToAccount(generatePrivateKey());
  const raw = await fresh.signTransaction({
    type: "eip1559", chainId: 8453, nonce: 0, to: OTHER, value: 1n, gas: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n,
  });
  const first = await broadcast(client, raw, fresh.address, () => {});
  expect(first.already).toBe(false);
  expect(first.receipt.status).toBe("success");
  const again = await broadcast(client, raw, fresh.address, () => {});
  expect(again.already).toBe(true);
  expect(again.receipt.transactionHash).toBe(first.receipt.transactionHash);
});

// Exit signed by NEAR: approve(router, amount), then the swap of that amount back to the derived address.
const exitAbi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);
const fees = { type: "eip1559", chainId: 8453, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 50_000_000n, gas: 250_000n, accessList: [] } as const;
const approveTx = (spender: Address = ROUTER, token: Address = TARGET) =>
  ({ ...fees, nonce: 0, to: token, value: 0n, data: encodeFunctionData({ abi: exitAbi, functionName: "approve", args: [spender, 1_000_000n] }) }) as const;
const swapTx = (recipient: Address = ADDR, token: Address = TARGET) =>
  ({
    ...fees,
    nonce: 1,
    to: ROUTER,
    value: 0n,
    data: encodeFunctionData({ abi: exitAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [1_000_000n, 5n, [token, WETH], recipient, 300n] }),
  }) as const;
const sale = { token: TARGET as Address, amount: 1_000_000n };

test("an exit decodes to approve(router) then the swap back to the derived address", async () => {
  const raws = [await signer.signTransaction(approveTx()), await signer.signTransaction(swapTx())];
  const lines = await verifyExit(raws, sale, ADDR, OTHER);
  expect(lines[0]).toContain("approve");
  expect(lines[1]).toContain("at least 5 wei");
  expect(await verifyExit(raws.slice(0, 1), sale, ADDR, OTHER)).toHaveLength(1); // approve alone (swap signature failed)
});

test("exit refused: other spender, other recipient, other token, other signer, swap before approve", async () => {
  const ok = await signer.signTransaction(approveTx());
  const swap = await signer.signTransaction(swapTx());
  await expect(verifyExit([await signer.signTransaction(approveTx(OTHER)), swap], sale, ADDR, OTHER)).rejects.toThrow("approve");
  await expect(verifyExit([ok, await signer.signTransaction(swapTx(OTHER))], sale, ADDR, OTHER)).rejects.toThrow("recipient");
  await expect(verifyExit([ok, await signer.signTransaction(swapTx(ADDR, OTHER))], sale, ADDR, OTHER)).rejects.toThrow("path");
  await expect(verifyExit([await intruder.signTransaction(approveTx()), swap], sale, ADDR, OTHER)).rejects.toThrow("signer");
  await expect(verifyExit([swap, ok], sale, ADDR, OTHER)).rejects.toThrow();
});

test("the owner's sale with an approve of 2^256 - 1 is accepted only when its exit says so", async () => {
  const max = await signer.signTransaction({ ...approveTx(), data: encodeFunctionData({ abi: exitAbi, functionName: "approve", args: [ROUTER, maxUint256] }) });
  const swap = await signer.signTransaction(swapTx());
  expect((await verifyExit([max, swap], { ...sale, approve: maxUint256 }, ADDR, OTHER))[0]).toContain(`approve(router, ${maxUint256})`);
  await expect(verifyExit([max, swap], sale, ADDR, OTHER)).rejects.toThrow("approve");
});

test("a withdrawal pays the owner's address fixed at init, nothing else", async () => {
  const pay = (to: Address) => signer.signTransaction({ ...fees, nonce: 0, to, value: 1_000n, data: "0x" });
  expect((await verifyExit([await pay(OTHER)], { token: null, amount: 1_000n }, ADDR, OTHER))[0]).toContain("withdraw");
  await expect(verifyExit([await pay(TARGET)], { token: null, amount: 1_000n }, ADDR, OTHER)).rejects.toThrow("withdraw");
});

test("the tests' stand-in for the guard's previews builds the contract's bytes (src/lib.rs vectors)", async () => {
  const p = localPreviews({ guard: ADDR, target: TARGET, amount: 10_000_000_000_000n });
  // the_preview_is_the_transaction_the_buy_signs: quote 20,435 -> minimum 19,821, deadline 300 s, nonce 0
  expect((await p.check(20_435n)).map((t) => keccak256(t))).toEqual(["0x314bf89cb90d7232250c56241836f4ab662a81de9030d250712eedbcdd5fd5e0"]);
  // the_sale_preview_is_the_exit_the_guard_signs_with_a_floor_of_0: 1,000,000 tokens, deadline 300 s
  expect((await p.sale(1_000_000n, 300n)).map((t) => keccak256(t))).toEqual([
    "0x655e06dcbeba90aa01c2e4fb6f9b6bf827516faf20694d21488d2d9e168bb101",
    "0x4e63831862f4e2d50eab33966eee2e53843bd3f8cea8c0d01f4ece43e71cf1d1",
  ]);
});
