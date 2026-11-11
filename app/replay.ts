// Rejeu d'une preuve : n'importe qui retrouve le verdict a partir de proofs/<id>.json et d'un noeud EVM.
// Le fichier porte la chaine `evidence` exacte postee en chaine ; tout son contenu est reverifie.
// Usage : bun app/replay.ts <preuve.json> [rpc] [--check]
import { keccak256, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { beforeBlock, buildIndex, indexSha256, reputationOf, templateOf, type Reputation } from "./index";
import {
  balances,
  buildRequest,
  buyStages,
  byLabel,
  deriveProbes,
  exitPlan,
  FUND,
  GUARD,
  implementationAt,
  judge,
  judgeExit,
  liquidityFacts,
  NEXT_S,
  ok as succeeded,
  plan,
  quoteOf,
  ROUTER,
  rpc,
  WETH,
  type Header,
  type Liquidity,
  type NearFacts,
  type ProofFile,
  type Result,
} from "./verifier";

export type Proof = ProofFile;
type Evidence = {
  chain_id: number;
  block: number;
  method: string;
  request_sha256: string;
  gas_limit: number;
  code_hash: string;
  implementation: string | null;
  calls: string[];
  quote: string;
  liquidity: Liquidity;
  template: string;
  reputation: Reputation | null;
  near: NearFacts;
};
type ExitEvidence = { kind: "exit"; chain_id: number; block: number; method: string; request_sha256: string; gas_limit: number; amount: string; calls: string[]; quote: string };
/** `skipped` : controle non verifiable sur ce noeud, dit comme tel (ni reussi ni echoue). */
export type Line = { ok: boolean; line: string; skipped?: boolean };
/** Demande lue par get_check sur la garde NEAR. */
export type OnChain = {
  target: string;
  verdict: string | null;
  reasons: string;
  evidence_sha256: string;
  quote: string;
  requested_ns: string;
  judged_ns: string;
  code: { code_hash: string; implementation: string | null } | null;
  exit_amount: string | null;
  /** Gas limit the verdict was simulated with: the guard signs a buy or an exit on it only if its own is the same. */
  gas_limit: number;
} | null;
/** A blocklist entry as get_entry returns it, null if not listed. */
export type OnChainEntry = { reporter: string; evidence_sha256: string } | null;
type BlockStateCall = { blockOverrides: { time: Hex }; calls: { from: Address }[] };

const EVIDENCE_KEYS = "block,calls,chain_id,code_hash,gas_limit,implementation,liquidity,method,near,quote,reputation,request_sha256,template";
const EXIT_KEYS = "amount,block,calls,chain_id,gas_limit,kind,method,quote,request_sha256";
const REPUTATION_KEYS = "before_block,drained,from,index_sha256,median_drain_blocks,pools,template,to";
/** Ecart tolere entre l'heure du bloc EVM et celles de la demande et du verdict NEAR : horloges de
 *  deux chaines, retard du RPC EVM lu par la sentinelle, intervalle de bloc. */
const CLOCK_SLACK_S = 60;
/** Le noeud suit l'heure reelle si son dernier bloc a moins de 2 min d'ecart avec l'horloge locale. */
const LIVE_S = 120;

const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000", "");
const blockOf = (url: string, tag: string) => rpc<Header>(url, "eth_getBlockByNumber", [tag, false]);

/** Contenu de la chaine evidence : exactement les champs que la sentinelle poste, bien types. */
function parseEvidence(p: Proof): Evidence | ExitEvidence | string {
  if (typeof p.evidence !== "string") return "evidence is not the string posted on chain (old proof format?)";
  let e: unknown;
  try {
    e = JSON.parse(p.evidence);
  } catch (err) {
    return `evidence is not JSON (${msg(err)})`;
  }
  if (isObj(e) && e.kind === "exit") {
    if (Object.keys(e).sort().join() !== EXIT_KEYS) return `exit evidence keys are not exactly ${EXIT_KEYS}`;
    const typed = Number.isSafeInteger(e.chain_id) && Number.isSafeInteger(e.block) && e.method === "eth_simulateV1" && typeof e.request_sha256 === "string" && Number.isSafeInteger(e.gas_limit) &&
      typeof e.amount === "string" && /^\d+$/.test(e.amount) && Array.isArray(e.calls) && typeof e.quote === "string" && /^\d+$/.test(e.quote);
    return typed ? (e as unknown as ExitEvidence) : "exit evidence fields have unexpected types";
  }
  if (!isObj(e) || Object.keys(e).sort().join() !== EVIDENCE_KEYS) return `evidence keys are not exactly ${EVIDENCE_KEYS}`;
  const typed =
    Number.isSafeInteger(e.chain_id) &&
    Number.isSafeInteger(e.block) &&
    (e.block as number) >= 0 &&
    e.method === "eth_simulateV1" &&
    typeof e.request_sha256 === "string" &&
    Number.isSafeInteger(e.gas_limit) &&
    typeof e.code_hash === "string" &&
    (e.implementation === null || typeof e.implementation === "string") &&
    Array.isArray(e.calls) &&
    e.calls.every((c) => typeof c === "string") &&
    typeof e.quote === "string" &&
    /^\d+$/.test(e.quote) &&
    (e.liquidity === null || isObj(e.liquidity)) &&
    typeof e.template === "string" &&
    (e.reputation === null ||
      (isObj(e.reputation) && Object.keys(e.reputation).sort().join() === REPUTATION_KEYS && [e.reputation.from, e.reputation.to, e.reputation.before_block].every(Number.isSafeInteger))) &&
    isObj(e.near) &&
    Array.isArray(e.near.listed) &&
    (e.near.previous === null || isObj(e.near.previous));
  return typed ? (e as unknown as Evidence) : "evidence fields have unexpected types";
}

/** Forme minimale de la requete, verifiee AVANT tout envoi : seule eth_simulateV1 (lecture seule) au
 *  bloc de la preuve part vers le noeud. Renvoie le defaut trouve, ou null. */
function shapeError(p: Proof, e: { block: number }): string | null {
  const r = p.request as unknown;
  if (!isObj(r) || r.method !== "eth_simulateV1") return "method is not eth_simulateV1";
  if (!Array.isArray(r.params) || r.params.length !== 2) return "params is not [request, block]";
  const [req, blk] = r.params;
  if (!isObj(req) || !Array.isArray(req.blockStateCalls) || !isObj(req.blockStateCalls[0])) return "params[0] has no blockStateCalls";
  if (blk !== toHex(e.block)) return `params[1] ${String(blk)} is not evidence.block ${toHex(e.block)}`;
  if (typeof p.target !== "string" || !Array.isArray(p.response)) return "malformed proof file";
  return null;
}

type Rebuilt = { labels: string[]; buyer: Address; guard: Address; stranger: Address | null; owner: Address | null };
const NOBODY: Address = "0x0000000000000000000000000000000000000000";

/** Reconstruit la requete que checkToken aurait produite pour proof.target (memes appels, memes
 *  adresses, routeur, WETH, blocs aux memes ecarts de temps) et en tire les libelles : ceux du fichier
 *  ne comptent pas. Seuls l'acheteur, l'adresse de la garde, l'inconnu et l'heure viennent de la
 *  requete (at the positions plan() gives them); quantites et proprietaire viennent de la reponse
 *  fraiche ; prix du gaz, prevrandao, coinbase et solde reel de owner() viennent du noeud, au bloc de
 *  la preuve. Aucun repli : une sonde absente est un defaut. */
async function rebuild(url: string, p: Proof, e: Evidence, fresh: Result[]): Promise<Rebuilt | { error: string }> {
  try {
    const bs = (p.request.params[0] as { blockStateCalls: BlockStateCall[] }).blockStateCalls;
    const now = BigInt(bs[0].blockOverrides.time);
    const token = p.target as Address;
    const block = BigInt(e.block);
    /** Sender of the first-block call that plan() labels `label`, in the request. */
    const from = (blocks: { calls: { label: string }[] }[], label: string) => bs[0].calls[blocks[0].calls.findIndex((c) => c.label === label)]?.from;
    const buyer = from(plan(token, NOBODY, NOBODY, block, now), "tokens before buy");
    const guard = from(plan(token, NOBODY, NOBODY, block, now), `${GUARD}tokens before buy`);
    if (!buyer || !guard) return { error: "request has no buyer or no guard side" };
    const head = await blockOf(url, toHex(e.block));
    const buyOnly = plan(token, buyer, guard, block, now);
    const buyLabels = buyOnly[0].calls.map((c) => c.label);
    const st = buyStages(byLabel(buyLabels, fresh.slice(0, buyLabels.length)));
    let blocks = buyOnly;
    let stranger: Address | null = null;
    if (!st.stop) {
      const full = { amounts: st.amounts, owner: st.owner };
      stranger = from(plan(token, buyer, guard, block, now, { ...full, stranger: NOBODY }), "transferFrom by a stranger") ?? null;
      if (!stranger) return { error: "request has no stranger probe where checkToken puts one" };
      blocks = plan(token, buyer, guard, block, now, { ...full, stranger });
    }
    const gas = BigInt(e.gas_limit);
    const funds = await balances(url, head, buyer, guard, gas, stranger ? { stranger, owner: st.owner } : undefined);
    const want = JSON.stringify(buildRequest(head, funds, blocks, gas));
    if (want !== JSON.stringify(p.request)) return { error: "request is not the one checkToken builds for this target" };
    const labels = blocks.flatMap((b) => b.calls.map((c) => c.label));
    if (labels.length !== fresh.length) return { error: `expected ${labels.length} calls, node returned ${fresh.length}` };
    return { labels, buyer, guard, stranger, owner: st.owner };
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
const readEntry = async (token: string) => (await import("./near")).view<OnChainEntry>("get_entry", { token });
/** The guard account (GUARD in .env) and its EVM address derived through Chain Signatures. */
export type GuardInfo = { account: string; evm: Address };
async function readGuard(): Promise<GuardInfo> {
  const { env } = await import("./near");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  return { account: env("GUARD"), evm: deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH) };
}
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

type Opts = {
  check?: boolean;
  chain?: (id: number) => Promise<OnChain>;
  entry?: (token: string) => Promise<OnChainEntry>;
  guard?: GuardInfo;
  clock?: () => number;
};

export async function replay(
  proof: Proof,
  url: string,
  opts: Opts = {},
): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const fail = (text: string, e: unknown) => out.push({ ok: false, line: `ERROR    ${text}: ${msg(e)}` });

  const e = parseEvidence(proof);
  if (typeof e === "string") {
    out.push({ ok: false, line: `MISMATCH ${e} (nothing sent to the node)` });
    return out;
  }
  if ("kind" in e) return replayExit(proof, e, url, opts);

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
  let blockHash: Hex | null = null;
  try {
    const header = await blockOf(url, toHex(e.block));
    blockTs = Number(BigInt(header.timestamp));
    blockHash = header.hash;
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
  let rebuilt: Rebuilt | null = null;
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
    const r = await rebuild(url, proof, e, fresh);
    if ("error" in r) add(false, `request shape: ${r.error}`);
    else {
      rebuilt = r;
      try {
        const problems = await probeProblems(url, e, proof.target as Address, r);
        add(!problems.length, problems.length ? `probe addresses: ${problems.join(" ; ")}` : "probe addresses are fresh (no code, not router/WETH/target/owner(), distinct)");
      } catch (err) {
        fail("checking the probe addresses", err);
      }
      const want = fresh.map((res, i) => `${r.labels[i]}: ${succeeded(res) ? "ok" : "revert"}`);
      const same = JSON.stringify(want) === JSON.stringify(e.calls);
      add(same, same ? "call labels rebuilt from the request match evidence.calls" : "call labels in evidence.calls differ from those rebuilt from the request");
      const j = judge(r.labels, fresh, { ...e, code_hash: e.code_hash as Hex, implementation: e.implementation as Address | null });
      const ok = j.verdict === proof.verdict && j.reasons === proof.reasons;
      add(ok, ok ? `verdict ${j.verdict} rejudged identically (same reasons)` : `verdict/reasons differ: file "${proof.verdict}: ${proof.reasons}" vs rejudged "${j.verdict}: ${j.reasons}"`);
      const q = quoteOf(r.labels, fresh).toString();
      add(q === e.quote, q === e.quote ? `quote ${q} tokens for 0.01 ETH recomputed identically` : `quote in evidence ${e.quote} != recomputed ${q}`);
    }
  }

  // (e2) LP facts recomputed from the node at the block (the rejudging above used the file's)
  try {
    const l = JSON.stringify(await liquidityFacts(url, proof.target as Address, BigInt(e.block)));
    const same = l === JSON.stringify(e.liquidity);
    add(same, same ? "liquidity facts (pair, LP supply, holders) recomputed identically" : `liquidity facts differ: evidence ${JSON.stringify(e.liquidity)} vs node ${l}`);
  } catch (err) {
    fail("recomputing the liquidity facts", err);
  }

  // (e3) template reputation: the index rebuilt from the node over the same window, same sha256, and
  // the pools funded before the target's own one counted by the same rule (beforeBlock, pure)
  if (!e.reputation) add(true, "no template index used: reputation unknown, which the verdict counts as a warn");
  else {
    const r = e.reputation;
    try {
      const index = await buildIndex(url, r.from, r.to);
      const sha = indexSha256(index);
      add(sha === r.index_sha256, sha === r.index_sha256 ? `template index of blocks ${r.from}..${r.to} rebuilt from the node: same sha256 ${sha.slice(0, 10)}...` : `template index of blocks ${r.from}..${r.to} rebuilt with sha256 ${sha}, evidence says ${r.index_sha256}`);
      const want = JSON.stringify(reputationOf(index, e.template as Hex, beforeBlock(index, e.liquidity?.pair ?? null)));
      add(want === JSON.stringify(r), want === JSON.stringify(r) ? `template reputation recomputed identically (${r.drained} of ${r.pools} earlier pools drained)` : `template reputation differs: evidence ${JSON.stringify(r)} vs rebuilt ${want}`);
    } catch (err) {
      fail("rebuilding the template index", err);
    }
  }

  // (e) code de la cible et implementation du proxy au bloc
  try {
    const code = await rpc<Hex>(url, "eth_getCode", [proof.target, toHex(e.block)]);
    const h = keccak256(code);
    add(h === e.code_hash, h === e.code_hash ? "target code hash matches evidence" : `target code hash ${h} != ${e.code_hash}`);
    const t = templateOf(code);
    add(t === e.template, t === e.template ? "target template (code, immutables and metadata masked) matches evidence" : `target template ${t} != ${e.template}`);
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
        add(c.quote === e.quote, c.quote === e.quote ? `on-chain quote ${c.quote} matches evidence` : `on-chain quote ${c.quote} != evidence quote ${e.quote}`);
        add(c.gas_limit === e.gas_limit, c.gas_limit === e.gas_limit ? `on-chain gas limit ${c.gas_limit} is the one simulated with` : `on-chain gas limit ${c.gas_limit} != simulated gas limit ${e.gas_limit}`);
        if (c.target.toLowerCase() !== proof.target.toLowerCase()) add(false, `on-chain target ${c.target} is not the proof target ${proof.target}`);
        else {
          const same = c.verdict === proof.verdict && c.reasons === proof.reasons;
          add(same, same ? `on-chain verdict ${c.verdict} for #${proof.id} matches (same target, same reasons)` : `on-chain "${c.verdict}: ${c.reasons}" != file "${proof.verdict}: ${proof.reasons}"`);
        }
        if (rebuilt) out.push(...(await derivation(proof.id, rebuilt, c, blockHash, opts.guard ?? (await readGuard()))));
        out.push(...(await nearFacts(proof, e, opts.chain ?? readCheck, opts.entry ?? readEntry)));
        if (blockTs !== null) out.push(await timing(url, blockTs, c, opts.clock ?? (() => Date.now() / 1000)));
      }
    } catch (err) {
      fail("reading the NEAR contract", err);
    }
  } else {
    out.push({ ok: true, skipped: true, line: "SKIPPED  probe addresses not verified: they are derived from on-chain data, checked only with --check" });
    out.push({ ok: true, skipped: true, line: "SKIPPED  NEAR facts (blocklist entries, code at the last check) not verified: checked only with --check" });
  }
  return out;
}

