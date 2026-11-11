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
  return data === "0x" ? "revert sans raison" : data.slice(0, 18);
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
  const deadline = now + 10_000n;
  const buyPath = [WETH, token];
  const sellPath = [token, WETH];
  const balance = (label: string, of: Address) => call(label, buyer, of, erc20, "balanceOf", [buyer]);
  const buy = [
    balance("jetons avant achat", token),
    call("devis d'achat", buyer, ROUTER, router, "getAmountsOut", [BUY, buyPath]),
    call("achat 0.01 ETH", buyer, ROUTER, router, "swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, buyPath, buyer, deadline], BUY),
    balance("jetons apres achat", token),
    call("owner()", buyer, token, erc20, "owner", []),
  ];

  // 1re simulation : quantite achetee et proprietaire, pour construire la seconde.
  const first = await simulate(url, block, buyer, [{ time: now, calls: buy }]);
  const f = byLabel(buy, first.results);
  const findings: Finding[] = [];
  if (!ok(f["devis d'achat"])) findings.push({ level: "warn", text: "pas de pool V2 WETH : vente non verifiable" });
  else if (!ok(f["achat 0.01 ETH"])) findings.push({ level: "block", text: `achat simule en echec : ${revertReason(f["achat 0.01 ETH"])}` });
  const delta = (after: Result, before: Result) =>
    ok(after) && ok(before) ? (uint(erc20, "balanceOf", after) as bigint) - (uint(erc20, "balanceOf", before) as bigint) : 0n;
  const amount = delta(f["jetons apres achat"], f["jetons avant achat"]);
  const owner = ok(f["owner()"]) ? (uint(erc20, "owner", f["owner()"]) as Address) : null;
  if (findings.length || amount < 10n) {
    if (!findings.length) findings.push({ level: "block", text: "achat simule sans jeton recu" });
    return report(chainId, block, first, findings, buy.map((c) => c.label));
  }

  // 2e simulation, la preuve : reprises sans approbation, vente immediate, vente 1 h plus tard.
  const half = amount / 2n;
  const rest = amount - half - 2n; // 2 unites peut-etre reprises par les sondes transferFrom
  const now1 = [
    ...buy,
    ...(owner ? [call("transferFrom par owner()", owner, token, erc20, "transferFrom", [buyer, owner, 1n])] : []),
    call("transferFrom par un inconnu", stranger, token, erc20, "transferFrom", [buyer, stranger, 1n]),
    call("approve routeur", buyer, token, erc20, "approve", [ROUTER, maxUint256]),
    balance("WETH avant vente", WETH),
    call("devis de vente", buyer, ROUTER, router, "getAmountsOut", [half, sellPath]),
    call("vente immediate", buyer, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [half, 0n, sellPath, buyer, deadline]),
    balance("WETH apres vente", WETH),
  ];
  const later = [
    call("devis de vente +1 h", buyer, ROUTER, router, "getAmountsOut", [rest, sellPath]),
    call("vente +1 h", buyer, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [rest, 0n, sellPath, buyer, deadline + BigInt(LATER_S)]),
    balance("WETH apres vente +1 h", WETH),
  ];
  const sim = await simulate(url, block, buyer, [
    { time: now, calls: now1 },
    { time: now + BigInt(LATER_S), calls: later },
  ]);
  const r = byLabel([...now1, ...later], sim.results);

  if (owner && moved(r["transferFrom par owner()"])) {
    findings.push({ level: "block", text: `owner() ${owner} reprend les jetons par transferFrom sans approbation` });
  }
  if (moved(r["transferFrom par un inconnu"])) {
    findings.push({ level: "block", text: "n'importe qui reprend les jetons par transferFrom sans approbation" });
  }
  const quoted = (res: Result) => (ok(res) ? (uint(router, "getAmountsOut", res) as bigint[])[1] : 0n);
  // Sans devis, la taxe n'est pas mesurable : perte totale supposee, donc block (echec ferme).
  const loss = (got: bigint, expected: bigint) => (expected > 0n ? 1 - Number(got) / Number(expected) : 1);
  const taxed = (tax: number, when: string) => {
    const text = tax >= 1 ? `taxe non mesurable ${when} (devis du pool en echec)` : `taxe de ${Math.round(tax * 100)} % ${when}`;
    if (tax >= TAX_BLOCK) findings.push({ level: "block", text });
    else if (tax >= TAX_WARN) findings.push({ level: "warn", text });
  };
  taxed(loss(amount, quoted(r["devis d'achat"])), "a l'achat");
  if (!ok(r["vente immediate"])) {
    findings.push({ level: "block", text: `vente juste apres l'achat refusee (${revertReason(r["vente immediate"])})` });
  } else {
    taxed(loss(delta(r["WETH apres vente"], r["WETH avant vente"]), quoted(r["devis de vente"])), "sur la vente immediate");
  }
  if (!ok(r["vente +1 h"])) {
    findings.push({ level: "block", text: `vente 1 h apres l'achat refusee (${revertReason(r["vente +1 h"])})` });
  } else {
    taxed(loss(delta(r["WETH apres vente +1 h"], r["WETH apres vente"]), quoted(r["devis de vente +1 h"])), "sur la vente +1 h");
  }
  return report(chainId, block, sim, findings, [...now1, ...later].map((c) => c.label));
}

const byLabel = (calls: Call[], results: Result[]) => Object.fromEntries(calls.map((c, i) => [c.label, results[i]]));

function report(
  chainId: number,
  block: bigint,
  sim: { request: unknown; results: Result[] },
  findings: Finding[],
  labels: string[],
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
      calls: sim.results.map((res, i) => `${labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    },
    request: sim.request,
    response: sim.results,
  };
}
