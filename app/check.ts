// Role de l'agent : demande un controle de verdict sur un jeton et attend la reponse de la sentinelle.
// Usage : bun --env-file=.env --env-file=.env.agent app/check.ts <jeton 0x...>
// Affiche l'id, le verdict, les raisons et le chemin de la preuve ; code 1 si pas de verdict.
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
