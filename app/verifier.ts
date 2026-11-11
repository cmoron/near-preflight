// Pre-buy sentinel: checks by read-only simulation (eth_simulateV1) on an
// EVM chain, Uniswap V2 route WETH -> token. Nothing is signed or sent on the EVM chain.
import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  keccak256,
  encodeFunctionData,
  parseAbi,
  parseEther,
  parseTransaction,
  sha256,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { beforeBlock, ownAfterIndex, reputationFindings, reputationOf, templateOf, type Index, type Reputation } from "./index";

export const ROUTER: Address = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Uniswap V2 Router02 (Base)
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const FACTORY: Address = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // Uniswap V2 factory (Base), ROUTER.factory()
/** The first simulated block follows the proof's block, 2 s after it (Base's block rate);
 *  the first sale is simulated in the next block, 2 s later again. */
export const NEXT_S = 2n;
export const LATER_S = 3600n; // timestamp of the late sale: one hour after the buy
// What the guard signs is what the guard side simulates: its buy, approves and swaps are the unsigned
// transactions the contract builds (preview_check, preview_sale), sent as is from its address (same
// calldata, value, nonce, gas limit and fees). Every other call gets the same gas limit and fees:
// without them eth_simulateV1 gives tx.gasprice = 0, block.basefee = 0 and gasleft() = block limit,
// where a token recognizes the simulation and refuses only the real sale.
export const FUND = parseEther("1"); // balance of the fresh probes beyond the amount bought, for their gas
// eth_simulateV1 refuses more than 256 blocks above the base block: the late sale is 256 blocks
// ahead (about 8.5 min of 2 s Base blocks, 1800 blocks would be 1 h) with its timestamp 1 h ahead. A
// token counting blocks sees 8.5 min, one reading the timestamp sees 1 h.
const MAX_BLOCKS = 256n;
/** The late sale in verdict reasons: what the simulation really does, not "1 h". */
const LATE = "256 blocks (timestamp +1 h) after the buy";
// Slots of a proxy's implementation address: EIP-1967, then ZeppelinOS (USDC).
const IMPL_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
];
const TAX_WARN = 0.1; // loss beyond the pool's quote: warn at 10 %, block at 50 %
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
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);
/** The three functions the guard signs: the buy, an exit's approve, an exit's swap. */
const signed = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
  "function approve(address,uint256) returns (bool)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);

