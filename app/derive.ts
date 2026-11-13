// The NEAR network every script talks to, and the derivation of a NEAR account's EVM address via
// Chain Signatures on it.
// tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
// key = master_key + tweak*G ; address = last 20 bytes of keccak256(key without the 04 prefix)
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { keccak256, toHex, getAddress, type Hex } from "viem";
import { patientFetch } from "./verifier";

/** NEAR_NETWORK=mainnet, testnet when unset; any other value throws. Each value's source: docs/mainnet.md. */
const NETWORKS = {
  testnet: { rpc: "https://test.rpc.fastnear.com", mpc: "v1.signer-prod.testnet", explorer: "https://testnet.nearblocks.io", suffix: ".testnet" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", mpc: "v1.signer", explorer: "https://nearblocks.io", suffix: ".near" },
} as const;
export const NETWORK = (process.env.NEAR_NETWORK || "testnet") as keyof typeof NETWORKS;
if (!Object.hasOwn(NETWORKS, NETWORK)) throw new Error(`NEAR_NETWORK=${NETWORK}: expected testnet or mainnet`);
export const NET = NETWORKS[NETWORK];
export const MPC_CONTRACT = NET.mpc;
/** Guard derivation path, fixed by the contract (DERIVATION_PATH in src/lib.rs). */
export const GUARD_PATH = "evm-1";
const RPC = process.env.NEAR_RPC ?? NET.rpc;

/** Master key "secp256k1:<base58 of x||y>" -> its 64 bytes; throws on any other length. */
export function parseNearSecpKey(s: string): Uint8Array {
  const raw = bs58.decode(s.replace(/^secp256k1:/, ""));
  if (raw.length !== 64) throw new Error(`NEAR secp256k1 key expected on 64 bytes, got ${raw.length}`);
  return raw;
}

/** The EVM address Chain Signatures signs for when `predecessor` calls `sign` with `path`: the guard's
 *  Base address is deriveEvmAddress(master, "guard.<parent>.testnet", "evm-1"). Pure, checksummed. */
export function deriveEvmAddress(masterPublicKey: string, predecessor: string, path: string): Hex {
  const xy = parseNearSecpKey(masterPublicKey);
  const master = secp256k1.Point.fromBytes(new Uint8Array([4, ...xy]));
  const tweak = sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${predecessor},${path}`));
  const t = BigInt("0x" + Buffer.from(tweak).toString("hex")) % secp256k1.Point.Fn.ORDER;
  const key = master.add(secp256k1.Point.BASE.multiply(t));
  const uncompressed = key.toBytes(false); // 65 bytes, 04 prefix
  return getAddress("0x" + keccak256(toHex(uncompressed.slice(1))).slice(26));
}

/** EVM address of a NEAR secp256k1 key "secp256k1:<base58 of x||y>". */
export function addressOfKey(key: string): Hex {
  return getAddress("0x" + keccak256(toHex(parseNearSecpKey(key))).slice(26));
}

/** A view of the MPC contract, read from the NEAR RPC (a 429 waited out). */
async function mpcView(method: string, args: object): Promise<string> {
  const r = await patientFetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: MPC_CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const j: any = await r.json();
  if (!j.result?.result) throw new Error(`${method}: ${JSON.stringify(j.error ?? j)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

/** The MPC contract's master public key (view `public_key`). */
export const fetchMasterPublicKey = () => mpcView("public_key", {});

/** The address the MPC contract itself derives for `predecessor` and `path` (view `derived_public_key`,
 *  secp256k1 domain 0): what deriveEvmAddress must give. */
export const fetchDerivedAddress = async (predecessor: string, path: string) =>
  addressOfKey(await mpcView("derived_public_key", { path, predecessor, domain_id: 0 }));

if (import.meta.main) {
  const [account, path] = process.argv.slice(2);
  if (!account || !path) throw new Error("usage: bun app/derive.ts <account> <path>");
  console.log(deriveEvmAddress(await fetchMasterPublicKey(), account, path));
}
