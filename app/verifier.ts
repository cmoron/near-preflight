// The check behind every verdict: read-only simulation (eth_simulateV1) on an EVM chain, Uniswap V2
// route WETH -> token. Nothing is signed or sent on the EVM chain. checkToken runs a buy check (four
// requests: guard side, probe side and synthetic calls on the reference block bound to the NEAR request,
// then the later side on a real block mined after it; plus code, liquidity, environment and reputation
// facts), checkExit an agent's exit quote; judge and judgeExit are pure, so app/replay.ts rejudges a
// proof with the same code. app/sentinel.ts posts the result; docs/sentinel.md explains it.
import {
  concat,
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
import { environmentFindings, envOpcodes, trace, type Diff } from "./environment";
import { beforeBlock, ownFunding, reputationFindings, reputationOf, templateOf, windowProblem, type Index, type Reputation } from "./index";

export const ROUTER: Address = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"; // Uniswap V2 Router02 (Base)
export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const FACTORY: Address = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"; // Uniswap V2 factory (Base), ROUTER.factory()
/** Base's block time: a simulated block n blocks after the proof's block is n * 2 s after it. */
export const NEXT_S = 2n;
// What the guard signs is what the guard side simulates: its buy, approves and swaps are the unsigned
// transactions the contract builds (preview_check, preview_sale), sent as is from its address (same
// calldata, value, nonce, gas limit and fees), and nothing else: no read, no probe, no other sender
// before or between them, from the block's real state. Every other call (quote, owner(), takebacks)
// runs in a request of its own, sharing no state with the guard side; amounts come from the logs.
// Every call gets the guard's gas limit and fees: without them eth_simulateV1 gives tx.gasprice = 0,
// block.basefee = 0 and gasleft() = block limit, where a token recognizes the simulation.
export const FUND = parseEther("1"); // balance of the fresh probes beyond what they spend, for their gas
/** eth_simulateV1 refuses blocks more than 256 above the base block: the late sale lands at most in
 *  that one. Every block up to the late sale is in the request, empty but for the guard's transactions,
 *  at 2 s per block: a node would fill a gap with 12 s blocks, and a timestamp that does not match the
 *  block number tells a simulation from the chain. The sales' swap deadline is past that block. */
export const LATE_BLOCKS = 256n;
// Slots of a proxy's implementation address: EIP-1967, then ZeppelinOS (USDC).
const IMPL_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
];
const TAX_WARN = 0.1; // loss beyond the pool's quote: warn at 10 %, block at 50 %
const TAX_BLOCK = 0.5;
/** Below this many base units (tokens the pool quotes for the agent's buy, wei it quotes for a sale),
 *  rounding alone can make a finding: it then depends on the amount the agent chose, never lists. The
 *  pool's quote, not what the token delivered: a token that delivers almost nothing is still listed. */
const DUST = 1000n;
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
/** A simulated call. `nonce` only on the guard's own transactions, which carry the nonce they are signed at;
 *  `gas` only on a call that needs more than the guard's limit (others' createPair). */
type Call = { label: string; from: Address; to: Address; data: Hex; value?: bigint; nonce?: number; gas?: bigint };
/** Gas limit and fee fields of every simulated call: those of the guard's own transactions (evm_config). */
export type Fees = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
/** A log as eth_simulateV1 returns it (other fields ignored). */
export type Log = { address: Address; topics: Hex[]; data: Hex };
export type Result = { status: Hex; returnData: Hex; logs?: Log[]; error?: { message?: string; data?: Hex } };
/** `list`: a property of the token shown after a buy that succeeded, which nothing the agent chose
 *  decides (judge lists the token on such a block). */
export type Finding = { level: Verdict; text: string; list?: boolean };
export type Report = {
  verdict: Verdict;
  reasons: string;
  /** post_verdict's `list_target`: a block the probe side shows after a buy that succeeded, which the
   *  agent's amount does not decide (judge); the guard then lists the token. */
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
    /** Opcodes whose value no simulation can match, in the reachable code of the target and of its
     *  implementation (app/environment.ts envOpcodes), sorted. */
    opcodes: string[];
    /** Every address the guard side's transactions touch, taken on a local fork that replays them at
     *  their simulated blocks (app/environment.ts trace), lowercase, sorted; null without a pool. */
    touched: string[] | null;
    /** The contracts the token's own code calls in those transactions (same trace), sorted; null without a pool. */
    token_calls: string[] | null;
    /** The later side (laterSide): the real block it ran on, the slots the buy wrote that Base also wrote
     *  before it, the pool's reserves at its start; null when the check stopped at the buy. */
    later: Later | null;
    /** When both sales land and how much the first one sells, derived with the probes (deriveProbes). */
    sales: Sale;
    /** The `list_target` posted with the verdict (judge): replay recomputes it, the guard stores it. */
    list_target: boolean;
  };
  /** Full requests and responses, to replay the simulation at the same blocks: the guard side, the
   *  probe side, the synthetic calls (quote, owner(), takebacks) and the later side, four requests sharing
   *  no state (the later side absent when the check stopped at the buy). */
  request: Request[];
  response: Result[][];
};
export type Request = { method: string; params: unknown[] };

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

/** One JSON-RPC call with a timeout (RPC_TIMEOUT_MS, 20 s by default); throws on an error or no result. */
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

/** A simulated block: its number fixes its time (2 s per block after the proof's block) and its prevrandao. */
export type Block = { number: bigint; calls: Call[] };
/** Real block on top of which we simulate: its base fee and coinbase are reused, its prevrandao seeds
 *  each simulated block's; the node would otherwise set them to zero in the simulated blocks. `l1Seq`:
 *  L1Block's sequenceNumber at that block, its position in its L1 epoch (headAt). */
export type Header = { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas: Hex; mixHash: Hex; miner: Address; l1Seq: bigint };
/** Base's L1Block predeploy, which the L1 attributes deposit rewrites at the start of every real block. */
export const L1_BLOCK: Address = "0x4200000000000000000000000000000000000015";
/** L2 blocks per L1 block on Base (12 s / 2 s): an L1 epoch, over which prevrandao is the L1 origin's. */
export const EPOCH_BLOCKS = 6n;

