// Sentinelle avant achat : controles par simulation en lecture seule (eth_simulateV1) sur une
// chaine EVM, route Uniswap V2 WETH -> jeton. Rien n'est signe ni envoye sur la chaine EVM.
import {
  decodeAbiParameters,
  decodeFunctionResult,
  keccak256,
  encodeFunctionData,
  maxUint256,
  parseAbi,
  parseEther,
  sha256,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

export const ROUTER: Address = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Uniswap V2 Router02 (Base)
export const WETH: Address = "0x4200000000000000000000000000000000000006";
/** Achat simule ; le devis poste est en jetons pour ce montant (QUOTE_WEI dans src/lib.rs). */
const BUY = parseEther("0.01");
/** Le premier bloc simule suit le bloc de la preuve, 2 s apres lui (rythme des blocs de Base) ;
 *  la premiere vente est simulee au bloc d'apres, encore 2 s plus tard. */
export const NEXT_S = 2n;
const LATER_S = 3600n; // timestamp of the late sale: one hour after the buy
// Sans prix du gaz ni limite par appel, eth_simulateV1 donne tx.gasprice = 0, block.basefee = 0 et
// gasleft() = limite du bloc : un jeton y reconnait la simulation et ne refuse que la vraie vente.
const TIP = 1_000_000n; // pourboire propose par mainnet.base.org (eth_maxPriorityFeePerGas)
const GAS = 1_000_000n; // limite de gaz d'un appel, celle d'un vrai swap
const FUND = parseEther("1"); // solde des sondes neuves, de quoi acheter et payer le gaz
// eth_simulateV1 refuse plus de 256 blocs au-dessus du bloc de base : the late sale is 256 blocks
// ahead (about 8.5 min of 2 s Base blocks, 1800 blocks would be 1 h) with its timestamp 1 h ahead. A
// token counting blocks sees 8.5 min, one reading the timestamp sees 1 h.
const MAX_BLOCKS = 256n;
/** The late sale in verdict reasons: what the simulation really does, not "1 h". */
const LATE = "256 blocks (timestamp +1 h) after the buy";
// Emplacements de l'adresse d'implementation d'un proxy : EIP-1967, puis ZeppelinOS (USDC).
const IMPL_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
];
const TAX_WARN = 0.1; // perte au-dela du devis du pool : avertir a 10 %, bloquer a 50 %
const TAX_BLOCK = 0.5;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function owner() view returns (address)",
]);
const router = parseAbi([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);

export type Verdict = "allow" | "warn" | "block";
type Call = { label: string; from: Address; to: Address; data: Hex; value?: Hex };
export type Result = { status: Hex; returnData: Hex; error?: { message?: string; data?: Hex } };
type Finding = { level: Verdict; text: string };
export type Report = {
  verdict: Verdict;
  reasons: string;
  /** Resume poste en chaine (<= 8000 caracteres). */
  evidence: {
    chain_id: number;
    block: number;
    method: "eth_simulateV1";
    request_sha256: Hex;
    /** keccak256 du code de la cible au bloc du controle. */
    code_hash: Hex;
    /** Implementation derriere un proxy (EIP-1967 ou ZeppelinOS), sinon null. */
    implementation: Address | null;
    calls: string[];
    /** Devis : jetons recus par l'achat simule de 0,01 ETH (decimal, "0" sans achat) ; la garde en
     *  tire le minimum de jetons du swap qu'elle fait signer. */
    quote: string;
  };
  /** Requete et reponse completes, pour rejouer la simulation au meme bloc. */
  request: { method: string; params: unknown[] };
  response: Result[];
};

function call(label: string, from: Address, to: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint): Call {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return { label, from, to, data, ...(value ? { value: toHex(value) } : {}) };
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(Number(process.env.RPC_TIMEOUT_MS ?? 20_000)), // jamais d'attente sans fin
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method} : ${body.error?.message ?? res.status}`);
  return body.result;
}

export type Block = { number?: bigint; time: bigint; calls: Call[] };
/** Bloc reel au-dessus duquel on simule : sa base fee, son prevrandao et son coinbase sont repris, le
 *  noeud les mettrait sinon a zero (prevrandao, base fee) dans les blocs simules. */
export type Header = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex; mixHash: Hex; miner: Address };

/** Requete eth_simulateV1 complete, telle qu'envoyee et sauvegardee dans la preuve. */
export function buildRequest(head: Header, balances: Record<string, bigint>, blocks: Block[]) {
  const baseFee = BigInt(head.baseFeePerGas);
  const env = { baseFeePerGas: toHex(baseFee), prevRandao: head.mixHash, feeRecipient: head.miner };
  const fees = { gas: toHex(GAS), maxFeePerGas: toHex(2n * baseFee + TIP), maxPriorityFeePerGas: toHex(TIP) };
  const request = {
    blockStateCalls: blocks.map((b, i) => ({
      blockOverrides: { ...(b.number ? { number: toHex(b.number) } : {}), time: toHex(b.time), ...env },
      ...(i === 0 ? { stateOverrides: Object.fromEntries(Object.entries(balances).map(([a, v]) => [a, { balance: toHex(v) }])) } : {}),
      calls: b.calls.map(({ label: _, ...c }) => ({ ...c, ...fees })),
    })),
    validation: false,
  };
  return { method: "eth_simulateV1", params: [request, toHex(BigInt(head.number))] };
}

/** Soldes poses par la simulation : sondes neuves financees ; owner() complete seulement s'il ne peut
 *  pas payer le gaz de son appel, sinon son solde reel reste (un vrai owner() paie aussi son gaz).
 *  The guard's EVM address gets the same balance as the probe buyer, whatever it holds on chain. */
export async function balances(url: string, head: Header, buyer: Address, guard: Address, full?: { stranger: Address; owner: Address | null }) {
  const out: Record<string, bigint> = { [buyer]: FUND, [guard]: FUND };
  if (!full) return out;
  out[full.stranger] = FUND;
  if (full.owner) {
    const need = GAS * (2n * BigInt(head.baseFeePerGas) + TIP);
    if (BigInt(await rpc<Hex>(url, "eth_getBalance", [full.owner, head.number])) < need) out[full.owner] = FUND;
  }
  return out;
}

/** Simule des blocs successifs au-dessus de `head` ; renvoie la requete et un resultat par appel. */
async function simulate(url: string, head: Header, funds: Record<string, bigint>, blocks: Block[]) {
  const request = buildRequest(head, funds, blocks);
  const out = await rpc<{ calls: Result[] }[]>(url, request.method, request.params);
  return { request, results: out.flatMap((b) => b.calls) };
}

/** Label prefix of the calls made as the guard's own EVM address (the real buyer); the probe
 *  buyer's calls have none. A token that targets the guard's public address shows up on this side. */
export const GUARD = "guard: ";

/** Les blocs a simuler. Sans `full` : l'achat seul (1re simulation). Avec `full` (inconnu, quantites
 *  achetees et proprietaire, lus dans la 1re simulation) : la preuve complete en trois blocs, achat +
 *  reprises sans approbation + approve, vente de la moitie au bloc suivant, vente du reste 256 blocks (timestamp +1 h)
 *  later. Every step runs twice in the same blocks: as the probe buyer, then as the guard's EVM
 *  address. Partage avec app/replay.ts, qui reconstruit ainsi la requete attendue. */
export function plan(
  token: Address,
  buyer: Address,
  guard: Address,
  block: bigint,
  now: bigint,
  full?: { stranger: Address; amounts: [bigint, bigint]; owner: Address | null },
): Block[] {
  const deadline = now + 10_000n;
  const buyPath = [WETH, token];
  const sellPath = [token, WETH];
  const sides: [string, Address][] = [["", buyer], [GUARD, guard]];
  const each = (f: (p: string, who: Address, i: number) => Call[]) => sides.flatMap(([p, who], i) => f(p, who, i));
  const balance = (p: string, who: Address, label: string, of: Address) => call(p + label, who, of, erc20, "balanceOf", [who]);
  const buy = each((p, who) => [
    balance(p, who, "tokens before buy", token),
    call(`${p}buy quote`, who, ROUTER, router, "getAmountsOut", [BUY, buyPath]),
    call(`${p}buy 0.01 ETH`, who, ROUTER, router, "swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, buyPath, who, deadline], BUY),
    balance(p, who, "tokens after buy", token),
    call(`${p}owner()`, who, token, erc20, "owner", []),
  ]);
  if (!full) return [{ time: now, calls: buy }];
  const { stranger, amounts, owner } = full;
  const half = (i: number) => amounts[i] / 2n;
  const rest = (i: number) => amounts[i] - half(i) - 2n; // 2 unites peut-etre reprises par les sondes transferFrom
  const block1 = [
    ...buy,
    ...each((p, who) => [
      ...(owner ? [call(`${p}transferFrom by owner()`, owner, token, erc20, "transferFrom", [who, owner, 1n])] : []),
      call(`${p}transferFrom by a stranger`, stranger, token, erc20, "transferFrom", [who, stranger, 1n]),
      call(`${p}approve router`, who, token, erc20, "approve", [ROUTER, maxUint256]),
    ]),
  ];
  const block2 = each((p, who, i) => [
    balance(p, who, "WETH before sale", WETH),
    call(`${p}sale quote`, who, ROUTER, router, "getAmountsOut", [half(i), sellPath]),
    call(`${p}sale in next block`, who, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [half(i), 0n, sellPath, who, deadline]),
    balance(p, who, "WETH after sale", WETH),
  ]);
  const block3 = each((p, who, i) => [
    call(`${p}sale quote +256 blocks`, who, ROUTER, router, "getAmountsOut", [rest(i), sellPath]),
    call(`${p}sale +256 blocks`, who, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [rest(i), 0n, sellPath, who, deadline + LATER_S]),
    balance(p, who, "WETH after sale +256 blocks", WETH),
  ]);
  return [
    { time: now, calls: block1 },
    { time: now + NEXT_S, calls: block2 },
    { number: block + MAX_BLOCKS, time: now + LATER_S, calls: block3 },
  ];
}

export const ok = (r: Result) => r.status === "0x1";
const uint = (abi: Abi, fn: string, r: Result) => decodeFunctionResult({ abi, functionName: fn, data: r.returnData } as Parameters<typeof decodeFunctionResult>[0]);

/** Raison d'un revert `Error(string)` (dans `error.data` ou `returnData` selon le noeud). */
function revertReason(r: Result): string {
  const data = r.error?.data ?? r.returnData;
  if (data.startsWith("0x08c379a0")) return decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`)[0];
  return data === "0x" ? "revert without reason" : data.slice(0, 18);
}

