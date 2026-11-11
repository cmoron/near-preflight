// Role de l'armeur : arme l'agent dans les bornes fixees par l'humain. Signe avec sa seule cle
// function-call (arm, disarm sur la garde), lue dans .env.armer ; il ne fixe pas les bornes.
// Usage : bun --env-file=.env --env-file=.env.armer app/arm.ts <budget NEAR> <duree s>
// Sort avec le code 1 si le contrat refuse, en affichant sa raison.
import { nearToYocto, yoctoToNear } from "near-api-js";
import { account, call, env, reason, view } from "./near";

const armer = account(env("ARMER"), env("ARMER_KEY"));
const agent = env("AGENT");
const [budget = "0.06", duration = "900"] = process.argv.slice(2);
// Controle d'integrite : l'armeur arme l'etat qu'il a lu ; si le credit change d'ici la transaction,
// le contrat refuse l'armement.
const credit = await view<`${bigint}`>("credit_of", { account: agent });
try {
  const args = { agent, budget: nearToYocto(budget as `${number}`).toString(), duration_s: Number(duration), expected_credit: credit };
  const { tx } = await call(armer, "arm", args);
  console.log(`  [armer] ${agent} armed: ${budget} NEAR for ${duration} s (prepaid credit read: ${yoctoToNear(credit)} NEAR)  ${tx}`);
} catch (e) {
  console.log(`  [armer] arm ${budget} NEAR for ${duration} s: REFUSED (${reason(e)})`);
  process.exit(1);
}
