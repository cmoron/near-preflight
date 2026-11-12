// Replay of a proof: anyone recovers the verdict from proofs/<id>.json and an EVM node.
// The file carries the exact `evidence` string posted on chain; all of its content is rechecked.
// Usage: bun app/replay.ts <proof.json> [rpc] [--check]
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, parseTransaction, serializeTransaction, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { ENV_OPCODES, touched } from "./environment";
import { beforeBlock, buildIndex, indexSha256, ownFunding, reputationOf, templateOf, type Reputation } from "./index";
import {
  balances,
  buildRequest,
  buyStages,
  byLabel,
  deriveProbes,
  exitPlan,
  FACTORY,
  GUARD,
  headAt,
  implementationAt,
  judge,
  judgeExit,
  labelsOf,
  LATE_BLOCKS,
  liquidityFacts,
  NEXT_S,
  ok as succeeded,
  opcodesOf,
  plan,
  quoteOf,
  ROUTER,
  rpc,
  saleAmounts,
  SALE_BLOCKS,
  SALES,
  SIDES,
  WETH,
  type Block,
  type Fees,
  type GuardTxs,
  type Header,
  type Liquidity,
  type NearFacts,
  type ProofFile,
  type Request,
  type Result,
  type Sale,
} from "./verifier";

export type Proof = ProofFile;
type Evidence = {
  chain_id: number;
  block: number;
  method: string;
  request_sha256: string;
  amount_wei: string;
  tx_hashes: string[];
  code_hash: string;
  implementation: string | null;
  calls: string[];
  quote: string;
  liquidity: Liquidity;
  template: string;
  reputation: Reputation | null;
  near: NearFacts;
  opcodes: string[];
  touched: string[] | null;
  first_sale: Sale;
  list_target: boolean;
};
type ExitEvidence = { kind: "exit"; chain_id: number; block: number; method: string; request_sha256: string; amount: string; calls: string[]; quote: string; tx_hashes: string[] };
/** `skipped`: check not verifiable on this node, reported as such (neither passed nor failed). */
export type Line = { ok: boolean; line: string; skipped?: boolean };
/** Request read by get_check on the NEAR guard. */
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
  /** The buy the agent stated at request_check, in wei ("0" for an exit quote). */
  amount_wei: string;
  /** Signing hashes (no 0x) the sentinel posted: the guard signs only these transactions for the check. */
  tx_hashes: string[];
  /** The buy NEAR signed for this check (base64), null if none. */
  signed_tx?: string | null;
  /** The `list_target` the sentinel posted with the verdict. */
  list_target: boolean;
} | null;
/** A blocklist entry as get_entry returns it, null if not listed. */
export type OnChainEntry = { reporter: string; evidence_sha256: string } | null;
type BlockStateCall = { blockOverrides: { number: Hex; time: Hex }; calls: RequestCall[] };
const blocksOf = (q: Request) => (q.params[0] as { blockStateCalls: BlockStateCall[] }).blockStateCalls;
/** What replay compares of a call's result: status, return data and logs (emitter, topics, data). */
const outcome = (r: Result) => JSON.stringify([r.status, r.returnData, (r.logs ?? []).map((l) => [l.address.toLowerCase(), l.topics, l.data])]);

const EVIDENCE_KEYS = "amount_wei,block,calls,chain_id,code_hash,first_sale,implementation,liquidity,list_target,method,near,opcodes,quote,reputation,request_sha256,template,touched,tx_hashes";
const EXIT_KEYS = "amount,block,calls,chain_id,kind,method,quote,request_sha256,tx_hashes";
const REPUTATION_KEYS = "before_block,drained,from,index_sha256,median_drain_blocks,pools,template,to";
/** Tolerated gap between the EVM block time and those of the NEAR request and verdict: clocks of
 *  two chains, lag of the EVM RPC read by the sentinel, block interval. */
const CLOCK_SLACK_S = 60;
/** The node follows real time if its latest block is less than 2 min from the local clock. */
const LIVE_S = 120;

const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000", "");
const blockOf = (url: string, tag: string) => rpc<Header>(url, "eth_getBlockByNumber", [tag, false]);

/** `n` keccak256 hashes (0x + 64 hex digits). */
const hashes = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every((h) => typeof h === "string" && /^0x[0-9a-f]{64}$/.test(h));

