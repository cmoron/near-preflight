// Rejeu d'une preuve : n'importe qui retrouve le verdict a partir de proofs/<id>.json et d'un noeud EVM.
// Le fichier porte la chaine `evidence` exacte postee en chaine ; tout son contenu est reverifie.
// Usage : bun app/replay.ts <preuve.json> [rpc] [--check]
import { keccak256, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import {
  buildRequest,
  buyStage,
  byLabel,
  implementationAt,
  judge,
  NEXT_S,
  ok as succeeded,
  plan,
  ROUTER,
  rpc,
  WETH,
  type ProofFile,
  type Result,
} from "./verifier";

export type Proof = ProofFile;
type Evidence = {
  chain_id: number;
  block: number;
  method: string;
  request_sha256: string;
  code_hash: string;
  implementation: string | null;
  calls: string[];
};
/** `skipped` : controle non verifiable sur ce noeud, dit comme tel (ni reussi ni echoue). */
export type Line = { ok: boolean; line: string; skipped?: boolean };
/** Demande lue par get_check sur la garde NEAR. */
export type OnChain = {
  target: string;
  verdict: string | null;
  reasons: string;
  evidence_sha256: string;
  requested_ns: string;
  judged_ns: string;
} | null;
type BlockStateCall = { blockOverrides: { time: Hex }; calls: { from: Address }[] };

const EVIDENCE_KEYS = "block,calls,chain_id,code_hash,implementation,method,request_sha256";
/** Ecart tolere entre l'heure du bloc EVM et celles de la demande et du verdict NEAR : horloges de
 *  deux chaines, retard du RPC EVM lu par la sentinelle, intervalle de bloc. */
const CLOCK_SLACK_S = 60;
/** Le noeud suit l'heure reelle si son dernier bloc a moins de 2 min d'ecart avec l'horloge locale. */
const LIVE_S = 120;

const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000", "");
const blockOf = (url: string, tag: string) => rpc<{ number: Hex; timestamp: Hex }>(url, "eth_getBlockByNumber", [tag, false]);

/** Contenu de la chaine evidence : exactement les champs que la sentinelle poste, bien types. */
function parseEvidence(p: Proof): Evidence | string {
  if (typeof p.evidence !== "string") return "evidence is not the string posted on chain (old proof format?)";
  let e: unknown;
  try {
    e = JSON.parse(p.evidence);
  } catch (err) {
    return `evidence is not JSON (${msg(err)})`;
  }
  if (!isObj(e) || Object.keys(e).sort().join() !== EVIDENCE_KEYS) return `evidence keys are not exactly ${EVIDENCE_KEYS}`;
  const typed =
    Number.isSafeInteger(e.chain_id) &&
    Number.isSafeInteger(e.block) &&
    (e.block as number) >= 0 &&
    e.method === "eth_simulateV1" &&
    typeof e.request_sha256 === "string" &&
    typeof e.code_hash === "string" &&
    (e.implementation === null || typeof e.implementation === "string") &&
    Array.isArray(e.calls) &&
    e.calls.every((c) => typeof c === "string");
  return typed ? (e as unknown as Evidence) : "evidence fields have unexpected types";
}

/** Forme minimale de la requete, verifiee AVANT tout envoi : seule eth_simulateV1 (lecture seule) au
 *  bloc de la preuve part vers le noeud. Renvoie le defaut trouve, ou null. */
function shapeError(p: Proof, e: Evidence): string | null {
  const r = p.request as unknown;
  if (!isObj(r) || r.method !== "eth_simulateV1") return "method is not eth_simulateV1";
  if (!Array.isArray(r.params) || r.params.length !== 2) return "params is not [request, block]";
  const [req, blk] = r.params;
  if (!isObj(req) || !Array.isArray(req.blockStateCalls) || !isObj(req.blockStateCalls[0])) return "params[0] has no blockStateCalls";
  if (blk !== toHex(e.block)) return `params[1] ${String(blk)} is not evidence.block ${toHex(e.block)}`;
  if (typeof p.target !== "string" || !Array.isArray(p.response)) return "malformed proof file";
  return null;
}

type Rebuilt = { labels: string[]; buyer: Address; stranger: Address | null; owner: Address | null };

/** Reconstruit la requete que checkToken aurait produite pour proof.target (memes appels, memes
 *  adresses, routeur, WETH, blocs aux memes ecarts de temps) et en tire les libelles : ceux du fichier
 *  ne comptent pas. Seuls l'acheteur, l'inconnu et l'heure viennent de la requete ; quantite et
 *  proprietaire viennent de la reponse fraiche. Aucun repli : une sonde absente est un defaut. */
function rebuild(p: Proof, e: Evidence, fresh: Result[]): Rebuilt | { error: string } {
  try {
    const bs = (p.request.params[0] as { blockStateCalls: BlockStateCall[] }).blockStateCalls;
    const now = BigInt(bs[0].blockOverrides.time);
    const buyer = bs[0].calls[0]?.from;
    if (!buyer) return { error: "request has no buyer" };
    const token = p.target as Address;
    const buyOnly = plan(token, buyer, now);
    const buyLabels = buyOnly[0].calls.map((c) => c.label);
    const st = buyStage(byLabel(buyLabels, fresh.slice(0, buyLabels.length)));
    let blocks = buyOnly;
    let stranger: Address | null = null;
    if (!st.findings.length) {
      // l'inconnu suit l'achat et la sonde du proprietaire, comme dans plan()
      stranger = bs[0].calls[buyLabels.length + (st.owner ? 1 : 0)]?.from ?? null;
      if (!stranger) return { error: "request has no stranger probe where checkToken puts one" };
      blocks = plan(token, buyer, now, { stranger, amount: st.amount, owner: st.owner });
    }
    const want = JSON.stringify(buildRequest(BigInt(e.block), buyer, blocks));
    if (want !== JSON.stringify(p.request)) return { error: "request is not the one checkToken builds for this target" };
    const labels = blocks.flatMap((b) => b.calls.map((c) => c.label));
    if (labels.length !== fresh.length) return { error: `expected ${labels.length} calls, node returned ${fresh.length}` };
    return { labels, buyer, stranger, owner: st.owner };
  } catch (err) {
    return { error: `request cannot be parsed (${msg(err)})` };
  }
}

/** Les sondes doivent etre des adresses neuves : ni routeur, ni WETH, ni cible, ni owner(), sans code
 *  au bloc, et distinctes. Sinon un jeton qui exempte une adresse privilegiee passerait pour sain. */
async function probeProblems(url: string, e: Evidence, target: Address, r: Rebuilt): Promise<string[]> {
  const known: [string, Address | null][] = [
    ["router", ROUTER],
    ["WETH", WETH],
    ["target", target],
    ["owner()", r.owner],
  ];
  const probes: [string, Address][] = [["buyer", r.buyer]];
  if (r.stranger) probes.push(["stranger", r.stranger]);
  const out: string[] = [];
  for (const [role, a] of probes) {
    for (const [name, k] of known) if (k && a.toLowerCase() === k.toLowerCase()) out.push(`${role} ${a} is the ${name}`);
    const code = await rpc<Hex>(url, "eth_getCode", [a, toHex(e.block)]);
    if (code !== "0x") out.push(`${role} ${a} has code at block ${e.block}`);
  }
  if (r.stranger && r.buyer.toLowerCase() === r.stranger.toLowerCase()) out.push(`buyer and stranger are the same address ${r.buyer}`);
  return out;
}

const readCheck = async (id: number) => (await import("./near")).view<OnChain>("get_check", { id }); // near.ts pose un fetch global : charge ici seulement

export async function replay(
  proof: Proof,
  url: string,
  opts: { check?: boolean; chain?: (id: number) => Promise<OnChain>; clock?: () => number } = {},
): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const fail = (text: string, e: unknown) => out.push({ ok: false, line: `ERROR    ${text}: ${msg(e)}` });

  const e = parseEvidence(proof);
  if (typeof e === "string") {
    out.push({ ok: false, line: `MISMATCH ${e} (nothing sent to the node)` });
    return out;
  }

  // (a) la requete du fichier est celle dont le hash est dans evidence
  const hash = sha256(stringToHex(JSON.stringify(proof.request)));
  add(hash === e.request_sha256, `request hash ${hash === e.request_sha256 ? "matches evidence" : `${hash} != ${e.request_sha256}`}`);

  const bad = shapeError(proof, e);
  if (bad) {
    add(false, `request shape: ${bad} (nothing sent to the node)`);
    return out;
  }

  // (b) meme chaine ; heure du premier bloc simule = heure du bloc de la preuve + 2 s
  try {
    const id = Number(await rpc<Hex>(url, "eth_chainId", []));
    add(id === e.chain_id, id === e.chain_id ? `chain id ${id} matches evidence` : `node chain id ${id} != evidence chain id ${e.chain_id}`);
  } catch (err) {
    fail("reading the chain id", err);
  }
  let blockTs: number | null = null;
  try {
    blockTs = Number(BigInt((await blockOf(url, toHex(e.block))).timestamp));
    const first = BigInt((proof.request.params[0] as { blockStateCalls: BlockStateCall[] }).blockStateCalls[0].blockOverrides.time);
    const want = BigInt(blockTs) + NEXT_S;
    add(
      first === want,
      first === want
        ? `first simulated block time = block ${e.block} time + ${NEXT_S} s (${iso(Number(want))})`
        : `first simulated block time ${first} is not block ${e.block} time ${blockTs} + ${NEXT_S} s`,
    );
  } catch (err) {
    fail(`reading block ${e.block} or the first simulated block time`, err);
  }

  // (c) meme requete, meme bloc ; memes statuts et memes donnees de retour
  let fresh: Result[] | null = null;
  try {
    const blocks = await rpc<{ calls: Result[] }[]>(url, proof.request.method, proof.request.params);
    fresh = blocks.flatMap((b) => b.calls);
    add(true, `request resent to ${url} at block ${e.block} (${fresh.length} calls)`);
  } catch (err) {
    fail("resending the request", err);
  }
  if (fresh) {
    const diffs: string[] = [];
    if (fresh.length !== proof.response.length) diffs.push(`call count ${proof.response.length} -> ${fresh.length}`);
    const labels = e.calls.map((c) => c.replace(/: (ok|revert)$/, "")); // pour nommer les ecarts seulement
    proof.response.forEach((old, i) => {
      const now = fresh[i];
      if (!now) return;
      if (old.status !== now.status) diffs.push(`${labels[i] ?? i}: status ${old.status} -> ${now.status}`);
      if (old.returnData !== now.returnData) diffs.push(`${labels[i] ?? i}: return data differs`);
    });
    add(!diffs.length, diffs.length ? `call results differ: ${diffs.join(" ; ")}` : `status and return data of all ${fresh.length} calls identical`);

    // (d) requete reconstruite, sondes neuves, libelles, puis rejugement a partir de la reponse fraiche
    const r = rebuild(proof, e, fresh);
    if ("error" in r) add(false, `request shape: ${r.error}`);
    else {
      try {
        const problems = await probeProblems(url, e, proof.target as Address, r);
        add(!problems.length, problems.length ? `probe addresses: ${problems.join(" ; ")}` : "probe addresses are fresh (no code, not router/WETH/target/owner(), distinct)");
      } catch (err) {
        fail("checking the probe addresses", err);
      }
      const want = fresh.map((res, i) => `${r.labels[i]}: ${succeeded(res) ? "ok" : "revert"}`);
      const same = JSON.stringify(want) === JSON.stringify(e.calls);
      add(same, same ? "call labels rebuilt from the request match evidence.calls" : "call labels in evidence.calls differ from those rebuilt from the request");
      const j = judge(r.labels, fresh);
      const ok = j.verdict === proof.verdict && j.reasons === proof.reasons;
      add(ok, ok ? `verdict ${j.verdict} rejudged identically (same reasons)` : `verdict/reasons differ: file "${proof.verdict}: ${proof.reasons}" vs rejudged "${j.verdict}: ${j.reasons}"`);
    }
  }

  // (e) code de la cible et implementation du proxy au bloc
  try {
    const h = keccak256(await rpc<Hex>(url, "eth_getCode", [proof.target, toHex(e.block)]));
    add(h === e.code_hash, h === e.code_hash ? "target code hash matches evidence" : `target code hash ${h} != ${e.code_hash}`);
    const impl = await implementationAt(url, proof.target as Address, BigInt(e.block));
    const same = impl?.toLowerCase() === e.implementation?.toLowerCase();
    add(same, same ? `proxy implementation (${impl ?? "none"}) matches evidence` : `proxy implementation ${impl ?? "none"} != evidence ${e.implementation ?? "none"}`);
  } catch (err) {
    fail("reading target code", err);
  }

  // (f) verdict poste sur le contrat NEAR, lie a cette chaine evidence par son sha256
  if (opts.check) {
    try {
      const c = await (opts.chain ?? readCheck)(proof.id);
      if (!c) out.push({ ok: false, line: `ERROR    no request #${proof.id} on the contract` });
      else if (!c.verdict) out.push({ ok: false, line: `ERROR    request #${proof.id} has no verdict on chain yet` });
      else {
        const h = sha256(stringToHex(proof.evidence)).slice(2);
        add(
          h === c.evidence_sha256,
          h === c.evidence_sha256
            ? `on-chain evidence_sha256 ${h} is the sha256 of the evidence replayed above`
            : `on-chain evidence_sha256 ${c.evidence_sha256} != sha256 of the file's evidence ${h}`,
        );
        if (c.target.toLowerCase() !== proof.target.toLowerCase()) add(false, `on-chain target ${c.target} is not the proof target ${proof.target}`);
        else {
          const same = c.verdict === proof.verdict && c.reasons === proof.reasons;
          add(same, same ? `on-chain verdict ${c.verdict} for #${proof.id} matches (same target, same reasons)` : `on-chain "${c.verdict}: ${c.reasons}" != file "${proof.verdict}: ${proof.reasons}"`);
        }
        if (blockTs !== null) out.push(await timing(url, blockTs, c, opts.clock ?? (() => Date.now() / 1000)));
      }
    } catch (err) {
      fail("reading the NEAR contract", err);
    }
  }
  return out;
}

