// Enveloppe cote agent : aucun achat sans verdict, refus de signer sur block. Signe uniquement avec
// la cle function-call de l'agent, limitee a la garde (request_check, spend, refund_check).
import { formatNearAmount } from "near-api-js";
import { account, call, env, view, type Check } from "./near";

export const agent = account(env("AGENT"), env("AGENT_KEY"));
const log = (s: string) => console.log(`  [enveloppe] ${s}`);
const TIMEOUT_MS = 300_000; // delai du contrat avant remboursement d'une demande sans verdict

export async function requestCheck(target: string): Promise<number> {
  const { value: id, tx } = await call<number>(agent, "request_check", { target });
  log(`demande #${id} : verdict sur ${target}, 0,01 NEAR debite du credit  ${tx}`);
  return id;
}

export async function waitVerdict(id: number): Promise<Check | null> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    const check = await view<Check | null>("get_check", { id }); // null : le noeud lu n'a pas encore le bloc
    if (check?.verdict) return check;
    await Bun.sleep(1500);
  }
  return null;
}

/** Achete `target` pour `amount` yoctoNEAR payes a la boutique permise, seulement sur verdict allow. */
export async function guardedBuy(target: string, amount: bigint): Promise<{ id: number; paid: boolean }> {
  const id = await requestCheck(target);
  const check = await waitVerdict(id);
  if (!check) {
    await Bun.sleep(5_000); // le contrat mesure le delai a l'heure du bloc
    const { tx } = await call(agent, "refund_check", { id });
    log(`#${id} : pas de verdict en 5 min, prix rembourse, achat abandonne  ${tx}`);
    return { id, paid: false };
  }
  if (check.verdict !== "allow") {
    // ponytail: warn s'arrete ici comme block ; l'approbation humaine d'un warn n'est pas construite.
    log(`#${id} : ${check.verdict.toUpperCase()}, JE REFUSE DE SIGNER l'achat (${check.reasons})`);
    return { id, paid: false };
  }
  const { tx } = await call(agent, "spend", { id, recipient: env("SHOP"), amount: amount.toString() });
  log(`#${id} : ALLOW, achat signe, ${formatNearAmount(amount.toString())} NEAR payes a ${env("SHOP")}  ${tx}`);
  return { id, paid: true };
}
