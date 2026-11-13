// Fixed vectors: no network call. Master key and signatures taken from testnet on 2026-11-11.
import { expect, test } from "bun:test";
import { recoverAddress, type Hex } from "viem";
import { addressOfKey, deriveEvmAddress } from "./derive";

const MASTER = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
const ACCOUNT = "goblin-guard-00044.testnet";
const ADDR = "0x68706820a7c4c6A58EF80d7fE13689134FfcF6A7";
// payload = keccak256("goblin-near")
const HASH: Hex = "0x63541cb099b93ea999c3ec8ba838130c462a9179d5e7c3d76c9c8e5927aa68df";

// Real responses of v1.signer-prod.testnet: r = x of big_r (bytes 1..33 of the compressed point),
// s = scalar, yParity = recovery_id
const SIGS = [
  { big_r: "02ae8bb48852ee95dbece0ef8a38aa2bf1b1f4c03ca08262c452796191e2056878", s: "22c573fbded6ce4d0fcad43b575adf4ade445adfb714f71003ce0855c88a4a10", recovery_id: 1 },
  { big_r: "02a7378076a8321ebe724e751bdb71a3cfaae60a36e4e3ac6156edc01cec7273e6", s: "1ac1c5d95e3d4ab51f6252dcbcae7732cee56c035937f211c46e579f26803586", recovery_id: 0 },
];

test("derived address of the demo account", () => {
  expect(deriveEvmAddress(MASTER, ACCOUNT, "evm-1")).toBe(ADDR);
});

test("another path or another account gives another address", () => {
  expect(deriveEvmAddress(MASTER, ACCOUNT, "evm-2")).not.toBe(ADDR);
  expect(deriveEvmAddress(MASTER, "other.testnet", "evm-1")).not.toBe(ADDR);
});

// Read from mainnet's v1.signer on 2026-11-13: public_key, and derived_public_key for that account and path.
test("on mainnet, the local derivation gives the address v1.signer derives itself", () => {
  const master = "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya";
  const derived = "secp256k1:5ZfCtgU28p4iGSag2FoBytBkEfWmW3fPc3sKxNtpDpfqDt5LLtyQutTXBqpCvnvMoEc8m7yvT2LW55dgJcAXBLPH";
  expect(deriveEvmAddress(master, "guard.near-preflight.near", "evm-1")).toBe(addressOfKey(derived));
  expect(addressOfKey(derived)).toBe("0xB407022A1e227D66B994149d25c675d4cdbc9538");
});

test("the real MPC signatures recover the derived address", async () => {
  for (const g of SIGS) {
    const recovered = await recoverAddress({
      hash: HASH,
      signature: { r: `0x${g.big_r.slice(2)}`, s: `0x${g.s}`, yParity: g.recovery_id as 0 | 1 },
    });
    expect(recovered).toBe(ADDR);
  }
});
