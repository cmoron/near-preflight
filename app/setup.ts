// Deploie la garde sur testnet sous un compte parent (l'humain) et ecrit .env.
// Usage : bun app/setup.ts <parent>.testnet
import { actions, KeyPair, nearToYocto, teraToGas } from "near-api-js";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { account, humanAccount, provider, RPC } from "./near";

const parent = process.argv[2];
if (!parent?.endsWith(".testnet")) throw new Error("usage : bun app/setup.ts <parent>.testnet");
const human = await humanAccount(parent);
const id = (name: string) => `${name}.${parent}`;
const PRICE = nearToYocto("0.01"); // prix d'un verdict, couvre le stockage d'une demande

/** Cree un sous-compte, range sa cle complete dans le trousseau de l'humain, pas dans le depot. */
async function subAccount(name: string, near: string): Promise<string> {
  const key = KeyPair.fromRandom("ed25519");
  await human.createSubAccount({ accountOrPrefix: name, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(near) });
  const dir = `${homedir()}/.near-credentials/testnet`;
  await mkdir(dir, { recursive: true });
  const body = { account_id: id(name), public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await Bun.write(`${dir}/${id(name)}.json`, JSON.stringify(body), { mode: 0o600 });
  console.log(`compte ${id(name)} cree (${near} NEAR), cle complete dans ${dir}`);
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
  console.log(`cle function-call de ${id(name)} : ${id("guard")} [${methods.join(", ")}], 0,25 NEAR de gaz`);
  return key.toString();
}

const guardKey = await subAccount("guard", "3");
await subAccount("agent", "0.5");
await subAccount("sentinel", "0.5");
await subAccount("shop", "0.1");

const wasm = await Bun.file("target/near/goblin_near.wasm").bytes();
const guard = account(id("guard"), guardKey);
await guard.signAndSendTransaction({
  receiverId: id("guard"),
  actions: [
    actions.deployContract(wasm),
    actions.functionCall("new", { owner: parent, sentinel: id("sentinel"), price: PRICE.toString() }, teraToGas("100"), 0n),
  ],
});
console.log(`garde deployee et initialisee sur ${id("guard")} (proprietaire ${parent}, prix 0,01 NEAR)`);

const agentKey = await scopedKey("agent", ["request_check", "spend", "refund_check"]);
const sentinelKey = await scopedKey("sentinel", ["post_verdict"]);

await human.callFunction({ contractId: id("guard"), methodName: "allow_recipient", args: { account: id("shop") } });
await human.callFunction({
  contractId: id("guard"),
  methodName: "deposit_credit",
  args: { account_id: id("agent") },
  deposit: nearToYocto("1"),
});
console.log(`${id("shop")} permis ; 1 NEAR de credit depose pour ${id("agent")}`);

await Bun.write(
  ".env",
  [
    `NEAR_RPC=${RPC}`,
    `OWNER=${parent}`,
    `GUARD=${id("guard")}`,
    `AGENT=${id("agent")}`,
    `AGENT_KEY=${agentKey}`,
    `SENTINEL=${id("sentinel")}`,
    `SENTINEL_KEY=${sentinelKey}`,
    `SHOP=${id("shop")}`,
    `EVM_RPC=http://127.0.0.1:8545`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(".env ecrit (cles function-call seulement) ; credit de l'agent :", await provider.callFunction({
  contractId: id("guard"),
  method: "credit_of",
  args: { account: id("agent") },
}));
