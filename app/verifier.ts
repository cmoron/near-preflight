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
import { beforeBlock, reputationFindings, reputationOf, templateOf, type Index, type Reputation } from "./index";

export const ROUTER: Address = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Uniswap V2 Router02 (Base)
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const FACTORY: Address = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // Uniswap V2 factory (Base), ROUTER.factory()
/** Achat simule ; le devis poste est en jetons pour ce montant (QUOTE_WEI dans src/lib.rs). */
const BUY = parseEther("0.01");
/** Le premier bloc simule suit le bloc de la preuve, 2 s apres lui (rythme des blocs de Base) ;
 *  la premiere vente est simulee au bloc d'apres, encore 2 s plus tard. */
export const NEXT_S = 2n;
const LATER_S = 3600n; // timestamp of the late sale: one hour after the buy
// Sans prix du gaz ni limite par appel, eth_simulateV1 donne tx.gasprice = 0, block.basefee = 0 et
// gasleft() = limite du bloc : un jeton y reconnait la simulation et ne refuse que la vraie vente.
// Every call gets the gas limit the guard signs with (its evm_config, read per check): a token whose
// sale needs more gas than that passes a looser simulation and traps the real exit.
const TIP = 1_000_000n; // pourboire propose par mainnet.base.org (eth_maxPriorityFeePerGas)
export const FUND = parseEther("1"); // solde des sondes neuves, de quoi acheter et payer le gaz
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
/** Liquidity window, 1 h of 2 s Base blocks. Liquidity is "old" when at least OLD_BPS of today's LP
 *  supply already existed WINDOW_BLOCKS ago (totalSupply read at both blocks: two eth_call, no logs),
 *  whatever the age of the pair contract and the depth of the pool. Otherwise the LP holders are read
 *  from the pair's Transfer logs over the window (from its creation block if the pair is younger,
 *  found by bisecting eth_getCode): at most 4 eth_getLogs of LOG_CHUNK blocks. */
export const WINDOW_BLOCKS = 1800n;
const OLD_BPS = 9_000n;
/** eth_getLogs window: public RPCs refuse wide ranges. */
export const LOG_CHUNK = 500n;
/** More LP holder candidates than this: holders not read, which is a warn. */
const MAX_HOLDERS = 20;
/** Warn when at least half the LP can be removed now: past that, more than half the depth we would
 *  sell into can leave at the will of its holders (several wallets are summed: splitting LP across
 *  fresh wallets does not hide it). Removable is the normal state of most fresh launches, not proof
 *  of a rug: warn, the human decides; the template's history (app/index.ts) is what blocks. */
const REMOVABLE_WARN = 0.5;
const BURN_ADDRESSES = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];
const TRANSFER_TOPIC = keccak256(stringToHex("Transfer(address,address,uint256)"));

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

