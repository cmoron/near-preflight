// Agent role: requests a verdict check on buying a token and waits for the sentinel's answer.
// Usage: bun --env-file=.env --env-file=.env.agent app/check.ts <token 0x...> [ETH to buy, default 0.00001]
// Prints the id, verdict, reasons and the proof files of the votes the guard took; code 1 if no verdict.
import { parseEther } from "viem";
import { requestCheck, waitVerdict } from "./agent";
import { env, proofsOf, reason } from "./near";

const [token, eth = "0.00001"] = process.argv.slice(2);
if (!token) {
  console.error("usage: bun app/check.ts <token 0x...> [ETH to buy, default 0.00001]");
  process.exit(2);
}
const id = await requestCheck(token, parseEther(eth)).catch((e) => {
  console.log(`  [${env("AGENT")}] request_check(${token}, ${eth} ETH) : REFUSED (${reason(e)})`);
  process.exit(1);
});
const check = await waitVerdict(id);
if (!check) {
  console.error(`#${id} : no verdict`);
  process.exit(1);
}
console.log(`#${id} verdict=${check.verdict} reasons=${check.reasons} proof=${(await proofsOf(id)).join(" ")}`);