/** Block `tag` with its position in its L1 epoch (L1Block.sequenceNumber() there; 0 without L1Block). */
export async function headAt(url: string, tag: string): Promise<Header> {
  const h = await rpc<Omit<Header, "l1Seq">>(url, "eth_getBlockByNumber", [tag, false]);
  const seq = await rpc<Hex>(url, "eth_call", [{ to: L1_BLOCK, data: "0x64ca23ef" }, h.number]); // sequenceNumber()
  return { ...h, l1Seq: seq === "0x" ? 0n : BigInt(seq) };
}

/** Block `n`'s time at Base's cadence: the proof's block time plus 2 s per block after it. */
export const timeOf = (head: Header, n: bigint) => BigInt(head.timestamp) + NEXT_S * (n - BigInt(head.number));
/** Block `n`'s prevrandao as Base sets it: the L1 origin's, one per epoch of EPOCH_BLOCKS blocks. The
 *  proof block's for the rest of its epoch, then keccak256(it, epoch index) per later epoch, so that
 *  replay recomputes it. One per block would itself tell a simulation from the chain. */
export const prevRandaoOf = (head: Header, n: bigint) => {
  const epoch = (head.l1Seq + n - BigInt(head.number)) / EPOCH_BLOCKS;
  return epoch === 0n ? head.mixHash : keccak256(concat([head.mixHash, toHex(epoch, { size: 32 })]));
};

/** Full eth_simulateV1 request, as sent and saved in the proof. Every call gets `fees`, the guard's own;
 *  value and nonce are hex when present. traceTransfers reports each ETH transfer as a log: what a
 *  seller receives is read there. `state`: storage slots set before the first block (the later side). */
export function buildRequest(head: Header, balances: Record<string, bigint>, blocks: Block[], fees: Fees, state: Record<string, Record<string, Hex>> = {}): Request {
  const env = { baseFeePerGas: toHex(BigInt(head.baseFeePerGas)), feeRecipient: head.miner };
  const f = { gas: toHex(fees.gas), maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas) };
  const accounts = [...new Set([...Object.keys(balances), ...Object.keys(state)])];
  const overrides = Object.fromEntries(accounts.map((a) => [a, { ...(a in balances ? { balance: toHex(balances[a]) } : {}), ...(state[a] ? { stateDiff: state[a] } : {}) }]));
  const request = {
    blockStateCalls: blocks.map((b, i) => ({
      blockOverrides: { number: toHex(b.number), time: toHex(timeOf(head, b.number)), prevRandao: prevRandaoOf(head, b.number), ...env },
      ...(i === 0 ? { stateOverrides: overrides } : {}),
      calls: b.calls.map(({ label: _, value, nonce, gas, ...c }) => ({
        ...c,
        ...(value ? { value: toHex(value) } : {}),
        ...(nonce === undefined ? {} : { nonce: toHex(nonce) }),
        ...f,
        ...(gas ? { gas: toHex(gas) } : {}),
      })),
    })),
    validation: false,
    traceTransfers: true,
  };
  return { method: "eth_simulateV1", params: [request, toHex(BigInt(head.number))] };
}

/** Balances a request sets, for the senders of its calls only. The guard's EVM address keeps its real
 *  balance when it covers what its calls spend (their value and gas at the max fee), else gets exactly
 *  that. owner() keeps its real balance if it covers its call, else gets FUND. Any other sender is a
 *  fresh probe: FUND plus what it spends. */
