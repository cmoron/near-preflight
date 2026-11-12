// Human (owner) role: emergency stop and freeze lift. Signs with its full key,
// kept in the near-cli keychain (~/.near-credentials), never in .env.
// stop: disarms the agent and freezes it, the armer can no longer re-arm it; unfreeze: lifts the freeze.
// approve <id>: approves a warn verdict so the agent may buy on it (within its 120 s).
// reset: clears the agent's 7-day arming log (after replacing a compromised armer).
// withdraw <wei>: ETH from the guard's EVM address to the owner's address fixed at init.
// sell <token> <amount> [min wei] [max | 0x approve]: the owner's own exit, never blocked by a freeze, a verdict or the
// list; the router is approved for the amount sold, or for 2^256 - 1 with "max", or any 0x amount.
// unlist <token>: removes a token from the shared blocklist.
// holding <token> <agent> [amount]: the token is now held for that agent (0, the default, frees it).
// gas <limit>: sets the gas limit of every transaction the guard signs (21,000 to 2,000,000, fees
// unchanged): a sale that needs more gas than the limit can be retried with `sell` after raising it.
// replace <nonce>: has NEAR sign 0 wei to the owner's address at a nonce already used: fills a nonce
// whose signature never came back (event sign_unsettled), or replaces a transaction that cannot be mined.
// clear <nonce> refund|spent: settles a transaction reserved at that nonce: refund once the replacement
// is mined (the agent's charge and tokens come back), spent if its late signature was mined.
// The relay broadcasts withdrawals and sales: bun --env-file=.env app/relay.ts exit <nonce>.
// Usage: bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei] [max | 0x approve] | unlist <token> | holding <token> <agent> [amount] | gas <limit> | replace <nonce> | clear <nonce> refund|spent
import { parseTransaction, type Hex } from "viem";
import { call, env, humanAccount, view } from "./near";

const human = await humanAccount(env("OWNER"));
const agent = env("AGENT");
const [cmd, a, b, c = "0", d] = process.argv.slice(2);
const EXIT_GAS = 150_000_000_000_000n; // one or two sign calls to the MPC and the callback
/** Where the relay picks the exit up: the nonce of its first signed transaction. */
const relayHint = (signed: Hex[]) => (signed.length ? `; broadcast: bun --env-file=.env app/relay.ts exit ${parseTransaction(signed[0]).nonce}` : "");
if (cmd === "stop") {
  const { tx } = await call(human, "disarm", { agent });
  console.log(`  [human] emergency stop: ${agent} disarmed and frozen  ${tx}`);
} else if (cmd === "unfreeze") {
  const { tx } = await call(human, "unfreeze", { agent });
  console.log(`  [human] ${agent} unfrozen: the armer may arm it again, within the bounds  ${tx}`);
} else if (cmd === "approve" && a) {
  const { tx } = await call(human, "approve_warn", { id: Number(a) });
  console.log(`  [human] warn #${a} approved on chain: the agent may buy it until 120 s after the verdict  ${tx}`);
} else if (cmd === "reset") {
  const { tx } = await call(human, "reset_armings", { agent });
  console.log(`  [human] 7-day arming log of ${agent} cleared  ${tx}`);
} else if (cmd === "withdraw" && a) {
  const { value, tx } = await call<Hex[]>(human, "withdraw_eth", { amount_wei: a }, 0n, EXIT_GAS);
  console.log(`  [human] withdrawal of ${a} wei signed by NEAR (${value.length}/1 tx)${relayHint(value)}  ${tx}`);
} else if (cmd === "unlist" && a) {
  const { tx } = await call(human, "unlist", { token: a });
  console.log(`  [human] ${a} removed from the shared blocklist  ${tx}`);
} else if (cmd === "holding" && a && b) {
  const { tx } = await call(human, "set_holding", { token: a, agent: b, amount: c });
  console.log(`  [human] ${a} now held for ${b}: ${c} to sell (0 frees it for any agent)  ${tx}`);
} else if (cmd === "gas" && a) {
  const { max_fee_per_gas, max_priority_fee_per_gas } = await view<{ max_fee_per_gas: string; max_priority_fee_per_gas: string }>("evm_config");
  const { tx } = await call(human, "set_evm_gas", { gas_limit: Number(a), max_fee_per_gas, max_priority_fee_per_gas });
  console.log(`  [human] gas limit of every signed transaction set to ${a} (fees unchanged)  ${tx}`);
} else if (cmd === "replace" && a) {
  const { value, tx } = await call<Hex[]>(human, "sign_replacement", { nonce: Number(a) }, 0n, EXIT_GAS);
  console.log(`  [human] replacement at nonce ${a} (0 wei to the owner's address) signed by NEAR (${value.length}/1 tx)${relayHint(value)}  ${tx}`);
} else if (cmd === "clear" && a && (b === "refund" || b === "spent")) {
  const { tx } = await call(human, "clear_unsettled", { nonce: Number(a), refund: b === "refund" });
  console.log(`  [human] transaction reserved at nonce ${a} settled as ${b}  ${tx}`);
} else if (cmd === "sell" && a && b) {
  // approve: "max" for 2^256 - 1 (a token may let only that sell), or 0x + hex; the amount sold by default
  const approve = d === "max" ? `0x${"f".repeat(64)}` : (d ?? null);
  const { value, tx } = await call<Hex[]>(human, "sell", { token: a, amount: b, min_out_wei: c, approve }, 0n, EXIT_GAS);
  console.log(`  [human] sale of ${b} ${a} (approve ${d ?? "of the amount"}) signed by NEAR (${value.length}/2 tx)${relayHint(value)}  ${tx}`);
} else {
  console.error("usage: bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei] [max | 0x approve] | unlist <token> | holding <token> <agent> [amount] | gas <limit> | replace <nonce> | clear <nonce> refund|spent");
  process.exit(2);
}
