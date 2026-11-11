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

const ROUTER: Address = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Uniswap V2 Router02 (Base)
const WETH: Address = "0x4200000000000000000000000000000000000006";
const BUY = parseEther("0.01");
const NEXT_S = 2n; // la premiere vente est simulee au bloc suivant, 2 s apres l'achat
const LATER_S = 3600n; // la seconde vente est simulee une heure apres l'achat
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
  };
  /** Requete et reponse completes, pour rejouer la simulation au meme bloc. */
  request: unknown;
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

/** Simule des blocs successifs au-dessus de `block` ; renvoie la requete et un resultat par appel. */
async function simulate(url: string, block: bigint, buyer: Address, blocks: { time: bigint; calls: Call[] }[]) {
  const request = {
    blockStateCalls: blocks.map((b, i) => ({
      blockOverrides: { time: toHex(b.time) },
      ...(i === 0 ? { stateOverrides: { [buyer]: { balance: toHex(parseEther("1")) } } } : {}),
      calls: b.calls.map(({ label: _, ...c }) => c),
    })),
    validation: false,
  };
  const out = await rpc<{ calls: Result[] }[]>(url, "eth_simulateV1", [request, toHex(block)]);
  return { request: { method: "eth_simulateV1", params: [request, toHex(block)] }, results: out.flatMap((b) => b.calls) };
}

const ok = (r: Result) => r.status === "0x1";
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

/** Adresse neuve, tiree au hasard a chaque controle : un jeton ne peut pas reconnaitre la simulation
 *  a une adresse connue, ni fausser les mesures en lui envoyant des fonds d'avance. */
const fresh = (): Address => toHex(crypto.getRandomValues(new Uint8Array(20)));