const pairAbi = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export type Verdict = "allow" | "warn" | "block";
type Call = { label: string; from: Address; to: Address; data: Hex; value?: Hex };
export type Result = { status: Hex; returnData: Hex; error?: { message?: string; data?: Hex } };
export type Finding = { level: Verdict; text: string };
export type Report = {
  verdict: Verdict;
  reasons: string;
  /** post_verdict's `list_target`: a block resting on the token's own simulation or liquidity, which
   *  the guard turns into a `token:` listing (judge). */
  list_target: boolean;
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
    /** Who can remove the pool's liquidity right now: facts read at `block` (liquidityFacts). */
    liquidity: Liquidity;
    /** Template of the target's code (app/index.ts templateOf). */
    template: Hex;
    /** What the index says of that template, null without an index for this chain. */
    reputation: Reputation | null;
    /** What the guard on NEAR said before the verdict: blocklist entries, code at the last verdict. */
    near: NearFacts;
    /** Gas limit of every simulated call: the guard's, which it also stores with the verdict. */
    gas_limit: number;
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
export function buildRequest(head: Header, balances: Record<string, bigint>, blocks: Block[], gas: bigint) {
  const baseFee = BigInt(head.baseFeePerGas);
  const env = { baseFeePerGas: toHex(baseFee), prevRandao: head.mixHash, feeRecipient: head.miner };
  const fees = { gas: toHex(gas), maxFeePerGas: toHex(2n * baseFee + TIP), maxPriorityFeePerGas: toHex(TIP) };
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
export async function balances(url: string, head: Header, buyer: Address, guard: Address, gas: bigint, full?: { stranger: Address; owner: Address | null }) {
  const out: Record<string, bigint> = { [buyer]: FUND, [guard]: FUND };
  if (!full) return out;
  out[full.stranger] = FUND;
  if (full.owner) {
    const need = gas * (2n * BigInt(head.baseFeePerGas) + TIP);
    if (BigInt(await rpc<Hex>(url, "eth_getBalance", [full.owner, head.number])) < need) out[full.owner] = FUND;
  }
  return out;
}

/** Simule des blocs successifs au-dessus de `head` ; renvoie la requete et un resultat par appel. */
async function simulate(url: string, head: Header, funds: Record<string, bigint>, blocks: Block[], gas: bigint) {
  const request = buildRequest(head, funds, blocks, gas);
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

/** An LP holder at the block: `burned` (0x0, 0xdead), `eoa` (no code, or an EIP-7702 delegation:
 *  still a key that can sign), `contract` (unlock terms not read: counted as removable). */
export type Holder = { address: Address; balance: string; kind: "burned" | "eoa" | "contract" };
/** The target's Uniswap V2 WETH pair at the block, null without one. `supply_before`: its LP supply
 *  WINDOW_BLOCKS earlier ("0" if the pair did not exist). `created`: the pair's creation block when
 *  it is younger than the window, else null. `holders`: LP holders at the block, from the window's
 *  Transfer recipients plus 0x0 and 0xdead; null when not read (old liquidity) or when there are
 *  more than MAX_HOLDERS `candidates`. Deterministic for a block: replay recomputes it. */
export type Liquidity = {
  pair: Address;
  supply: string;
  supply_before: string;
  created: number | null;
  candidates: number;
  holders: Holder[] | null;
} | null;

async function read(url: string, to: Address, fn: string, args: unknown[], block: bigint): Promise<any> {
  const data = encodeFunctionData({ abi: pairAbi, functionName: fn, args } as Parameters<typeof encodeFunctionData>[0]);
  const out = await rpc<Hex>(url, "eth_call", [{ to, data }, toHex(block)]);
  return decodeFunctionResult({ abi: pairAbi, functionName: fn, data: out } as Parameters<typeof decodeFunctionResult>[0]);
}
const codeAt = (url: string, a: Address, block: bigint) => rpc<Hex>(url, "eth_getCode", [a, toHex(block)]);
const isOld = (supply: bigint, before: bigint) => before * 10_000n >= supply * OLD_BPS;

/** Who can remove the liquidity of `token`'s V2 WETH pair at `block`, from public-RPC reads only:
 *  eth_call, eth_getCode, and eth_getLogs over the window only, never below the pair's creation. */
export async function liquidityFacts(url: string, token: Address, block: bigint): Promise<Liquidity> {
  const found = (await read(url, FACTORY, "getPair", [token, WETH], block)) as Address;
  if (BigInt(found) === 0n) return null;
  const pair = found.toLowerCase() as Address;
  const supply = (await read(url, pair, "totalSupply", [], block)) as bigint;
  const from = block - WINDOW_BLOCKS;
  const pairOld = from >= 0n && (await codeAt(url, pair, from)) !== "0x";
  const before = pairOld ? ((await read(url, pair, "totalSupply", [], from)) as bigint) : 0n;
  const base = { pair, supply: supply.toString(), supply_before: before.toString() };
  if (isOld(supply, before)) return { ...base, created: null, candidates: 0, holders: null };
  let start = from + 1n;
  if (!pairOld) {
    let [lo, hi] = [from < 0n ? -1n : from, block]; // no code at lo, code at hi
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await codeAt(url, pair, mid)) === "0x") lo = mid;
      else hi = mid;
    }
    start = hi;
  }
  const seen = new Set<Address>(BURN_ADDRESSES as Address[]);
  for (let s = start; s <= block; s += LOG_CHUNK) {
    const end = s + LOG_CHUNK - 1n < block ? s + LOG_CHUNK - 1n : block;
    const logs = await rpc<{ topics: Hex[] }[]>(url, "eth_getLogs", [{ address: pair, fromBlock: toHex(s), toBlock: toHex(end), topics: [TRANSFER_TOPIC] }]);
    for (const l of logs) seen.add(`0x${l.topics[2].slice(26)}` as Address);
  }
  const created = pairOld ? null : Number(start);
  const candidates = [...seen].sort();
  if (candidates.length > MAX_HOLDERS) return { ...base, created, candidates: candidates.length, holders: null };
  const holders: Holder[] = [];
  for (const address of candidates) {
    const balance = (await read(url, pair, "balanceOf", [address], block)) as bigint;
    if (balance === 0n) continue;
    const code = BURN_ADDRESSES.includes(address) ? "" : await codeAt(url, address, block);
    const kind = code === "" ? "burned" : code === "0x" || code.startsWith("0xef0100") ? "eoa" : "contract";
    holders.push({ address, balance: balance.toString(), kind });
  }
  holders.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : a.address < b.address ? -1 : 1));
  return { ...base, created, candidates: candidates.length, holders };
}

