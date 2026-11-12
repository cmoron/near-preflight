// Armer role: arms the agent within the bounds set by the human. Signs with its sole function-call
// key (arm, disarm on the guard), read from .env.armer; it does not set the bounds.
// Usage: bun --env-file=.env --env-file=.env.armer app/arm.ts <NEAR budget> <duration s> | disarm
// Exits with code 1 if the contract refuses, printing its reason.
import { nearToYocto, yoctoToNear } from "near-api-js";
import { account, call, env, reason, view } from "./near";

const armer = account(env("ARMER"), env("ARMER_KEY"));
const agent = env("AGENT");
if (process.argv[2] === "disarm") {
  // The armer's disarm takes the budget without freezing the agent: no buy can be signed until it is armed again.
  const { tx } = await call(armer, "disarm", { agent });
  console.log(`  [armer] ${agent} disarmed: no budget left, so the guard signs no buy  ${tx}`);
  process.exit(0);
}
const [budget = "0.06", duration = "900"] = process.argv.slice(2);
// Integrity check: the armer passes the credit it read; the contract refuses the arming if the credit
// drops below it before the transaction (the agent spent or was drained), and accepts a top-up.
const credit = await view<`${bigint}`>("credit_of", { account: agent });
try {
  const args = { agent, budget: nearToYocto(budget as `${number}`).toString(), duration_s: Number(duration), expected_credit: credit };
  const { tx } = await call(armer, "arm", args);
  console.log(`  [armer] ${agent} armed: ${budget} NEAR for ${duration} s (prepaid credit read: ${yoctoToNear(credit)} NEAR)  ${tx}`);
} catch (e) {
  console.log(`  [armer] arm ${budget} NEAR for ${duration} s: REFUSED (${reason(e)})`);
  process.exit(1);
}
