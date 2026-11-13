// Shared NEAR access: configuration read from .env (bun loads it by itself), keys kept out of the repo.
import { Account, getTransactionLastResult, JsonRpcProvider, yoctoToNear } from "near-api-js";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { patientFetch } from "./verifier";
import { NET, NETWORK } from "./derive";

// near-api-js calls fetch without a timeout (a response that never arrives hung the sentinel) and throws
// on the RPC's rate limit (HTTP 429: replay --check, the armer and the agent failed on it). Every fetch of
// a process that loads this file goes through patientFetch: a timeout per try, a 429 waited out and the
// same bytes sent again.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => patientFetch(input, init)) as typeof fetch;

export const RPC = process.env.NEAR_RPC ?? NET.rpc;
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

/** The human's account, signed by its full key from the near-cli keychain (~/.near-credentials/<network>). */
export async function humanAccount(id: string): Promise<Account> {
  const file = `${homedir()}/.near-credentials/${NETWORK}/${id}.json`;
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

/** Runs `attempt` (given its number, from 1) again while the guard refuses it because its nonce, gas or
 *  fees moved since the simulation: a quote is of the transactions simulated, so the attempt must ask a
 *  new one each time. `tries` attempts at most; the last refusal, and any other failure, is thrown. */
export async function requoted<T>(attempt: (n: number) => Promise<T>, tries = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (e) {
      if (n >= tries || !reason(e).includes("transaction differs from the one simulated")) throw e;
    }
  }
}

/** Link to a transaction on nearblocks, on the network NEAR_NETWORK names. */
export const explorer = (tx: string) => `${NET.explorer}/txns/${tx}`;

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
  /** True once the check's transactions were sent to signing and came back signed, or were reserved (a
   *  buy or an exit whose signature did not come back keeps its nonce): it is used, and takes no more votes. */
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
  /** The sentinels' votes, in the order posted; `verdict` is set once they decide (the quorum's identical
   *  allow or warn, one block vote, or a disagreement). On an exit quote every sentinel votes, and `quote`,
   *  `tx_hashes` and `evidence_sha256` above are those of the quote that stands: the median of three
   *  allow quotes, the highest of fewer. */
  votes: Vote[];
};
/** One sentinel's vote on a check: its verdict and the sha256 of the evidence it posted. `quote`: on an
 *  exit quote, the ETH out (wei) an allow vote quoted, which counts toward the floor; null otherwise. */
export type Vote = { sentinel: string; verdict: "allow" | "warn" | "block"; evidence_sha256: string; quote?: string | null };
/** The guard's sentinels and how many must post the same allow or warn (view `sentinels`). */
export type Sentinels = { sentinels: string[]; quorum: number };

/** The proof files of the votes the guard holds on check `id`, in the order posted: a sentinel writes
 *  proofs/<id>.json when it is the first the guard names, proofs/<id>.s<n>.json as the n-th
 *  (app/sentinel.ts). A sentinel whose vote the guard did not take (the quorum's allow came first) keeps
 *  no file, so these are the files to replay. */
export async function proofsOf(id: number): Promise<string[]> {
  const [{ sentinels }, check] = await Promise.all([view<Sentinels>("sentinels"), view<Check | null>("get_check", { id })]);
  const ranks = (check?.votes ?? []).map((v) => sentinels.indexOf(v.sentinel)).filter((rank) => rank >= 0);
  return ranks.map((rank) => `proofs/${id}${rank ? `.s${rank + 1}` : ""}.json`);
}
/** A shared blocklist entry (get_entry). */
export type Entry = { reporter: string; at_ns: string; evidence_sha256: string; note: string };