/** The NEAR facts in the evidence against the guard now: each listing cited is the target's and is on
 *  the guard with the same reporter and evidence (or was removed since), and the previous code is the
 *  one the guard stored with that check. Listings the sentinel left out are not detectable here; the
 *  guard itself refuses to buy a listed token and an allow on changed code. */
async function nearFacts(proof: Proof, e: Evidence, chain: (id: number) => Promise<OnChain>, entry: (token: string) => Promise<OnChainEntry>): Promise<Line[]> {
  const out: Line[] = [];
  const line = (ok: boolean, text: string, skipped = false): Line => ({ ok, skipped, line: `${skipped ? "SKIPPED " : ok ? "OK      " : "MISMATCH"} ${text}` });
  for (const l of e.near.listed) {
    if (l.key.toLowerCase() !== proof.target.toLowerCase()) {
      out.push(line(false, `blocklist entry of ${l.key} is not the target's`));
      continue;
    }
    const now = await entry(l.key);
    if (!now) out.push(line(true, `blocklist entry of ${l.key} no longer on the guard (removed by the owner since)`, true));
    else {
      const same = now.reporter === l.reporter && now.evidence_sha256 === l.evidence_sha256;
      out.push(line(same, same ? `blocklist entry of ${l.key} by ${l.reporter} found on the guard` : `blocklist entry of ${l.key}: guard says ${now.reporter} ${now.evidence_sha256}, evidence says ${l.reporter} ${l.evidence_sha256}`));
    }
  }
  const p = e.near.previous;
  if (p) {
    const c = await chain(p.id);
    const same = !!c?.code && c.target.toLowerCase() === proof.target.toLowerCase() && c.code.code_hash === p.code_hash.toLowerCase() && (c.code.implementation ?? null) === (p.implementation?.toLowerCase() ?? null);
    out.push(line(same, same ? `code at the last check #${p.id} matches the guard's record` : `code at the last check #${p.id} is not the one the guard stored for ${proof.target}`));
  }
  if (!e.near.listed.length && !p) out.push(line(true, "NEAR facts: no blocklist entry and no previous check cited"));
  return out;
}