export async function balances(url: string, head: Header, blocks: Block[], fees: Fees, guard: Address, owner: Address | null) {
  const need = new Map<Address, bigint>();
  for (const c of blocks.flatMap((b) => b.calls)) need.set(c.from, (need.get(c.from) ?? 0n) + (c.value ?? 0n) + (c.gas ?? fees.gas) * fees.maxFeePerGas);
  const out: Record<string, bigint> = {};
  for (const [who, n] of need) {
    if (same(who, guard)) Object.assign(out, await topUp(url, head, who, n));
    else if (owner && same(who, owner)) Object.assign(out, Object.keys(await topUp(url, head, who, n)).length ? { [who]: FUND } : {});
    else out[who] = FUND + n;
  }
  return out;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `who` keeps its real balance at the block if it has `need`, else gets exactly `need`. */
export async function topUp(url: string, head: Header, who: Address, need: bigint): Promise<Record<string, bigint>> {
  return BigInt(await rpc<Hex>(url, "eth_getBalance", [who, head.number])) < need ? { [who]: need } : {};
}

/** The four requests of a check, in this order; they share no state. The later side is empty until the
 *  full proof, and runs on its own base block (laterSide). */
export type Sides = { guard: Block[]; probe: Block[]; synthetic: Block[]; later: Block[] };
export const SIDES = ["guard", "probe", "synthetic", "later"] as const;
/** The sides simulated on the reference block. */
export const FROZEN = ["guard", "probe", "synthetic"] as const;
/** Labels of every call, guard side first, then the probe side, the synthetic calls, the later side. */
export const labelsOf = (s: Sides) => SIDES.flatMap((k) => s[k].flatMap((b) => b.calls.map((c) => c.label)));

/** Simulates the frozen sides on top of `head`, each in its own request; `owner` is owner() once known. */
async function simulate(url: string, head: Header, sides: Sides, fees: Fees, guard: Address, owner: Address | null) {
  const request = await Promise.all(FROZEN.map(async (k) => buildRequest(head, await balances(url, head, sides[k], fees, guard, owner), sides[k], fees)));
  const out = await Promise.all(request.map((q) => rpc<{ calls: Result[] }[]>(url, q.method, q.params)));
  return { request, response: out.map((blocks) => blocks.flatMap((b) => b.calls)) };
}

/** Label prefix of the calls made as the guard's own EVM address (the real buyer); the probe
 *  buyer's calls have none. A token that targets the guard's public address shows up on this side. */
export const GUARD = "guard: ";

/** Tokens each side received from its simulated buy. */
export type Amounts = { guard: bigint; probe: bigint };
/** The guard's own transactions a check simulates, unsigned as the contract builds them: its buy of
 *  the check's amount (preview_check) and, for the full proof, its two sales (preview_sale: approve of
 *  the exact amount then swapExactTokensForETH back to its address; a share, then the rest). */
export type GuardTxs = { buy: Hex; sales?: [Hex[], Hex[]] };
/** The two sales of a check, derived like the probes from the ticket and the block hash (deriveProbes),
 *  so a token cannot expect them: the first swap `first` blocks after the buy (5 to 150: no real exit
 *  lands in the next block), of `bps` / 10,000 of the tokens bought (13 % to 87 %, never a whole
 *  percent); the rest swapped `late` blocks after the buy (200 to 255, 400 to 510 s). */
export type Sale = { first: number; bps: number; late: number };
/** Seconds of real Base between the reference block and the block the later side runs on (the first
 *  block that late), drawn per check (deriveProbes): 16 to 24 s, about 100 blocks on Base, which has
 *  mined a block every 0.2 s since 2026, and 8 to 12 on the fork the tests mine at 2 s. Measured on Base
 *  mainnet on 2026-11-12: WETH's supply moved in 160 of 600 blocks (2 min), the V2 factory got 16
 *  pairs in an hour. */
export const LATER_S = [16, 24] as const;
export const SALE_BLOCKS = [5, 150] as const;
/** The buy is in the 1st block after the proof's: the late swap is at most LATE_BLOCKS - 1 after it. */
export const LATE_SALE_BLOCKS = [200, Number(LATE_BLOCKS) - 1] as const;
/** The sale amounts after buying `amount` tokens: `bps` / 10,000 of them, then the rest. */
export const saleAmounts = (amount: bigint, bps: number): [bigint, bigint] => {
  const first = (amount * BigInt(bps)) / 10_000n;
  return [first, amount - first];
};
/** Suffixes of the two sales' labels. */
export const SALES = [" first", " late"] as const;
/** The addresses a check simulates: the guard's EVM address and the probes derived for it. */
export type Who = { guard: Address; buyer: Address; stranger: Address };

/** The reference block is the first Base block whose timestamp is at least this long after the NEAR
 *  request: it is mined after the request is on NEAR, so nobody knows its hash when asking. */
export const REF_MARGIN_S = 4n;
/** How often a wait reads the node, and how long it waits for a block before the check fails. */
const POLL_MS = 500;
const WAIT_MS = 120_000;
type Stamp = { number: Hex; timestamp: Hex };
const stampOf = (url: string, tag: string) => rpc<Stamp>(url, "eth_getBlockByNumber", [tag, false]);
/** Waits until the node's latest block satisfies `done`. */
async function until(url: string, done: (h: Stamp) => boolean, what: string): Promise<Stamp> {
  for (const end = Date.now() + WAIT_MS; ; await Bun.sleep(POLL_MS)) {
    const h = await stampOf(url, "latest");
    if (done(h)) return h;
    if (Date.now() > end) throw new Error(`${what} not mined within ${WAIT_MS / 1000} s (latest block ${BigInt(h.number)})`);
  }
}

/** The first block whose timestamp is at least `at` (seconds), once mined. The search starts at the
 *  block before that time at 2 s per block, then bisects: Base mines faster, a fork's history keeps
 *  other cadences. */
export async function firstAt(url: string, at: bigint): Promise<Header> {
  const head = await until(url, (h) => BigInt(h.timestamp) >= at, `a block at ${at} s`);
  const late = async (n: bigint) => BigInt((await stampOf(url, toHex(n))).timestamp) >= at;
  // invariant: block `hi` is at or after `at`, block `lo` before it (or lo = -1)
  let hi = BigInt(head.number);
  let lo = hi - (BigInt(head.timestamp) - at) / NEXT_S - 1n;
  for (let step = 1n; lo >= 0n && (await late(lo)); step *= 2n) [hi, lo] = [lo, lo - step];
  if (lo < 0n) lo = -1n;
  if (lo + 1n < hi && (await late(lo + 1n))) hi = lo + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await late(mid)) hi = mid;
    else lo = mid;
  }
  return headAt(url, toHex(hi));
}

/** The check's reference block, which the sentinel does not choose: the first block whose timestamp is
 *  at least REF_MARGIN_S after the NEAR request (`requested_ns`, nanoseconds). replay --check recomputes it. */
export const refBlock = (url: string, requestedNs: string) => firstAt(url, (BigInt(requestedNs) + 999_999_999n) / 1_000_000_000n + REF_MARGIN_S);

/** Label prefix of the later side: the guard's approves and swaps again, on a real block after the reference. */
export const LATER = "later: ";
/** The later side's facts (evidence.later): the real block, the slots the buy wrote that Base also wrote
 *  before it (address:slot), the pool's reserves (token0, token1) at its start. */
export type Later = { block: number; moved: string[]; reserves: [string, string] };
const GET_RESERVES = "0x0902f1ac";

/** The later side's blocks: the guard side's (`guardSide`, on reference block `block`) after real block
 *  `real`, every one listed (a node fills a gap with 12 s blocks), its approves and swaps relabelled,
 *  at the same block numbers. A sale whose approve is not after `real` is left out whole: its swap's
 *  block stays, empty (on Base, about 100 blocks a check, often the first sale). */
export function laterBlocks(guardSide: Block[], block: bigint, sale: Sale, real: bigint): Block[] {
  const dropped = block + BigInt(sale.first) <= real ? block + BigInt(sale.first) + 1n : real;
  return guardSide.filter((b) => b.number > real).map((b) => ({ ...b, calls: b.number <= dropped ? [] : b.calls.map((c) => ({ ...c, label: `${LATER}${c.label}` })) }));
}

/** The later side's request: the guard side's approves and swaps (`blocks`, laterBlocks) on real block
 *  `r`, which Base mined after the reference block `ref`, with what the guard's buy wrote there (`diff`,
 *  from the trace) applied. A storage slot Base did not write since takes the buy's value; one Base also
 *  wrote keeps Base's value and is reported in `moved`; an ETH balance adds the buy's change to Base's
 *  (WETH's is its total supply). The guard gets what its own calls spend, as on the other sides. Each
 *  simulated block keeps the guard side's time, so the two sides differ only in state, unless Base's
 *  clock ran ahead of 2 s a block (then the blocks follow `r`'s time). `reserves`: the pool's at the
 *  start, for the sales' quotes. Shared with app/replay.ts. */
