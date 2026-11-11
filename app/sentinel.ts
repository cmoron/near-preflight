// Role de la sentinelle : lit les demandes de verdict de la garde, simule l'achat sur la chaine EVM,
// poste verdict, raisons et resume de preuve avec sa cle function-call (post_verdict and report).
// It also reads the guard's shared blocklist and the code seen at the target's last verdict, consults
// the template index in INDEX (app/index.ts), reports a template whose reputation blocks, and quotes
// agents' exits (request_exit) by simulating the sale from the guard's EVM address.
// La preuve complete (requete eth_simulateV1, reponse et chaine evidence postee, octet pour octet)
// va dans proofs/<id>.json ; le contrat stocke le sha256 de cette chaine avec le verdict.
import type { Address, Hex } from "viem";
import type { Index } from "./index";
import type { Check, Entry } from "./near";
import type { NearFacts } from "./verifier";

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
  const { account, call, env, reason, view, viewAt } = await import("./near");
  const { checkExit, checkToken, deriveProbes, toProof } = await import("./verifier");
  const { reputationFindings } = await import("./index");
  const { sha256, stringToHex } = await import("viem");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  const { mkdir } = await import("node:fs/promises");

  const sentinel = account(env("SENTINEL"), env("SENTINEL_KEY"));
  const EVM = env("EVM_RPC");
  // The real buyer: the guard's EVM address, public, derived like the relay does. Simulated too.
  const GUARD_EVM = deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH);
  const log = (s: string) => console.log(`    [sentinel] ${s}`);
  await mkdir("proofs", { recursive: true });
  const INDEX = process.env.INDEX;
  const index = INDEX ? ((await Bun.file(INDEX).json()) as Index) : null;
  const pools = index ? Object.values(index.templates).flat().length : 0;
  log(index ? `template index ${INDEX}: chain ${index.chain_id}, blocks ${index.from}..${index.to}, ${pools} WETH pools` : "no template index (INDEX unset): reputation unknown, so every buy verdict is at least warn");

  /** The guard's blocklist entries on the target and its template, and the code of its last verdict. */
  const nearFacts = async (target: Address, template: Hex): Promise<NearFacts> => {
    const [token, code, last] = await Promise.all([
      view<Entry | null>("get_entry", { kind: "token", key: target }),
      view<Entry | null>("get_entry", { kind: "code", key: template }),
      view<{ id: number; code: { code_hash: Hex; implementation: Address | null } } | null>("last_code", { target }),
    ]);
    const listing = (kind: "token" | "code", key: string, e: Entry | null) => (e ? [{ kind, key: key.toLowerCase(), reporter: e.reporter, evidence_sha256: e.evidence_sha256 }] : []);
    return { listed: [...listing("token", target, token), ...listing("code", template, code)], previous: last ? { id: last.id, ...last.code } : null };
  };

  // ponytail: relit toutes les demandes depuis 1 au demarrage ; partir d'un curseur sauvegarde si elles se comptent par milliers.
  let next = 1;
  const failures = new Map<number, number>();
  const MAX_TRIES = 3;

  const judge = async (id: number, check: Check) => {
    const target = check.target as Address;
    if (check.exit_amount) {
      log(`#${id} : ${check.agent} wants to sell ${check.exit_amount} of ${target}: exit quote, sale simulated as the guard's EVM address...`);
      const r = await checkExit(EVM, target, GUARD_EVM, BigInt(check.exit_amount));
      const proof = toProof(id, target, r);
      await Bun.write(`proofs/${id}.json`, JSON.stringify(proof, null, 2));
      const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code: null });
      log(`#${id} : exit quote ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.quote} wei for ${check.exit_amount} tokens, block ${r.evidence.block}, proof proofs/${id}.json  ${tx}`);
      return;
    }
    log(`#${id} : ${check.agent} wants to buy ${target}: read-only simulation, liquidity, template reputation, blocklist...`);
    // Probes derived from on-chain data, not chosen here: replay --check recomputes them.
    const ticket = { guard: env("GUARD"), id, requested_ns: check.requested_ns };
    const r = await checkToken(EVM, target, GUARD_EVM, (head) => deriveProbes(ticket, head.hash), { index, near: nearFacts });
    const proof = toProof(id, target, r);
    await Bun.write(`proofs/${id}.json`, JSON.stringify(proof, null, 2));
    const code = { code_hash: r.evidence.code_hash, implementation: r.evidence.implementation };
    const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code });
    const failed = r.evidence.calls.filter((c) => c.endsWith("revert")).length;
    log(`#${id} : ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.calls.length} simulated calls (${failed} reverted, takeback probes included), quote ${r.evidence.quote} for 0.01 ETH, block ${r.evidence.block}, proof proofs/${id}.json  ${tx}`);
    if (r.verdict === "block") log(`#${id} : ${target} listed on the guard's shared blocklist by this block verdict (evidence sha256 = the proof's)`);
    // A template whose reputation blocks is reported too: a fresh token of it is then blocked by
    // any agent or sentinel reading the list, index or not.
    const rep = r.evidence.reputation;
    if (rep && reputationFindings(rep)[0]?.level === "block" && !r.evidence.near.listed.some((l) => l.kind === "code")) {
      const evidence_sha256 = sha256(stringToHex(proof.evidence)).slice(2);
      const note = `template: ${rep.drained} of ${rep.pools} earlier pools drained (verdict #${id})`;
      try {
        const { tx: t } = await call(sentinel, "report", { kind: "code", key: r.evidence.template, evidence_sha256, note });
        log(`#${id} : template ${r.evidence.template} reported to the shared blocklist (${note})  ${t}`);
      } catch (e) {
        log(`#${id} : reporting template ${r.evidence.template} failed: ${reason(e)}`); // the verdict stands
      }
    }
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
              quote: "0",
              code: null,
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

  log(`listening to ${env("GUARD")}, simulating on ${EVM} as a derived probe buyer and as the guard's EVM address ${GUARD_EVM}`);
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
