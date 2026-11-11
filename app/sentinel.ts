// Role de la sentinelle : lit les demandes de verdict de la garde, simule l'achat sur la chaine EVM,
// poste verdict, raisons et resume de preuve avec sa cle function-call (post_verdict seulement).
// La preuve complete (requete eth_simulateV1, reponse et chaine evidence postee, octet pour octet)
// va dans proofs/<id>.json ; le contrat stocke le sha256 de cette chaine avec le verdict.
import type { Check } from "./near";

/** Que faire de la demande lue a la hauteur de bloc `readAt`, son id etant <= last_check_id lu a la
 *  hauteur `lastAt`. Absente a une hauteur >= lastAt : elle existait a lastAt et n'existe plus, donc
 *  effacee par refund_check (les ids ne reviennent jamais), on la saute. Absente a une hauteur
 *  inferieure : le noeud lu est en retard, on la relit au tour suivant sans avancer. */
export function step(check: Check | null, readAt: number, lastAt: number): "judge" | "skip" | "retry" {
  if (check) return check.verdict ? "skip" : "judge";
  return readAt >= lastAt ? "skip" : "retry";
}

if (import.meta.main) {
  // near.ts pose un fetch global et lit NEAR_RPC a l'import : charge ici seulement, pas par les tests.
  const { account, call, env, viewAt } = await import("./near");
  const { checkToken, toProof } = await import("./verifier");
  const { mkdir } = await import("node:fs/promises");

  const sentinel = account(env("SENTINEL"), env("SENTINEL_KEY"));
  const EVM = env("EVM_RPC");
  const log = (s: string) => console.log(`    [sentinel] ${s}`);
  await mkdir("proofs", { recursive: true });

  // ponytail: relit toutes les demandes depuis 1 au demarrage ; partir d'un curseur sauvegarde si elles se comptent par milliers.
  let next = 1;
  const failures = new Map<number, number>();
  const MAX_TRIES = 3;

  const judge = async (id: number, check: Check) => {
    log(`#${id} : ${check.agent} wants to buy ${check.target}, read-only simulation...`);
    const r = await checkToken(EVM, check.target as `0x${string}`);
    for (const c of r.evidence.calls) log(`#${id}   ${c}`);
    const proof = toProof(id, check.target, r);
    await Bun.write(`proofs/${id}.json`, JSON.stringify(proof, null, 2));
    const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence });
    log(`#${id} : ${r.verdict.toUpperCase()} (${r.reasons}), block ${r.evidence.block}, proof proofs/${id}.json  ${tx}`);
  };

  const scan = async () => {
    const { value: last, height: lastAt } = await viewAt<number>("last_check_id");
    while (next <= last) {
      const { value: check, height } = await viewAt<Check | null>("get_check", { id: next });
      const what = step(check, height, lastAt);
      if (what === "retry") {
        log(`#${next} : not found on a node behind the guard (block ${height} < ${lastAt}), will reread`);
        break;
      }
      if (check && what === "judge") {
        try {
          await judge(next, check);
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          const tries = (failures.get(next) ?? 0) + 1;
          failures.set(next, tries);
          if (tries < MAX_TRIES) {
            log(`#${next} : failure ${tries}/${MAX_TRIES}, will retry (${msg})`);
            break;
          }
          // Echec ferme : un jeton qui fait echouer la simulation ne bloque pas les demandes suivantes,
          // et ne s'achete pas.
          // Si ce post echoue aussi (RPC NEAR, verdict deja arrive), le tour suivant relit la demande :
          // un verdict deja en chaine est saute, sinon on reposte.
          try {
            const { tx } = await call(sentinel, "post_verdict", {
              id: next,
              verdict: "block",
              reasons: `simulation impossible after ${MAX_TRIES} tries : ${msg}`.slice(0, 280),
              evidence: JSON.stringify({ error: msg.slice(0, 1000) }),
            });
            log(`#${next} : BLOCK, simulation impossible (${msg})  ${tx}`);
          } catch (e2) {
            log(`#${next} : fallback verdict not posted, will retry (${e2 instanceof Error ? e2.message.split("\n")[0] : e2})`);
            break;
          }
        }
      } else if (!check) log(`#${next} : refunded without a verdict, skipped`);
      next++;
    }
  };

  log(`listening to ${env("GUARD")}, simulating on ${EVM}`);
  for (;;) {
    try {
      await scan();
    } catch (e) {
      // RPC NEAR indisponible ou trop lent : rien n'est perdu, le tour suivant relit depuis `next`.
      log(`reading the guard failed, will retry (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    await Bun.sleep(1500);
  }
}
