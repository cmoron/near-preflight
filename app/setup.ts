// Deploie la garde sur testnet sous un compte parent (l'humain) et ecrit .env et un fichier de cle
// par role (.env.agent, .env.sentinel, .env.armer).
// Usage : bun app/setup.ts <parent>.testnet
import { actions, KeyPair, nearToYocto, teraToGas } from "near-api-js";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { account, humanAccount, provider, RPC, writeSecret } from "./near";

const parent = process.argv[2];
if (!parent?.endsWith(".testnet")) throw new Error("usage: bun app/setup.ts <parent>.testnet");
const human = await humanAccount(parent);
const id = (name: string) => `${name}.${parent}`;
const PRICE = nearToYocto("0.01"); // prix d'un verdict, couvre le stockage d'une demande
// Bornes de demo fixees par l'humain : 0,1 NEAR par armement, 1 h au plus, 0,5 NEAR sur 7 jours.
const BOUNDS = { max_budget: nearToYocto("0.1").toString(), max_duration_s: 3600, max_7d: nearToYocto("0.5").toString() };

/** Cree un sous-compte, range sa cle complete dans le trousseau de l'humain, pas dans le depot. */
async function subAccount(name: string, near: `${number}`): Promise<string> {
  const key = KeyPair.fromRandom("ed25519");
  await human.createSubAccount({ accountOrPrefix: name, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
  const dir = `${homedir()}/.near-credentials/testnet`;
  await mkdir(dir, { recursive: true });
  const body = { account_id: id(name), public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await writeSecret(`${dir}/${id(name)}.json`, JSON.stringify(body));
  console.log(`account ${id(name)} created (${near} NEAR), full-access key in ${dir}`);
  return key.toString();
}

/** Ajoute une cle function-call limitee a la garde et a `methods` ; seule cle remise au logiciel. */
async function scopedKey(name: string, methods: string[]): Promise<string> {
  const owner = await humanAccount(id(name));
  const key = KeyPair.fromRandom("ed25519");
  await owner.addFunctionCallAccessKey({
    publicKey: key.getPublicKey(),
    contractId: id("guard"),
    methodNames: methods,
    allowance: nearToYocto("0.25"), // plafond de gaz de la cle
  });
  console.log(`function-call key of ${id(name)}: ${id("guard")} [${methods.join(", ")}], 0.25 NEAR gas allowance`);
  return key.toString();
}

const guardKey = await subAccount("guard", "3");
await subAccount("agent", "0.5");
await subAccount("sentinel", "0.5");
await subAccount("armer", "0.3");
await subAccount("shop", "0.1");

const wasm = await Bun.file("target/near/goblin_near.wasm").bytes();
const guard = account(id("guard"), guardKey);
await guard.signAndSendTransaction({
  receiverId: id("guard"),
  actions: [
    actions.deployContract(wasm),
    actions.functionCall(
      "new",
      { owner: parent, armer: id("armer"), sentinel: id("sentinel"), price: PRICE.toString() },
      teraToGas("100"),
      0n,
    ),
  ],
});
console.log(`guard deployed and initialized on ${id("guard")} (owner ${parent}, armer ${id("armer")}, price 0.01 NEAR)`);

const agentKey = await scopedKey("agent", ["request_check", "spend", "refund_check"]);
const sentinelKey = await scopedKey("sentinel", ["post_verdict"]);
const armerKey = await scopedKey("armer", ["arm", "disarm"]);

const owner = (methodName: string, args: Record<string, unknown>) => human.callFunction({ contractId: id("guard"), methodName, args });
await owner("set_bounds", BOUNDS);
await owner("register_agent", { agent: id("agent") });
await owner("allow_recipient", { account: id("shop") });
console.log(`bounds: 0.1 NEAR per arming, 3600 s max, 0.5 NEAR per 7 days; ${id("agent")} registered`);
await human.callFunction({
  contractId: id("guard"),
  methodName: "deposit_credit",
  args: { account_id: id("agent") },
  deposit: nearToYocto("1"),
});
console.log(`${id("shop")} allowed as recipient; 1 NEAR of credit deposited for ${id("agent")}`);

// Config partagee sans cle ; chaque cle function-call dans son fichier, charge par son seul processus
// (bun --env-file=.env --env-file=.env.agent ...) : l'agent ne lit jamais la cle de la sentinelle
// ni celle de l'armeur.
const write = (file: string, lines: string[]) => writeSecret(file, [...lines, ""].join("\n"));
await write(".env", [
  `NEAR_RPC=${RPC}`,
  `OWNER=${parent}`,
  `GUARD=${id("guard")}`,
  `AGENT=${id("agent")}`,
  `SENTINEL=${id("sentinel")}`,
  `ARMER=${id("armer")}`,
  `SHOP=${id("shop")}`,
  `EVM_RPC=http://127.0.0.1:8545`,
]);
await write(".env.agent", [`AGENT_KEY=${agentKey}`]);
await write(".env.sentinel", [`SENTINEL_KEY=${sentinelKey}`]);
await write(".env.armer", [`ARMER_KEY=${armerKey}`]);
console.log(".env, .env.agent, .env.sentinel, .env.armer written; agent credit (yoctoNEAR):", await provider.callFunction({
  contractId: id("guard"),
  method: "credit_of",
  args: { account: id("agent") },
}));