const pairAbi = parseAbi([
  "function getPair(address,address) view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export type Verdict = "allow" | "warn" | "block";
/** A simulated call. `nonce` only on the guard's own transactions, which carry the nonce they are signed at. */
type Call = { label: string; from: Address; to: Address; data: Hex; value?: bigint; nonce?: number };
/** Gas limit and fee fields of every simulated call: those of the guard's own transactions (evm_config). */
export type Fees = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type Result = { status: Hex; returnData: Hex; error?: { message?: string; data?: Hex } };
export type Finding = { level: Verdict; text: string };
export type Report = {
  verdict: Verdict;
  reasons: string;
  /** post_verdict's `list_target`: a block resting on the token's own simulation or liquidity, which
   *  the guard turns into a `token:` listing (judge). */
  list_target: boolean;
  /** Digest posted on chain (<= 8000 characters). */
  evidence: {
    chain_id: number;
    block: number;
    method: "eth_simulateV1";
    request_sha256: Hex;
    /** keccak256 of the target's code at the check's block. */
    code_hash: Hex;
    /** Implementation behind a proxy (EIP-1967 or ZeppelinOS), otherwise null. */
    implementation: Address | null;
    calls: string[];
    /** The buy the agent stated at request_check, in wei (decimal): the amount simulated. */
    amount_wei: string;
    /** Quote: tokens the guard's address received in its simulated buy (decimal, "0" without a buy); the
     *  guard's swap minimum is this quote minus its slippage bound. */
    quote: string;
    /** keccak256 of the guard's unsigned buy as simulated (the MPC payload): the guard signs only it. */
    tx_hashes: Hex[];
    /** Who can remove the pool's liquidity right now: facts read at `block` (liquidityFacts). */
    liquidity: Liquidity;
    /** Template of the target's code (app/index.ts templateOf). */
    template: Hex;
    /** What the index says of that template, null without an index for this chain. */
    reputation: Reputation | null;
    /** What the guard on NEAR said before the verdict: blocklist entries, code at the last verdict. */
    near: NearFacts;
  };
  /** Full request and response, to replay the simulation at the same block. */
  request: { method: string; params: unknown[] };
  response: Result[];
};

function call(label: string, from: Address, to: Address, abi: Abi, functionName: string, args: unknown[]): Call {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  return { label, from, to, data };
}

/** One of the guard's transactions (unsigned EIP-1559, `0x` + hex, as preview_check and preview_sale
 *  return it) as a call from the guard's address, its fee fields and its keccak256 (the MPC payload). */
export function guardTx(label: string, from: Address, unsigned: Hex): { call: Call; fees: Fees; hash: Hex } {
  const t = parseTransaction(unsigned);
  if (t.type !== "eip1559" || !t.to || t.gas === undefined || t.maxFeePerGas === undefined || t.maxPriorityFeePerGas === undefined) {
    throw new Error(`${label}: not an unsigned EIP-1559 transaction of the guard`);
  }
  return {
    call: { label, from, to: t.to, data: t.data ?? "0x", ...(t.value ? { value: t.value } : {}), nonce: t.nonce ?? 0 },
    fees: { gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas },
    hash: keccak256(unsigned),
  };
}

/** The probe's twin of one of the guard's calls: same function, path and deadline, the probe as
 *  recipient, no minimum, and its own `amount` for an approve or a sale. */
function asProbe(c: Call, label: string, probe: Address, amount = 0n): Call {
  const { functionName, args } = decodeFunctionData({ abi: signed, data: c.data });
  const a = [...args] as unknown[];
  if (functionName === "approve") a[1] = amount;
  else if (functionName === "swapExactETHForTokensSupportingFeeOnTransferTokens") [a[0], a[2]] = [0n, probe];
  else [a[0], a[1], a[3]] = [amount, 0n, probe];
  const data = encodeFunctionData({ abi: signed, functionName, args: a } as Parameters<typeof encodeFunctionData>[0]);
  return { label, from: probe, to: c.to, data, ...(c.value ? { value: c.value } : {}) };
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(Number(process.env.RPC_TIMEOUT_MS ?? 20_000)), // never wait forever
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method} : ${body.error?.message ?? res.status}`);
  return body.result;
}

export type Block = { number?: bigint; time: bigint; calls: Call[] };
/** Real block on top of which we simulate: its base fee, prevrandao and coinbase are reused, the
 *  node would otherwise set them to zero (prevrandao, base fee) in the simulated blocks. */
export type Header = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex; mixHash: Hex; miner: Address };

/** Full eth_simulateV1 request, as sent and saved in the proof. Every call gets `fees`, the guard's own;
 *  value and nonce are hex when present. */
export function buildRequest(head: Header, balances: Record<string, bigint>, blocks: Block[], fees: Fees) {
  const env = { baseFeePerGas: toHex(BigInt(head.baseFeePerGas)), prevRandao: head.mixHash, feeRecipient: head.miner };
  const f = { gas: toHex(fees.gas), maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas) };
  const request = {
    blockStateCalls: blocks.map((b, i) => ({
      blockOverrides: { ...(b.number ? { number: toHex(b.number) } : {}), time: toHex(b.time), ...env },
      ...(i === 0 ? { stateOverrides: Object.fromEntries(Object.entries(balances).map(([a, v]) => [a, { balance: toHex(v) }])) } : {}),
      calls: b.calls.map(({ label: _, value, nonce, ...c }) => ({
        ...c,
        ...(value ? { value: toHex(value) } : {}),
        ...(nonce === undefined ? {} : { nonce: toHex(nonce) }),
        ...f,
      })),
    })),
    validation: false,
  };
  return { method: "eth_simulateV1", params: [request, toHex(BigInt(head.number))] };
}

/** Balances set by the simulation. The guard's EVM address keeps its real balance when it covers what
 *  its calls spend (the amount bought and every call's gas at the max fee), else gets exactly that. The
 *  fresh probes get the amount plus FUND for gas; owner() is topped up only if it cannot pay the gas of
 *  its call, otherwise its real balance stays (a real owner() pays its gas too). */
export async function balances(
  url: string,
  head: Header,
  side: { buyer: Address; guard: Address; amount: bigint; fees: Fees; guardCalls: number },
  full?: { stranger: Address; owner: Address | null },
) {
  const perCall = side.fees.gas * side.fees.maxFeePerGas;
  const out: Record<string, bigint> = { [side.buyer]: FUND + side.amount };
  Object.assign(out, await topUp(url, head, side.guard, side.amount + BigInt(side.guardCalls) * perCall));
  if (!full) return out;
  out[full.stranger] = FUND;
  if (full.owner && Object.keys(await topUp(url, head, full.owner, perCall)).length) out[full.owner] = FUND;
  return out;
}

/** `who` keeps its real balance at the block if it has `need`, else gets exactly `need`. */
export async function topUp(url: string, head: Header, who: Address, need: bigint): Promise<Record<string, bigint>> {
  return BigInt(await rpc<Hex>(url, "eth_getBalance", [who, head.number])) < need ? { [who]: need } : {};
}

/** Number of calls `who` sends in `blocks`. */
export const callsBy = (blocks: Block[], who: Address) => blocks.flatMap((b) => b.calls).filter((c) => c.from.toLowerCase() === who.toLowerCase()).length;

/** Simulates successive blocks on top of `head`; returns the request and one result per call. */
async function simulate(url: string, head: Header, funds: Record<string, bigint>, blocks: Block[], fees: Fees) {
  const request = buildRequest(head, funds, blocks, fees);
  const out = await rpc<{ calls: Result[] }[]>(url, request.method, request.params);
  return { request, results: out.flatMap((b) => b.calls) };
}

/** Label prefix of the calls made as the guard's own EVM address (the real buyer); the probe
 *  buyer's calls have none. A token that targets the guard's public address shows up on this side. */
export const GUARD = "guard: ";

/** Tokens each side received from its simulated buy. */
export type Amounts = { guard: bigint; probe: bigint };
/** The guard's own transactions a check simulates, unsigned as the contract builds them: its buy of
 *  the check's amount (preview_check) and, for the full proof, its two sales (preview_sale: approve of
 *  the exact amount then swapExactTokensForETH back to its address; half, then the rest). */
export type GuardTxs = { buy: Hex; sales?: [Hex[], Hex[]] };
/** The guard's sale amounts after buying `amount` tokens: half, then the rest less the 2 units the
 *  transferFrom probes may have taken back. */
export const saleAmounts = (amount: bigint): [bigint, bigint] => [amount / 2n, amount - amount / 2n - 2n];
/** Suffixes of the two sales' labels. */
const SALES = [" in next block", " +256 blocks"] as const;

/** The blocks to simulate. Without `full`: the buy alone (1st simulation). With `full` (stranger,
 *  amounts bought, owner and pair, read in the 1st simulation): the complete proof in three blocks, buy +
 *  takebacks without approval, sale of half in the next block, sale of the rest 256 blocks (timestamp
 *  +1 h) later, each sale an approve of its exact amount then the swap to ETH, as the guard signs them.
 *  Every step runs twice in the same blocks: first as the guard's EVM address, with the guard's own
 *  transactions as is (its buy meets the block's real state), then as the probe buyer with their
 *  twins (asProbe). Shared with app/replay.ts, which rebuilds the expected request this way. */
export function plan(
  token: Address,
  buyer: Address,
  guard: Address,
  block: bigint,
  now: bigint,
  amount: bigint,
  txs: GuardTxs,
  full?: { stranger: Address; amounts: Amounts; owner: Address | null; pair: Address },
): Block[] {
  const buyPath = [WETH, token];
  const sellPath = [token, WETH];
  const sides: [string, Address][] = [[GUARD, guard], ["", buyer]];
  const each = (f: (p: string, who: Address) => Call[]) => sides.flatMap(([p, who]) => f(p, who));
  const balance = (p: string, who: Address, label: string, of: Address) => call(p + label, who, of, erc20, "balanceOf", [who]);
  const guardBuy = guardTx(`${GUARD}buy`, guard, txs.buy).call;
  const buy = each((p, who) => [
    balance(p, who, "tokens before buy", token),
    call(`${p}buy quote`, who, ROUTER, router, "getAmountsOut", [amount, buyPath]),
    p === GUARD ? guardBuy : asProbe(guardBuy, "buy", who),
    balance(p, who, "tokens after buy", token),
    call(`${p}owner()`, who, token, erc20, "owner", []),
  ]);
  if (!full) return [{ time: now, calls: buy }];
  const { stranger, amounts, owner, pair } = full;
  if (!txs.sales) throw new Error("the full proof needs the guard's two sales");
  const block1 = [
    ...buy,
    ...each((p, who) => [
      ...(owner ? [call(`${p}transferFrom by owner()`, owner, token, erc20, "transferFrom", [who, owner, 1n])] : []),
      call(`${p}transferFrom by a stranger`, stranger, token, erc20, "transferFrom", [who, stranger, 1n]),
    ]),
  ];
  const sale = (i: 0 | 1) =>
    each((p, who) => {
      const when = SALES[i];
      const x = saleAmounts(p === GUARD ? amounts.guard : amounts.probe)[i];
      const [approve, swap] = txs.sales![i].map((t, j) => guardTx(`${GUARD}${j ? "sale" : "approve router"}${when}`, guard, t).call);
      const pairWeth = (label: string) => call(`${p}pair WETH ${label}${when}`, who, WETH, erc20, "balanceOf", [pair]);
      return [
        pairWeth("before sale"),
        call(`${p}sale quote${when}`, who, ROUTER, router, "getAmountsOut", [x, sellPath]),
        p === GUARD ? approve : asProbe(approve, `approve router${when}`, who, x),
        p === GUARD ? swap : asProbe(swap, `sale${when}`, who, x),
        pairWeth("after sale"),
      ];
    });
  return [
    { time: now, calls: block1 },
    { time: now + NEXT_S, calls: sale(0) },
    { number: block + MAX_BLOCKS, time: now + LATER_S, calls: sale(1) },
  ];
}

export const ok = (r: Result) => r.status === "0x1";
const uint = (abi: Abi, fn: string, r: Result) => decodeFunctionResult({ abi, functionName: fn, data: r.returnData } as Parameters<typeof decodeFunctionResult>[0]);

/** Reason of an `Error(string)` revert (in `error.data` or `returnData` depending on the node). */
function revertReason(r: Result): string {
  const data = r.error?.data ?? r.returnData;
  if (data.startsWith("0x08c379a0")) return decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`)[0];
  return data === "0x" ? "revert without reason" : data.slice(0, 18);
}

