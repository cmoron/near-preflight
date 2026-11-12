// Shared NEAR access: configuration read from .env (bun loads it by itself), keys kept out of the repo.
import { Account, getTransactionLastResult, JsonRpcProvider, yoctoToNear } from "near-api-js";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { patientFetch } from "./verifier";

// near-api-js calls fetch without a timeout (a response that never arrives hung the sentinel) and throws
// on the RPC's rate limit (HTTP 429: replay --check, the armer and the agent failed on it). Every fetch of
// a process that loads this file goes through patientFetch: a timeout per try, a 429 waited out and the
// same bytes sent again.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => patientFetch(input, init)) as typeof fetch;

export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC });

/** A required setting from the environment (.env or a role's key file); throws, naming setup, if unset. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (.env or the role's key file): run bun app/setup.ts <parent>.testnet first`);
  return v;
}

/** Writes a key file readable by its owner only (0600), even if it already existed:
 *  Bun.write ignores its `mode` option and left keys at 0664. */
export async function writeSecret(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Account signed by a given key (e.g. the agent's function-call key). */
export function account(id: string, key: string): Account {
  return new Account(id, provider, key as `ed25519:${string}`);
}

/** The human's account, signed by its full key from the near-cli keychain (~/.near-credentials). */
export async function humanAccount(id: string): Promise<Account> {
  const file = `${homedir()}/.near-credentials/testnet/${id}.json`;
  const { private_key } = await Bun.file(file).json();
  return account(id, private_key);
}

/** A view call on the guard named by GUARD (no key, no gas). */
export function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return provider.callFunction({ contractId: env("GUARD"), method, args }) as Promise<T>;
}

/** View and height of the block read: the RPC spreads reads over nodes that are more or less up to date. */
export async function viewAt<T>(method: string, args: Record<string, unknown> = {}): Promise<{ value: T; height: number }> {
  const raw = await provider.callFunctionRaw({ contractId: env("GUARD"), method, args });
  return { value: JSON.parse(new TextDecoder().decode(new Uint8Array(raw.result))) as T, height: raw.block_height };
}

/** Error message of the contract (panic) or of the protocol, without the stack. */
export function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.match(/Smart contract panicked: ([^"\n]+)/)?.[1] ?? msg.split("\n")[0];
}

/** Link to a testnet transaction on nearblocks. */
export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

/** Guard call signed by `who`; returns the value, the transaction link and what it
 *  burnt (gas and NEAR, all its receipts included: MPC call and callback for a buy). */
export async function call<T>(who: Account, methodName: string, args: Record<string, unknown>, deposit = 0n, gas?: bigint) {
  const raw = await who.callFunctionRaw({ contractId: env("GUARD"), methodName, args, deposit, ...(gas ? { gas } : {}) });
  const outcomes = [raw.transaction_outcome, ...raw.receipts_outcome].map((o) => o.outcome);
  const tgas = outcomes.reduce((n, o) => n + Number(o.gas_burnt), 0) / 1e12;
  const near = outcomes.reduce((n, o) => n + BigInt(o.tokens_burnt), 0n);
  return { value: getTransactionLastResult(raw) as T, tx: explorer(raw.transaction.hash), burnt: `${tgas.toFixed(1)} TGas, ${yoctoToNear(near)} NEAR burnt` };
}

export type Check = {
  agent: string;
  target: string;
  requested_ns: string;
  verdict: "allow" | "warn" | "block" | null;
  /** sha256 of the decision package (app/llm.ts) that asked for this check, null without one. */
  decision_sha256: string | null;
  /** sha256 of the decision package that asked for the buy on this check, null without one. */
  buy_decision_sha256: string | null;
  reasons: string;
  /** Verdict time, in nanoseconds (string). */
  judged_ns: string;
  /** sha256 (hex) of the evidence string posted with the verdict; empty without a verdict. */
  evidence_sha256: string;
  /** The buy the agent stated at request_check, in wei (decimal; "0" for an exit quote). */
  amount_wei: string;
  /** Tokens the guard's address received in the simulated buy of amount_wei (decimal); the swap's minimum is it minus 3 %. */
  quote: string;
  settled: boolean;
  /** True once the owner approved this warn verdict (approve_warn). */
  approved: boolean;
  /** EIP-1559 transaction signed by the MPC for the buy (base64), null while there is none. */
  signed_tx: string | null;
  /** The target's code posted with the verdict (keccak256, proxy implementation), null if none. */
  code: { code_hash: string; implementation: string | null } | null;
  /** An exit quote (request_exit): tokens to sell; its quote is then the ETH out, in wei. */
  exit_amount: string | null;
  /** Signing hashes (no 0x) of the transactions the sentinel simulated: the guard signs only these for the check. */
  tx_hashes: string[];
};
/** A shared blocklist entry (get_entry). */
export type Entry = { reporter: string; at_ns: string; evidence_sha256: string; note: string };