export async function checkToken(url: string, token: Address): Promise<Report> {
  const buyer = fresh();
  const stranger = fresh();
  const head = await rpc<{ number: Hex; timestamp: Hex }>(url, "eth_getBlockByNumber", ["latest", false]);
  const block = BigInt(head.number);
  const now = BigInt(head.timestamp) + 2n;
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const code = await rpc<Hex>(url, "eth_getCode", [token, toHex(block)]);
  let implementation: Address | null = null;
  for (const slot of IMPL_SLOTS) {
    const word = await rpc<Hex>(url, "eth_getStorageAt", [token, slot, toHex(block)]);
    const addr = `0x${word.slice(-40)}`.toLowerCase() as Address;
    if (BigInt(word) !== 0n) {
      implementation = addr;
      break;
    }
  }
  const proof = { chain_id: chainId, block, code_hash: keccak256(code), implementation };
  const deadline = now + 10_000n;
  const buyPath = [WETH, token];
  const sellPath = [token, WETH];
  const balance = (label: string, of: Address) => call(label, buyer, of, erc20, "balanceOf", [buyer]);
  const buy = [
    balance("tokens before buy", token),
    call("buy quote", buyer, ROUTER, router, "getAmountsOut", [BUY, buyPath]),
    call("buy 0.01 ETH", buyer, ROUTER, router, "swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, buyPath, buyer, deadline], BUY),
    balance("tokens after buy", token),
    call("owner()", buyer, token, erc20, "owner", []),
  ];

  // 1re simulation : quantite achetee et proprietaire, pour construire la seconde.
  const first = await simulate(url, block, buyer, [{ time: now, calls: buy }]);
  const buyLabels = buy.map((c) => c.label);
  const st = buyStage(byLabel(buyLabels, first.results));
  if (st.findings.length) return report(proof, first, buyLabels);
  const { amount, owner } = st;

  // 2e simulation, la preuve, en trois blocs : achat + reprises sans approbation + approve,
  // vente de la moitie au bloc suivant, vente du reste une heure plus tard.
  const half = amount / 2n;
  const rest = amount - half - 2n; // 2 unites peut-etre reprises par les sondes transferFrom
  const block1 = [
    ...buy,
    ...(owner ? [call("transferFrom by owner()", owner, token, erc20, "transferFrom", [buyer, owner, 1n])] : []),
    call("transferFrom by a stranger", stranger, token, erc20, "transferFrom", [buyer, stranger, 1n]),
    call("approve router", buyer, token, erc20, "approve", [ROUTER, maxUint256]),
  ];
  const block2 = [
    balance("WETH before sale", WETH),
    call("sale quote", buyer, ROUTER, router, "getAmountsOut", [half, sellPath]),
    call("sale in next block", buyer, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [half, 0n, sellPath, buyer, deadline]),
    balance("WETH after sale", WETH),
  ];
  const block3 = [
    call("sale quote +1 h", buyer, ROUTER, router, "getAmountsOut", [rest, sellPath]),
    call("sale +1 h", buyer, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [rest, 0n, sellPath, buyer, deadline + LATER_S]),
    balance("WETH after sale +1 h", WETH),
  ];
  const sim = await simulate(url, block, buyer, [
    { time: now, calls: block1 },
    { time: now + NEXT_S, calls: block2 },
    { time: now + LATER_S, calls: block3 },
  ]);
  return report(proof, sim, [...block1, ...block2, ...block3].map((c) => c.label));
}

/** Phase achat : quantite recue, proprietaire, premiers constats. `findings` vide = on peut poursuivre. */
function buyStage(f: Record<string, Result>) {
  const findings: Finding[] = [];
  if (!ok(f["buy quote"])) findings.push({ level: "warn", text: "no liquidity: no Uniswap V2 WETH pair, sale not verifiable" });
  else if (!ok(f["buy 0.01 ETH"])) findings.push({ level: "block", text: `simulated buy failed: ${revertReason(f["buy 0.01 ETH"])}` });
  const amount = delta(f["tokens after buy"], f["tokens before buy"]);
  const owner = ok(f["owner()"]) && f["owner()"].returnData !== "0x" ? (uint(erc20, "owner", f["owner()"]) as Address) : null;
  if (!findings.length && amount < 10n) findings.push({ level: "block", text: "simulated buy received no tokens" });
  return { findings, amount, owner };
}

// Une adresse sans code repond "0x" a balanceOf : solde nul, pas une erreur de decodage.
const bal = (r: Result) => (ok(r) && r.returnData !== "0x" ? (uint(erc20, "balanceOf", r) as bigint) : 0n);
const delta = (after: Result, before: Result) => (ok(after) && ok(before) ? bal(after) - bal(before) : 0n);

/** Jugement pur : ne depend que des libelles des appels et de leurs resultats, donc rejouable
 *  par n'importe qui a partir d'une preuve (voir app/replay.ts). */
export function judge(labels: string[], results: Result[]): { verdict: Verdict; reasons: string } {
  const r = byLabel(labels, results);
  const { findings, amount, owner } = buyStage(r);
  if (!findings.length) {
    if (owner && moved(r["transferFrom by owner()"])) {
      findings.push({ level: "block", text: `owner() ${owner} takes tokens back by transferFrom without approval` });
    }
    if (moved(r["transferFrom by a stranger"])) {
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
    taxed(loss(amount, quoted(r["buy quote"])), "on the buy");
    if (!ok(r["sale in next block"])) {
      findings.push({ level: "block", text: `sale refused in the next block after the buy (${revertReason(r["sale in next block"])})` });
    } else {
      taxed(loss(delta(r["WETH after sale"], r["WETH before sale"]), quoted(r["sale quote"])), "on the sale in the next block");
    }
    if (!ok(r["sale +1 h"])) {
      findings.push({ level: "block", text: `sale refused 1 h after the buy (${revertReason(r["sale +1 h"])})` });
    } else {
      taxed(loss(delta(r["WETH after sale +1 h"], r["WETH after sale"]), quoted(r["sale quote +1 h"])), "on the sale 1 h after the buy");
    }
  }
  const verdict: Verdict = findings.some((f) => f.level === "block") ? "block" : findings.some((f) => f.level === "warn") ? "warn" : "allow";
  const reasons = findings.length ? findings.map((f) => f.text).join(" ; ") : "buy, takeback probes and sales simulated without anomaly";
  return { verdict, reasons: reasons.slice(0, 280) };
}

const byLabel = (labels: string[], results: Result[]) => Object.fromEntries(labels.map((l, i) => [l, results[i]]));

function report(
  proof: { chain_id: number; block: bigint; code_hash: Hex; implementation: Address | null },
  sim: { request: unknown; results: Result[] },
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
  };
  if (JSON.stringify(evidence).length > 8000) throw new Error("evidence above 8000 characters");
  return { verdict, reasons, evidence, request: sim.request, response: sim.results };
}