/** True if a transferFrom without approval moved tokens (success and no `false` returned). */
function moved(r: Result): boolean {
  if (!ok(r)) return false;
  return r.returnData === "0x" || (uint(erc20, "transferFrom", r) as boolean);
}

/** Probe addresses and time of the first simulated block. Only tests impose the time (forged
 *  but consistent proofs); the sentinel derives the probes (deriveProbes) and starts at block + 2 s. */
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

/** Implementation behind a proxy (EIP-1967, then ZeppelinOS) at the block, otherwise null. */
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
/** The guard's own transactions for a check, read from the guard (unsigned EIP-1559 hex): `check` is
 *  preview_check(id, quote), what buy or sell_quoted would sign with that quote; `sale` is
 *  preview_sale(token, amount, deadline), an exit's approve and swap. Tests pass a local builder. */
export type Previews = { check: (quote: bigint) => Promise<Hex[]>; sale: (amount: bigint, deadline: bigint) => Promise<Hex[]> };
/** What the sentinel knows beside the EVM chain: the template index it loaded (app/index.ts), a
 *  reader of the guard's blocklist entry and last code for a target, the amount the agent asked to
 *  buy (request_check), and the guard's previews of what it would sign. */
export type Context = { index: Index | null; near: (target: Address) => Promise<NearFacts>; amount: bigint; preview: Previews };

