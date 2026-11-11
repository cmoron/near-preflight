// Derivation de l'adresse EVM d'un compte NEAR via Chain Signatures (MPC testnet).
// tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
// cle = cle_maitresse + tweak*G ; adresse = 20 derniers octets de keccak256(cle sans le prefixe 04)
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { keccak256, toHex, getAddress, type Hex } from "viem";

export const MPC_CONTRACT = "v1.signer-prod.testnet";
/** Chemin de derivation de la garde, fixe par le contrat (DERIVATION_PATH dans src/lib.rs). */
export const GUARD_PATH = "evm-1";
const RPC = "https://rpc.testnet.near.org";

// Cle maitresse "secp256k1:<base58 de x||y>" -> 64 octets
export function parseNearSecpKey(s: string): Uint8Array {
  const raw = bs58.decode(s.replace(/^secp256k1:/, ""));
  if (raw.length !== 64) throw new Error(`cle secp256k1 NEAR attendue sur 64 octets, recu ${raw.length}`);
  return raw;
}

export function deriveEvmAddress(masterPublicKey: string, predecessor: string, path: string): Hex {
  const xy = parseNearSecpKey(masterPublicKey);
  const master = secp256k1.Point.fromBytes(new Uint8Array([4, ...xy]));
  const tweak = sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`));
  const t = BigInt("0x" + Buffer.from(tweak).toString("hex")) % secp256k1.Point.Fn.ORDER;
  const key = master.add(secp256k1.Point.BASE.multiply(t));
  const uncompressed = key.toBytes(false); // 65 octets, prefixe 04
  return getAddress("0x" + keccak256(toHex(uncompressed.slice(1))).slice(26));
}

// Appel de vue public_key sur le contrat MPC
export async function fetchMasterPublicKey(): Promise<string> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: MPC_CONTRACT, method_name: "public_key", args_base64: "e30=" },
    }),
  });
  const j: any = await r.json();
  if (!j.result?.result) throw new Error(`public_key: ${JSON.stringify(j.error ?? j)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

if (import.meta.main) {
  const [account, path] = process.argv.slice(2);
  if (!account || !path) throw new Error("usage: bun app/derive.ts <compte> <path>");
  console.log(deriveEvmAddress(await fetchMasterPublicKey(), account, path));
}