/** Content of the evidence string: exactly the fields the sentinel posts, well typed. */
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
    const typed = Number.isSafeInteger(e.chain_id) && Number.isSafeInteger(e.block) && e.method === "eth_simulateV1" && typeof e.request_sha256 === "string" &&
      typeof e.amount === "string" && /^\d+$/.test(e.amount) && Array.isArray(e.calls) && typeof e.quote === "string" && /^\d+$/.test(e.quote) && hashes(e.tx_hashes, 2);
    return typed ? (e as unknown as ExitEvidence) : "exit evidence fields have unexpected types";
  }
  if (!isObj(e) || Object.keys(e).sort().join() !== EVIDENCE_KEYS) return `evidence keys are not exactly ${EVIDENCE_KEYS}`;
  const typed =
    Number.isSafeInteger(e.chain_id) &&
    Number.isSafeInteger(e.block) &&
    (e.block as number) >= 0 &&
    e.method === "eth_simulateV1" &&
    typeof e.request_sha256 === "string" &&
    typeof e.amount_wei === "string" &&
    /^\d+$/.test(e.amount_wei) &&
    hashes(e.tx_hashes, 1) &&
    typeof e.code_hash === "string" &&
    (e.implementation === null || typeof e.implementation === "string") &&
    Array.isArray(e.calls) &&
    e.calls.every((c) => typeof c === "string") &&
    typeof e.quote === "string" &&
    /^\d+$/.test(e.quote) &&
    (e.liquidity === null || isObj(e.liquidity)) &&
    typeof e.template === "string" &&
    (e.reputation === null ||
      (isObj(e.reputation) &&
        Object.keys(e.reputation).sort().join() === REPUTATION_KEYS &&
        [e.reputation.from, e.reputation.to].every(Number.isSafeInteger) &&
        (e.reputation.before_block === null || Number.isSafeInteger(e.reputation.before_block)))) &&
    isObj(e.near) &&
    Array.isArray(e.near.listed) &&
    (e.near.previous === null || isObj(e.near.previous)) &&
    Array.isArray(e.opcodes) &&
    e.opcodes.every((o) => Object.values(ENV_OPCODES).includes(o as string)) &&
    (e.touched === null || (Array.isArray(e.touched) && e.touched.every((a) => typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a)))) &&
    isSale(e.first_sale) &&
    typeof e.list_target === "boolean";
  return typed ? (e as unknown as Evidence) : "evidence fields have unexpected types";
}

/** A first sale deriveProbes can give: 5 to 150 blocks after the buy, 13 % to 87 %, never a whole percent. */
const isSale = (x: unknown): x is Sale =>
  isObj(x) &&
  Object.keys(x).sort().join() === "blocks,bps" &&
  Number.isSafeInteger(x.blocks) &&
  (x.blocks as number) >= SALE_BLOCKS[0] &&
  (x.blocks as number) <= SALE_BLOCKS[1] &&
  Number.isSafeInteger(x.bps) &&
  (x.bps as number) > 1300 &&
  (x.bps as number) < 8700 &&
  (x.bps as number) % 100 !== 0;

/** Minimal shape of the requests, checked BEFORE anything is sent: only `n` eth_simulateV1 requests
 *  (read-only) at the proof's block go to the node. Returns the defect found, or null. */
function shapeError(p: Proof, e: { block: number }, n: number): string | null {
  const rs = p.request as unknown;
  if (!Array.isArray(rs) || rs.length !== n) return `request is not ${n} eth_simulateV1 request(s)`;
  for (const r of rs) {
    if (!isObj(r) || r.method !== "eth_simulateV1") return "method is not eth_simulateV1";
    if (!Array.isArray(r.params) || r.params.length !== 2) return "params is not [request, block]";
    const [req, blk] = r.params;
    if (!isObj(req) || !Array.isArray(req.blockStateCalls) || !req.blockStateCalls.length || !req.blockStateCalls.every((b) => isObj(b) && Array.isArray(b.calls))) return "params[0] has no blockStateCalls";
    if (blk !== toHex(e.block)) return `params[1] ${String(blk)} is not evidence.block ${toHex(e.block)}`;
  }
  if (typeof p.target !== "string" || !Array.isArray(p.response) || p.response.length !== n || !p.response.every(Array.isArray)) return "malformed proof file";
  return null;
}