export async function laterSide(url: string, r: Header, ref: Header, blocks: Block[], diff: Diff, fees: Fees, guard: Address, pair: Address): Promise<{ request: Request } & Omit<Later, "block">> {
  const state: Record<string, Record<string, Hex>> = {};
  const moved: string[] = [];
  for (const [a, slots] of Object.entries(diff.storage)) {
    for (const [s, [pre, post]] of Object.entries(slots)) {
      if (BigInt(await rpc<Hex>(url, "eth_getStorageAt", [a, s, r.number])) === BigInt(pre)) (state[a] ??= {})[s] = post;
      else moved.push(`${a}:${s}`);
    }
  }
  const funds: Record<string, bigint> = {};
  for (const [a, [pre, post]] of Object.entries(diff.balance)) funds[a] = BigInt(await rpc<Hex>(url, "eth_getBalance", [a, r.number])) + BigInt(post) - BigInt(pre);
  Object.assign(funds, await balances(url, r, blocks, fees, guard, null));
  const aligned = timeOf(ref, BigInt(r.number));
  const request = buildRequest(aligned >= BigInt(r.timestamp) ? { ...r, timestamp: toHex(aligned) } : r, funds, blocks, fees, state);
  const [{ stateOverrides }] = (request.params[0] as { blockStateCalls: { stateOverrides: unknown }[] }).blockStateCalls;
  const out = await rpc<Hex>(url, "eth_call", [{ to: pair, data: GET_RESERVES }, r.number, stateOverrides]);
  return { request, moved, reserves: [BigInt(`0x${out.slice(2, 66)}`).toString(), BigInt(`0x${out.slice(66, 130)}`).toString()] };
}

/** The four requests to simulate. Guard side: the guard's own transactions as is and nothing else,
 *  its buy on the block's real state in the next block, then (full proof) the first sale and the rest,
 *  where `sale` puts them, the request ending with the late swap; each sale an approve of its exact
 *  amount then the swap to ETH, each in a block of its own as the relay mines them, empty blocks in
 *  between. Probe side: their twins from the probe buyer (asProbe), in a request of its own. Synthetic: the pool's quote and owner() on the block's state, then (full proof) both buys
 *  followed by transferFrom without approval by owner() and by a stranger (takebacks). The later side
 *  is empty: laterBlocks fills it once its real block is known. Without `full` (the 1st simulation, for
 *  the amounts bought and owner()): the buys, the quote and owner() only.
 *  Shared with app/replay.ts, which rebuilds the expected requests this way. */
export function plan(token: Address, who: Who, block: bigint, amount: bigint, txs: GuardTxs, full?: { amounts: Amounts; owner: Address | null; sale: Sale }): Sides {
  const { guard, buyer, stranger } = who;
  const at = (n: bigint, calls: Call[]): Block => ({ number: block + n, calls });
  const guardBuy = guardTx(`${GUARD}buy`, guard, txs.buy).call;
  const probeBuy = asProbe(guardBuy, "buy", buyer);
  const reads = [call("buy quote", buyer, ROUTER, router, "getAmountsOut", [amount, [WETH, token]]), call("owner()", buyer, token, erc20, "owner", [])];
  if (!full) return { guard: [at(1n, [guardBuy])], probe: [at(1n, [probeBuy])], synthetic: [at(1n, reads)], later: [] };
  if (!txs.sales) throw new Error("the full proof needs the guard's two sales");
  const { amounts, owner } = full;
  const sale = (p: string, seller: Address, i: 0 | 1): Call[] => {
    const [approve, swap] = txs.sales![i].map((t, j) => guardTx(`${GUARD}${j ? "sale" : "approve router"}${SALES[i]}`, guard, t).call);
    if (p === GUARD) return [approve, swap];
    const x = saleAmounts(amounts.probe, full.sale.bps)[i];
    return [asProbe(approve, `approve router${SALES[i]}`, seller, x), asProbe(swap, `sale${SALES[i]}`, seller, x)];
  };
  // Each swap's block, its approve in the block before; every other block up to the late swap is
  // explicit and empty: a node fills a gap with 12 s blocks.
  const swaps = [1n + BigInt(full.sale.first), 1n + BigInt(full.sale.late)];
  const side = (p: string, seller: Address, buy: Call) => {
    const filled = new Map<bigint, Call[]>([[1n, [buy]]]);
    for (const i of [0, 1] as const) {
      const [approve, swap] = sale(p, seller, i);
      filled.set(swaps[i] - 1n, [approve]).set(swaps[i], [swap]);
    }
    return Array.from({ length: Number(swaps[1]) }, (_, i) => at(BigInt(i) + 1n, filled.get(BigInt(i) + 1n) ?? []));
  };
  const takebacks = (p: string, holder: Address) => [
    ...(owner ? [call(`${p}transferFrom by owner()`, owner, token, erc20, "transferFrom", [holder, owner, 1n])] : []),
    call(`${p}transferFrom by a stranger`, stranger, token, erc20, "transferFrom", [holder, stranger, 1n]),
  ];
  return {
    guard: side(GUARD, guard, guardBuy),
    probe: side("", buyer, probeBuy),
    synthetic: [at(1n, [...reads, { ...guardBuy, label: `${GUARD}buy before takebacks` }, { ...probeBuy, label: "buy before takebacks" }, ...takebacks(GUARD, guard), ...takebacks("", buyer)])],
    later: [],
  };
}

/** The simulated call succeeded. */
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

/** Probe addresses, the sales and how many seconds of real Base the later side waits (`later`): the
 *  sentinel derives them (deriveProbes); tests impose others (forged but consistent proofs). */
export type Probe = { buyer: Address; stranger: Address; sale: Sale; later: number };
/** On-chain inputs of the probe derivation: the guard account, the check id and its request time
 *  (`requested_ns`, set by the guard contract), all readable by anyone from a NEAR RPC. */
export type Ticket = { guard: string; id: number; requested_ns: string };

/** Probe addresses, sales and the later side's real block the sentinel does not choose: sha256 of the
 *  ticket and of the hash of the reference block. That hash does not exist before the block, so a token
 *  owner watching NEAR cannot whitelist the probes, nor expect either sale's block, the first one's
 *  amount or the later side's block, in advance; replay --check recomputes them. */
