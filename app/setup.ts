// Deploie la garde sur testnet sous un compte parent (l'humain) et ecrit .env et un fichier de cle
// par role (.env.agent, .env.sentinel, .env.armer).
// Usage : bun app/setup.ts <parent>.testnet [owner EVM address for ETH withdrawals]
import { actions, KeyPair, nearToYocto, teraToGas } from "near-api-js";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH, MPC_CONTRACT } from "./derive";
import { account, humanAccount, provider, RPC, writeSecret } from "./near";

const [parent, withdrawTo = "0x000000000000000000000000000000000000dEaD"] = process.argv.slice(2);
if (!parent?.endsWith(".testnet") || !/^0x[0-9a-fA-F]{40}$/.test(withdrawTo)) {
  throw new Error("usage: bun app/setup.ts <parent>.testnet [owner EVM address for ETH withdrawals]");
}
const human = await humanAccount(parent);
const id = (name: string) => `${name}.${parent}`;
const PRICE = nearToYocto("0.01"); // prix d'un verdict, couvre le stockage d'une demande
// Demo bounds set by the human: 0.2 NEAR per arming (the demo arms 0.12), 1 h at most, 1 NEAR per 7 days.
const BOUNDS = { max_budget: nearToYocto("0.2").toString(), max_duration_s: 3600, max_7d: nearToYocto("1").toString() };
// Achat EVM fixe par l'humain : gaz 250 000 (un swap V2 en use ~140 000 sur le fork), frais au plus
// 0,05 gwei (base fee de Base ~0,005 gwei), pourboire 0,001 gwei ; budget debite a 1 ETH = 1000 NEAR ;
// minimum de jetons = devis de la sentinelle moins 3 %.
const EVM = {
  gas_limit: 250_000,
  max_fee_per_gas: "50000000",
  max_priority_fee_per_gas: "1000000",
  yocto_per_wei: "1000000000",
  max_slippage_bps: 300,
};

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
async function scopedKey(name: string, methods: string[], allowance: `${number}` = "0.25"): Promise<string> {
  const owner = await humanAccount(id(name));
  const key = KeyPair.fromRandom("ed25519");
  await owner.addFunctionCallAccessKey({
    publicKey: key.getPublicKey(),
    contractId: id("guard"),
    methodNames: methods,
    allowance: nearToYocto(allowance), // plafond de gaz de la cle
  });
  console.log(`function-call key of ${id(name)}: ${id("guard")} [${methods.join(", ")}], ${allowance} NEAR gas allowance`);
  return key.toString();
}

const guardKey = await subAccount("guard", "3");
await subAccount("agent", "0.5");
await subAccount("sentinel", "0.5");
await subAccount("armer", "0.3");
// Adresse EVM que NEAR signe pour la garde : derivee de la cle maitresse du MPC, du compte et du chemin fixe.
const evmAddress = deriveEvmAddress(await fetchMasterPublicKey(), id("guard"), GUARD_PATH);

const wasm = await Bun.file("target/near/goblin_near.wasm").bytes();
const guard = account(id("guard"), guardKey);
await guard.signAndSendTransaction({
  receiverId: id("guard"),
  actions: [
    actions.deployContract(wasm),
    actions.functionCall(
      "new",
      {
        owner: parent,
        armer: id("armer"),
        sentinel: id("sentinel"),
        price: PRICE.toString(),
        evm: { mpc: MPC_CONTRACT, address: evmAddress, withdraw_to: withdrawTo, ...EVM },
      },
      teraToGas("100"),
      0n,
    ),
  ],
});
console.log(`guard deployed and initialized on ${id("guard")} (owner ${parent}, armer ${id("armer")}, price 0.01 NEAR)`);
console.log(`derived EVM address of ${id("guard")} (path ${GUARD_PATH}, signer ${MPC_CONTRACT}): ${evmAddress}`);
console.log(`ETH withdrawals from it go only to ${withdrawTo}, fixed at init${process.argv[3] ? "" : " (default burn address: pass your own EVM address as 2nd argument)"}`);

// buy attache 100 TGas : le protocole exige 0,101 NEAR d'allocation libre pour l'envoyer (gaz au prix
// pessimiste), puis ne retire que le gaz brule (mesure : 0,0014 NEAR par achat signe). sell attaches
// 150 TGas (two signatures). 0,5 NEAR, le solde du compte de l'agent qui paie ce gaz.
const agentKey = await scopedKey("agent", ["request_check", "buy", "refund_check", "sell"], "0.5");
const sentinelKey = await scopedKey("sentinel", ["post_verdict"]);
const armerKey = await scopedKey("armer", ["arm", "disarm"]);

const owner = (methodName: string, args: Record<string, unknown>) => human.callFunction({ contractId: id("guard"), methodName, args });
await owner("set_bounds", BOUNDS);
await owner("register_agent", { agent: id("agent") });
console.log(`bounds: 0.2 NEAR per arming, 3600 s max, 1 NEAR per 7 days; ${id("agent")} registered`);
await human.callFunction({
  contractId: id("guard"),
  methodName: "deposit_credit",
  args: { account_id: id("agent") },
  deposit: nearToYocto("1"),
});
console.log(`1 NEAR of credit deposited for ${id("agent")}`);

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
  `EVM_RPC=http://127.0.0.1:8545`,
]);
await write(".env.agent", [`AGENT_KEY=${agentKey}`]);
await write(".env.sentinel", [`SENTINEL_KEY=${sentinelKey}`]);
await write(".env.armer", [`ARMER_KEY=${armerKey}`]);
// The RPC spreads reads over nodes more or less up to date: a node behind the deposit says 0.
let credit = "0";
for (let i = 0; i < 20 && credit === "0"; i++) {
  if (i) await Bun.sleep(1500);
  credit = (await provider.callFunction({ contractId: id("guard"), method: "credit_of", args: { account: id("agent") } })) as string;
}
console.log(`.env, .env.agent, .env.sentinel, .env.armer written; agent credit: ${credit} yoctoNEAR`);