/** L'heure du bloc EVM de la preuve doit tomber entre la demande et le verdict NEAR. Verifiable
 *  seulement si le noeud suit l'heure reelle : une copie locale (anvil) garde l'heure du bloc copie. */
async function timing(url: string, blockTs: number, c: NonNullable<OnChain>, clock: () => number): Promise<Line> {
  const head = Number(BigInt((await blockOf(url, "latest")).timestamp));
  const lag = Math.round(clock() - head);
  if (Math.abs(lag) > LIVE_S) {
    const h = (Math.abs(lag) / 3600).toFixed(1);
    return {
      ok: true,
      skipped: true,
      line: `SKIPPED  EVM block time vs NEAR request/verdict time: not verifiable on this node, its latest block is ${h} h ${lag > 0 ? "behind" : "ahead of"} the local clock (a local fork keeps the forked block's time)`,
    };
  }
  const [req, jud] = [c.requested_ns, c.judged_ns].map((ns) => Number(BigInt(ns) / 1_000_000_000n));
  const inside = req - CLOCK_SLACK_S <= blockTs && blockTs <= jud + CLOCK_SLACK_S;
  const text = `EVM block time ${iso(blockTs)} ${inside ? "lies" : "is NOT"} between the NEAR request ${iso(req)} and verdict ${iso(jud)} (+/- ${CLOCK_SLACK_S} s)`;
  return { ok: inside, line: `${inside ? "OK      " : "MISMATCH"} ${text}` };
}

export function summary(lines: Line[], checked: boolean, verdict: string): string {
  const bad = lines.filter((l) => !l.ok).length;
  if (bad) return `REPLAY FAILED: ${bad} check(s) not confirmed`;
  const skipped = lines.filter((l) => l.skipped).length;
  const note = skipped ? ` (${skipped} check(s) not verified on this node, see SKIPPED)` : "";
  return checked
    ? `REPLAY OK: verdict ${verdict} confirmed, same as on chain${note}`
    : `REPLAY OK (not checked against any on-chain verdict; use --check): verdict ${verdict}${note}`;
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
