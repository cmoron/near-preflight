// Sentinelle avant achat : controles par simulation en lecture seule (eth_simulateV1) sur une
// chaine EVM, route Uniswap V2 WETH -> jeton. Rien n'est signe ni envoye sur la chaine EVM.
import {
  decodeAbiParameters,
  decodeFunctionResult,
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
const BUYER: Address = "0x5e47110000000000000000000000000000000b0b"; // acheteur simule, sans cle
const STRANGER: Address = "0x57a2a6e400000000000000000000000000000001"; // un inconnu quelconque
const BUY = parseEther("0.01");
const LATER_S = 3600; // la seconde vente est simulee une heure apres l'achat
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
type Result = { status: Hex; returnData: Hex; error?: { message?: string; data?: Hex } };
type Finding = { level: Verdict; text: string };
export type Report = {
  verdict: Verdict;
  reasons: string;
  /** Resume poste en chaine (<= 8000 caracteres). */
  evidence: { chain_id: number; block: number; method: "eth_simulateV1"; request_sha256: Hex; calls: string[] };
  /** Requete et reponse completes, pour rejouer la simulation au meme bloc. */
  request: unknown;
  response: Result[];
};

function call(label: string, from: Address, to: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint): Call {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return { label, from, to, data, ...(value ? { value: toHex(value) } : {}) };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method} : ${body.error?.message ?? res.status}`);
  return body.result;
}

/** Simule des blocs successifs au-dessus de `block` ; renvoie la requete et un resultat par appel. */
async function simulate(url: string, block: bigint, blocks: { time: bigint; calls: Call[] }[]) {
  const request = {
    blockStateCalls: blocks.map((b, i) => ({
      blockOverrides: { time: toHex(b.time) },
      ...(i === 0 ? { stateOverrides: { [BUYER]: { balance: toHex(parseEther("1")) } } } : {}),
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
  return data === "0x" ? "revert sans raison" : data.slice(0, 18);
}

/** Vrai si un transferFrom sans approbation a deplace des jetons (succes et pas de `false` renvoye). */
function moved(r: Result): boolean {
  if (!ok(r)) return false;
  return r.returnData === "0x" || (uint(erc20, "transferFrom", r) as boolean);
}

export async function checkToken(url: string, token: Address): Promise<Report> {
  const head = await rpc<{ number: Hex; timestamp: Hex }>(url, "eth_getBlockByNumber", ["latest", false]);
  const block = BigInt(head.number);
  const now = BigInt(head.timestamp) + 2n;
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const deadline = now + 10_000n;
  const buyPath = [WETH, token];
  const sellPath = [token, WETH];
  const buy = [
    call("devis d'achat", BUYER, ROUTER, router, "getAmountsOut", [BUY, buyPath]),
    call("achat 0.01 ETH", BUYER, ROUTER, router, "swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, buyPath, BUYER, deadline], BUY),
    call("solde achete", BUYER, token, erc20, "balanceOf", [BUYER]),
    call("owner()", BUYER, token, erc20, "owner", []),
  ];

  // 1re simulation : quantite achetee et proprietaire, pour construire la seconde.
  const first = await simulate(url, block, [{ time: now, calls: buy }]);
  const [quote, bought, held, ownerRes] = first.results;
  const findings: Finding[] = [];
  if (!ok(quote)) findings.push({ level: "warn", text: "pas de pool V2 WETH : vente non verifiable" });
  else if (!ok(bought)) findings.push({ level: "block", text: `achat simule en echec : ${revertReason(bought)}` });
  const amount = ok(held) ? (uint(erc20, "balanceOf", held) as bigint) : 0n;
  const owner = ok(ownerRes) ? (uint(erc20, "owner", ownerRes) as Address) : null;
  if (findings.length || amount < 10n) {
    if (!findings.length) findings.push({ level: "block", text: "achat simule sans jeton recu" });
    return report(chainId, block, first, findings);
  }

  // 2e simulation, la preuve : reprises sans approbation, vente immediate, vente 1 h plus tard.
  const half = amount / 2n;
  const rest = amount - half - 2n; // 2 unites peut-etre reprises par les sondes transferFrom
  const now1 = [
    ...buy,
    ...(owner ? [call("transferFrom par owner()", owner, token, erc20, "transferFrom", [BUYER, owner, 1n])] : []),
    call("transferFrom par un inconnu", STRANGER, token, erc20, "transferFrom", [BUYER, STRANGER, 1n]),
    call("approve routeur", BUYER, token, erc20, "approve", [ROUTER, maxUint256]),
    call("devis de vente", BUYER, ROUTER, router, "getAmountsOut", [half, sellPath]),
    call("vente immediate", BUYER, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [half, 0n, sellPath, BUYER, deadline]),
    call("WETH recu", BUYER, WETH, erc20, "balanceOf", [BUYER]),
  ];
  const later = [
    call("devis de vente +1 h", BUYER, ROUTER, router, "getAmountsOut", [rest, sellPath]),
    call("vente +1 h", BUYER, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [rest, 0n, sellPath, BUYER, deadline + BigInt(LATER_S)]),
    call("WETH recu +1 h", BUYER, WETH, erc20, "balanceOf", [BUYER]),
  ];
  const sim = await simulate(url, block, [
    { time: now, calls: now1 },
    { time: now + BigInt(LATER_S), calls: later },
  ]);
  const r = Object.fromEntries([...now1, ...later].map((c, i) => [c.label, sim.results[i]]));

  if (owner && moved(r["transferFrom par owner()"])) {
    findings.push({ level: "block", text: `owner() ${owner} reprend les jetons par transferFrom sans approbation` });
  }
  if (moved(r["transferFrom par un inconnu"])) {
    findings.push({ level: "block", text: "n'importe qui reprend les jetons par transferFrom sans approbation" });
  }
  const quoted = (res: Result) => (uint(router, "getAmountsOut", res) as bigint[])[1];
  const loss = (got: bigint, expected: bigint) => (expected > 0n ? 1 - Number(got) / Number(expected) : 0);
  const buyTax = loss(amount, quoted(r["devis d'achat"]));
  let sold = 0n;
  if (!ok(r["vente immediate"])) {
    findings.push({ level: "block", text: `vente juste apres l'achat refusee (${revertReason(r["vente immediate"])})` });
  } else {
    sold = uint(erc20, "balanceOf", r["WETH recu"]) as bigint;
    const sellTax = loss(sold, quoted(r["devis de vente"]));
    const tax = Math.max(buyTax, sellTax);
    const pct = `${Math.round(tax * 100)} %`;
    if (tax >= TAX_BLOCK) findings.push({ level: "block", text: `taxe de ${pct} sur l'achat ou la vente` });
    else if (tax >= TAX_WARN) findings.push({ level: "warn", text: `taxe de ${pct} sur l'achat ou la vente` });
  }
  if (!ok(r["vente +1 h"])) {
    findings.push({ level: "block", text: `vente 1 h apres l'achat refusee (${revertReason(r["vente +1 h"])})` });
  }
  return report(chainId, block, sim, findings, [...now1, ...later].map((c) => c.label));
}

function report(
  chainId: number,
  block: bigint,
  sim: { request: unknown; results: Result[] },
  findings: Finding[],
  labels: string[] = [],
): Report {
  const verdict: Verdict = findings.some((f) => f.level === "block")
    ? "block"
    : findings.some((f) => f.level === "warn")
      ? "warn"
      : "allow";
  const reasons = findings.length ? findings.map((f) => f.text).join(" ; ") : "achat, reprise et ventes simulees sans anomalie";
  return {
    verdict,
    reasons: reasons.slice(0, 280),
    evidence: {
      chain_id: chainId,
      block: Number(block),
      method: "eth_simulateV1",
      request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
      calls: sim.results.map((res, i) => `${labels[i] ?? i}: ${ok(res) ? "ok" : "revert"}`),
    },
    request: sim.request,
    response: sim.results,
  };
}
