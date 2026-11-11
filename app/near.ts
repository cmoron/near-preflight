// Acces NEAR partage : configuration lue dans .env (bun la charge seul), cles hors depot.
import { Account, JsonRpcProvider } from "near-api-js";
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