/** Replay of an exit quote: the request is the sale checkExit builds for the target and amount from
 *  the address in the request; resent, rejudged, quote recomputed; with --check, that address must be
 *  the guard's derived one and the on-chain verdict, quote and amount the file's. */
async function replayExit(proof: Proof, e: ExitEvidence, url: string, opts: Opts): Promise<Line[]> {
  const out: Line[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const hash = sha256(stringToHex(JSON.stringify(proof.request)));
  add(hash === e.request_sha256, hash === e.request_sha256 ? "request hash matches evidence" : `request hash ${hash} != ${e.request_sha256}`);
  const bad = shapeError(proof, e);
  if (bad) {
    add(false, `request shape: ${bad} (nothing sent to the node)`);
    return out;
  }
  let seller: Address | null = null;
  try {
    const id = Number(await rpc<Hex>(url, "eth_chainId", []));
    add(id === e.chain_id, id === e.chain_id ? `chain id ${id} matches evidence` : `node chain id ${id} != evidence chain id ${e.chain_id}`);
    seller = (proof.request.params[0] as { blockStateCalls: BlockStateCall[] }).blockStateCalls[0].calls[0]?.from ?? null;
    const head = await blockOf(url, toHex(e.block));
    const blocks = exitPlan(proof.target as Address, seller ?? NOBODY, BigInt(e.amount), BigInt(head.timestamp) + NEXT_S);
    const same = JSON.stringify(buildRequest(head, { [seller ?? NOBODY]: FUND }, blocks, BigInt(e.gas_limit))) === JSON.stringify(proof.request);
    add(same, same ? `request is the exit sale checkExit builds for ${e.amount} tokens from ${seller}` : "request is not the exit sale checkExit builds for this target and amount");
    const fresh = (await rpc<{ calls: Result[] }[]>(url, proof.request.method, proof.request.params)).flatMap((b) => b.calls);
    const sameResults = JSON.stringify(fresh.map((r) => [r.status, r.returnData])) === JSON.stringify(proof.response.map((r) => [r.status, r.returnData]));
    add(sameResults, sameResults ? `request resent to ${url} at block ${e.block}: status and return data of all ${fresh.length} calls identical` : "call results differ");
    const j = judgeExit(blocks[0].calls.map((c) => c.label), fresh);
    add(j.verdict === proof.verdict && j.reasons === proof.reasons, `exit verdict ${j.verdict} ${j.verdict === proof.verdict && j.reasons === proof.reasons ? "rejudged identically" : `differs from the file's ${proof.verdict}`}`);
    add(j.quote.toString() === e.quote, j.quote.toString() === e.quote ? `exit quote ${e.quote} wei recomputed identically` : `exit quote in evidence ${e.quote} != recomputed ${j.quote}`);
  } catch (err) {
    out.push({ ok: false, line: `ERROR    replaying the exit quote: ${msg(err)}` });
  }
  if (!opts.check) {
    out.push({ ok: true, skipped: true, line: "SKIPPED  seller and on-chain verdict not verified: checked only with --check" });
    return out;
  }
  try {
    const g = opts.guard ?? (await readGuard());
    add(!!seller && same(seller, g.evm), seller && same(seller, g.evm) ? `seller is ${g.account}'s derived EVM address ${g.evm}` : `seller ${seller} is not the guard's derived EVM address ${g.evm}`);
    const c = await (opts.chain ?? readCheck)(proof.id);
    if (!c?.verdict) out.push({ ok: false, line: `ERROR    request #${proof.id} has no verdict on chain` });
    else {
      const h = sha256(stringToHex(proof.evidence)).slice(2);
      add(h === c.evidence_sha256, h === c.evidence_sha256 ? `on-chain evidence_sha256 ${h} is the sha256 of the evidence replayed above` : `on-chain evidence_sha256 ${c.evidence_sha256} != ${h}`);
      const ok = c.verdict === proof.verdict && c.reasons === proof.reasons && c.quote === e.quote && c.exit_amount === e.amount && c.gas_limit === e.gas_limit && same(c.target, proof.target);
      add(ok, ok ? `on-chain exit quote #${proof.id}: ${c.verdict}, ${c.quote} wei for ${c.exit_amount} tokens at gas limit ${c.gas_limit}, matches` : `on-chain #${proof.id} (${c.verdict}, quote ${c.quote}, amount ${c.exit_amount}, gas limit ${c.gas_limit}, ${c.target}) differs from the file`);
    }
  } catch (err) {
    out.push({ ok: false, line: `ERROR    reading the NEAR contract: ${msg(err)}` });
  }
  return out;
}

/** The probes must be deriveProbes(guard, #id, on-chain request time, EVM block hash) and the guard
 *  side must be the guard's derived EVM address: otherwise the sentinel chose who was simulated. */
function derivation(id: number, r: Rebuilt, c: NonNullable<OnChain>, blockHash: Hex | null, g: GuardInfo): Line[] {
  if (!blockHash) return [{ ok: false, line: "ERROR    probe derivation: EVM block hash unknown" }];
  const want = deriveProbes({ guard: g.account, id, requested_ns: c.requested_ns }, blockHash);
  const probesOk = same(r.buyer, want.buyer) && (r.stranger === null || same(r.stranger, want.stranger));
  const line = (ok: boolean, text: string): Line => ({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  return [
    line(
      probesOk,
      probesOk
        ? `probe addresses derived from ${g.account}, #${id}, request time ${c.requested_ns} ns on NEAR and EVM block hash ${blockHash.slice(0, 10)}...`
        : `probe addresses not derived from on-chain data: buyer ${r.buyer} (derived ${want.buyer}), stranger ${r.stranger ?? "none"} (derived ${want.stranger})`,
    ),
    line(
      same(r.guard, g.evm),
      same(r.guard, g.evm) ? `guard side simulated as ${g.account}'s derived EVM address ${g.evm}` : `guard side simulated as ${r.guard}, not ${g.account}'s derived EVM address ${g.evm}`,
    ),
  ];
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
  const note = skipped ? ` (${skipped} check(s) not verified, see SKIPPED)` : "";
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
