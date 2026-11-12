// Sentinel role: reads the guard's verdict requests, simulates the buy on the EVM chain,
// posts verdict, reasons and proof digest with its function-call key (post_verdict only).
// It also reads the guard's shared blocklist and the code seen at the target's last verdict, builds the
// template index up to each check's reference block (app/index.ts, indexer), and quotes
// agents' exits (request_exit) by simulating the
// sale from the guard's EVM address. The guard side runs the guard's own transactions, read from the
// guard (preview_check, preview_sale): same calldata, value, nonce, gas and fees as it signs. The
// verdict carries their hashes, and the guard signs nothing else for that check.
// The full proof (eth_simulateV1 request, response and posted evidence string, byte for byte)
// goes to proofs/<id>.json; the contract stores the sha256 of that string with the verdict.
// A check that fails 3 times gets a block (fail closed): a token cannot stall the queue nor be bought.
// A buy check waits for the real Base block its later side runs on: the first block 16 to 24 s after
// the reference block, itself the first block 4 s after the request.
// The guard takes votes: an allow or a warn needs the quorum of its sentinels to post the same one, any
// one of them blocks. Each sentinel is this program with its own account, key and, ideally, Base node.
// Usage: [INDEX_RPC=<rpc>] [INDEX_FROM=<block>|none] bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts   (EVM_RPC: the node)
import { formatEther, type Address, type Hex } from "viem";
import { buildIndex, indexSha256, INDEX_SPAN_S, windowStart, type Index } from "./index";
import type { Check, Entry, Sentinels } from "./near";
import type { NearFacts, Previews } from "./verifier";

/** The template index this sentinel judges with, from its environment: built for each check up to its
 *  reference block, on INDEX_RPC (EVM_RPC by default; it must serve eth_getLogs). It starts at block
 *  INDEX_FROM when set (the fork), otherwise at the last block 2 h before the check's (windowStart: real
 *  Base, the same window for every sentinel). INDEX_FROM=none: no index, so every buy verdict is at least
 *  warn. `log` gets each build's window, request count, time and sha256. */
export function indexer(e: Record<string, string | undefined>, log: (s: string) => void = () => {}): { rpc: string; build: (block: number) => Promise<Index> } | null {
  if (e.INDEX_FROM === "none") return null;
  const rpc = e.INDEX_RPC || e.EVM_RPC;
  if (!rpc) throw new Error("INDEX_RPC or EVM_RPC must name a node for the template index");
  const fixed = e.INDEX_FROM ? Number(e.INDEX_FROM) : null;
  const build = async (block: number) => {
    const started = Date.now();
    let requests = 0;
    const from = fixed ?? (await windowStart(rpc, block));
    const index = await buildIndex(rpc, from, block, async () => void requests++);
    const pools = Object.values(index.templates).flat().length;
    log(`template index of blocks ${from}..${block} on ${rpc}: ${pools} WETH pools, built in ${requests} requests, ${((Date.now() - started) / 1000).toFixed(1)} s in all, sha256 ${indexSha256(index).slice(0, 10)}...`);
    return index;
  };
  return { rpc, build };
}

/** What to do with the request read at block height `readAt`, its id being <= last_check_id read at
 *  height `lastAt`. Absent at a height >= lastAt: it existed at lastAt and no longer does, so it was
 *  erased by refund_check (ids never come back), skip it. Absent at a lower
 *  height: the node read is behind, reread it on the next round without advancing.
 *  Present: sentinel `me` judges it while its vote can still count: it has not voted, the check is
 *  undecided or blocked (a block takes votes up to the quorum: listing needs them), and fewer than
 *  `quorum` votes are in (one for an exit quote); and only if it was requested at or after `since` (ns,
 *  this sentinel's start): an older check is another run's, perhaps on another chain (a fork and Base
 *  share chain id 8453 and the demo guard), and a vote on it is either useless or wrong. Left undecided,
 *  it times out (300 s) and its agent gets its price back (refund_check). */