/** The fee fields shared by every preview of a check; a disagreement is a broken guard, never simulated. */
function sameFees(txs: Hex[]): Fees {
  const all = txs.map((t) => guardTx("preview", NOBODY, t).fees);
  if (all.some((f) => JSON.stringify(f, (_, v) => String(v)) !== JSON.stringify(all[0], (_, v) => String(v)))) throw new Error("the guard's previews disagree on gas or fees");
  return all[0];
}
const NOBODY: Address = "0x0000000000000000000000000000000000000000";

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
  const own = liquidity?.pair ?? null;
  const reputation = ctx.index?.chain_id === chainId ? reputationOf(ctx.index, template, beforeBlock(ctx.index, own, await ownAfterIndex(url, ctx.index, own))) : null;
  const near = await ctx.near(token);
  const amount = ctx.amount;
  const proof = { chain_id: chainId, block, code_hash: keccak256(code), implementation, liquidity, template, reputation, near, amount_wei: amount.toString() };

  // 1st simulation: the buy alone, the guard's with no minimum (quote 0), for the amounts bought and owner().
  const [buy0] = await ctx.preview.check(0n);
  const first1 = plan(token, buyer, guard, block, now, amount, { buy: buy0 });
  const side = { buyer, guard, amount, fees: sameFees([buy0]) };
  const first = await simulate(url, head, await balances(url, head, { ...side, guardCalls: callsBy(first1, guard) }), first1, side.fees);
  const buyLabels = first1[0].calls.map((c) => c.label);
  const st = buyStages(byLabel(buyLabels, first.results));
  if (st.stop || !liquidity) return report(proof, first, buyLabels, [keccak256(buy0)]);

  // 2nd simulation: the guard's buy as it would be signed on this quote (minimum = quote - slippage),
  // then its two sales as it would sign them.
  const [buy] = await ctx.preview.check(st.amounts.guard);
  const deadline = now + LATER_S + 10_000n;
  const [half, rest] = saleAmounts(st.amounts.guard);
  const sales: [Hex[], Hex[]] = [await ctx.preview.sale(half, deadline), await ctx.preview.sale(rest, deadline)];
  const fees = sameFees([buy, ...sales.flat()]);
  const blocks = plan(token, buyer, guard, block, now, amount, { buy, sales }, { stranger, amounts: st.amounts, owner: st.owner, pair: liquidity.pair });
  const funds = await balances(url, head, { ...side, fees, guardCalls: callsBy(blocks, guard) }, { stranger, owner: st.owner });
  const sim = await simulate(url, head, funds, blocks, fees);
  return report(proof, sim, blocks.flatMap((b) => b.calls.map((c) => c.label)), [keccak256(buy)]);
}

