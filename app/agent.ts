// Enveloppe cote agent : aucun achat sans verdict, refus d'acheter sur block. Signe uniquement avec
// la cle function-call de l'agent, limitee a la garde (request_check, buy, refund_check) ; l'agent
// n'a aucune cle EVM : la garde construit la transaction d'achat et NEAR la signe.
import { formatEther, type Address } from "viem";
import { account, call, env, view, type Check } from "./near";

export const agent = account(env("AGENT"), env("AGENT_KEY"));
/** Gaz attache a `buy` : le sien, l'appel `sign` au MPC (15 TGas reserves) et le callback (10). */
export const BUY_GAS = 100_000_000_000_000n;
const log = (s: string) => console.log(`  [wrapper] ${s}`);
const VERDICT_TTL_MS = 120_000; // un verdict allow expire 120 s apres son poste (meme regle que le contrat)
const TIMEOUT_MS = 300_000; // delai du contrat avant remboursement d'une demande sans verdict

export async function requestCheck(target: string): Promise<number> {
  const { value: id, tx } = await call<number>(agent, "request_check", { target });
  log(`request #${id} : verdict on ${target}, 0.01 NEAR taken from credit  ${tx}`);
  return id;
}

export async function waitVerdict(id: number): Promise<Check | null> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      const check = await view<Check | null>("get_check", { id }); // null : le noeud lu n'a pas encore le bloc
      if (check?.verdict) return check;
    } catch (e) {
      log(`#${id} : reading the verdict failed, will retry (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    await Bun.sleep(1500);
  }
  return null;
}

/** Achete `target` pour `wei` sur Base, seulement sur verdict allow : la garde construit la transaction
 *  et la fait signer par NEAR. Renvoie l'id et la transaction signee (null sans achat). */
export async function guardedBuy(target: Address, wei: bigint): Promise<{ id: number; signed: string | null }> {
  const id = await requestCheck(target);
  const check = await waitVerdict(id);
  if (!check) {
    await Bun.sleep(5_000); // le contrat mesure le delai a l'heure du bloc
    const { tx } = await call(agent, "refund_check", { id });
    log(`#${id} : no verdict in 5 min, fee refunded, purchase abandoned  ${tx}`);
    return { id, signed: null };
  }
  if (check.verdict !== "allow") {
    // ponytail: warn s'arrete ici comme block ; l'approbation humaine d'un warn n'est pas construite.
    log(`#${id} : ${String(check.verdict).toUpperCase()}, I REFUSE TO BUY (${check.reasons})`);
    return { id, signed: null };
  }
  const age = Date.now() - Number(BigInt(check.judged_ns) / 1_000_000n);
  if (age > VERDICT_TTL_MS) {
    log(`#${id} : ALLOW expired (${Math.round(age / 1000)} s old, limit ${VERDICT_TTL_MS / 1000} s), I REFUSE TO BUY`);
    return { id, signed: null };
  }
  const started = Date.now();
  const args = { id, amount_wei: wei.toString() };
  const { value: signed, tx, burnt } = await call<string | null>(agent, "buy", args, 0n, BUY_GAS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!signed) {
    log(`#${id} : ALLOW, but the MPC returned no signature in ${secs} s: credit and budget restored  ${tx}`);
    return { id, signed: null };
  }
  log(`#${id} : ALLOW, buy of ${formatEther(wei)} ETH signed by NEAR in ${secs} s (${burnt}): ${signed.slice(0, 18)}...  ${tx}`);
  return { id, signed };
}
