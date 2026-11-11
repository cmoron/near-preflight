// Acces NEAR partage : configuration lue dans .env (bun la charge seul), cles hors depot.
import { Account, getTransactionLastResult, JsonRpcProvider } from "near-api-js";
import { homedir } from "node:os";

export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC });

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} absent de .env : lance d'abord bun app/setup.ts <parent>.testnet`);
  return v;
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
  settled: boolean;
};