export function deriveProbes(t: Ticket, blockHash: Hex): Probe {
  const digest = (role: string) => sha256(stringToHex(`goblin-near probe|${t.guard}|${t.id}|${t.requested_ns}|${blockHash.toLowerCase()}|${role}`));
  const x = BigInt(digest("sale"));
  const span = BigInt(SALE_BLOCKS[1] - SALE_BLOCKS[0] + 1);
  // 13.01 % to 86.99 %: a whole percent (74 choices) plus 1 to 99 basis points.
  const bps = 1301n + ((x / span) % 74n) * 100n + ((x / span / 74n) % 99n);
  const late = BigInt(digest("late")) % BigInt(LATE_SALE_BLOCKS[1] - LATE_SALE_BLOCKS[0] + 1);
  return {
    buyer: `0x${digest("buyer").slice(-40)}` as Address,
    stranger: `0x${digest("stranger").slice(-40)}` as Address,
    sale: { first: SALE_BLOCKS[0] + Number(x % span), bps: Number(bps), late: LATE_SALE_BLOCKS[0] + Number(late) },
    later: LATER_S[0] + Number(BigInt(digest("later")) % BigInt(LATER_S[1] - LATER_S[0] + 1)),
  };
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
/** What the sentinel knows beside the EVM chain: the check's request time on NEAR (`requested_ns`, which
 *  fixes the reference block), the template index it builds up to a block (app/index.ts), a reader of the
 *  guard's blocklist entry and last code for a target, the amount the agent asked to buy (request_check),
 *  and the guard's previews of what it would sign. */
export type Context = { requested_ns: string; index: ((block: number) => Promise<Index>) | null; near: (target: Address) => Promise<NearFacts>; amount: bigint; preview: Previews };

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

/** The buy check of `token`: the verdict, reasons, list_target, evidence and the full requests and
 *  responses (Report). Simulated on the reference block bound to the request (refBlock), then on the
 *  first real block `later` seconds after it. `guard` is the guard's EVM address; `probes` gets the reference
 *  block (the sentinel passes deriveProbes of its ticket); `ctx` gives the request time, the index, the
 *  guard's NEAR facts, the amount stated at the check and the guard's previews. A first simulation
 *  measures the buys; the full one (plan) runs the guard's buy as it would sign it on that quote, then its
 *  two sales; the trace gives what the buy wrote, and the later side runs the sales again on Base's later
 *  state with it applied. Throws when the index window is not bound to the block: no verdict rather than
 *  an unknown reputation. */
export async function checkToken(url: string, token: Address, guard: Address, probes: (head: Header) => Probe, ctx: Context): Promise<Report> {
  const head = await refBlock(url, ctx.requested_ns);
  const { sale, later, ...probe } = probes(head);
  const who = { guard, ...probe };
  const block = BigInt(head.number);
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const code = await rpc<Hex>(url, "eth_getCode", [token, toHex(block)]);
  const implementation = await implementationAt(url, token, block);
  const opcodes = await opcodesOf(url, code, implementation, block);
  const liquidity = await liquidityFacts(url, token, block);
  const template = templateOf(code);
  const own = liquidity?.pair ?? null;
  // An index whose window is not bound to this block judges nothing: the check fails (the sentinel then
  // posts a block), it never falls back to an unknown reputation.
  const index = ctx.index ? await ctx.index(Number(block)) : null;
  const window = index?.chain_id === chainId ? windowProblem(Number(block), index.from, index.to) : null;
  if (window) throw new Error(window);
  const reputation = index?.chain_id === chainId ? reputationOf(index, template, beforeBlock(index, own, await ownFunding(url, index, own))) : null;
  const near = await ctx.near(token);
  const amount = ctx.amount;
  const proof = { chain_id: chainId, block, code_hash: keccak256(code), implementation, liquidity, template, reputation, near, amount_wei: amount.toString(), opcodes, sales: sale };

  // 1st simulation: the buys alone, the guard's with no minimum (quote 0), for the amounts bought; the
  // quote and owner() apart. Without a pool the check stops at the buy with a warn, and nothing is traced.
  const [buy0] = await ctx.preview.check(0n);
  const first1 = plan(token, who, block, amount, { buy: buy0 });
  const first = await simulate(url, head, first1, sameFees([buy0]), guard, null);
  const st = buyStages(byLabel(labelsOf(first1), first.response.flat()), { token, ...who });
  if (st.stop || !liquidity) {
    const t = liquidity ? await trace(url, first.request[0], Number(block), token) : null;
    return report({ ...proof, touched: t?.touched ?? null, token_calls: t?.calls ?? null, later: null }, first, labelsOf(first1), [keccak256(buy0)], { token, ...who });
  }

  // 2nd simulation: the guard's buy as it would be signed on this quote (minimum = quote - slippage),
  // then its two sales as it would sign them; their twins and the synthetic calls apart.
  const [buy] = await ctx.preview.check(st.amounts.guard);
  const deadline = timeOf(head, block + LATE_BLOCKS) + 10_000n;
  const [share, rest] = saleAmounts(st.amounts.guard, sale.bps);
  const sales: [Hex[], Hex[]] = [await ctx.preview.sale(share, deadline), await ctx.preview.sale(rest, deadline)];
  const fees = sameFees([buy, ...sales.flat()]);
  const sides = plan(token, who, block, amount, { buy, sales }, { amounts: st.amounts, owner: st.owner, sale });
  const sim = await simulate(url, head, sides, fees, guard, st.owner);
  // The guard side replayed on a local fork: the addresses it touches, the token's calls, the buy's
  // state change; then the sales again on the first real block `later` seconds on, with that change applied.
  const t = await trace(url, sim.request[0], Number(block), token);
  const real = await firstAt(url, BigInt(head.timestamp) + BigInt(later));
  sides.later = laterBlocks(sides.guard, block, sale, BigInt(real.number));
  const l = await laterSide(url, real, head, sides.later, t.diff, fees, guard, liquidity.pair);
  const out = await rpc<{ calls: Result[] }[]>(url, l.request.method, l.request.params);
  const both = { request: [...sim.request, l.request], response: [...sim.response, out.flatMap((b) => b.calls)] };
  const facts = { ...proof, touched: t.touched, token_calls: t.calls, later: { block: Number(real.number), moved: l.moved, reserves: l.reserves } };
  return report(facts, both, labelsOf(sides), [keccak256(buy)], { token, ...who });
}

/** envOpcodes of the target's code and of its implementation's, at the block. */
export async function opcodesOf(url: string, code: Hex, implementation: Address | null, block: bigint): Promise<string[]> {
  const impl = implementation ? envOpcodes(await rpc<Hex>(url, "eth_getCode", [implementation, toHex(block)])) : [];
  return [...new Set([...envOpcodes(code), ...impl])].sort();
}

/** The token and the addresses its judgment reads logs for. */
export type Parties = { token: Address } & Who;

/** traceTransfers reports each ETH transfer as a `Transfer` log of this address. */
export const ETH_LOGS: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SYNC_TOPIC = keccak256(stringToHex("Sync(uint112,uint112)"));
const word = (h: Hex) => (h.length === 66 ? BigInt(h) : 0n); // a malformed log moves nothing
const topicIs = (t: Hex | undefined, a: Address) => !!t && same(`0x${t.slice(26)}`, a);
/** What `who` received (`to`) or sent (`from`) of `asset` in the `Transfer` logs of `results`. */
function moves(results: (Result | undefined)[], asset: Address, who: Address, side: "to" | "from"): bigint {
  const logs = results.flatMap((r) => r?.logs ?? []).filter((l) => same(l.address, asset) && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3);
  return logs.filter((l) => topicIs(l.topics[side === "from" ? 1 : 2], who)).reduce((n, l) => n + word(l.data), 0n);
}
/** Tokens `who` received net in a call, from the token's own Transfer logs. */
const tokensIn = (r: Result | undefined, token: Address, who: Address) => (r && ok(r) ? moves([r], token, who, "to") - moves([r], token, who, "from") : 0n);
/** The pair's last reserves (token0, token1) in `results`: its last `Sync` log, or null. */
function lastSync(results: (Result | undefined)[], pair: Address): [bigint, bigint] | null {
  const sync = results.flatMap((r) => r?.logs ?? []).filter((l) => same(l.address, pair) && l.topics[0] === SYNC_TOPIC && l.data.length === 130).at(-1);
  return sync ? [BigInt(`0x${sync.data.slice(2, 66)}`), BigInt(`0x${sync.data.slice(66)}`)] : null;
}
/** What selling `x` tokens yields at reserves (token0, token1), by the router's formula (getAmountOut,
 *  0.3 % fee). */
function quoteAt([r0, r1]: [bigint, bigint], token: Address, x: bigint): bigint {
  const [rIn, rOut] = BigInt(token) < BigInt(WETH) ? [r0, r1] : [r1, r0];
  return rIn + x === 0n ? 0n : (x * 997n * rOut) / (rIn * 1000n + x * 997n);
}
/** What selling `x` tokens yields at the pair's last reserves in `before`; 0 without a Sync. */
function saleQuote(before: (Result | undefined)[], pair: Address, token: Address, x: bigint): bigint {
  const r = lastSync(before, pair);
  return r ? quoteAt(r, token, x) : 0n;
}

/** Buy phase of one side (prefix "" or GUARD, buyer `who`): amount received, owner, first findings.
 *  Empty `findings` = we can continue. */
export function buyStage(f: Record<string, Result>, token: Address, who: Address, p = "") {
  const findings: Finding[] = [];
  if (!ok(f["buy quote"])) findings.push({ level: "warn", text: "no liquidity: no Uniswap V2 WETH pair, sale not verifiable" });
  else if (!ok(f[`${p}buy`])) findings.push({ level: "block", text: `simulated buy failed: ${revertReason(f[`${p}buy`])}` });
  const amount = tokensIn(f[`${p}buy`], token, who);
  const o = f["owner()"];
  const owner = ok(o) && o.returnData !== "0x" ? (uint(erc20, "owner", o) as Address) : null;
  // Tokens the pool quotes for the agent's amount (reserves the token does not set for that amount).
  const quoted = ok(f["buy quote"]) ? (uint(router, "getAmountsOut", f["buy quote"]) as bigint[])[1] : 0n;
  if (!findings.length && amount < 10n) findings.push({ level: "block", text: "simulated buy received no tokens", list: quoted >= DUST });
  return { findings, amount, owner, quoted };
}

/** Both buy stages: a finding on either side stops the check after the buy. */
export function buyStages(f: Record<string, Result>, w: Parties) {
  const [b, g] = [buyStage(f, w.token, w.buyer), buyStage(f, w.token, w.guard, GUARD)];
  return { stop: b.findings.length + g.findings.length > 0, amounts: { guard: g.amount, probe: b.amount } as Amounts, owner: b.owner };
}

/** Findings of one side (prefix "" or GUARD, seller `who`): buy, takebacks, sales. A sale is judged on
 *  the ETH that reached the seller (traceTransfers logs) against the pool's quote before its approve
 *  (last Sync), and blocked when the pool paid out more WETH than the seller received. */
function sideFindings(r: Record<string, Result>, p: string, w: Parties, pair: Address | null, stop: boolean, sales: Sale): Finding[] {
  const who = p === GUARD ? w.guard : w.buyer;
  const { findings, amount, owner, quoted } = buyStage(r, w.token, who, p);
  // A buy that failed blocks and never lists (the agent's amount can make it fail); one that received
  // nothing lists only when the pool quoted more than dust for it.
  if (stop) return findings;
  const listable = quoted >= DUST;
  if (owner && moved(r[`${p}transferFrom by owner()`])) {
    findings.push({ level: "block", text: `owner() ${owner} takes tokens back by transferFrom without approval`, list: listable });
  }
  if (moved(r[`${p}transferFrom by a stranger`])) {
    findings.push({ level: "block", text: "anyone can take tokens back by transferFrom without approval", list: listable });
  }
  // Without a quote, the tax cannot be measured: total loss assumed, hence block (fail closed).
  const loss = (got: bigint, expected: bigint) => (expected > 0n ? 1 - Number(got) / Number(expected) : 1);
  // Listed only when the pool quotes at least DUST units for the buy and for that step.
  const taxed = (got: bigint, expected: bigint, when: string) => {
    const tax = loss(got, expected);
    const text = tax >= 1 ? `tax not measurable ${when} (pool quote failed)` : `${Math.round(tax * 100)} % tax ${when}`;
    if (tax >= TAX_BLOCK) findings.push({ level: "block", text, list: listable && expected >= DUST });
    else if (tax >= TAX_WARN) findings.push({ level: "warn", text });
  };
  taxed(amount, quoted, "on the buy");
  // Per sale, when it happens (reason texts).
  const when = [`${sales.first} blocks after the buy`, `${sales.late} blocks after the buy`];
  const steps = SALES.map((s) => [r[`${p}approve router${s}`], r[`${p}sale${s}`]]);
  SALES.forEach((s, i) => {
    const sale = r[`${p}sale${s}`];
    const before = [r[`${p}buy`], ...steps.slice(0, i).flat()];
    const quote = pair ? saleQuote(before, pair, w.token, saleAmounts(amount, sales.bps)[i]) : 0n;
    // A sale the pool quotes at less than DUST wei can fail or look taxed by rounding alone: not listed.
    // Nor is a refusal the late sale does not share: one that clears with time (an honest cooldown)
    // blocks this check, and listing it would let any agent repeat checks until one draws it.
    const late = r[`${p}sale${SALES[1]}`];
    if (!ok(sale)) return findings.push({ level: "block", text: `sale refused ${when[i]} (${revertReason(sale)})`, list: listable && quote >= DUST && !ok(late) });
    const got = moves(steps[i], ETH_LOGS, who, "to");
    taxed(got, quote, `on the sale ${when[i]}`);
    // Not listed: a fee swap the buy's own fees can trigger (amount-dependent) does it too.
    if (pair && moves(steps[i], WETH, pair, "from") > got) findings.push({ level: "block", text: `the pool paid out more WETH than the seller received ${when[i]}` });
  });
  return findings;
}

/** The later side against the guard side, sale by sale at the same blocks: a sale of the guard's that
 *  goes through on the reference block's frozen copy but is refused on Base's later state, or pays more
 *  than 1 % less there against the pool's quote (the pool may have moved), is keyed on state Base moves
 *  and a lone simulation keeps still. The first difference only (a refused first sale changes the late
 *  one). Never listed: Base's state, not the token's behaviour alone. A slot the buy wrote that Base also
 *  wrote before the later block is a warn: the later sales ran on Base's value there, not on the buy's. */
function laterFindings(r: Record<string, Result>, w: Parties, sales: Sale, later: Later | null, pair: Address | null): Finding[] {
  if (!later || !pair) return [];
  const out: Finding[] = [];
  if (later.moved.length) {
    const owners = [...new Set(later.moved.map((m) => short(m.split(":")[0])))].join(", ");
    out.push({ level: "warn", text: `${later.moved.length} slot(s) the buy wrote moved on Base before block ${later.block} (${owners}): the later sales ran on Base's values` });
  }
  const at = `on Base's state of block ${later.block}`;
  const bought = tokensIn(r[`${GUARD}buy`], w.token, w.guard);
  const steps = [GUARD, `${LATER}${GUARD}`].map((p) => SALES.map((s) => [r[`${p}approve router${s}`], r[`${p}sale${s}`]]));
  const start: [bigint, bigint] = [BigInt(later.reserves[0]), BigInt(later.reserves[1])];
  for (const [i, s] of SALES.entries()) {
    const [frozen, real] = steps.map((side) => side[i]);
    if (!frozen[1] || !real[1] || !ok(frozen[1])) continue;
    const when = `${i ? sales.late : sales.first} blocks after the buy`;
    if (!ok(real[1])) return [...out, { level: "block", text: `sale refused ${when} ${at} (${revertReason(real[1])})` }];
    const x = saleAmounts(bought, sales.bps)[i];
    const quoteFrozen = saleQuote([r[`${GUARD}buy`], ...steps[0].slice(0, i).flat()], pair, w.token, x);
    const quoteReal = quoteAt(lastSync(steps[1].slice(0, i).flat(), pair) ?? start, w.token, x);
    const [paid, paidReal] = [frozen, real].map((x) => moves(x, ETH_LOGS, w.guard, "to"));
    // paidReal / quoteReal below 99 % of paid / quoteFrozen
    if (paidReal * quoteFrozen * 100n < paid * quoteReal * 99n) {
      const pct = quoteFrozen && quoteReal && paid ? Math.round(100 - (100 * Number(paidReal) * Number(quoteFrozen)) / (Number(paid) * Number(quoteReal))) : 100;
      return [...out, { level: "block", text: `sale ${when} pays ${pct} % less ${at}` }];
    }
  }
  return out;
}

/** Pure judgment: depends only on the call labels and their results, hence replayable
 *  by anyone from a proof (see app/replay.ts). The guard side's findings that the
 *  probe buyer does not share are reported as "guard address only, not listed: ...". */
export function judge(labels: string[], results: Result[], facts: Facts, w: Parties): { verdict: Verdict; reasons: string; list_target: boolean } {
  const r = byLabel(labels, results);
  const { stop } = buyStages(r, w);
  const pair = facts.liquidity?.pair ?? null;
  const findings = sideFindings(r, "", w, pair, stop, facts.sales);
  // Only a block on the probe side lists the token: the probes are fresh addresses derived from a
  // block hash, so their findings are the token's own behaviour. The guard's address is public and a
  // third party can change its state (send it tokens, get it frozen): a failure there blocks this
  // check but lists nothing. Template reputation can be poisoned by copies; it never lists either.
  // The amount is the agent's: a buy that fails, and what the pool quotes as dust, block without listing.
  const list_target = findings.some((f) => f.level === "block" && f.list);
  const seen = new Set(findings.map((f) => f.text));
  for (const f of sideFindings(r, GUARD, w, pair, stop, facts.sales)) if (!seen.has(f.text)) findings.push({ ...f, text: `guard address only, not listed: ${f.text}` });
  findings.push(...laterFindings(r, w, facts.sales, facts.later, pair));
  findings.push(...liquidityFindings(facts.liquidity, facts.block), ...environmentFindings(facts, w));
  findings.unshift(...nearFindings(facts.near, facts.code_hash, facts.implementation), ...reputationFindings(facts.reputation));
  const rank = { block: 0, warn: 1, allow: 2 }; // an "allow" finding is a note: it changes no verdict
  findings.sort((a, b) => rank[a.level] - rank[b.level]); // stable: blocks first, so the 280-byte cut keeps them
  const verdict: Verdict = findings.some((f) => f.level === "block") ? "block" : findings.some((f) => f.level === "warn") ? "warn" : "allow";
  const texts = findings.map((f) => f.text);
  if (verdict === "allow") texts.unshift("buy, takeback probes and sales simulated without anomaly");
  return { verdict, reasons: texts.join(" ; ").slice(0, 280), list_target };
}

/** Quote posted with the verdict: tokens the guard's address received in its simulated buy of the
 *  check's amount (its Transfer logs; 0 without a buy), taken from the response alone, hence
 *  replayable (app/replay.ts). */
export function quoteOf(labels: string[], results: Result[], w: Parties): bigint {
  const { amount } = buyStage(byLabel(labels, results), w.token, w.guard, GUARD);
  return amount > 0n ? amount : 0n;
}

/** Results keyed by call label, the form judge reads them in. */
export const byLabel = (labels: string[], results: Result[]) => Object.fromEntries(labels.map((l, i) => [l, results[i]]));

/** Facts beside the simulation that the verdict rests on, all in the evidence. */
export type Facts = Pick<Report["evidence"], "block" | "code_hash" | "implementation" | "liquidity" | "reputation" | "near" | "opcodes" | "touched" | "token_calls" | "sales" | "later">;

function report(
  proof: Omit<Facts, "block"> & { chain_id: number; block: bigint; template: Hex; amount_wei: string },
  sim: { request: Request[]; response: Result[][] },
  labels: string[],
  txHashes: Hex[],
  w: Parties,
): Report {
  const results = sim.response.flat();
  const { verdict, reasons, list_target } = judge(labels, results, { ...proof, block: Number(proof.block) }, w);
  const evidence = {
    chain_id: proof.chain_id,
    block: Number(proof.block),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify(sim.request))),
    amount_wei: proof.amount_wei,
    tx_hashes: txHashes,
    code_hash: proof.code_hash,
    implementation: proof.implementation,
    calls: results.map((res, i) => `${labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: quoteOf(labels, results, w).toString(),
    liquidity: proof.liquidity,
    template: proof.template,
    reputation: proof.reputation,
    near: proof.near,
    opcodes: proof.opcodes,
    touched: proof.touched,
    token_calls: proof.token_calls,
    sales: proof.sales,
    later: proof.later,
    list_target,
  };
  if (JSON.stringify(evidence).length > 8000) throw new Error("evidence above 8000 characters");
  return { verdict, reasons, list_target, evidence, request: sim.request, response: sim.response };
}

/** Exit quote: the guard's EVM address sells `amount` of the token it holds with the approve and swap
 *  the guard would sign (`txs`, from preview_check), alone, each in a block of its own as the relay
 *  mines them: the approve 2 blocks after `block` (a real exit lands blocks after its quote, never in
 *  the next one), the swap in the block after (its real token balance). The quote is the ETH that
 *  reached the guard's address: the guard sets the agent's floor from it. */
export function exitPlan(guard: Address, block: bigint, txs: Hex[]): Block[] {
  const [approve, swap] = txs.map((t, i) => guardTx(i ? "exit sale" : "approve router", guard, t).call);
  return [{ number: block + 1n, calls: [] }, { number: block + 2n, calls: [approve] }, { number: block + 3n, calls: [swap] }];
}

export type ExitReport = {
  verdict: Verdict;
  reasons: string;
  evidence: { kind: "exit"; chain_id: number; block: number; method: "eth_simulateV1"; request_sha256: Hex; amount: string; calls: string[]; quote: string; tx_hashes: Hex[] };
  /** One request: the guard's approve and swap, nothing else. */
  request: Request[];
  response: Result[][];
};

/** Pure: allow with the ETH that reached the seller in the simulated sale (traceTransfers logs), or block
 *  without a quote. Not the WETH that left the pool: a token that pulls WETH out of the pool during the
 *  sale would inflate that, and the floor with it. */
export function judgeExit(labels: string[], results: Result[], w: { token: Address; seller: Address; pair: Address }): { verdict: Verdict; reasons: string; quote: bigint } {
  const r = byLabel(labels, results);
  if (!ok(r["exit sale"])) return { verdict: "block", reasons: `exit sale fails in simulation (${revertReason(r["exit sale"])}): no quote`, quote: 0n };
  const quote = moves([r["approve router"], r["exit sale"]], ETH_LOGS, w.seller, "to");
  if (quote <= 0n) return { verdict: "block", reasons: "exit sale simulated but yields no ETH: no quote", quote: 0n };
  return { verdict: "allow", reasons: "exit sale from the guard's address simulated: quote = the ETH it receives", quote };
}

/** An agent's exit quote: selling `amount` of `token` from the guard's EVM address. `preview`:
 *  preview_check of the exit quote, the approve and swap the guard would sign with a quote. Simulated
 *  twice: with no floor for the quote, then exactly as signed on that quote. allow with the ETH received
 *  as quote, or block without one. */
export async function checkExit(url: string, token: Address, guard: Address, amount: bigint, preview: (quote: bigint) => Promise<Hex[]>): Promise<ExitReport> {
  const head = await headAt(url, "latest");
  const chainId = Number(await rpc<Hex>(url, "eth_chainId", []));
  const pair = (await read(url, FACTORY, "getPair", [token, WETH], BigInt(head.number))) as Address;
  const run = async (txs: Hex[]) => {
    const fees = sameFees(txs);
    const blocks = exitPlan(guard, BigInt(head.number), txs);
    const request = buildRequest(head, await balances(url, head, blocks, fees, guard, null), blocks, fees);
    const results = (await rpc<{ calls: Result[] }[]>(url, request.method, request.params)).flatMap((b) => b.calls);
    const labels = blocks.flatMap((b) => b.calls.map((c) => c.label));
    return { request, results, labels, txs, ...judgeExit(labels, results, { token, seller: guard, pair }) };
  };
  let r = await run(await preview(0n));
  if (r.verdict === "allow") r = await run(await preview(r.quote));
  const evidence = {
    kind: "exit" as const,
    chain_id: chainId,
    block: Number(BigInt(head.number)),
    method: "eth_simulateV1" as const,
    request_sha256: sha256(stringToHex(JSON.stringify([r.request]))),
    amount: amount.toString(),
    calls: r.results.map((res, i) => `${r.labels[i]}: ${ok(res) ? "ok" : "revert"}`),
    quote: r.quote.toString(),
    tx_hashes: r.txs.map((t) => keccak256(t)),
  };
  return { verdict: r.verdict, reasons: r.reasons, evidence, request: [r.request], response: [r.results] };
}

/** File proofs/<id>.json: `evidence` is the exact string posted to post_verdict, whose
 *  sha256 the contract stores; app/replay.ts rereads it as is. */
export type ProofFile = Omit<Report, "evidence" | "list_target"> & { id: number; target: string; evidence: string };

/** The proof file of check #id: the report with its evidence serialized once, as posted on chain. */
export function toProof(id: number, target: string, r: Report | ExitReport): ProofFile {
  return { id, target, verdict: r.verdict, reasons: r.reasons, evidence: JSON.stringify(r.evidence), request: r.request, response: r.response };
}

/** `special()` of a demo token: for guard_frozen, the guard EVM address that evm/fork.sh made it freeze. */
export async function specialOf(url: string, token: Address): Promise<Address> {
  const data = encodeFunctionData({ abi: parseAbi(["function special() view returns (address)"]), functionName: "special" });
  return `0x${(await rpc<Hex>(url, "eth_call", [{ to: token, data }, "latest"])).slice(-40)}` as Address;
}