/** Buy phase of one side (prefix "" or GUARD): amount received, owner, first findings.
 *  Empty `findings` = we can continue. */
export function buyStage(f: Record<string, Result>, p = "") {
  const findings: Finding[] = [];
  if (!ok(f[`${p}buy quote`])) findings.push({ level: "warn", text: "no liquidity: no Uniswap V2 WETH pair, sale not verifiable" });
  else if (!ok(f[`${p}buy`])) findings.push({ level: "block", text: `simulated buy failed: ${revertReason(f[`${p}buy`])}` });
  const amount = delta(f[`${p}tokens after buy`], f[`${p}tokens before buy`]);
  const o = f[`${p}owner()`];
  const owner = ok(o) && o.returnData !== "0x" ? (uint(erc20, "owner", o) as Address) : null;
  if (!findings.length && amount < 10n) findings.push({ level: "block", text: "simulated buy received no tokens" });
  return { findings, amount, owner };
}

/** Both buy stages: a finding on either side stops the check after the buy. */
export function buyStages(f: Record<string, Result>) {
  const [b, g] = [buyStage(f), buyStage(f, GUARD)];
  return { stop: b.findings.length + g.findings.length > 0, amounts: { guard: g.amount, probe: b.amount } as Amounts, owner: b.owner };
}