/** Vrai si un transferFrom sans approbation a deplace des jetons (succes et pas de `false` renvoye). */
function moved(r: Result): boolean {
  if (!ok(r)) return false;
  return r.returnData === "0x" || (uint(erc20, "transferFrom", r) as boolean);
}

/** Adresses de sonde et heure du premier bloc simule. Seuls les tests imposent l'heure (preuves
 *  falsifiees mais coherentes) ; la sentinelle derive les sondes (deriveProbes) et part du bloc + 2 s. */
export type Probe = { buyer: Address; stranger: Address; time?: bigint };
/** On-chain inputs of the probe derivation: the guard account, the check id and its request time
 *  (`requested_ns`, set by the guard contract), all readable by anyone from a NEAR RPC. */
export type Ticket = { guard: string; id: number; requested_ns: string };

/** Probe addresses the sentinel does not choose: sha256 of the ticket and of the hash of the EVM
 *  block simulated on. That hash does not exist before the block, so a token owner watching NEAR
 *  cannot whitelist the probes in advance; replay --check recomputes them. */
export function deriveProbes(t: Ticket, blockHash: Hex): { buyer: Address; stranger: Address } {
  const at = (role: string) => `0x${sha256(stringToHex(`goblin-near probe|${t.guard}|${t.id}|${t.requested_ns}|${blockHash.toLowerCase()}|${role}`)).slice(-40)}` as Address;
  return { buyer: at("buyer"), stranger: at("stranger") };
}

