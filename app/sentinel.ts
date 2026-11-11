// Role de la sentinelle : lit les demandes de verdict de la garde, simule l'achat sur la chaine EVM,
// poste verdict, raisons et resume de preuve avec sa cle function-call (post_verdict seulement).
// La preuve complete (requete eth_simulateV1 et reponse) va dans proofs/<id>.json.
import { mkdir } from "node:fs/promises";
import { account, call, env, view, type Check } from "./near";
import { checkToken } from "./verifier";

const sentinel = account(env("SENTINEL"), env("SENTINEL_KEY"));
const EVM = env("EVM_RPC");
const log = (s: string) => console.log(`    [sentinelle] ${s}`);
await mkdir("proofs", { recursive: true });

// ponytail: relit toutes les demandes depuis 1 au demarrage ; partir d'un curseur sauvegarde si elles se comptent par milliers.
let next = 1;
log(`a l'ecoute de ${env("GUARD")}, simulation sur ${EVM}`);
for (;;) {
  const last = await view<number>("last_check_id");
  while (next <= last) {
    const check = await view<Check | null>("get_check", { id: next });
    if (check && !check.verdict) {
      try {
        await judge(next, check);
      } catch (e) {
        log(`#${next} : echec, nouvel essai dans 2 s (${e instanceof Error ? e.message : e})`);
        break; // la demande reste sans verdict ; l'agent est rembourse si cela dure plus de 5 min
      }
    }
    next++;
  }
  await Bun.sleep(1500);
}

async function judge(id: number, check: Check) {
  log(`#${id} : ${check.agent} veut acheter ${check.target}, simulation en lecture seule...`);
  const r = await checkToken(EVM, check.target as `0x${string}`);
  for (const c of r.evidence.calls) log(`#${id}   ${c}`);
  await Bun.write(`proofs/${id}.json`, JSON.stringify({ id, target: check.target, ...r }, null, 2));
  const { tx } = await call(sentinel, "post_verdict", {
    id,
    verdict: r.verdict,
    reasons: r.reasons,
    evidence: JSON.stringify(r.evidence),
  });
  log(`#${id} : ${r.verdict.toUpperCase()} (${r.reasons}), bloc ${r.evidence.block}, preuve proofs/${id}.json  ${tx}`);
}
