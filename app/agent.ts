// Agent-side wrapper: no buy without a verdict, refuses to buy on block. Signs only with
// the agent's function-call key, limited to the guard (request_check, buy, refund_check, request_exit,
// sell_quoted); the agent
// has no EVM key: the guard builds the buy transaction and NEAR signs it.
import { createPublicClient, formatEther, http, parseAbi, parseTransaction, type Address, type Hex } from "viem";
import { account, call, env, view, type Check } from "./near";

export const agent = account(env("AGENT"), env("AGENT_KEY"));
/** Gas attached to `buy`: its own, the `sign` call to the MPC (15 TGas reserved) and the callback (10). */
export const BUY_GAS = 100_000_000_000_000n;
/** Gas attached to `sell`: two `sign` calls to the MPC (approve then swap) and the callback. */
export const SELL_GAS = 150_000_000_000_000n;
const log = (s: string) => console.log(`  [wrapper] ${s}`);
const VERDICT_TTL_MS = 120_000; // an allow verdict expires 120 s after it is posted (same rule as the contract)
const TIMEOUT_MS = 300_000; // contract delay before refunding a request without a verdict

/** Asks the guard for a verdict on buying `wei` of `target`: the sentinel simulates that very buy,
 *  and the guard signs no other amount on it. `decision`: sha256 of the model's decision package
 *  (app/llm.ts) that asked for it, stored with the check. */
export async function requestCheck(target: string, wei: bigint, decision?: string): Promise<number> {
  const { value: id, tx } = await call<number>(agent, "request_check", { target, amount_wei: wei.toString(), decision_sha256: decision });
  log(`request #${id} : verdict on a buy of ${formatEther(wei)} ETH of ${target}, 0.019 NEAR taken from credit${decision ? `, decision ${decision.slice(0, 12)}...` : ""}  ${tx}`);
  return id;
}

export async function waitVerdict(id: number): Promise<Check | null> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      const check = await view<Check | null>("get_check", { id }); // null: the node read does not have the block yet
      if (check?.verdict) return check;
    } catch (e) {
      log(`#${id} : reading the verdict failed, will retry (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    await Bun.sleep(1500);
  }
  return null;
}

/** Waits for the owner's approve_warn of #id on chain, at most `waitMs` and never past the verdict's
 *  life (the buy needs ~10 s more). */
async function waitApproval(id: number, judgedNs: string, waitMs: number): Promise<boolean> {
  const end = Math.min(Date.now() + waitMs, Number(BigInt(judgedNs) / 1_000_000n) + VERDICT_TTL_MS - 10_000);
  while (Date.now() < end) {
    try {
      if ((await view<Check | null>("get_check", { id }))?.approved) return true;
    } catch (e) {
      log(`#${id} : reading the approval failed, will retry (${e instanceof Error ? e.message.split("\n")[0] : e})`);
    }
    await Bun.sleep(1500);
  }
  return false;
}

/** Buys `target` for `wei` on Base, on an allow verdict, or on warn once the human approved it on
 *  chain (asked through `onWarn`, waited for at most `approvalWaitMs`): the guard builds the
 *  transaction and has NEAR sign it. Returns the id and the signed transaction (null without a buy). */
