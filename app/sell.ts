// Agent role: sells what the guard bought on a check (exit quote, then the approve and swap NEAR signs);
// broadcasts nothing.
// Usage: bun --env-file=.env --env-file=.env.agent app/sell.ts <buy id>
// Prints the exit quote's id, its verdict and reasons, then the relay command of the signed approve and
// swap or why there is no sale; code 1 without a signed sale.
import { sellAll } from "./agent";
import { env, reason, view, type Check } from "./near";

const buyId = process.argv[2];
if (!/^\d+$/.test(buyId ?? "")) {
  console.error("usage: bun app/sell.ts <id of the check that bought>");
  process.exit(2);
}
const { id, nonce, signed } = await sellAll(Number(buyId)).catch((e) => {
  console.log(`  [${env("AGENT")}] sale of what #${buyId} bought : REFUSED (${reason(e)})`);
  process.exit(1);
});
const quote = await view<Check | null>("get_check", { id }).catch((e) => {
  console.log(`#${id} : verdict not read (${reason(e)})`);
  return null;
});
console.log(`#${id} verdict=${quote?.verdict ?? "none"} reasons=${quote?.reasons ?? ""}`);
console.log(`#${id} ${signed.length ? `signed by NEAR, relay with: bun --env-file=.env app/relay.ts exit ${nonce}` : "no sale: the [wrapper] line above says why"}`);
process.exitCode = signed.length ? 0 : 1;
