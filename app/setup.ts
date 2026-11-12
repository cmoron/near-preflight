// Deploys the guard on testnet under a parent account (the human) and writes .env and one key file
// per role (.env.agent, .env.sentinel, .env.sentinel2, .env.armer), plus .env.agent2 for a second agent
// (demo --full). Two sentinels, both needed for an allow (quorum 2 of 2): each its own account and key.
// Usage: bun app/setup.ts <parent>.testnet [owner EVM address for ETH withdrawals]
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
// Price of a verdict: covers the storage of a check, its votes, its code record and, on a block, its
// listing and quarantine (CHECK_STORAGE_BYTES = 2450 in src/lib.rs, at 10^19 yoctoNEAR per byte).
const PRICE = nearToYocto("0.025");
// Demo bounds set by the human: 0.5 NEAR per arming (the demo arms 0.4), 1 h at most, 5 NEAR per 7 days,
// 0.0001 ETH per buy (the demo buys 0.00001).
const BOUNDS = { max_budget: nearToYocto("0.5").toString(), max_duration_s: 3600, max_7d: nearToYocto("5").toString(), max_buy_wei: "100000000000000" };
// Per token, for all agents together: 0.0005 ETH an hour (50 demo buys; the guard keeps at most 32 buys of
// a token per period). Zero at init: no check until the owner sets it. The quarantine keeps its 30 min.
const TOKEN_CAP = { cap_wei: "500000000000000", period_s: 3600 };
const AGENT_METHODS = ["request_check", "buy", "refund_check", "request_exit", "sell_quoted"];
// EVM buy fixed by the human: gas 250,000 (a V2 swap uses ~140,000 on the fork), fees at most
// 0.05 gwei (Base's base fee ~0.005 gwei), tip 0.001 gwei; budget debited at 1 ETH = 1000 NEAR;
// minimum tokens = the sentinel's quote minus 3 %.
const EVM = {
  gas_limit: 250_000,
  max_fee_per_gas: "50000000",
  max_priority_fee_per_gas: "1000000",
  yocto_per_wei: "1000000000",
  max_slippage_bps: 300,
};

/** Creates a sub-account, keeps its full key in the human's keychain, not in the repo. */
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

/** Adds a function-call key limited to the guard and to `methods`; the only key handed to the software. */
async function scopedKey(name: string, methods: string[], allowance: `${number}` = "0.25"): Promise<string> {
  const owner = await humanAccount(id(name));
  const key = KeyPair.fromRandom("ed25519");
  await owner.addFunctionCallAccessKey({
    publicKey: key.getPublicKey(),
    contractId: id("guard"),
    methodNames: methods,
    allowance: nearToYocto(allowance), // gas allowance of the key
  });
  console.log(`function-call key of ${id(name)}: ${id("guard")} [${methods.join(", ")}], ${allowance} NEAR gas allowance`);
  return key.toString();
}

// The guard's account pays for its code: 10^19 yoctoNEAR per byte, plus its state as it grows.
const wasm = await Bun.file("target/near/goblin_near.wasm").bytes();
const GUARD_NEAR = (Math.ceil(wasm.length / 1e4) / 10 + 0.3).toFixed(1) as `${number}`;
// About 7.2 NEAR in all with the credit below: one 10 NEAR faucet account is enough, with room to spare.
const guardKey = await subAccount("guard", GUARD_NEAR); // the wasm and its account: 1 NEAR per 100 KB of storage
// Each role's own account pays the gas of its calls: a few thousandths of NEAR each.
await subAccount("agent", "0.3");
await subAccount("agent2", "0.2");
await subAccount("sentinel", "0.3");
await subAccount("sentinel2", "0.3");
await subAccount("armer", "0.2");
// EVM address that NEAR signs for the guard: derived from the MPC master key, the account and the fixed path.
const evmAddress = deriveEvmAddress(await fetchMasterPublicKey(), id("guard"), GUARD_PATH);

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
console.log(`guard deployed and initialized on ${id("guard")} (owner ${parent}, armer ${id("armer")}, price 0.025 NEAR)`);
console.log(`derived EVM address of ${id("guard")} (path ${GUARD_PATH}, signer ${MPC_CONTRACT}): ${evmAddress}`);
console.log(`ETH withdrawals from it go only to ${withdrawTo}, fixed at init`);
if (!process.argv[3]) console.log("  0x...dEaD is a demo placeholder (a burn address), not an owner's address: pass your own EVM address as 2nd argument");

// buy attaches 100 TGas: the protocol requires 0.101 NEAR of free allowance to send it (gas at the
// pessimistic price), then removes only the gas burnt (measured: 0.0014 NEAR per signed buy). sell_quoted
// attaches 150 TGas (two signatures). 0.5 NEAR, the balance of the agent account that pays this gas.
const agentKey = await scopedKey("agent", AGENT_METHODS, "0.5");
const agent2Key = await scopedKey("agent2", AGENT_METHODS);
const sentinelKey = await scopedKey("sentinel", ["post_verdict"]);
const sentinel2Key = await scopedKey("sentinel2", ["post_verdict"]);
const armerKey = await scopedKey("armer", ["arm", "disarm"]);

const owner = (methodName: string, args: Record<string, unknown>) => human.callFunction({ contractId: id("guard"), methodName, args });
await owner("set_bounds", BOUNDS);
await owner("set_token_cap", TOKEN_CAP);
// An allow or a warn needs both sentinels to post the same one; either blocks alone.
await owner("set_sentinels", { sentinels: [id("sentinel"), id("sentinel2")], quorum: 2 });
console.log(`sentinels: ${id("sentinel")} and ${id("sentinel2")}, quorum 2 of 2`);
await owner("register_agent", { agent: id("agent") });
await owner("register_agent", { agent: id("agent2") });
console.log(`bounds: 0.5 NEAR per arming, 3600 s max, 5 NEAR per 7 days, 0.0001 ETH per buy, 0.0005 ETH per token an hour; ${id("agent")} and ${id("agent2")} registered`);
await human.callFunction({
  contractId: id("guard"),
  methodName: "deposit_credit",
  args: { account_id: id("agent") },
  deposit: nearToYocto("1.5"),
});
console.log(`1.5 NEAR of credit deposited for ${id("agent")} (a demo run spends 0.1 to 0.3 of it)`);
// The second agent checks the farm token in ./demo.sh --full: one verdict, plus margin.
await human.callFunction({ contractId: id("guard"), methodName: "deposit_credit", args: { account_id: id("agent2") }, deposit: nearToYocto("0.05") });
console.log(`0.05 NEAR of credit deposited for ${id("agent2")}`);

// Shared config without keys; each function-call key in its own file, loaded by its own process only
// (bun --env-file=.env --env-file=.env.agent ...): the agent never reads the sentinel's key
// nor the armer's.
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
await write(".env.sentinel2", [`SENTINEL=${id("sentinel2")}`, `SENTINEL_KEY=${sentinel2Key}`]);
await write(".env.armer", [`ARMER_KEY=${armerKey}`]);
await write(".env.agent2", [`AGENT=${id("agent2")}`, `AGENT_KEY=${agent2Key}`]);
// The RPC spreads reads over nodes more or less up to date: a node behind the deposit says 0.
let credit = "0";
for (let i = 0; i < 20 && credit === "0"; i++) {
  if (i) await Bun.sleep(1500);
  credit = (await provider.callFunction({ contractId: id("guard"), method: "credit_of", args: { account: id("agent") } })) as string;
}
console.log(`.env, .env.agent, .env.agent2, .env.sentinel, .env.sentinel2, .env.armer written; agent credit: ${credit} yoctoNEAR`);
