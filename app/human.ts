// Role de l'humain (proprietaire) : arret d'urgence et levee du gel. Signe avec sa cle complete,
// rangee dans le trousseau near-cli (~/.near-credentials), jamais dans .env.
// stop : desarme l'agent et le gele, l'armeur ne peut plus le rearmer ; unfreeze : leve le gel.
// approve <id>: approves a warn verdict so the agent may buy on it (within its 120 s).
// reset: clears the agent's 7-day arming log (after replacing a compromised armer).
// withdraw <wei>: ETH from the guard's EVM address to the owner's address fixed at init.
// sell <token> <amount> [min wei]: the owner's own exit, never blocked by a freeze or a verdict.
// The relay broadcasts withdrawals and sales: bun --env-file=.env app/relay.ts exit <nonce>.
// Usage : bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei]
import { parseTransaction, type Hex } from "viem";
import { call, env, humanAccount } from "./near";

const human = await humanAccount(env("OWNER"));
const agent = env("AGENT");
const [cmd, a, b, c = "0"] = process.argv.slice(2);
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
} else if (cmd === "sell" && a && b) {
  const { value, tx } = await call<Hex[]>(human, "sell", { token: a, amount: b, min_out_wei: c }, 0n, EXIT_GAS);
  console.log(`  [human] sale of ${b} ${a} signed by NEAR (${value.length}/2 tx)${relayHint(value)}  ${tx}`);
} else {
  console.error("usage: bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei]");
  process.exit(2);
}
