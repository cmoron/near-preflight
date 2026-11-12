// Sentinel role: reads the guard's verdict requests, simulates the buy on the EVM chain,
// posts verdict, reasons and proof digest with its function-call key (post_verdict only).
// It also reads the guard's shared blocklist and the code seen at the target's last verdict, consults
// the template index in INDEX (app/index.ts), and quotes agents' exits (request_exit) by simulating the
// sale from the guard's EVM address. The guard side runs the guard's own transactions, read from the
// guard (preview_check, preview_sale): same calldata, value, nonce, gas and fees as it signs. The
// verdict carries their hashes, and the guard signs nothing else for that check.
// The full proof (eth_simulateV1 request, response and posted evidence string, byte for byte)
// goes to proofs/<id>.json; the contract stores the sha256 of that string with the verdict.
// A check that fails 3 times gets a block (fail closed): a token cannot stall the queue nor be bought.
// Usage: [INDEX=<index.json>] bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts   (EVM_RPC: the node)
import { formatEther, type Address, type Hex } from "viem";
import type { Index } from "./index";
import type { Check, Entry } from "./near";
import type { NearFacts, Previews } from "./verifier";

/** What to do with the request read at block height `readAt`, its id being <= last_check_id read at
 *  height `lastAt`. Absent at a height >= lastAt: it existed at lastAt and no longer does, so it was
 *  erased by refund_check (ids never come back), skip it. Absent at a lower
 *  height: the node read is behind, reread it on the next round without advancing. */
export function step(check: Check | null, readAt: number, lastAt: number): "judge" | "skip" | "retry" {
  if (check) return check.verdict ? "skip" : "judge";
  return readAt >= lastAt ? "skip" : "retry";
}

if (import.meta.main) {
  // near.ts installs a global fetch and reads NEAR_RPC at import: loaded here only, not by the tests.
  const { account, call, env, view, viewAt } = await import("./near");
  const { checkExit, checkToken, deriveProbes, toProof } = await import("./verifier");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  const { mkdir } = await import("node:fs/promises");

  const sentinel = account(env("SENTINEL"), env("SENTINEL_KEY"));
  const EVM = env("EVM_RPC");
  // The real buyer: the guard's EVM address, public, derived like the relay does. Simulated too.
  const GUARD_EVM = deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH);
  const log = (s: string) => console.log(`    [sentinel] ${s}`);
  await mkdir("proofs", { recursive: true });
  const INDEX = process.env.INDEX;
  const index = INDEX ? ((await Bun.file(INDEX).json()) as Index) : null;
  const pools = index ? Object.values(index.templates).flat().length : 0;
  log(index ? `template index ${INDEX}: chain ${index.chain_id}, blocks ${index.from}..${index.to}, ${pools} WETH pools` : "no template index (INDEX unset): reputation unknown, so every buy verdict is at least warn");

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
    };
    const unprefixed = (hs: Hex[]) => hs.map((h) => h.slice(2));
    if (check.exit_amount) {
      log(`#${id} : ${check.agent} wants to sell ${check.exit_amount} of ${target}: exit quote, the guard's approve and swap simulated from its EVM address...`);
      const r = await checkExit(EVM, target, GUARD_EVM, BigInt(check.exit_amount), preview.check);
      const proof = toProof(id, target, r);
      await Bun.write(`proofs/${id}.json`, JSON.stringify(proof, null, 2));
      const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code: null, list_target: false, tx_hashes: unprefixed(r.evidence.tx_hashes) });
      log(`#${id} : exit quote ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.quote} wei for ${check.exit_amount} tokens, block ${r.evidence.block}, proof proofs/${id}.json  ${tx}`);
      return;
    }
    log(`#${id} : ${check.agent} wants to buy ${formatEther(BigInt(check.amount_wei))} ETH of ${target}: the guard's own buy and sales simulated, liquidity, template reputation, blocklist...`);
    // Probes derived from on-chain data, not chosen here: replay --check recomputes them.
    const ticket = { guard: env("GUARD"), id, requested_ns: check.requested_ns };
    const r = await checkToken(EVM, target, GUARD_EVM, (head) => deriveProbes(ticket, head.hash), { index, near: nearFacts, amount: BigInt(check.amount_wei), preview });
    const proof = toProof(id, target, r);
    await Bun.write(`proofs/${id}.json`, JSON.stringify(proof, null, 2));
    const code = { code_hash: r.evidence.code_hash, implementation: r.evidence.implementation };
    // list_target: the guard lists the token only on a block the probe side shows after a buy that
    // succeeded, never on what the agent's amount decides (judge).
    const { tx } = await call(sentinel, "post_verdict", { id, verdict: r.verdict, reasons: r.reasons, evidence: proof.evidence, quote: r.evidence.quote, code, list_target: r.list_target, tx_hashes: unprefixed(r.evidence.tx_hashes) });
    const failed = r.evidence.calls.filter((c) => c.endsWith("revert")).length;
    log(`#${id} : ${r.verdict.toUpperCase()} (${r.reasons}), ${r.evidence.calls.length} simulated calls (${failed} reverted, takeback probes included), quote ${r.evidence.quote} for ${r.evidence.amount_wei} wei, guard tx ${r.evidence.tx_hashes[0].slice(0, 10)}..., block ${r.evidence.block}, proof proofs/${id}.json  ${tx}`);
    // An entry is never overwritten: a token already listed keeps its first entry.
    if (r.list_target && !r.evidence.near.listed.length) log(`#${id} : ${target} listed on the guard's shared blocklist by this block verdict (evidence sha256 = the proof's)`);
  };

  const scan = async () => {
    const { value: last, height: lastAt } = await viewAt<number>("last_check_id");
    while (next <= last) {
      const { value: check, height } = await viewAt<Check | null>("get_check", { id: next });
      const what = step(check, height, lastAt);
      if (what === "retry") {
        log(`#${next} : not found on a node behind the guard (block ${height} < ${lastAt}), will reread`);
        break;
      }
      if (check && what === "judge") {
        try {
          await judge(next, check);
        } catch (e) {
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

  log(`listening to ${env("GUARD")}, simulating on ${EVM} as a derived probe buyer and as the guard's EVM address ${GUARD_EVM}`);
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
