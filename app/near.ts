// Acces NEAR partage : configuration lue dans .env (bun la charge seul), cles hors depot.
import { Account, getTransactionLastResult, JsonRpcProvider } from "near-api-js";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

// near-api-js appelle fetch sans delai : une reponse qui n'arrive jamais suspendait un role pour
// toujours (vu sur la sentinelle). Tout fetch du processus recoit un delai, sauf signal deja fourni.
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 20_000);
const rawFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  rawFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS) })) as typeof fetch;

export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC });

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (.env or the role's key file): run bun app/setup.ts <parent>.testnet first`);
  return v;
}

/** Ecrit un fichier de cle lisible par son seul proprietaire (0600), meme s'il existait deja :
 *  Bun.write ignore son option `mode` et laissait les cles en 0664. */
export async function writeSecret(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Compte signe par une cle donnee (ex. la cle function-call de l'agent). */
export function account(id: string, key: string): Account {
  return new Account(id, provider, key as `ed25519:${string}`);
}

/** Compte de l'humain, signe par sa cle complete du trousseau near-cli (~/.near-credentials). */
export async function humanAccount(id: string): Promise<Account> {
  const file = `${homedir()}/.near-credentials/testnet/${id}.json`;
  const { private_key } = await Bun.file(file).json();
  return account(id, private_key);
}

export function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return provider.callFunction({ contractId: env("GUARD"), method, args }) as Promise<T>;
}

/** Message d'erreur du contrat (panique) ou du protocole, sans la pile. */
export function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.match(/Smart contract panicked: ([^"\n]+)/)?.[1] ?? msg.split("\n")[0];
}

export const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

/** Appel de la garde signe par `who` ; renvoie la valeur et le lien de la transaction. */
export async function call<T>(who: Account, methodName: string, args: Record<string, unknown>, deposit = 0n) {
  const raw = await who.callFunctionRaw({ contractId: env("GUARD"), methodName, args, deposit });
  return { value: getTransactionLastResult(raw) as T, tx: explorer(raw.transaction.hash) };
}

export type Check = {
  agent: string;
  target: string;
  requested_ns: string;
  verdict: "allow" | "warn" | "block" | null;
  reasons: string;
  /** Heure du verdict, en nanosecondes (chaine). */
  judged_ns: string;
  /** sha256 (hexadecimal) de la chaine evidence postee avec le verdict ; vide sans verdict. */
  evidence_sha256: string;
  settled: boolean;
};