/** Implementation derriere un proxy (EIP-1967, puis ZeppelinOS) au bloc, sinon null. */
export async function implementationAt(url: string, token: Address, block: bigint): Promise<Address | null> {
  for (const slot of IMPL_SLOTS) {
    const word = await rpc<Hex>(url, "eth_getStorageAt", [token, slot, toHex(block)]);
    if (BigInt(word) !== 0n) return `0x${word.slice(-40)}`.toLowerCase() as Address;
  }
  return null;
}

/** Simulates buying `token` as two buyers, the probe and `guard` (the guard's EVM address); `probes`
 *  gets the block simulated on (the sentinel passes deriveProbes of its ticket). */
export async function checkToken(url: string, token: Address, guard: Address, probes: (head: Header) => Probe): Promise<Report> {
  const head = await rpc<Header>(url, "eth_getBlockByNumber", ["latest", false]);
  const probe = probes(head);
  const { buyer, stranger } = probe;
  const block = BigInt(head.number);
  const now = probe.time ?? BigInt(head.timestamp) + NEXT_S;
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const code = await rpc<Hex>(url, "eth_getCode", [token, toHex(block)]);
  const implementation = await implementationAt(url, token, block);
  const proof = { chain_id: chainId, block, code_hash: keccak256(code), implementation };
  const [first1] = plan(token, buyer, guard, block, now);

  // 1re simulation : quantites achetees et proprietaire, pour construire la seconde.
  const first = await simulate(url, head, await balances(url, head, buyer, guard), [first1]);
  const buyLabels = first1.calls.map((c) => c.label);
  const st = buyStages(byLabel(buyLabels, first.results));
  if (st.stop) return report(proof, first, buyLabels);

  const blocks = plan(token, buyer, guard, block, now, { stranger, amounts: st.amounts, owner: st.owner });
  const sim = await simulate(url, head, await balances(url, head, buyer, guard, { stranger, owner: st.owner }), blocks);
  return report(proof, sim, blocks.flatMap((b) => b.calls.map((c) => c.label)));
}

