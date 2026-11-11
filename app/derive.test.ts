// Vecteurs fixes : aucun appel reseau. Cle maitresse et signatures relevees sur testnet le 2026-11-11.
import { expect, test } from "bun:test";
import { recoverAddress, type Hex } from "viem";
import { deriveEvmAddress } from "./derive";

const MASTER = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
const ACCOUNT = "goblin-guard-00044.testnet";
const ADDR = "0x68706820a7c4c6A58EF80d7fE13689134FfcF6A7";
// payload = keccak256("goblin-near")
const HASH: Hex = "0x63541cb099b93ea999c3ec8ba838130c462a9179d5e7c3d76c9c8e5927aa68df";

// Reponses reelles de v1.signer-prod.testnet : r = x de big_r (octets 1..33 du point compresse),
// s = scalar, yParity = recovery_id
const SIGS = [
  { big_r: "02ae8bb48852ee95dbece0ef8a38aa2bf1b1f4c03ca08262c452796191e2056878", s: "22c573fbded6ce4d0fcad43b575adf4ade445adfb714f71003ce0855c88a4a10", recovery_id: 1 },
  { big_r: "02a7378076a8321ebe724e751bdb71a3cfaae60a36e4e3ac6156edc01cec7273e6", s: "1ac1c5d95e3d4ab51f6252dcbcae7732cee56c035937f211c46e579f26803586", recovery_id: 0 },
];

test("adresse derivee du compte de demo", () => {
  expect(deriveEvmAddress(MASTER, ACCOUNT, "evm-1")).toBe(ADDR);
});

test("un autre path ou un autre compte donne une autre adresse", () => {
  expect(deriveEvmAddress(MASTER, ACCOUNT, "evm-2")).not.toBe(ADDR);
  expect(deriveEvmAddress(MASTER, "autre.testnet", "evm-1")).not.toBe(ADDR);
});

test("les signatures MPC reelles recuperent l'adresse derivee", async () => {
  for (const g of SIGS) {
    const recovered = await recoverAddress({
      hash: HASH,
      signature: { r: `0x${g.big_r.slice(2)}`, s: `0x${g.s}`, yParity: g.recovery_id as 0 | 1 },
    });
    expect(recovered).toBe(ADDR);
  }
});