// An address without code answers "0x" to balanceOf: zero balance, not a decoding error.
const bal = (r: Result) => (ok(r) && r.returnData !== "0x" ? (uint(erc20, "balanceOf", r) as bigint) : 0n);
const delta = (after: Result, before: Result) => (ok(after) && ok(before) ? bal(after) - bal(before) : 0n);
/** ETH a sale paid out: the WETH that left the pair (the router unwraps it all to the seller). */
const paidOut = (before: Result, after: Result) => (ok(after) && ok(before) ? bal(before) - bal(after) : 0n);

/** Findings of one side (prefix "" or GUARD): buy, takebacks, sales. */
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
  // Without a quote, the tax cannot be measured: total loss assumed, hence block (fail closed).
  const loss = (got: bigint, expected: bigint) => (expected > 0n ? 1 - Number(got) / Number(expected) : 1);
  const taxed = (tax: number, when: string) => {
    const text = tax >= 1 ? `tax not measurable ${when} (pool quote failed)` : `${Math.round(tax * 100)} % tax ${when}`;
    if (tax >= TAX_BLOCK) findings.push({ level: "block", text });
    else if (tax >= TAX_WARN) findings.push({ level: "warn", text });
  };
  taxed(loss(amount, quoted(r[`${p}buy quote`])), "on the buy");
  // Per sale: when it is refused, when it is taxed (reason texts).
  const when = [["in the next block after the buy", "in the next block"], [LATE, LATE]];
  SALES.forEach((s, i) => {
    const sale = r[`${p}sale${s}`];
    if (!ok(sale)) findings.push({ level: "block", text: `sale refused ${when[i][0]} (${revertReason(sale)})` });
    else taxed(loss(paidOut(r[`${p}pair WETH before sale${s}`], r[`${p}pair WETH after sale${s}`]), quoted(r[`${p}sale quote${s}`])), `on the sale ${when[i][1]}`);
  });
  return findings;
}

/** Pure judgment: depends only on the call labels and their results, hence replayable
 *  by anyone from a proof (see app/replay.ts). The guard side's findings that the
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
  const rank = { block: 0, warn: 1, allow: 2 }; // an "allow" finding is a note: it changes no verdict
  findings.sort((a, b) => rank[a.level] - rank[b.level]); // stable: blocks first, so the 280-byte cut keeps them
  const verdict: Verdict = findings.some((f) => f.level === "block") ? "block" : findings.some((f) => f.level === "warn") ? "warn" : "allow";
  const texts = findings.map((f) => f.text);
  if (verdict === "allow") texts.unshift("buy, takeback probes and sales simulated without anomaly");
  return { verdict, reasons: texts.join(" ; ").slice(0, 280), list_target };
}

/** Quote posted with the verdict: tokens the guard's address received in its simulated buy of the
 *  check's amount (0 without a buy), taken from the response alone, hence replayable (app/replay.ts). */
export function quoteOf(labels: string[], results: Result[]): bigint {
  const { amount } = buyStage(byLabel(labels, results), GUARD);
  return amount > 0n ? amount : 0n;
}

export const byLabel = (labels: string[], results: Result[]) => Object.fromEntries(labels.map((l, i) => [l, results[i]]));

/** Facts beside the simulation that the verdict rests on, all in the evidence. */
export type Facts = Pick<Report["evidence"], "block" | "code_hash" | "implementation" | "liquidity" | "reputation" | "near">;