/** Phase achat d'un cote (prefixe "" ou GUARD) : quantite recue, proprietaire, premiers constats.
 *  `findings` vide = on peut poursuivre. */
export function buyStage(f: Record<string, Result>, p = "") {
  const findings: Finding[] = [];
  if (!ok(f[`${p}buy quote`])) findings.push({ level: "warn", text: "no liquidity: no Uniswap V2 WETH pair, sale not verifiable" });
  else if (!ok(f[`${p}buy 0.01 ETH`])) findings.push({ level: "block", text: `simulated buy failed: ${revertReason(f[`${p}buy 0.01 ETH`])}` });
  const amount = delta(f[`${p}tokens after buy`], f[`${p}tokens before buy`]);
  const o = f[`${p}owner()`];
  const owner = ok(o) && o.returnData !== "0x" ? (uint(erc20, "owner", o) as Address) : null;
  if (!findings.length && amount < 10n) findings.push({ level: "block", text: "simulated buy received no tokens" });
  return { findings, amount, owner };
}

/** Both buy stages: a finding on either side stops the check after the buy. */
export function buyStages(f: Record<string, Result>) {
  const [b, g] = [buyStage(f), buyStage(f, GUARD)];
  return { stop: b.findings.length + g.findings.length > 0, amounts: [b.amount, g.amount] as [bigint, bigint], owner: b.owner };
}

// Une adresse sans code repond "0x" a balanceOf : solde nul, pas une erreur de decodage.
const bal = (r: Result) => (ok(r) && r.returnData !== "0x" ? (uint(erc20, "balanceOf", r) as bigint) : 0n);
const delta = (after: Result, before: Result) => (ok(after) && ok(before) ? bal(after) - bal(before) : 0n);

/** Constats d'un cote (prefixe "" ou GUARD) : achat, reprises, ventes. */
function sideFindings(r: Record<string, Result>, p: string, stop: boolean): Finding[] {
  const { findings, amount, owner } = buyStage(r, p);
  if (stop) return findings;
  if (owner && moved(r[`${p}transferFrom by owner()`])) {
    findings.push({ level: "block", text: `owner() ${owner} takes tokens back by transferFrom without approval` });
  }
  if (moved(r[`${p}transferFrom by a stranger`])) {
    findings.push({ level: "block", text: "anyone can take tokens back by transferFrom without approval" });
  }
  const quoted = (res: Result) => (ok(res) ? (uint(router, "getAmountsOut", res) as bigint[])[1] : 0n);
  // Sans devis, la taxe n'est pas mesurable : perte totale supposee, donc block (echec ferme).
  const loss = (got: bigint, expected: bigint) => (expected > 0n ? 1 - Number(got) / Number(expected) : 1);
  const taxed = (tax: number, when: string) => {
    const text = tax >= 1 ? `tax not measurable ${when} (pool quote failed)` : `${Math.round(tax * 100)} % tax ${when}`;
    if (tax >= TAX_BLOCK) findings.push({ level: "block", text });
    else if (tax >= TAX_WARN) findings.push({ level: "warn", text });
  };
  taxed(loss(amount, quoted(r[`${p}buy quote`])), "on the buy");
  if (!ok(r[`${p}sale in next block`])) {
    findings.push({ level: "block", text: `sale refused in the next block after the buy (${revertReason(r[`${p}sale in next block`])})` });
  } else {
    taxed(loss(delta(r[`${p}WETH after sale`], r[`${p}WETH before sale`]), quoted(r[`${p}sale quote`])), "on the sale in the next block");
  }
  if (!ok(r[`${p}sale +256 blocks`])) {
    findings.push({ level: "block", text: `sale refused ${LATE} (${revertReason(r[`${p}sale +256 blocks`])})` });
  } else {
    taxed(loss(delta(r[`${p}WETH after sale +256 blocks`], r[`${p}WETH after sale`]), quoted(r[`${p}sale quote +256 blocks`])), `on the sale ${LATE}`);
  }
  return findings;
}

