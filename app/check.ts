// Agent role: requests a verdict check on a token and waits for the sentinel's answer.
// Usage: bun --env-file=.env --env-file=.env.agent app/check.ts <token 0x...>
// Prints the id, verdict, reasons and proof path; code 1 if no verdict.
import { requestCheck, waitVerdict } from "./agent";
import { env, reason } from "./near";

const token = process.argv[2];
if (!token) {
  console.error("usage: bun app/check.ts <token 0x...>");
  process.exit(2);
}
const id = await requestCheck(token).catch((e) => {
  console.log(`  [${env("AGENT")}] request_check(${token}) : REFUSED (${reason(e)})`);
  process.exit(1);
});
const check = await waitVerdict(id);
if (!check) {
  console.error(`#${id} : no verdict`);
  process.exit(1);
}
console.log(`#${id} verdict=${check.verdict} reasons=${check.reasons} proof=proofs/${id}.json`);