function report(
  proof: Omit<Facts, "block"> & { chain_id: number; block: bigint; template: Hex; amount_wei: string },
  sim: { request: Report["request"]; results: Result[] },
  labels: string[],
  txHashes: Hex[],
): Report {
  const { verdict, reasons, list_target } = judge(labels, sim.results, { ...proof, block: Number(proof.block) });
  const evidence = {
    chain_id: proof.chain_id,
    block: Number(proof.block),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
    amount_wei: proof.amount_wei,
    tx_hashes: txHashes,
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

/** Exit quote: the guard's EVM address sells `amount` of the token it holds with the approve and swap
 *  the guard would sign (`txs`, from preview_check), in one simulated block over the latest one (its
 *  real token balance). The quote is the ETH paid out (the WETH that left `pair`): the guard sets the
 *  agent's floor from it. */
export function exitPlan(token: Address, guard: Address, amount: bigint, now: bigint, pair: Address, txs: Hex[]): Block[] {
  const [approve, swap] = txs.map((t, i) => guardTx(i ? "exit sale" : "approve router", guard, t).call);
  const pairWeth = (label: string) => call(label, guard, WETH, erc20, "balanceOf", [pair]);
  return [
    {
      time: now,
      calls: [pairWeth("pair WETH before exit"), approve, call("exit quote", guard, ROUTER, router, "getAmountsOut", [amount, [token, WETH]]), swap, pairWeth("pair WETH after exit")],
    },
  ];
}

export type ExitReport = {
  verdict: Verdict;
  reasons: string;
  evidence: { kind: "exit"; chain_id: number; block: number; method: "eth_simulateV1"; request_sha256: Hex; amount: string; calls: string[]; quote: string; tx_hashes: Hex[] };
  request: Report["request"];
  response: Result[];
};

/** Pure: allow with the ETH out of the simulated sale, or block without a quote. */
export function judgeExit(labels: string[], results: Result[]): { verdict: Verdict; reasons: string; quote: bigint } {
  const r = byLabel(labels, results);
  if (!ok(r["exit sale"])) return { verdict: "block", reasons: `exit sale fails in simulation (${revertReason(r["exit sale"])}): no quote`, quote: 0n };
  const quote = paidOut(r["pair WETH before exit"], r["pair WETH after exit"]);
  if (quote <= 0n) return { verdict: "block", reasons: "exit sale simulated but yields no ETH: no quote", quote: 0n };
  return { verdict: "allow", reasons: "exit sale from the guard's address simulated: quote = its ETH out", quote };
}

/** `preview`: preview_check of the exit quote, the approve and swap the guard would sign with a quote.
 *  Simulated twice: with no floor for the quote, then exactly as signed on that quote. */
export async function checkExit(url: string, token: Address, guard: Address, amount: bigint, preview: (quote: bigint) => Promise<Hex[]>): Promise<ExitReport> {
  const head = await rpc<Header>(url, "eth_getBlockByNumber", ["latest", false]);
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const pair = (await read(url, FACTORY, "getPair", [token, WETH], BigInt(head.number))) as Address;
  const now = BigInt(head.timestamp) + NEXT_S;
  const run = async (txs: Hex[]) => {
    const fees = sameFees(txs);
    const blocks = exitPlan(token, guard, amount, now, pair, txs);
    const sim = await simulate(url, head, await topUp(url, head, guard, BigInt(callsBy(blocks, guard)) * fees.gas * fees.maxFeePerGas), blocks, fees);
    const labels = blocks[0].calls.map((c) => c.label);
    return { sim, labels, txs, ...judgeExit(labels, sim.results) };
  };
  let r = await run(await preview(0n));
  if (r.verdict === "allow") r = await run(await preview(r.quote));
  const evidence = {
    kind: "exit" as const,
    chain_id: chainId,
    block: Number(BigInt(head.number)),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(r.sim.request))),
    amount: amount.toString(),
    calls: r.sim.results.map((res, i) => `${r.labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: r.quote.toString(),
    tx_hashes: r.txs.map((t) => keccak256(t)),
  };
  return { verdict: r.verdict, reasons: r.reasons, evidence, request: r.sim.request, response: r.sim.results };
}

/** File proofs/<id>.json: `evidence` is the exact string posted to post_verdict, whose
 *  sha256 the contract stores; app/replay.ts rereads it as is. */
export type ProofFile = Omit<Report, "evidence" | "list_target"> & { id: number; target: string; evidence: string };

export function toProof(id: number, target: string, r: Report | ExitReport): ProofFile {
  return { id, target, verdict: r.verdict, reasons: r.reasons, evidence: JSON.stringify(r.evidence), request: r.request, response: r.response };
}

/** `special()` of a demo token: for guard_frozen, the guard EVM address that evm/fork.sh made it freeze. */
export async function specialOf(url: string, token: Address): Promise<Address> {
  const data = encodeFunctionData({ abi: parseAbi(["function special() view returns (address)"]), functionName: "special" });
  return `0x${(await rpc<Hex>(url, "eth_call", [{ to: token, data }, "latest"])).slice(-40)}` as Address;
}
