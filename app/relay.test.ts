// Verification hors chaine de la transaction signee par NEAR, sans reseau. Memes vecteurs que les
// tests Rust de src/lib.rs : viem les produit, le contrat produit les memes octets.
import { expect, test } from "bun:test";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyBuy } from "./relay";
import { ROUTER, WETH } from "./verifier";

const signer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
const intruder = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const ADDR = signer.address; // tient lieu d'adresse derivee de la garde
const TARGET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const HASH0 = "0x77f64e70df6935239916ccdd2ab75716323a4429d486e44e45d33123fafabce2";
const RAW0 =
  "0x02f9015782210580830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de95000000000000000000000000000000000000000000000000000000000000303900000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000025800000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c080a0bf93c409439f99904f5f934ce623933abc8dbb7d5668c4697f1c9ffdcb92ac37a0104b962a6f1920aa60d690cf6b391ec5a12bfde960bb3b43f8a8812383345119";

const swap = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);

/** Le swap des tests Rust (nonce 0, 1e13 wei, minimum 12345, echeance 600 s), champs modifiables. */
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

test("viem produit les octets que le contrat fait signer puis assemble", async () => {
  expect(keccak256(serializeTransaction(tx()))).toBe(HASH0);
  expect(await signer.signTransaction(tx())).toBe(RAW0);
});

test("la transaction du contrat se decode vers le routeur, la cible et l'adresse derivee", async () => {
  expect(await verifyBuy(RAW0, TARGET, ADDR)).toMatchObject({
    nonce: 0,
    value: 10_000_000_000_000n,
    minOut: 12_345n,
    gas: 250_000n,
    maxFeePerGas: 50_000_000n,
  });
});

test("refus : autre routeur, autre jeton, autre destinataire, autre signataire, autre chaine", async () => {
  await expect(verifyBuy(await signer.signTransaction(tx({ to: OTHER })), TARGET, ADDR)).rejects.toThrow("router");
  await expect(verifyBuy(RAW0, OTHER, ADDR)).rejects.toThrow("path");
  await expect(verifyBuy(await signer.signTransaction(tx({ recipient: OTHER })), TARGET, ADDR)).rejects.toThrow("recipient");
  await expect(verifyBuy(await intruder.signTransaction(tx()), TARGET, ADDR)).rejects.toThrow("signer");
  await expect(verifyBuy(await signer.signTransaction(tx({ chainId: 1 })), TARGET, ADDR)).rejects.toThrow("chain id");
});