const SELECTOR = { buy: "0xb6f9de95", approve: "0x095ea7b3", sale: "0x791ac947" } as const;
/** The guard-side request holds the guard's own transactions and nothing else, nothing before or
 *  between them: its buy alone in the first block, then (full proof) an approve, a swap, an approve and
 *  a swap, each alone in its block, each swap in the block after its approve, the last swap in the last
 *  block, the other blocks empty, every call from the same address and carrying its nonce. Where the
 *  first sale falls is rebuild's to check (evidence.first_sale), their content (amounts, recipient,
 *  path) guardShape's, the buy's hash the evidence's. */
function guardOnly(bs: BlockStateCall[]): string | null {
  if (bs.length !== 1 && bs.length !== Number(LATE_BLOCKS)) return `${bs.length} blocks, not 1 or ${LATE_BLOCKS}`;
  const want = bs.length === 1 ? [SELECTOR.buy] : [SELECTOR.buy, SELECTOR.approve, SELECTOR.sale, SELECTOR.approve, SELECTOR.sale];
  const filled = [...bs.entries()].filter(([, b]) => b.calls.length);
  const got = filled.map(([i, b]) => `${i + 1}: ${b.calls.map((c) => String(c.data).slice(0, 10)).join(", ")}`);
  const ordered =
    filled.length === want.length &&
    filled.every(([, b], k) => b.calls.length === 1 && String(b.calls[0].data).slice(0, 10) === want[k]) &&
    filled[0][0] === 0 &&
    filled.at(-1)![0] === bs.length - 1 &&
    filled.every(([i], k) => want[k] !== SELECTOR.sale || filled[k - 1][0] === i - 1);
  if (!ordered) return `blocks hold ${got.join(" ; ")}, not the buy, then each approve and its swap in the next block, one call per block, the last swap in the last block`;
  const from = bs[0].calls[0].from;
  for (const [i, b] of filled) if (b.calls.some((c) => !same(c.from, from) || c.nonce === undefined)) return `block ${i + 1} holds a call from another address than ${from}, or without a nonce`;
  return null;
}

