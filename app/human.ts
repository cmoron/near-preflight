// Role de l'humain (proprietaire) : arret d'urgence et levee du gel. Signe avec sa cle complete,
// rangee dans le trousseau near-cli (~/.near-credentials), jamais dans .env.
// stop : desarme l'agent et le gele, l'armeur ne peut plus le rearmer ; unfreeze : leve le gel.
// Usage : bun --env-file=.env app/human.ts stop | unfreeze
import { call, env, humanAccount } from "./near";

const human = await humanAccount(env("OWNER"));
const agent = env("AGENT");
const cmd = process.argv[2];
if (cmd === "stop") {
  const { tx } = await call(human, "disarm", { agent });
  console.log(`  [human] emergency stop: ${agent} disarmed and frozen  ${tx}`);
} else if (cmd === "unfreeze") {
  const { tx } = await call(human, "unfreeze", { agent });
  console.log(`  [human] ${agent} unfrozen: the armer may arm it again, within the bounds  ${tx}`);
} else {
  console.error("usage: bun --env-file=.env app/human.ts stop | unfreeze");
  process.exit(2);
}
