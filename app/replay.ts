// Rejeu d'une preuve : n'importe qui retrouve le verdict a partir de proofs/<id>.json et d'un noeud EVM.
// Usage : bun app/replay.ts <preuve.json> [rpc] [--check]
import { keccak256, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { buildRequest, buyStage, byLabel, judge, ok as succeeded, plan, rpc, type Result } from "./verifier";

type Proof = {
  id: number;
  verdict: string;
  reasons: string;
  evidence: { block: number; request_sha256: string; code_hash: string; calls: string[] };
  request: { method: string; params: unknown[] };
  response: Result[];
  target: string;
};
export type Line = { ok: boolean; line: string };

const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Forme minimale de la requete, verifiee AVANT tout envoi : seule eth_simulateV1 (lecture seule) au
 *  bloc de la preuve part vers le noeud. Renvoie le defaut trouve, ou null. */
function shapeError(p: Proof): string | null {
  const r = p.request;
  if (!isObj(r) || r.method !== "eth_simulateV1") return "method is not eth_simulateV1";
  const [req, blk] = Array.isArray(r.params) ? r.params : [];
  if (!Array.isArray(r.params) || r.params.length !== 2) return "params is not [request, block]";
  if (!isObj(req) || !Array.isArray(req.blockStateCalls)) return "params[0] has no blockStateCalls";
  if (blk !== toHex(p.evidence.block)) return `params[1] ${String(blk)} is not evidence.block ${toHex(p.evidence.block)}`;
  if (typeof p.target !== "string" || !Array.isArray(p.response) || !Array.isArray(p.evidence.calls)) return "malformed proof file";
  return null;
}

/** Reconstruit la requete que checkToken aurait produite pour proof.target (memes appels, memes
 *  adresses, routeur, WETH, blocs aux memes ecarts de temps) et en tire les libelles : ceux du fichier
 *  ne comptent pas. Seuls l'acheteur, l'etranger et l'heure viennent de la requete ; quantite et
 *  proprietaire viennent de la reponse fraiche. Renvoie les libelles, ou le defaut trouve. */
function expectedLabels(p: Proof, fresh: Result[]): { labels: string[] } | { error: string } {
  try {
    const bs = (p.request.params[0] as { blockStateCalls: { blockOverrides: { time: Hex }; calls: { from: Address }[] }[] }).blockStateCalls;
    const [now, buyer] = [BigInt(bs[0].blockOverrides.time), bs[0].calls[0].from];
    const token = p.target as Address;
    const buyLabels = plan(token, buyer, buyer, now)[0].calls.map((c) => c.label);
    const st = buyStage(byLabel(buyLabels, fresh.slice(0, buyLabels.length)));
    const stranger = bs[0].calls[st.owner ? 6 : 5]?.from ?? buyer;
    const blocks = st.findings.length ? plan(token, buyer, buyer, now) : plan(token, buyer, stranger, now, st);
    const want = JSON.stringify(buildRequest(BigInt(p.evidence.block), buyer, blocks));
    if (want !== JSON.stringify(p.request)) return { error: "request is not the one checkToken builds for this target" };
    const labels = blocks.flatMap((b) => b.calls.map((c) => c.label));
    return labels.length === fresh.length ? { labels } : { error: `expected ${labels.length} calls, node returned ${fresh.length}` };
  } catch (e) {
    return { error: `request cannot be parsed (${msg(e)})` };
  }
}

type OnChain = { target: string; verdict: string | null; reasons: string } | null;

export async function replay(proof: Proof, url: string, opts: { check?: boolean; chain?: (id: number) => Promise<OnChain> } = {}): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const fail = (text: string, e: unknown) => out.push({ ok: false, line: `ERROR    ${text}: ${msg(e)}` });

  // (a) la requete du fichier est celle dont le hash a ete poste
  const hash = sha256(stringToHex(JSON.stringify(proof.request)));
  add(hash === proof.evidence.request_sha256, `request hash ${hash === proof.evidence.request_sha256 ? "matches evidence" : `${hash} != ${proof.evidence.request_sha256}`}`);

  const bad = shapeError(proof);
  if (bad) {
    add(false, `request shape: ${bad} (nothing sent to the node)`);
    return out;
  }

  // (b) meme requete, meme bloc ; (c) memes statuts et memes donnees de retour
  let fresh: Result[] | null = null;
  try {
    const blocks = await rpc<{ calls: Result[] }[]>(url, proof.request.method, proof.request.params);
    fresh = blocks.flatMap((b) => b.calls);
    add(true, `request resent to ${url} at block ${proof.evidence.block} (${fresh.length} calls)`);
  } catch (e) {
    fail("resending the request", e);
  }
  if (fresh) {
    const diffs: string[] = [];
    if (fresh.length !== proof.response.length) diffs.push(`call count ${proof.response.length} -> ${fresh.length}`);
    const labels = proof.evidence.calls.map((c) => c.replace(/: (ok|revert)$/, "")); // pour nommer les ecarts seulement
    proof.response.forEach((old, i) => {
      const now = fresh[i];
      if (!now) return;
      if (old.status !== now.status) diffs.push(`${labels[i] ?? i}: status ${old.status} -> ${now.status}`);
      if (old.returnData !== now.returnData) diffs.push(`${labels[i] ?? i}: return data differs`);
    });
    add(!diffs.length, diffs.length ? `call results differ: ${diffs.join(" ; ")}` : `status and return data of all ${fresh.length} calls identical`);

    // (d) libelles reconstruits depuis la requete, puis rejugement a partir de la reponse fraiche
    const exp = expectedLabels(proof, fresh);
    if ("error" in exp) add(false, `request shape: ${exp.error}`);
    else {
      const want = fresh.map((r, i) => `${exp.labels[i]}: ${succeeded(r) ? "ok" : "revert"}`);
      const same = JSON.stringify(want) === JSON.stringify(proof.evidence.calls);
      add(same, same ? "call labels rebuilt from the request match evidence.calls" : "call labels in evidence.calls differ from those rebuilt from the request");
      const j = judge(exp.labels, fresh);
      const ok = j.verdict === proof.verdict && j.reasons === proof.reasons;
      add(ok, ok ? `verdict ${j.verdict} rejudged identically (same reasons)` : `verdict/reasons differ: file "${proof.verdict}: ${proof.reasons}" vs rejudged "${j.verdict}: ${j.reasons}"`);
    }
  }

  // (e) code de la cible au bloc
  try {
    const code = await rpc<`0x${string}`>(url, "eth_getCode", [proof.target, `0x${proof.evidence.block.toString(16)}`]);
    const h = keccak256(code);
    add(h === proof.evidence.code_hash, h === proof.evidence.code_hash ? "target code hash matches evidence" : `target code hash ${h} != ${proof.evidence.code_hash}`);
  } catch (e) {
    fail("reading target code", e);
  }

  // (f) verdict poste sur le contrat NEAR
  if (opts.check) {
    try {
      // near.ts n'est charge qu'ici : il pose un fetch global
      const c = await (opts.chain ?? (async (id) => (await import("./near")).view<OnChain>("get_check", { id })))(proof.id);
      if (!c) out.push({ ok: false, line: `ERROR    no request #${proof.id} on the contract` });
      else if (!c.verdict) out.push({ ok: false, line: `ERROR    request #${proof.id} has no verdict on chain yet` });
      else if (c.target.toLowerCase() !== proof.target.toLowerCase()) add(false, `on-chain target ${c.target} is not the proof target ${proof.target}`);
      else {
        const same = c.verdict === proof.verdict && c.reasons === proof.reasons;
        add(same, same ? `on-chain verdict ${c.verdict} for #${proof.id} matches (same reasons)` : `on-chain "${c.verdict}: ${c.reasons}" != file "${proof.verdict}: ${proof.reasons}"`);
      }
    } catch (e) {
      fail("reading the NEAR contract", e);
    }
  }
  return out;
}

export function summary(lines: Line[], checked: boolean, verdict: string): string {
  const bad = lines.filter((l) => !l.ok).length;
  if (bad) return `REPLAY FAILED: ${bad} check(s) not confirmed`;
  return checked ? `REPLAY OK: verdict ${verdict} confirmed, same as on chain` : `REPLAY OK (not checked against any on-chain verdict; use --check): verdict ${verdict}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const [file, url = process.env.EVM_RPC ?? "http://127.0.0.1:8545"] = args.filter((a) => a !== "--check");
  if (!file) {
    console.error("usage: bun app/replay.ts <proof.json> [rpc] [--check]");
    process.exit(2);
  }
  const proof = (await Bun.file(file).json()) as Proof;
  const lines = await replay(proof, url, { check });
  for (const l of lines) console.log(l.line);
  console.log(summary(lines, check, proof.verdict));
  process.exit(lines.every((l) => l.ok) ? 0 : 1);
}