export function step(check: Check | null, readAt: number, lastAt: number, me = "", quorum = 1, since = 0n): "judge" | "skip" | "retry" {
  if (!check) return readAt >= lastAt ? "skip" : "retry";
  if (BigInt(check.requested_ns) < since) return "skip";
  const open = (check.verdict === null || check.verdict === "block") && check.votes.length < (check.exit_amount ? 1 : quorum);
  return open && !check.votes.some((v) => v.sentinel === me) ? "judge" : "skip";
}

/** Why the guard refused a vote, when the sentinel set or the quorum read at startup explains it:
 *  `settled`, the check took no more votes (another sentinel's decided it, or a quorum lowered since);
 *  `not a sentinel`, this account was removed from the set. Then the set and quorum are read again.
 *  Any other refusal is a failure, retried. */
export function refusal(reason: string): "settled" | "not a sentinel" | null {
  if (/verdict already posted|sentinel already voted/.test(reason)) return "settled";
  return /sentinel only/.test(reason) ? "not a sentinel" : null;
}

if (import.meta.main) {
  // near.ts installs a global fetch and reads NEAR_RPC at import: loaded here only, not by the tests.
  const { account, call, env, reason, view, viewAt } = await import("./near");
  const { checkExit, checkToken, deriveProbes, toProof } = await import("./verifier");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  const { mkdir, rm } = await import("node:fs/promises");

  // Votes only on checks requested since now (step): 30 s of margin for NEAR's block clock against this
  // machine's, as check-mainnet.sh requests its check right after starting the sentinels.
  const since = BigInt(Date.now() - 30_000) * 1_000_000n;
  let tag = "sentinel"; // "sentinel 2" once it knows its place among several
  const log = (s: string) => console.log(`    [${tag}] ${s}`);
  const ME = env("SENTINEL");
  const sentinel = account(ME, env("SENTINEL_KEY"));
  // The guard's sentinels and quorum, read at startup and again when the guard refuses a vote for them
  // (refusal): this process is one of them, with its own key and, when the operator gives it one, its own
  // Base node (EVM_RPC). Its proofs go to proofs/<id>.json for the first sentinel named,
  // proofs/<id>.s<n>.json for the n-th.
  let { sentinels, quorum } = await view<Sentinels>("sentinels");
  let rank = sentinels.indexOf(ME);
  if (rank < 0) throw new Error(`${ME} is not one of the guard's sentinels (${sentinels.join(", ")})`);
  if (sentinels.length > 1) tag = `sentinel ${rank + 1}`;
  const proofPath = (id: number) => `proofs/${id}${rank ? `.s${rank + 1}` : ""}.json`;
  /** Reads the sentinel set and the quorum again; stops this process once it is no longer in the set. */
  const reread = async () => {
    ({ sentinels, quorum } = await view<Sentinels>("sentinels"));
    rank = sentinels.indexOf(ME);
    if (rank < 0) {
      // not a retryable failure: the scan loop would read the guard again forever
      console.error(`    [${tag}] ${ME} is no longer one of the guard's sentinels (${sentinels.join(", ")}): stopping`);
      process.exit(1);
    }
    log(`sentinel set read again: ${sentinels.join(", ")}, quorum ${quorum}; I am sentinel ${rank + 1}`);
  };
  const EVM = env("EVM_RPC");
  // The node it reads logs from (INDEX_RPC, EVM_RPC by default): the index's, its own pool's, LP holders'.
  // Each sentinel its own, tied to its EVM_RPC at every check (app/verifier.ts sameChain).
  const LOGS = process.env.INDEX_RPC || EVM;
  const NODES = { simulation: new URL(EVM).host, logs: new URL(LOGS).host };
  // The real buyer: the guard's EVM address, public, derived like the relay does. Simulated too.
  const GUARD_EVM = deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH);
  // The guard's slippage bound, fixed at init: an agent's holding is a buy's quote minus it, and each buy
  // check also sells that share (app/verifier.ts exitShare).
  const { max_slippage_bps } = await view<{ max_slippage_bps: number }>("evm_config");
  await mkdir("proofs", { recursive: true });
  // The index must end at each check's reference block (windowProblem): it is built for each check.
  const index = indexer(process.env, log);
  const from = process.env.INDEX_FROM ? `block ${process.env.INDEX_FROM}` : `the last block ${INDEX_SPAN_S / 3600} h before it`;
  log(index ? `template index on ${index.rpc}, for each check from ${from} to its block` : "no template index (INDEX_FROM=none): reputation unknown, so every buy verdict is at least warn");

  /** The guard's blocklist entry on the target, and the code of its last verdict. */
  const nearFacts = async (target: Address): Promise<NearFacts> => {
    const [entry, last] = await Promise.all([
      view<Entry | null>("get_entry", { token: target }),
      view<{ id: number; code: { code_hash: Hex; implementation: Address | null } } | null>("last_code", { target }),
    ]);
    const listed = entry ? [{ key: target.toLowerCase(), reporter: entry.reporter, evidence_sha256: entry.evidence_sha256 }] : [];
    return { listed, previous: last ? { id: last.id, ...last.code } : null };
  };

  // ponytail: rereads every request from 1 at startup; start from a saved cursor if they number in the thousands.
  let next = 1;
  const failures = new Map<number, number>();
  const MAX_TRIES = 3;

  const judge = async (id: number, check: Check) => {
    const target = check.target as Address;
    // What the guard would sign for this check, built by the guard itself: the guard side simulates
    // exactly these transactions, and the guard signs only those whose hashes the verdict carries.
    const preview: Previews = {
      check: (quote) => view<Hex[]>("preview_check", { id, quote: quote.toString() }),
      sale: (amount, deadline) => view<Hex[]>("preview_sale", { token: target, amount: amount.toString(), deadline_s: Number(deadline) }),
      slippage_bps: max_slippage_bps,
    };
    const unprefixed = (hs: Hex[]) => hs.map((h) => h.slice(2));
    if (check.exit_amount) {
      log(`#${id} : ${check.agent} wants to sell ${check.exit_amount} of ${target}: exit quote, the guard's approve and swap simulated from its EVM address...`);
      const r = await checkExit(EVM, target, GUARD_EVM, BigInt(check.exit_amount), preview.check);
      const proof = toProof(id, target, r, NODES);
      await Bun.write(proofPath(id), JSON.stringify(proof, null, 2));
      const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code: null, list_target: false, tx_hashes: unprefixed(r.evidence.tx_hashes) });
      log(`#${id} : exit quote ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.quote} wei for ${check.exit_amount} tokens, block ${r.evidence.block}, proof ${proofPath(id)}  ${tx}`);
      return;
    }
    log(`#${id} : ${check.agent} wants to buy ${formatEther(BigInt(check.amount_wei))} ETH of ${target}: the guard's own buy and sales simulated, liquidity, template reputation, blocklist...`);
    // Probes derived from on-chain data, not chosen here: replay --check recomputes them.
    const ticket = { guard: env("GUARD"), id, requested_ns: check.requested_ns };
    const r = await checkToken(EVM, target, GUARD_EVM, (head, cadence) => deriveProbes(ticket, head.hash, cadence), { requested_ns: check.requested_ns, index: index?.build ?? null, indexRpc: LOGS, near: nearFacts, amount: BigInt(check.amount_wei), preview });
    const proof = toProof(id, target, r, NODES);
    await Bun.write(proofPath(id), JSON.stringify(proof, null, 2));
    const code = { code_hash: r.evidence.code_hash, implementation: r.evidence.implementation };
    // list_target: the guard lists the token only on a block the probe side shows after a buy that
    // succeeded, never on what the agent's amount decides (judge).
    const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code, list_target: r.list_target, tx_hashes: unprefixed(r.evidence.tx_hashes) });
    const failed = r.evidence.calls.filter((c) => c.endsWith("revert")).length;
    const later = r.evidence.later ? `, sales again on block ${r.evidence.later.block}` : "";
    log(`#${id} : ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.calls.length} simulated calls (${failed} reverted, takeback probes included), quote ${r.evidence.quote} for ${r.evidence.amount_wei} wei, guard tx ${r.evidence.tx_hashes[0].slice(0, 10)}..., block ${r.evidence.block}${later}, proof ${proofPath(id)} (simulated on ${NODES.simulation}, logs from ${NODES.logs}), vote posted (an allow or a warn takes ${quorum})  ${tx}`);
    // An entry is never overwritten: a token already listed keeps its first entry. Listing takes the
    // quorum's identical block votes: this one asks for it.
    if (r.list_target && !r.evidence.near.listed.length) log(`#${id} : this block vote asks to list ${target} on the guard's shared blocklist: listed once ${quorum === 1 ? "posted" : `${quorum} sentinels' identical votes are in`}`);
  };

  const scan = async () => {
    const { value: last, height: lastAt } = await viewAt<number>("last_check_id");
    while (next <= last) {
      const { value: check, height } = await viewAt<Check | null>("get_check", { id: next });
      const what = step(check, height, lastAt, ME, quorum, since);
      if (what === "retry") {
        log(`#${next} : not found on a node behind the guard (block ${height} < ${lastAt}), will reread`);
        break;
      }
      if (check && what === "judge") {
        try {
          await judge(next, check);
        } catch (e) {
          const refused = refusal(reason(e));
          if (refused) {
            // its proof was never posted: an exit quote takes one vote, a decided check no more
            await rm(proofPath(next), { force: true });
            log(refused === "settled" ? `#${next} : the check takes no more votes (another sentinel's decided it, or the quorum changed): mine is not needed` : `#${next} : vote refused, "sentinel only"`);
            await reread(); // stops this process once this account is out of the set
            next++;
            continue;
          }
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          const tries = (failures.get(next) ?? 0) + 1;
          failures.set(next, tries);
          if (tries < MAX_TRIES) {
            log(`#${next} : failure ${tries}/${MAX_TRIES}, will retry (${msg})`);
            break;
          }
          // Fail closed: a token that makes the simulation fail does not block the following requests,
          // and is not bought.
          // If this post fails too (NEAR RPC, verdict already arrived), the next round rereads the request:
          // a verdict already on chain is skipped, otherwise it is reposted.
          try {
            const { tx } = await call(sentinel, "post_verdict", {
              id: next,
              verdict: "block",
              reasons: `simulation impossible after ${MAX_TRIES} tries : ${msg}`.slice(0, 280),
              evidence: JSON.stringify({ error: msg.slice(0, 1000) }),
              quote: "0",
              code: null,
              list_target: false,
              tx_hashes: [],
            });
            log(`#${next} : BLOCK, simulation impossible (${msg})  ${tx}`);
          } catch (e2) {
            log(`#${next} : fallback verdict not posted, will retry (${e2 instanceof Error ? e2.message.split("\n")[0] : e2})`);
            break;
          }
        }
      } else if (!check) log(`#${next} : refunded without a verdict, skipped`);
      next++;
    }
  };

  log(`${ME}, sentinel ${rank + 1} of ${sentinels.length} (quorum ${quorum}), listening to ${env("GUARD")}, simulating on ${NODES.simulation} (logs from ${NODES.logs}) as a derived probe buyer and as the guard's EVM address ${GUARD_EVM}`);
  for (;;) {
    try {
      await scan();
    } catch (e) {
      // NEAR RPC unavailable or too slow: nothing is lost, the next round rereads from `next`.
      log(`reading the guard failed, will retry (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    await Bun.sleep(1500);
  }
}