/** Short address for reasons (ASCII: the guard counts reasons in bytes). */
export const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

/** The liquidity rule (WINDOW_BLOCKS, REMOVABLE_WARN): old liquidity passes on its age; otherwise
 *  holders must be read and add up to the supply, or it is a warn. Pure: replay rejudges it. */
export function liquidityFindings(l: Liquidity, block: number): Finding[] {
  if (!l || BigInt(l.supply) === 0n) return []; // no pool or an empty one: the simulated buy says so
  const supply = BigInt(l.supply);
  if (isOld(supply, BigInt(l.supply_before))) return [];
  const pct = (x: bigint) => Math.round((Number(x) / Number(supply)) * 100);
  const age = l.created !== null ? `pool ${block - l.created} blocks old` : `${pct(supply - BigInt(l.supply_before))} % of the LP minted in the last ${WINDOW_BLOCKS} blocks`;
  if (!l.holders) return [{ level: "warn", text: `${age}: LP spread over ${l.candidates} addresses, holders not read` }];
  const sum = (hs: Holder[]) => hs.reduce((n, h) => n + BigInt(h.balance), 0n);
  if (sum(l.holders) !== supply) return [{ level: "warn", text: `${age}: LP holders not all accounted for (${pct(sum(l.holders))} % of the supply)` }];
  const removable = l.holders.filter((h) => h.kind !== "burned");
  if (Number(sum(removable)) / Number(supply) < REMOVABLE_WARN) return [];
  const top = removable[0];
  return [{ level: "warn", text: `${age}: ${pct(sum(removable))} % of the LP removable now (${top.kind === "eoa" ? "EOA" : "contract"} ${short(top.address)} holds ${pct(BigInt(top.balance))} %)` }];
}

/** Implementation derriere un proxy (EIP-1967, puis ZeppelinOS) au bloc, sinon null. */
export async function implementationAt(url: string, token: Address, block: bigint): Promise<Address | null> {
  for (const slot of IMPL_SLOTS) {
    const word = await rpc<Hex>(url, "eth_getStorageAt", [token, slot, toHex(block)]);
    if (BigInt(word) !== 0n) return `0x${word.slice(-40)}`.toLowerCase() as Address;
  }
  return null;
}

/** The target's blocklist entry read from the guard (`get_entry`): the guard lists tokens only. */
export type Listing = { key: string; reporter: string; evidence_sha256: string };
/** What the guard on NEAR says about the target: its blocklist entries, and the code its last verdict
 *  saw (`last_code`), null if never judged. */
export type NearFacts = { listed: Listing[]; previous: { id: number; code_hash: Hex; implementation: Address | null } | null };
/** What the sentinel knows beside the EVM chain: the template index it loaded (app/index.ts), a
 *  reader of the guard's blocklist entry and last code for a target, and the gas limit the guard
 *  signs with (evm_config), which every simulated call gets. */
export type Context = { index: Index | null; near: (target: Address) => Promise<NearFacts>; gas: bigint };

/** Listed on NEAR: block. Code (or proxy implementation) changed since the last verdict: warn, the
 *  human decides (the guard refuses an allow on changed code anyway). */
export function nearFindings(n: NearFacts, codeHash: Hex, implementation: Address | null): Finding[] {
  const out: Finding[] = n.listed.map((l) => ({ level: "block", text: `listed on NEAR by ${l.reporter}` }));
  const p = n.previous;
  const same = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  if (p && !(same(p.code_hash, codeHash) && same(p.implementation, implementation))) out.push({ level: "warn", text: `code changed since the last check #${p.id}` });
  return out;
}

/** Simulates buying `token` as two buyers, the probe and `guard` (the guard's EVM address); `probes`
 *  gets the block simulated on (the sentinel passes deriveProbes of its ticket). */