export async function guardedBuy(
  target: Address,
  wei: bigint,
  opts: { approvalWaitMs?: number; onWarn?: (id: number) => void } = {},
): Promise<{ id: number; signed: string | null }> {
  const id = await requestCheck(target, wei);
  const check = await waitVerdict(id);
  if (!check) {
    await Bun.sleep(5_000); // the contract measures the delay at block time
    const { tx } = await call(agent, "refund_check", { id });
    log(`#${id} : no verdict in 5 min, fee refunded, purchase abandoned  ${tx}`);
    return { id, signed: null };
  }
  const verdict = String(check.verdict).toUpperCase();
  if (check.verdict === "warn") {
    log(`#${id} : WARN (${check.reasons}). Asking the human: bun --env-file=.env app/human.ts approve ${id}`);
    opts.onWarn?.(id);
    const waitMs = opts.approvalWaitMs ?? VERDICT_TTL_MS;
    if (!(await waitApproval(id, check.judged_ns, waitMs))) {
      log(`#${id} : WARN not approved on chain within ${Math.round(waitMs / 1000)} s (or the verdict's life), I GIVE UP, no purchase`);
      return { id, signed: null };
    }
    log(`#${id} : WARN approved by the human on chain (approve_warn), buying`);
  } else if (check.verdict !== "allow") {
    log(`#${id} : ${verdict}, I REFUSE TO BUY (${check.reasons})`);
    return { id, signed: null };
  }
  const age = Date.now() - Number(BigInt(check.judged_ns) / 1_000_000n);
  if (age > VERDICT_TTL_MS) {
    log(`#${id} : ${verdict} expired (${Math.round(age / 1000)} s old, limit ${VERDICT_TTL_MS / 1000} s), I REFUSE TO BUY`);
    return { id, signed: null };
  }
  return { id, signed: await buy(id, wei, verdict) };
}

/** `buy` on check #id: the guard builds the swap and has NEAR sign it; the contract refuses it
 *  unless the verdict allows. `decision`: sha256 of the model's decision package, stored with the
 *  check. Returns the signed transaction, null if the MPC returned no signature. */
export async function buy(id: number, wei: bigint, verdict = "", decision?: string): Promise<string | null> {
  const started = Date.now();
  const args = { id, amount_wei: wei.toString(), decision_sha256: decision };
  const { value: signed, tx, burnt } = await call<string | null>(agent, "buy", args, 0n, BUY_GAS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!signed) {
    log(`#${id} : ${verdict}, but the MPC returned no signature in ${secs} s: credit and budget restored  ${tx}`);
    return null;
  }
  log(`#${id} : ${verdict ? `${verdict}, ` : ""}buy of ${formatEther(wei)} ETH signed by NEAR in ${secs} s (${burnt}): ${signed.slice(0, 18)}...  ${tx}`);
  return signed;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Exit: sells all of the token the guard bought for the agent's check `buyId`, back to ETH on the
 *  guard's address. The agent never picks the floor: it asks the sentinel for an exit quote
 *  (request_exit, the sale simulated from the guard's address), then sell_quoted has NEAR sign
 *  approve and swap with the floor set by the guard (quote minus the owner's 3 %), charged to the
 *  armed budget like a buy. Returns the nonce of the first signed transaction and the transactions. */
export async function sellAll(buyId: number): Promise<{ nonce: number; signed: Hex[] }> {
  const bought = await view<Check>("get_check", { id: buyId });
  const token = bought.target as Address;
  const { address } = await view<{ address: Address }>("evm_config");
  const client = createPublicClient({ transport: http(env("EVM_RPC")) });
  // The guard credits each buy at its signed minimum, so the agent sells at most that: the rest
  // (received above the minimum) stays for the owner's own exit.
  const [balance, held] = await Promise.all([
    client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [address] }),
    view<string>("holding", { agent: env("AGENT"), token }),
  ]);
  const amount = balance < BigInt(held) ? balance : BigInt(held);
  const { value: id, tx: asked } = await call<number>(agent, "request_exit", { buy_id: buyId, amount: amount.toString() });
  log(`request #${id} : exit quote for ${amount} ${token} (bought by #${buyId}), 0.019 NEAR taken from credit  ${asked}`);
  const quote = await waitVerdict(id);
  if (quote?.verdict !== "allow") {
    log(`#${id} : no exit quote (${quote?.reasons ?? "no verdict"}): no sale by the agent; the owner's own exit stays open`);
    return { nonce: -1, signed: [] };
  }
  const started = Date.now();
  const { value: signed, tx, burnt } = await call<Hex[]>(agent, "sell_quoted", { id }, 0n, SELL_GAS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`#${id} : exit quote ${formatEther(BigInt(quote.quote))} ETH; floor set by the guard at the quote minus 3 %, not by the agent: ${signed.length}/2 transactions signed by NEAR in ${secs} s (${burnt})  ${tx}`);
  return { nonce: signed.length ? (parseTransaction(signed[0]).nonce ?? 0) : -1, signed };
}
