// Agent role: buys a token through the guard (check, verdict, then the swap NEAR signs); broadcasts nothing.
// Usage: bun --env-file=.env --env-file=.env.agent app/buy.ts <token 0x...> [ETH to buy, default 0.00001]
// Prints the id, the verdict and its reasons, then the relay command of the signed swap or why there is no
// buy; code 1 without a signed buy. On warn it waits up to 120 s for the owner's approve (app/human.ts).
// An allow that came too late to buy gets one new check, never more: nothing else is asked again.
import { parseEther, type Address } from "viem";
import { guardedBuy } from "./agent";
import { env, reason, view, type Check } from "./near";

const [token, eth = "0.00001"] = process.argv.slice(2);
if (!token) {
  console.error("usage: bun app/buy.ts <token 0x...> [ETH to buy, default 0.00001]");
  process.exit(2);
}
async function attempt() {
  const { id, signed, late } = await guardedBuy(token as Address, parseEther(eth)).catch((e) => {
    console.log(`  [${env("AGENT")}] buy of ${eth} ETH of ${token} : REFUSED (${reason(e)})`);
    process.exit(1);
  });
  const check = await view<Check | null>("get_check", { id }).catch((e) => {
    console.log(`#${id} : verdict not read (${reason(e)})`);
    return null;
  });
  console.log(`#${id} verdict=${check?.verdict ?? "none"} reasons=${check?.reasons ?? ""}`);
  return { id, signed, again: late === true && check?.verdict === "allow" };
}
let { id, signed, again } = await attempt();
if (again) {
  console.log(`#${id} : the allow came too late to buy (on a fork just started, the first check waits while anvil fetches Base state): asking once more, a new check`);
  ({ id, signed } = await attempt());
}
console.log(`#${id} ${signed ? `signed by NEAR, relay with: bun --env-file=.env app/relay.ts ${id}` : "no buy: the [wrapper] line above says why"}`);
process.exitCode = signed ? 0 : 1;