/** Jugement pur : ne depend que des libelles des appels et de leurs resultats, donc rejouable
 *  par n'importe qui a partir d'une preuve (voir app/replay.ts). The guard side's findings that the
 *  probe buyer does not share are reported as "guard address: ...". */
export function judge(labels: string[], results: Result[]): { verdict: Verdict; reasons: string } {
  const r = byLabel(labels, results);
  const { stop } = buyStages(r);
  const findings = sideFindings(r, "", stop);
  const seen = new Set(findings.map((f) => f.text));
  for (const f of sideFindings(r, GUARD, stop)) if (!seen.has(f.text)) findings.push({ ...f, text: `guard address: ${f.text}` });
  const verdict: Verdict = findings.some((f) => f.level === "block") ? "block" : findings.some((f) => f.level === "warn") ? "warn" : "allow";
  const reasons = findings.length ? findings.map((f) => f.text).join(" ; ") : "buy, takeback probes and sales simulated without anomaly";
  return { verdict, reasons: reasons.slice(0, 280) };
}

/** Devis poste avec le verdict : jetons recus par l'achat simule de 0,01 ETH (0 sans achat), tire de
 *  la reponse seule, donc rejouable (voir app/replay.ts). */
export function quoteOf(labels: string[], results: Result[]): bigint {
  const { amount } = buyStage(byLabel(labels, results));
  return amount > 0n ? amount : 0n;
}

export const byLabel = (labels: string[], results: Result[]) => Object.fromEntries(labels.map((l, i) => [l, results[i]]));

function report(
  proof: { chain_id: number; block: bigint; code_hash: Hex; implementation: Address | null },
  sim: { request: Report["request"]; results: Result[] },
  labels: string[],
): Report {
  const { verdict, reasons } = judge(labels, sim.results);
  const evidence = {
    chain_id: proof.chain_id,
    block: Number(proof.block),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
    code_hash: proof.code_hash,
    implementation: proof.implementation,
    calls: sim.results.map((res, i) => `${labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: quoteOf(labels, sim.results).toString(),
  };
  if (JSON.stringify(evidence).length > 8000) throw new Error("evidence above 8000 characters");
  return { verdict, reasons, evidence, request: sim.request, response: sim.results };
}

/** Fichier proofs/<id>.json : `evidence` y est la chaine exacte postee a post_verdict, dont le
 *  contrat stocke le sha256 ; app/replay.ts la relit telle quelle. */
export type ProofFile = Omit<Report, "evidence"> & { id: number; target: string; evidence: string };

export function toProof(id: number, target: string, r: Report): ProofFile {
  return { id, target, verdict: r.verdict, reasons: r.reasons, evidence: JSON.stringify(r.evidence), request: r.request, response: r.response };
}

/** `special()` of a demo token: for guard_frozen, the guard EVM address that evm/fork.sh made it freeze. */
export async function specialOf(url: string, token: Address): Promise<Address> {
  const data = encodeFunctionData({ abi: parseAbi(["function special() view returns (address)"]), functionName: "special" });
  return `0x${(await rpc<Hex>(url, "eth_call", [{ to: token, data }, "latest"])).slice(-40)}` as Address;
}
