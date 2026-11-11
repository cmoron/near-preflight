// Enveloppe cote agent : aucun achat sans verdict, refus d'acheter sur block. Signe uniquement avec
// la cle function-call de l'agent, limitee a la garde (request_check, buy, refund_check, sell) ; l'agent
// n'a aucune cle EVM : la garde construit la transaction d'achat et NEAR la signe.
import { createPublicClient, formatEther, http, parseAbi, parseTransaction, type Address, type Hex } from "viem";
import { account, call, env, view, type Check } from "./near";
import { ROUTER, WETH } from "./verifier";

export const agent = account(env("AGENT"), env("AGENT_KEY"));
/** Gaz attache a `buy` : le sien, l'appel `sign` au MPC (15 TGas reserves) et le callback (10). */
export const BUY_GAS = 100_000_000_000_000n;
/** Gaz attache a `sell` : deux appels `sign` au MPC (approve puis swap) et le callback. */
export const SELL_GAS = 150_000_000_000_000n;
const log = (s: string) => console.log(`  [wrapper] ${s}`);
const VERDICT_TTL_MS = 120_000; // un verdict allow expire 120 s apres son poste (meme regle que le contrat)
const TIMEOUT_MS = 300_000; // delai du contrat avant remboursement d'une demande sans verdict

export async function requestCheck(target: string): Promise<number> {
  const { value: id, tx } = await call<number>(agent, "request_check", { target });
  log(`request #${id} : verdict on ${target}, 0.01 NEAR taken from credit  ${tx}`);
  return id;
}

export async function waitVerdict(id: number): Promise<Check | null> {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      const check = await view<Check | null>("get_check", { id }); // null : le noeud lu n'a pas encore le bloc
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

/** Achete `target` pour `wei` sur Base, sur verdict allow, or on warn once the human approved it on
 *  chain (asked through `onWarn`, waited for at most `approvalWaitMs`) : la garde construit la
 *  transaction et la fait signer par NEAR. Renvoie l'id et la transaction signee (null sans achat). */
export async function guardedBuy(
  target: Address,
  wei: bigint,
  opts: { approvalWaitMs?: number; onWarn?: (id: number) => void } = {},
): Promise<{ id: number; signed: string | null }> {
  const id = await requestCheck(target);
  const check = await waitVerdict(id);
  if (!check) {
    await Bun.sleep(5_000); // le contrat mesure le delai a l'heure du bloc
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
  const started = Date.now();
  const args = { id, amount_wei: wei.toString() };
  const { value: signed, tx, burnt } = await call<string | null>(agent, "buy", args, 0n, BUY_GAS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!signed) {
    log(`#${id} : ${verdict}, but the MPC returned no signature in ${secs} s: credit and budget restored  ${tx}`);
    return { id, signed: null };
  }
  log(`#${id} : ${verdict}, buy of ${formatEther(wei)} ETH signed by NEAR in ${secs} s (${burnt}): ${signed.slice(0, 18)}...  ${tx}`);
  return { id, signed };
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const pool = parseAbi(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);

/** Exit: sells all of `token` held by the guard's EVM address for ETH, back to that address; NEAR
 *  signs approve then swap. No verdict needed. The floor is the agent's own: pool quote now minus
 *  3 %. Returns the nonce of the first signed transaction and the signed transactions. */
export async function sellAll(token: Address): Promise<{ nonce: number; signed: Hex[] }> {
  const { address } = await view<{ address: Address }>("evm_config");
  const client = createPublicClient({ transport: http(env("EVM_RPC")) });
  const amount = await client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [address] });
  const [, out] = await client.readContract({ address: ROUTER, abi: pool, functionName: "getAmountsOut", args: [amount, [token, WETH]] });
  const min = (out * 97n) / 100n;
  const started = Date.now();
  const args = { token, amount: amount.toString(), min_out_wei: min.toString() };
  const { value: signed, tx, burnt } = await call<Hex[]>(agent, "sell", args, 0n, SELL_GAS);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`sell of ${amount} ${token} for at least ${formatEther(min)} ETH (pool quote minus 3 %): ${signed.length}/2 transactions signed by NEAR in ${secs} s (${burnt})  ${tx}`);
  return { nonce: signed.length ? (parseTransaction(signed[0]).nonce ?? 0) : -1, signed };
}
