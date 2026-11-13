// Deploys an inert guard: one account, guard.<parent>, running the reproducible wasm, initialized and
// nothing more. <parent> is its owner, armer and only sentinel; no agent, no credit; the bounds and the
// per-token cap stay at zero, so the guard refuses every check and signs no buy. The full demo (agents,
// three sentinels, credit) is app/setup.ts, on testnet only. Runbook: docs/mainnet.md.
// --dry-run prints each transaction it would send and what it moves, and sends nothing: it reads no key,
// builds no signer, and its fetch lets out only RPC reads.
// --verify reads a deployed guard and checks it is that inert one (exit 1 otherwise).
// Usage: [NEAR_NETWORK=mainnet] [WASM=<file.wasm>] bun app/deploy.ts <parent> [owner EVM address] [--dry-run | --verify]
import { actions, KeyPair, nearToYocto, PublicKey, teraToGas, type Action } from "near-api-js";
import bs58 from "bs58";
import { homedir } from "node:os";
import { fetchDerivedAddress, fetchMasterPublicKey, deriveEvmAddress, GUARD_PATH, MPC_CONTRACT, NET, NETWORK } from "./derive";

/** The reproducible build of commit 22e5c32 (docs/reproduce.md), the testnet guard's code: the only wasm
 *  this script deploys on mainnet. */
export const REPRODUCIBLE_SHA256 = "3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f";
export const SOURCE_REV = "22e5c32ad5387189eee7575ce00c6938ff253dc2";
const BASE_RPC = "https://mainnet.base.org";
const NEW_GAS = teraToGas("100");
/** JSON-RPC methods a dry run lets out: NEAR and Base reads. */
const READS = new Set(["query", "gas_price", "EXPERIMENTAL_protocol_config", "status", "eth_getBalance"]);

/** A fetch that lets out only RPC reads: in a dry run nothing can be sent, whatever code asks. */
export function readOnly(f: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = typeof init?.body === "string" ? JSON.parse(init.body).method : undefined;
    if (!READS.has(method)) return Promise.reject(new Error(`dry run: RPC method ${method} refused, only reads go out`));
    return f(input, init);
  }) as typeof fetch;
}

/** Arguments of `new` for an inert guard: every role is the owner's, so no other key can act on it;
 *  bounds and per-token cap are not arguments, they start at zero. EVM values as app/setup.ts. */
export function initArgs(parent: string, address: string, withdrawTo: string) {
  return {
    owner: parent,
    armer: parent,
    sentinel: parent,
    price: nearToYocto("0.025").toString(), // at least a check's storage, 2,450 bytes (src/lib.rs)
    evm: {
      mpc: MPC_CONTRACT,
      address,
      withdraw_to: withdrawTo,
      gas_limit: 250_000,
      max_fee_per_gas: "50000000",
      max_priority_fee_per_gas: "1000000",
      yocto_per_wei: "1000000000",
      max_slippage_bps: 300,
    },
  };
}

export type Tx = { signer: string; receiver: string; actions: Action[] };

/** The two transactions, and nothing else: the parent creates and funds guard.<parent> with one full-access
 *  key; that key deploys the wasm and calls `new` in one batch (`new` must be called by the guard itself). */
export function plan(parent: string, wasm: Uint8Array, guardKey: PublicKey, guardYocto: bigint, init: object): Tx[] {
  const guard = `guard.${parent}`;
  return [
    { signer: parent, receiver: guard, actions: [actions.createAccount(), actions.transfer(guardYocto), actions.addFullAccessKey(guardKey)] },
    { signer: guard, receiver: guard, actions: [actions.deployContract(wasm), actions.functionCall("new", init, NEW_GAS, 0n)] },
  ];
}

const near = (yocto: bigint) => (Number(yocto) / 1e24).toFixed(4);
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

