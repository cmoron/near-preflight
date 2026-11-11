// Role de l'humain : arme l'agent pour un budget et une duree, ou le desarme (arret d'urgence).
// Signe avec la cle complete du proprietaire, rangee dans le trousseau near-cli, jamais dans .env.
// Usage : bun app/arm.ts <budget NEAR> <duree s> | bun app/arm.ts stop
import { nearToYocto, yoctoToNear } from "near-api-js";
import { call, env, humanAccount, view } from "./near";

const human = await humanAccount(env("OWNER"));
const agent = env("AGENT");
if (process.argv[2] === "stop") {
  const { tx } = await call(human, "disarm", { agent });
  console.log(`[humain] arret d'urgence : budget de ${agent} retire  ${tx}`);
} else {
  const [budget = "0.06", duration = "900"] = process.argv.slice(2);
  const { tx } = await call(human, "arm", { agent, budget: nearToYocto(budget).toString(), duration_s: Number(duration) });
  const credit = await view<string>("credit_of", { account: agent });
  console.log(`[humain] ${agent} arme : ${budget} NEAR pendant ${duration} s (credit prepaye ${yoctoToNear(credit)} NEAR)  ${tx}`);
}