type Rebuilt = { labels: string[]; buyer: Address; guard: Address; stranger: Address | null; owner: Address | null; buy: Hex };
const NOBODY: Address = "0x0000000000000000000000000000000000000000";
type RequestCall = { from: Address; to: Address; data: Hex; value?: Hex; nonce?: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
const shape = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
  "function approve(address,uint256) returns (bool)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);
/** A placeholder unsigned transaction carrying `data`: only to lay out plan()'s calls by label. */
const placeholder = (functionName: string, args: unknown[]) =>
  serializeTransaction({ type: "eip1559", chainId: 1, to: NOBODY, data: encodeFunctionData({ abi: shape, functionName, args } as Parameters<typeof encodeFunctionData>[0]), gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
const SKELETON: GuardTxs = (() => {
  const sale = [placeholder("approve", [NOBODY, 0n]), placeholder("swapExactTokensForETHSupportingFeeOnTransferTokens", [0n, 0n, [], NOBODY, 0n])];
  return { buy: placeholder("swapExactETHForTokensSupportingFeeOnTransferTokens", [0n, [], NOBODY, 0n]), sales: [sale, sale] };
})();
/** One of the guard's calls of the request as the unsigned transaction it stands for (its hash is what
 *  the MPC signs). */
export function unsignedOf(c: RequestCall, chainId: number): Hex {
  if (c.nonce === undefined) throw new Error("a guard transaction without its nonce");
  return serializeTransaction({
    type: "eip1559",
    chainId,
    nonce: Number(BigInt(c.nonce)),
    to: c.to,
    value: BigInt(c.value ?? "0x0"),
    data: c.data,
    gas: BigInt(c.gas),
    maxFeePerGas: BigInt(c.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(c.maxPriorityFeePerGas),
    accessList: [],
  });
}

/** The guard's transactions must be what the guard builds for this check: a buy of `amount` wei of the
 *  target for the guard's address, and sales that approve exactly the amount they sell then swap it to
 *  ETH for the guard's address. Without --check this is all replay can say; with it, their hashes are
 *  the ones the guard stored. Returns the defect, or null. */
function guardShape(txs: GuardTxs, token: Address, guard: Address, amount: bigint, sold: [bigint, bigint] | null): string | null {
  const b = parseTransaction(txs.buy);
  const buy = decodeFunctionData({ abi: shape, data: b.data ?? "0x" });
  const [, bp, bto] = buy.args as unknown as [bigint, Address[], Address];
  if (buy.functionName !== "swapExactETHForTokensSupportingFeeOnTransferTokens" || !same(b.to ?? "", ROUTER) || b.value !== amount || bp.length !== 2 || !same(bp[0], WETH) || !same(bp[1], token) || !same(bto, guard))
    return `the guard's buy is not ${amount} wei of WETH -> ${token} on the router for ${guard}`;
  for (const [i, sale] of (txs.sales ?? []).entries()) {
    const bad = saleShape(sale, token, guard, sold![i]);
    if (bad) return `sale ${i + 1}: ${bad}`;
  }
  return null;
}

/** A sale as the guard signs it: approve(router, x) on the token, then the swap of x to ETH for `guard`. */
function saleShape(sale: Hex[], token: Address, guard: Address, x: bigint): string | null {
  const [a, s] = sale.map((t) => parseTransaction(t));
  const approve = decodeFunctionData({ abi: shape, data: a.data ?? "0x" });
  const swap = decodeFunctionData({ abi: shape, data: s.data ?? "0x" });
  const [spender, allowed] = approve.args as unknown as [Address, bigint];
  const [inAmount, , path, to] = swap.args as unknown as [bigint, bigint, Address[], Address];
  if (approve.functionName !== "approve" || !same(a.to ?? "", token) || !same(spender, ROUTER) || allowed !== x) return `not approve(router, ${x}) on the target`;
  if (swap.functionName !== "swapExactTokensForETHSupportingFeeOnTransferTokens" || !same(s.to ?? "", ROUTER) || inAmount !== x || path.length !== 2 || !same(path[0], token) || !same(path[1], WETH) || !same(to, guard))
    return `not a swap of ${x} target -> ETH on the router for ${guard}`;
  return null;
}

/** Rebuilds the requests checkToken would have produced for proof.target (same calls, same addresses,
 *  router, WETH, blocks at Base's cadence) and derives the labels from them: those of the file do not
 *  count. Only the buyer, the guard's address, the stranger and the guard's own transactions come from
 *  the requests (at the positions plan() gives them; the guard's must have the shape the guard builds,
 *  and their hashes are checked against the evidence and, with --check, the guard); amounts and owner
 *  come from the fresh responses; base fee, prevrandao, coinbase and real balances come from the node,
 *  at the proof's block. No fallback: a missing probe is a defect. */
async function rebuild(url: string, p: Proof, e: Evidence, fresh: Result[][]): Promise<Rebuilt | { error: string }> {
  try {
    const [g, pr, sy] = p.request.map(blocksOf);
    const token = p.target as Address;
    const block = BigInt(e.block);
    const amount = BigInt(e.amount_wei);
    /** The request's call that plan() labels `label` in `layout`. */
    const at = (layout: Block[], req: BlockStateCall[], label: string) => {
      for (const [i, b] of layout.entries()) {
        const j = b.calls.findIndex((c) => c.label === label);
        if (j >= 0) return req[i]?.calls[j];
      }
      return undefined;
    };
    const buyCall = g[0]?.calls[0];
    const buyer = pr[0]?.calls[0]?.from;
    if (!buyCall || !buyer) return { error: "request has no guard buy or no probe buy" };
    const guard = buyCall.from;
    const txs: GuardTxs = { buy: unsignedOf(buyCall, e.chain_id) };
    const fees: Fees = { gas: BigInt(buyCall.gas), maxFeePerGas: BigInt(buyCall.maxFeePerGas), maxPriorityFeePerGas: BigInt(buyCall.maxPriorityFeePerGas) };
    const head = await headAt(url, toHex(e.block));
    const buyOnly = plan(token, { guard, buyer, stranger: NOBODY }, block, amount, txs);
    // The 1st simulation's calls open each request: their fresh results give the amounts and owner().
    const first = SIDES.flatMap((k, i) => fresh[i].slice(0, buyOnly[k].flatMap((b) => b.calls).length));
    const st = buyStages(byLabel(labelsOf(buyOnly), first), { token, guard, buyer, stranger: NOBODY });
    let sides = buyOnly;
    let stranger: Address | null = null;
    const full = !st.stop && !!e.liquidity;
    if (full) {
      const layout = plan(token, { guard, buyer, stranger: NOBODY }, block, amount, SKELETON, { amounts: st.amounts, owner: st.owner, sale: e.first_sale });
      stranger = at(layout.synthetic, sy, "transferFrom by a stranger")?.from ?? null;
      if (!stranger) return { error: "request has no stranger probe where checkToken puts one" };
      const sales = SALES.map((when) => [`${GUARD}approve router${when}`, `${GUARD}sale${when}`].map((l) => at(layout.guard, g, l)));
      if (sales.flat().some((c) => !c)) return { error: `the guard's sales are not where evidence.first_sale puts them (${e.first_sale.blocks} blocks after the buy)` };
      txs.sales = sales.map((sale) => sale.map((c) => unsignedOf(c!, e.chain_id))) as [Hex[], Hex[]];
      sides = plan(token, { guard, buyer, stranger }, block, amount, txs, { amounts: st.amounts, owner: st.owner, sale: e.first_sale });
    }
    const bad = guardShape(txs, token, guard, amount, txs.sales ? saleAmounts(st.amounts.guard, e.first_sale.bps) : null);
    if (bad) return { error: bad };
    const owner = full ? st.owner : null;
    const want = await Promise.all(SIDES.map(async (k) => buildRequest(head, await balances(url, head, sides[k], fees, guard, owner), sides[k], fees)));
    if (JSON.stringify(want) !== JSON.stringify(p.request)) return { error: "requests are not the ones checkToken builds for this target" };
    const labels = labelsOf(sides);
    if (labels.length !== fresh.flat().length) return { error: `expected ${labels.length} calls, node returned ${fresh.flat().length}` };
    return { labels, buyer, guard, stranger, owner: st.owner, buy: txs.buy };
  } catch (err) {
    return { error: `request cannot be parsed (${msg(err)})` };
  }
}

/** The probes must be fresh addresses: not the router, WETH, target or owner(), without code
 *  at the block, and distinct. Otherwise a token that exempts a privileged address would pass as healthy. */
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

const readCheck = async (id: number) => (await import("./near")).view<OnChain>("get_check", { id }); // near.ts installs a global fetch: loaded here only
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

  // (a) the file's request is the one whose hash is in evidence
  const hash = sha256(stringToHex(JSON.stringify(proof.request)));
  add(hash === e.request_sha256, `request hash ${hash === e.request_sha256 ? "matches evidence" : `${hash} != ${e.request_sha256}`}`);

  const bad = shapeError(proof, e, 3);
  if (bad) {
    add(false, `request shape: ${bad} (nothing sent to the node)`);
    return out;
  }

  // (b) same chain; time of the first simulated block = time of the proof's block + 2 s (every block's
  // time, number and prevrandao are checked with the rebuilt requests)
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
    const first = BigInt(blocksOf(proof.request[0])[0].blockOverrides.time);
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

  // (b2) the guard side holds the guard's own transactions only: no read, no probe, no other call
  // before or between them (judge pass 5: a top-level balanceOf there let a honeypot sell)
  const only = guardOnly(blocksOf(proof.request[0]));
  add(!only, only ? `guard-side request: ${only}` : "guard-side request holds only the guard's own transactions (buy; approve, swap; approve, swap), nothing before or between them");

  // (c) same requests, same block; same statuses, return data and logs
  let fresh: Result[][] | null = null;
  let rebuilt: Rebuilt | null = null;
  try {
    fresh = await Promise.all(proof.request.map(async (q) => (await rpc<{ calls: Result[] }[]>(url, q.method, q.params)).flatMap((b) => b.calls)));
    add(true, `${fresh.length} requests resent to ${url} at block ${e.block} (${fresh.flat().length} calls)`);
  } catch (err) {
    fail("resending the requests", err);
  }
  if (fresh) {
    const diffs: string[] = [];
    const [now, old] = [fresh.flat(), proof.response.flat()];
    if (now.length !== old.length) diffs.push(`call count ${old.length} -> ${now.length}`);
    const labels = e.calls.map((c) => c.replace(/: (ok|revert)$/, "")); // only to name the discrepancies
    old.forEach((o, i) => {
      if (!now[i]) return;
      if (o.status !== now[i].status) diffs.push(`${labels[i] ?? i}: status ${o.status} -> ${now[i].status}`);
      else if (outcome(o) !== outcome(now[i])) diffs.push(`${labels[i] ?? i}: return data or logs differ`);
    });
    add(!diffs.length, diffs.length ? `call results differ: ${diffs.join(" ; ")}` : `status, return data and logs of all ${now.length} calls identical`);

    // (d) rebuilt requests, fresh probes, labels, then rejudging from the fresh responses
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
      const want = now.map((res, i) => `${r.labels[i]}: ${succeeded(res) ? "ok" : "revert"}`);
      const same = JSON.stringify(want) === JSON.stringify(e.calls);
      add(same, same ? "call labels rebuilt from the requests match evidence.calls" : "call labels in evidence.calls differ from those rebuilt from the requests");
      const parties = { token: proof.target as Address, guard: r.guard, buyer: r.buyer, stranger: r.stranger ?? NOBODY };
      const j = judge(r.labels, now, { ...e, code_hash: e.code_hash as Hex, implementation: e.implementation as Address | null }, parties);
      const ok = j.verdict === proof.verdict && j.reasons === proof.reasons;
      add(ok, ok ? `verdict ${j.verdict} rejudged identically (same reasons)` : `verdict/reasons differ: file "${proof.verdict}: ${proof.reasons}" vs rejudged "${j.verdict}: ${j.reasons}"`);
      const listOk = j.list_target === e.list_target;
      add(listOk, listOk ? `list_target ${j.list_target} rejudged identically` : `evidence.list_target ${e.list_target} != rejudged ${j.list_target}`);
      // the addresses the guard's transactions touch, traced again on a local fork of this node (the
      // requests are the ones checkToken builds, checked above)
      try {
        const t = e.liquidity ? await touched(url, proof.request[0], e.block) : null;
        const same = JSON.stringify(t) === JSON.stringify(e.touched);
        add(same, same ? `addresses the guard's transactions touch, traced again on a local fork at block ${e.block}: ${t ? t.length : "none, no pool"}, identical to evidence.touched` : `addresses touched: evidence ${JSON.stringify(e.touched)}, traced ${JSON.stringify(t)}`);
      } catch (err) {
        fail("tracing the guard's transactions on a local fork", err);
      }
      const q = quoteOf(r.labels, now, parties).toString();
      add(q === e.quote, q === e.quote ? `quote ${q} tokens for ${e.amount_wei} wei recomputed identically` : `quote in evidence ${e.quote} != recomputed ${q}`);
      const h = keccak256(r.buy);
      add(h === e.tx_hashes[0], h === e.tx_hashes[0] ? `the guard's buy simulated (calldata, value, nonce, gas, fees) hashes to evidence.tx_hashes ${h.slice(0, 10)}...` : `the guard's buy simulated hashes to ${h}, evidence says ${e.tx_hashes[0]}`);
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
      const own = e.liquidity?.pair ?? null;
      const want = JSON.stringify(reputationOf(index, e.template as Hex, beforeBlock(index, own, await ownFunding(url, index, own))));
      add(want === JSON.stringify(r), want === JSON.stringify(r) ? `template reputation recomputed identically (${r.drained} of ${r.pools} earlier pools drained)` : `template reputation differs: evidence ${JSON.stringify(r)} vs rebuilt ${want}`);
    } catch (err) {
      fail("rebuilding the template index", err);
    }
  }

  // (e) target's code and proxy implementation at the block
  try {
    const code = await rpc<Hex>(url, "eth_getCode", [proof.target, toHex(e.block)]);
    const h = keccak256(code);
    add(h === e.code_hash, h === e.code_hash ? "target code hash matches evidence" : `target code hash ${h} != ${e.code_hash}`);
    const t = templateOf(code);
    add(t === e.template, t === e.template ? "target template (code, immutables and metadata masked) matches evidence" : `target template ${t} != ${e.template}`);
    const impl = await implementationAt(url, proof.target as Address, BigInt(e.block));
    const same = impl?.toLowerCase() === e.implementation?.toLowerCase();
    add(same, same ? `proxy implementation (${impl ?? "none"}) matches evidence` : `proxy implementation ${impl ?? "none"} != evidence ${e.implementation ?? "none"}`);
    const ops = await opcodesOf(url, code, impl, BigInt(e.block));
    const sameOps = JSON.stringify(ops) === JSON.stringify(e.opcodes);
    add(sameOps, sameOps ? `opcodes no simulation can match, in the target's and its implementation's code: ${ops.join(", ") || "none"}, as in evidence` : `opcodes in the code: ${ops.join(", ") || "none"}, evidence says ${e.opcodes.join(", ") || "none"}`);
  } catch (err) {
    fail("reading target code", err);
  }

  // (f) verdict posted on the NEAR contract, tied to this evidence string by its sha256
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
        add(c.amount_wei === e.amount_wei, c.amount_wei === e.amount_wei ? `on-chain amount ${c.amount_wei} wei (stated at request_check) is the one simulated` : `on-chain amount ${c.amount_wei} wei != simulated ${e.amount_wei}`);
        add(
          c.list_target === e.list_target,
          c.list_target === e.list_target ? `on-chain list_target ${c.list_target} is the evidence's` : `on-chain list_target ${c.list_target} != evidence.list_target ${e.list_target}: the guard was asked to list what the evidence does not support`,
        );
        out.push(...signedAsSimulated(proof.id, c, e.tx_hashes));
        if (c.target.toLowerCase() !== proof.target.toLowerCase()) add(false, `on-chain target ${c.target} is not the proof target ${proof.target}`);
        else {
          const same = c.verdict === proof.verdict && c.reasons === proof.reasons;
          add(same, same ? `on-chain verdict ${c.verdict} for #${proof.id} matches (same target, same reasons)` : `on-chain "${c.verdict}: ${c.reasons}" != file "${proof.verdict}: ${proof.reasons}"`);
        }
        if (rebuilt) out.push(...(await derivation(proof.id, rebuilt, e.first_sale, c, blockHash, opts.guard ?? (await readGuard()))));
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

/** The guard signs only the transactions whose hashes it stored with the verdict: they must be the
 *  simulated ones, and a buy NEAR already signed must be that very transaction, signature aside. */
function signedAsSimulated(id: number, c: NonNullable<OnChain>, simulated: string[]): Line[] {
  const line = (ok: boolean, text: string): Line => ({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  const stored = c.tx_hashes.map((h) => `0x${h}`);
  const same = JSON.stringify(stored) === JSON.stringify(simulated);
  const out = [line(same, same ? `on-chain tx hashes of #${id} are those of the transactions simulated: the guard signs nothing else for it` : `on-chain tx hashes of #${id} ${stored.join(", ") || "none"} != simulated ${simulated.join(", ")}`)];
  if (c.signed_tx) {
    const { r: _r, s: _s, v: _v, yParity: _y, ...unsigned } = parseTransaction(`0x${Buffer.from(c.signed_tx, "base64").toString("hex")}`);
    const h = keccak256(serializeTransaction(unsigned));
    out.push(line(h === simulated[0], h === simulated[0] ? `the buy NEAR signed for #${id} is the transaction simulated (${h.slice(0, 10)}...)` : `the buy NEAR signed for #${id} hashes to ${h}, not the simulated ${simulated[0]}`));
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
  const bad = shapeError(proof, e, 1);
  if (bad) {
    add(false, `request shape: ${bad} (nothing sent to the node)`);
    return out;
  }
  let seller: Address | null = null;
  try {
    const id = Number(await rpc<Hex>(url, "eth_chainId", []));
    add(id === e.chain_id, id === e.chain_id ? `chain id ${id} matches evidence` : `node chain id ${id} != evidence chain id ${e.chain_id}`);
    const calls = blocksOf(proof.request[0]).flatMap((b) => b.calls);
    seller = calls[0]?.from ?? null;
    const head = await headAt(url, toHex(e.block));
    const token = proof.target as Address;
    const pair = `0x${(await rpc<Hex>(url, "eth_call", [{ to: FACTORY, data: encodeFunctionData({ abi: parseAbi(["function getPair(address,address) view returns (address)"]), args: [token, WETH] }) }, toHex(e.block)])).slice(-40)}` as Address;
    // the approve and swap the guard would sign (positions of exitPlan), from the request; shape checked, hashes against the evidence
    const txs = [calls[0], calls[1]].map((c) => unsignedOf(c, e.chain_id));
    const fees: Fees = { gas: BigInt(calls[0].gas), maxFeePerGas: BigInt(calls[0].maxFeePerGas), maxPriorityFeePerGas: BigInt(calls[0].maxPriorityFeePerGas) };
    const blocks = exitPlan(seller ?? NOBODY, BigInt(e.block), txs);
    const funds = await balances(url, head, blocks, fees, seller ?? NOBODY, null);
    const same = JSON.stringify([buildRequest(head, funds, blocks, fees)]) === JSON.stringify(proof.request);
    add(same, same ? `request is the exit sale checkExit builds for ${e.amount} tokens from ${seller}, alone in its block` : "request is not the exit sale checkExit builds for this target and amount");
    const sold = BigInt(e.amount);
    const shapeBad = saleShape(txs, token, seller ?? NOBODY, sold);
    add(!shapeBad, shapeBad ? `exit transactions: ${shapeBad}` : `exit transactions are approve(router, ${sold}) then the swap of ${sold} to ETH for ${seller}`);
    const hs = txs.map((t) => keccak256(t));
    add(JSON.stringify(hs) === JSON.stringify(e.tx_hashes), JSON.stringify(hs) === JSON.stringify(e.tx_hashes) ? "the approve and swap simulated hash to evidence.tx_hashes" : `the approve and swap simulated hash to ${hs.join(", ")}, evidence says ${e.tx_hashes.join(", ")}`);
    const fresh = (await rpc<{ calls: Result[] }[]>(url, proof.request[0].method, proof.request[0].params)).flatMap((b) => b.calls);
    const sameResults = JSON.stringify(fresh.map(outcome)) === JSON.stringify(proof.response[0].map(outcome));
    add(sameResults, sameResults ? `request resent to ${url} at block ${e.block}: status, return data and logs of all ${fresh.length} calls identical` : "call results differ");
    const j = judgeExit(blocks.flatMap((b) => b.calls.map((c) => c.label)), fresh, { token, seller: seller ?? NOBODY, pair });
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
      const ok = c.verdict === proof.verdict && c.reasons === proof.reasons && c.quote === e.quote && c.exit_amount === e.amount && same(c.target, proof.target);
      add(ok, ok ? `on-chain exit quote #${proof.id}: ${c.verdict}, ${c.quote} wei for ${c.exit_amount} tokens, matches` : `on-chain #${proof.id} (${c.verdict}, quote ${c.quote}, amount ${c.exit_amount}, ${c.target}) differs from the file`);
      out.push(...signedAsSimulated(proof.id, c, e.tx_hashes));
    }
  } catch (err) {
    out.push({ ok: false, line: `ERROR    reading the NEAR contract: ${msg(err)}` });
  }
  return out;
}

/** The probes and the first sale must be deriveProbes(guard, #id, on-chain request time, EVM block
 *  hash) and the guard side must be the guard's derived EVM address: otherwise the sentinel chose who
 *  was simulated, or when and how much it sold. */
function derivation(id: number, r: Rebuilt, sale: Sale, c: NonNullable<OnChain>, blockHash: Hex | null, g: GuardInfo): Line[] {
  if (!blockHash) return [{ ok: false, line: "ERROR    probe derivation: EVM block hash unknown" }];
  const want = deriveProbes({ guard: g.account, id, requested_ns: c.requested_ns }, blockHash);
  const probesOk = same(r.buyer, want.buyer) && (r.stranger === null || same(r.stranger, want.stranger));
  const saleOk = sale.blocks === want.sale.blocks && sale.bps === want.sale.bps;
  const line = (ok: boolean, text: string): Line => ({ ok, line: `${ok ? "OK      " : "MISMATCH"} ${text}` });
  return [
    line(
      saleOk,
      saleOk
        ? `first sale derived like the probes: ${sale.blocks} blocks after the buy, ${sale.bps / 100} % of the tokens bought`
        : `first sale not derived from on-chain data: ${sale.blocks} blocks, ${sale.bps} bps (derived ${want.sale.blocks} blocks, ${want.sale.bps} bps)`,
    ),
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

/** The proof's EVM block time must fall between the NEAR request and verdict. Verifiable
 *  only if the node follows real time: a local copy (anvil) keeps the copied block's time. */
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