export async function checkToken(url: string, token: Address, guard: Address, probes: (head: Header) => Probe, ctx: Context): Promise<Report> {
  const head = await rpc<Header>(url, "eth_getBlockByNumber", ["latest", false]);
  const probe = probes(head);
  const { buyer, stranger } = probe;
  const block = BigInt(head.number);
  const now = probe.time ?? BigInt(head.timestamp) + NEXT_S;
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const code = await rpc<Hex>(url, "eth_getCode", [token, toHex(block)]);
  const implementation = await implementationAt(url, token, block);
  const liquidity = await liquidityFacts(url, token, block);
  const template = templateOf(code);
  const reputation = ctx.index?.chain_id === chainId ? reputationOf(ctx.index, template, beforeBlock(ctx.index, liquidity?.pair ?? null)) : null;
  const near = await ctx.near(token);
  const proof = { chain_id: chainId, block, code_hash: keccak256(code), implementation, liquidity, template, reputation, near, gas_limit: Number(ctx.gas) };
  const [first1] = plan(token, buyer, guard, block, now);

  // 1re simulation : quantites achetees et proprietaire, pour construire la seconde.
  const first = await simulate(url, head, await balances(url, head, buyer, guard, ctx.gas), [first1], ctx.gas);
  const buyLabels = first1.calls.map((c) => c.label);
  const st = buyStages(byLabel(buyLabels, first.results));
  if (st.stop) return report(proof, first, buyLabels);

  const blocks = plan(token, buyer, guard, block, now, { stranger, amounts: st.amounts, owner: st.owner });
  const sim = await simulate(url, head, await balances(url, head, buyer, guard, ctx.gas, { stranger, owner: st.owner }), blocks, ctx.gas);
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
 *  probe buyer does not share are reported as "guard address only, not listed: ...". */
export function judge(labels: string[], results: Result[], facts: Facts): { verdict: Verdict; reasons: string; list_target: boolean } {
  const r = byLabel(labels, results);
  const { stop } = buyStages(r);
  const findings = sideFindings(r, "", stop);
  // Only a block on the probe side lists the token: the probes are fresh addresses derived from a
  // block hash, so their findings are the token's own behaviour. The guard's address is public and a
  // third party can change its state (send it tokens, get it frozen): a failure there blocks this
  // check but lists nothing. Template reputation can be poisoned by copies; it never lists either.
  const list_target = findings.some((f) => f.level === "block");
  const seen = new Set(findings.map((f) => f.text));
  for (const f of sideFindings(r, GUARD, stop)) if (!seen.has(f.text)) findings.push({ ...f, text: `guard address only, not listed: ${f.text}` });
  findings.push(...liquidityFindings(facts.liquidity, facts.block));
  findings.unshift(...nearFindings(facts.near, facts.code_hash, facts.implementation), ...reputationFindings(facts.reputation));
  const rank = (f: Finding) => (f.level === "block" ? 0 : 1);
  findings.sort((a, b) => rank(a) - rank(b)); // stable: blocks first, so the 280-byte cut keeps them
  const verdict: Verdict = findings.some((f) => f.level === "block") ? "block" : findings.some((f) => f.level === "warn") ? "warn" : "allow";
  const reasons = findings.length ? findings.map((f) => f.text).join(" ; ") : "buy, takeback probes and sales simulated without anomaly";
  return { verdict, reasons: reasons.slice(0, 280), list_target };
}

/** Devis poste avec le verdict : jetons recus par l'achat simule de 0,01 ETH (0 sans achat), tire de
 *  la reponse seule, donc rejouable (voir app/replay.ts). */
export function quoteOf(labels: string[], results: Result[]): bigint {
  const { amount } = buyStage(byLabel(labels, results));
  return amount > 0n ? amount : 0n;
}

export const byLabel = (labels: string[], results: Result[]) => Object.fromEntries(labels.map((l, i) => [l, results[i]]));

/** Facts beside the simulation that the verdict rests on, all in the evidence. */
export type Facts = Pick<Report["evidence"], "block" | "code_hash" | "implementation" | "liquidity" | "reputation" | "near">;

function report(
  proof: Omit<Facts, "block"> & { chain_id: number; block: bigint; template: Hex; gas_limit: number },
  sim: { request: Report["request"]; results: Result[] },
  labels: string[],
): Report {
  const { verdict, reasons, list_target } = judge(labels, sim.results, { ...proof, block: Number(proof.block) });
  const evidence = {
    chain_id: proof.chain_id,
    block: Number(proof.block),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
    gas_limit: proof.gas_limit,
    code_hash: proof.code_hash,
    implementation: proof.implementation,
    calls: sim.results.map((res, i) => `${labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: quoteOf(labels, sim.results).toString(),
    liquidity: proof.liquidity,
    template: proof.template,
    reputation: proof.reputation,
    near: proof.near,
  };
  if (JSON.stringify(evidence).length > 8000) throw new Error("evidence above 8000 characters");
  return { verdict, reasons, list_target, evidence, request: sim.request, response: sim.results };
}

/** Exit quote: the guard's EVM address sells `amount` of the token it holds, in one simulated block
 *  over the latest one (its real token balance, ETH topped up for gas). The quote is the WETH out:
 *  the guard sets the agent's floor from it. */
export function exitPlan(token: Address, guard: Address, amount: bigint, now: bigint): Block[] {
  const path = [token, WETH];
  return [
    {
      time: now,
      calls: [
        call("WETH before exit", guard, WETH, erc20, "balanceOf", [guard]),
        call("approve router", guard, token, erc20, "approve", [ROUTER, amount]),
        call("exit quote", guard, ROUTER, router, "getAmountsOut", [amount, path]),
        call("exit sale", guard, ROUTER, router, "swapExactTokensForTokensSupportingFeeOnTransferTokens", [amount, 0n, path, guard, now + 10_000n]),
        call("WETH after exit", guard, WETH, erc20, "balanceOf", [guard]),
      ],
    },
  ];
}

export type ExitReport = {
  verdict: Verdict;
  reasons: string;
  evidence: { kind: "exit"; chain_id: number; block: number; method: "eth_simulateV1"; request_sha256: Hex; gas_limit: number; amount: string; calls: string[]; quote: string };
  request: Report["request"];
  response: Result[];
};

/** Pure: allow with the WETH out of the simulated sale, or block without a quote. */
export function judgeExit(labels: string[], results: Result[]): { verdict: Verdict; reasons: string; quote: bigint } {
  const r = byLabel(labels, results);
  if (!ok(r["exit sale"])) return { verdict: "block", reasons: `exit sale fails in simulation (${revertReason(r["exit sale"])}): no quote`, quote: 0n };
  const quote = delta(r["WETH after exit"], r["WETH before exit"]);
  if (quote <= 0n) return { verdict: "block", reasons: "exit sale simulated but yields no ETH: no quote", quote: 0n };
  return { verdict: "allow", reasons: "exit sale from the guard's address simulated: quote = its ETH out", quote };
}

/** `gas`: the guard's gas limit, the one its approve and swap will be signed with. */
export async function checkExit(url: string, token: Address, guard: Address, amount: bigint, gas: bigint): Promise<ExitReport> {
  const head = await rpc<Header>(url, "eth_getBlockByNumber", ["latest", false]);
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const blocks = exitPlan(token, guard, amount, BigInt(head.timestamp) + NEXT_S);
  const sim = await simulate(url, head, { [guard]: FUND }, blocks, gas);
  const labels = blocks[0].calls.map((c) => c.label);
  const { verdict, reasons, quote } = judgeExit(labels, sim.results);
  const evidence = {
    kind: "exit" as const,
    chain_id: chainId,
    block: Number(BigInt(head.number)),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
    gas_limit: Number(gas),
    amount: amount.toString(),
    calls: sim.results.map((res, i) => `${labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: quote.toString(),
  };
  return { verdict, reasons, evidence, request: sim.request, response: sim.results };
}

/** Fichier proofs/<id>.json : `evidence` y est la chaine exacte postee a post_verdict, dont le
 *  contrat stocke le sha256 ; app/replay.ts la relit telle quelle. */
export type ProofFile = Omit<Report, "evidence" | "list_target"> & { id: number; target: string; evidence: string };

export function toProof(id: number, target: string, r: Report | ExitReport): ProofFile {
  return { id, target, verdict: r.verdict, reasons: r.reasons, evidence: JSON.stringify(r.evidence), request: r.request, response: r.response };
}

/** `special()` of a demo token: for guard_frozen, the guard EVM address that evm/fork.sh made it freeze. */
export async function specialOf(url: string, token: Address): Promise<Address> {
  const data = encodeFunctionData({ abi: parseAbi(["function special() view returns (address)"]), functionName: "special" });
  return `0x${(await rpc<Hex>(url, "eth_call", [{ to: token, data }, "latest"])).slice(-40)}` as Address;
}
