// Rejeu d'une preuve : n'importe qui retrouve le verdict a partir de proofs/<id>.json et d'un noeud EVM.
// Usage : bun app/replay.ts <preuve.json> [rpc] [--check]
import { keccak256, sha256, stringToHex } from "viem";
import { judge, rpc, type Result } from "./verifier";

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
// Les libelles des appels sont dans evidence.calls ("libelle: ok|revert").
const labelsOf = (p: Proof) => p.evidence.calls.map((c) => c.replace(/: (ok|revert)$/, ""));

export async function replay(proof: Proof, url: string, opts: { check?: boolean } = {}): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const fail = (text: string, e: unknown) => out.push({ ok: false, line: `ERROR    ${text}: ${msg(e)}` });

  // (a) la requete du fichier est celle dont le hash a ete poste
  const hash = sha256(stringToHex(JSON.stringify(proof.request)));
  add(hash === proof.evidence.request_sha256, `request hash ${hash === proof.evidence.request_sha256 ? "matches evidence" : `${hash} != ${proof.evidence.request_sha256}`}`);

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
    const labels = labelsOf(proof);
    proof.response.forEach((old, i) => {
      const now = fresh[i];
      if (!now) return;
      if (old.status !== now.status) diffs.push(`${labels[i] ?? i}: status ${old.status} -> ${now.status}`);
      if (old.returnData !== now.returnData) diffs.push(`${labels[i] ?? i}: return data differs`);
    });
    add(!diffs.length, diffs.length ? `call results differ: ${diffs.join(" ; ")}` : `status and return data of all ${fresh.length} calls identical`);

    // (d) rejugement a partir de la reponse fraiche
    const j = judge(labelsOf(proof), fresh);
    const same = j.verdict === proof.verdict && j.reasons === proof.reasons;
    add(same, same ? `verdict ${j.verdict} rejudged identically (same reasons)` : `verdict/reasons differ: file "${proof.verdict}: ${proof.reasons}" vs rejudged "${j.verdict}: ${j.reasons}"`);
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
      const { view } = await import("./near"); // charge seulement ici : near.ts pose un fetch global
      const c = await view<{ verdict: string | null; reasons: string } | null>("get_check", { id: proof.id });
      if (!c) out.push({ ok: false, line: `ERROR    no request #${proof.id} on the contract` });
      else if (!c.verdict) out.push({ ok: false, line: `ERROR    request #${proof.id} has no verdict on chain yet` });
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
  const bad = lines.filter((l) => !l.ok).length;
  console.log(bad ? `REPLAY FAILED: ${bad} check(s) not confirmed` : `REPLAY OK: verdict ${proof.verdict} confirmed`);
  process.exit(bad ? 1 : 0);
}