function describe(a: Action, keyLabel: string): string {
  if (a.createAccount) return "CreateAccount";
  if (a.transfer) return `Transfer ${near(a.transfer.deposit)} NEAR`;
  if (a.addKey) return `AddKey ${keyLabel}, full access`;
  if (a.deployContract) return `DeployContract ${a.deployContract.code.length} bytes, sha256 ${sha256(a.deployContract.code)}`;
  if (a.functionCall) {
    const f = a.functionCall;
    return `FunctionCall ${f.methodName} ${new TextDecoder().decode(f.args)}, ${f.gas / 10n ** 12n} TGas, deposit ${f.deposit}`;
  }
  throw new Error(`unexpected action ${a.enum}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const DRY = args.includes("--dry-run"), VERIFY = args.includes("--verify");
  const [parent, withdrawTo = "0x000000000000000000000000000000000000dEaD"] = args.filter((a) => !a.startsWith("--"));
  if (!parent?.endsWith(NET.suffix) || !/^0x[0-9a-fA-F]{40}$/.test(withdrawTo) || (DRY && VERIFY)) {
    throw new Error(`usage: [NEAR_NETWORK=mainnet] bun app/deploy.ts <parent>${NET.suffix} [owner EVM address] [--dry-run | --verify]`);
  }
  // near.ts sets the process's fetch (timeout, 429 waited out): imported here, so a test of this file does not.
  const { RPC, account, explorer, humanAccount, writeSecret } = await import("./near");
  if (DRY) globalThis.fetch = readOnly(globalThis.fetch);
  const guard = `guard.${parent}`;

  async function rpc<T = any>(url: string, method: string, params: unknown): Promise<T> {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j: any = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  const query = (params: object) => rpc(RPC, "query", { finality: "final", ...params });
  const viewAccount = (id: string) =>
    query({ request_type: "view_account", account_id: id }).catch((e: Error) => {
      if (e.message.includes("UNKNOWN_ACCOUNT")) return null;
      throw e;
    });
  const view = async (method: string, a: object = {}) => {
    const r = await query({ request_type: "call_function", account_id: guard, method_name: method, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") });
    return JSON.parse(Buffer.from(r.result).toString());
  };
  const baseBalance = async (address: string) => BigInt(await rpc<string>(BASE_RPC, "eth_getBalance", [address, "latest"]));

  // bun loads ./.env by itself, and the testnet demo's sets NEAR_RPC: the RPC must serve the network named.
  const { chain_id } = await rpc(RPC, "status", []);
  if (chain_id !== NETWORK) throw new Error(`NEAR_NETWORK=${NETWORK} but ${RPC} serves ${chain_id}: unset NEAR_RPC or point it at ${NETWORK}`);

  /** Reads the guard and checks it is the inert one; prints each fact. */
  async function verify(): Promise<boolean> {
    const acct = await viewAccount(guard);
    if (!acct) throw new Error(`${guard} does not exist on ${NETWORK}`);
    const [meta, keys, bounds, limits, sentinels, evm, last, lastExit, derived] = await Promise.all([
      view("contract_source_metadata"),
      query({ request_type: "view_access_key_list", account_id: guard }),
      view("bounds"),
      view("token_limits"),
      view("sentinels"),
      view("evm_config"),
      view("last_check_id"),
      view("last_exit"),
      fetchDerivedAddress(guard, GUARD_PATH),
    ]);
    const code = Buffer.from(bs58.decode(acct.code_hash)).toString("hex");
    const wei = await baseBalance(evm.address);
    const full = keys.keys.filter((k: any) => k.access_key.permission === "FullAccess").length;
    const rows: [boolean, string][] = [
      [code === REPRODUCIBLE_SHA256, `code sha256 ${code} (reproducible build of ${SOURCE_REV.slice(0, 7)}: ${REPRODUCIBLE_SHA256.slice(0, 8)}…)`],
      [String(meta.build_info?.source_code_snapshot).endsWith(SOURCE_REV), `source ${meta.build_info?.source_code_snapshot}`],
      [bounds.max_buy_wei === "0" && bounds.max_budget === "0", `bounds ${JSON.stringify(bounds)} (inert: zero, every check refused)`],
      [limits.cap_wei === "0", `per-token cap ${limits.cap_wei} wei (inert: zero, every check refused)`],
      [Number(last) === 0, `checks requested: ${last} (inert: none)`],
      [lastExit === null, `exits or withdrawals signed: ${lastExit === null ? "none" : JSON.stringify(lastExit)} (inert: none)`],
      [evm.mpc === MPC_CONTRACT && evm.address === derived, `signer ${evm.mpc}, Base address ${evm.address} (MPC derives ${derived})`],
      [wei === 0n, `Base mainnet balance of ${evm.address}: ${wei} wei`],
      [true, `sentinels ${JSON.stringify(sentinels)}; full-access keys on ${guard}: ${full}; storage ${acct.storage_usage} bytes`],
    ];
    for (const [ok, line] of rows) console.log(`  ${ok ? "ok " : "NOT"} ${line}`);
    return rows.every(([ok]) => ok);
  }

  if (VERIFY) {
    const inert = await verify();
    console.log(inert ? `${guard}: inert guard, as deployed by app/deploy.ts` : `${guard}: NOT the inert guard`);
    process.exit(inert ? 0 : 1);
  }

  const wasmPath = process.env.WASM || "target/near/goblin_near.wasm";
  const wasm = await Bun.file(wasmPath).bytes();
  if (NETWORK === "mainnet" && sha256(wasm) !== REPRODUCIBLE_SHA256) {
    throw new Error(`${wasmPath} is not the reproducible build of ${SOURCE_REV.slice(0, 7)} (sha256 ${sha256(wasm)}): see docs/mainnet.md`);
  }
  const [parentView, guardView] = await Promise.all([viewAccount(parent), viewAccount(guard)]);
  if (guardView) throw new Error(`${guard} already exists on ${NETWORK}: nothing to create`);
  // The Base address NEAR will sign for: derived here, and by the MPC contract itself; both must agree.
  const address = deriveEvmAddress(await fetchMasterPublicKey(), guard, GUARD_PATH);
  const mpcAddress = await fetchDerivedAddress(guard, GUARD_PATH);
  if (address !== mpcAddress) throw new Error(`derived ${address}, ${MPC_CONTRACT} derives ${mpcAddress}`);

  // Costs from the network's own parameters (nearcore docs/RuntimeSpec/Fees/Fees.md).
  const { runtime_config: rc } = await rpc(RPC, "EXPERIMENTAL_protocol_config", { finality: "final" });
  const perByte = BigInt(rc.storage_amount_per_byte);
  const gasPrice = BigInt((await rpc(RPC, "gas_price", [null])).gas_price);
  const purchase = gasPrice > BigInt(rc.min_gas_purchase_price) ? gasPrice : BigInt(rc.min_gas_purchase_price);
  const tc = rc.transaction_costs, ac = tc.action_creation_config;
  const fee = (f: any, sir: boolean) => BigInt(sir ? f.send_sir : f.send_not_sir) + BigInt(f.execution);
  // The guard's balance: its storage, 1 NEAR per 100 KB of wasm, plus 0.3 NEAR (as app/setup.ts).
  const guardYocto = nearToYocto((Math.ceil(wasm.length / 1e4) / 10 + 0.3).toFixed(1) as `${number}`);
  const init = initArgs(parent, address, withdrawTo);
  // A dry run builds no key: AddKey shows a placeholder, the send generates the key and saves it first.
  const guardKey = DRY ? null : KeyPair.fromRandom("ed25519");
  const pk = guardKey?.getPublicKey() ?? PublicKey.fromString("ed25519:11111111111111111111111111111111");
  const txs = plan(parent, wasm, pk, guardYocto, init);

  const gas1 = fee(tc.action_receipt_creation_config, false) + fee(ac.create_account_cost, false) + fee(ac.transfer_cost, false) + fee(ac.add_key_cost.full_access_cost, false);
  const argBytes = BigInt(JSON.stringify(init).length + "new".length);
  const deployGas = fee(tc.action_receipt_creation_config, true) + fee(ac.deploy_contract_cost, true) + fee(ac.deploy_contract_cost_per_byte, true) * BigInt(wasm.length) + fee(ac.function_call_cost, true) + fee(ac.function_call_cost_per_byte, true) * argBytes;
  const gas2 = deployGas + NEW_GAS; // `new` burns at most what is attached
  // Creating an account costs account_creation_charge in all: its create_account execution fee plus the rest, burnt.
  const creation = BigInt(rc.account_creation_charge) - BigInt(ac.create_account_cost.execution) * gasPrice;
  const spent = guardYocto + gas1 * gasPrice + (creation > 0n ? creation : 0n);
  const OVERHEAD = 1_000n; // account record 100 B, one key ~80 B, the guard's state after `new` ~600 B
  const locked = (BigInt(wasm.length) + OVERHEAD) * perByte;
  // While tx 2 runs its gas is held at the purchase price; the storage must still be covered then.
  if (guardYocto - gas2 * purchase < locked) throw new Error(`${near(guardYocto)} NEAR cannot cover ${near(locked)} of storage and ${near(gas2 * purchase)} of gas held`);
  const t = (g: bigint) => `${(Number(g) / 1e12).toFixed(1)} TGas`;

  console.log(`${DRY ? "DRY RUN on" : "Deployment to"} NEAR ${NETWORK} (${RPC}): an inert guard, ${txs.length} transactions`);
  const free = parentView ? BigInt(parentView.amount) - BigInt(parentView.storage_usage) * perByte : 0n;
  console.log(`  parent ${parent}: ${parentView ? `${near(free)} NEAR free (needs ${near(spent + gas1 * purchase)} at send)` : `does not exist on ${NETWORK}: a send would stop here`}`);
  console.log(`  wasm ${wasmPath}: ${wasm.length} bytes, sha256 ${sha256(wasm)}${sha256(wasm) === REPRODUCIBLE_SHA256 ? ` = reproducible build of ${SOURCE_REV.slice(0, 7)}` : ", NOT the reproducible build"}`);
  console.log(`  Base address NEAR would sign for (${MPC_CONTRACT}, path ${GUARD_PATH}): ${address}, the same as the MPC contract's derived_public_key; Base mainnet balance ${await baseBalance(address)} wei`);
  txs.forEach((tx, i) => {
    console.log(`\n  tx ${i + 1}: signer ${tx.signer} -> receiver ${tx.receiver}`);
    for (const a of tx.actions) console.log(`    ${describe(a, guardKey ? `${pk.toString()} (saved to ~/.near-credentials/${NETWORK}/${guard}.json)` : "<new ed25519 key, generated and saved to the keychain at send>")}`);
  });
  console.log(`\n  Costs at ${NETWORK}'s parameters now: storage ${perByte} yoctoNEAR per byte, gas ${gasPrice} yoctoNEAR per gas (bought at ${purchase}, the difference refunded)`);
  console.log(`  tx 1, paid by ${parent}: ${near(guardYocto)} NEAR moved to ${guard}; gas ${t(gas1)} and the account creation charge: ${near(spent - guardYocto)} NEAR burnt`);
  console.log(`  tx 2, paid by ${guard} from those ${near(guardYocto)}: gas ${t(deployGas)} to deploy + at most ${t(NEW_GAS)} for new, at most ${near(gas2 * gasPrice)} NEAR burnt (${near(gas2 * purchase)} held while it runs)`);
  console.log(`  ${parent} spends ${near(spent)} NEAR in all`);
  console.log(`  ${guard} then holds ${near(guardYocto - gas2 * gasPrice)} NEAR or more: about ${near(locked)} locked as storage staking (${wasm.length} wasm bytes + about ${OVERHEAD} for the account, its key and state;`);
  console.log(`    recovered only by deleting the account, with its full-access key), the rest, about ${near(guardYocto - gas2 * gasPrice - locked)}, free on the guard account`);
  console.log(`  Result: ${guard}, owner, armer and only sentinel ${parent}; no agent, no credit; bounds and per-token cap zero: every check refused, no buy signed.`);
  console.log(`  Not created: agent, armer or sentinel accounts, function-call keys, .env files. Base: nothing sent; never fund ${address}.`);
  if (DRY || !guardKey) {
    console.log("\nDRY RUN: nothing sent, no key read or created.");
    process.exit(0);
  }

  if (!parentView) throw new Error(`${parent} does not exist on ${NETWORK}`);
  if (free < spent + gas1 * purchase) throw new Error(`${parent} holds ${near(free)} NEAR free, needs ${near(spent + gas1 * purchase)}`);
  if (prompt(`\nSend these ${txs.length} transactions on NEAR ${NETWORK}? Type ${guard} to confirm:`) !== guard) throw new Error("not confirmed: nothing sent");
  const human = await humanAccount(parent); // its full key, from ~/.near-credentials/<network>/
  const keyFile = `${homedir()}/.near-credentials/${NETWORK}/${guard}.json`;
  if (await Bun.file(keyFile).exists()) throw new Error(`${keyFile} already exists: not overwritten`);
  // Saved before the account exists: a key that lands on chain is never lost.
  await writeSecret(keyFile, JSON.stringify({ account_id: guard, public_key: pk.toString(), private_key: guardKey.toString() }));
  const signers = { [parent]: human, [guard]: account(guard, guardKey.toString()) };
  for (const [i, tx] of txs.entries()) {
    // The RPC spreads reads over nodes more or less up to date: tx 2 needs one that sees the new account.
    for (let n = 0; tx.signer === guard && !(await viewAccount(guard)); n++) {
      if (n === 20) throw new Error(`${guard} not visible 30 s after tx 1: undo it and run again (docs/mainnet.md#undo)`);
      await Bun.sleep(1500);
    }
    const r = await signers[tx.signer].signAndSendTransaction({ receiverId: tx.receiver, actions: tx.actions, waitUntil: "FINAL", throwOnFailure: true });
    console.log(`tx ${i + 1} final: ${explorer(r.transaction.hash)}`);
  }
  console.log(`\n${guard}: full-access key kept in ${keyFile} (docs/mainnet.md: keep or delete)`);
  process.exit((await verify()) ? 0 : 1);
}
