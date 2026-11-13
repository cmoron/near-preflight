// Deploys an inert guard: one account, guard.<parent>, running the reproducible wasm, initialized and
// nothing more. <parent> is its owner, armer and only sentinel; no agent, no credit; the bounds and the
// per-token cap stay at zero, so the guard refuses every check and signs no buy, until the owner changes
// them. The full demo (agents, three sentinels, credit) is app/setup.ts, on testnet only. Runbook: docs/mainnet.md.
// --dry-run prints each transaction it would send and what it moves, and sends nothing: it reads no key and
// builds no signer, so it has nothing to sign; the fetch near-api-js and this script use lets out only RPC reads.
// --verify reads a deployed guard and checks it is that inert one (exit 1 otherwise).
// A run stopped between the two transactions is resumed by running it again: the guard's key, saved before
// the first, is reused and never overwritten.
// Usage: [NEAR_NETWORK=mainnet] [WASM=<file.wasm>] bun app/deploy.ts <parent> [owner EVM address] [--dry-run | --verify]
import { actions, KeyPair, nearToYocto, PublicKey, teraToGas, type Account, type Action, type KeyPairString } from "near-api-js";
import bs58 from "bs58";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fetchDerivedAddress, fetchMasterPublicKey, deriveEvmAddress, GUARD_PATH, MPC_CONTRACT, NET, NETWORK } from "./derive";

/** The reproducible build of commit 22e5c32 (docs/reproduce.md), the testnet guard's code: the only wasm
 *  this script deploys on mainnet. */
export const REPRODUCIBLE_SHA256 = "3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f";
export const SOURCE_REV = "22e5c32ad5387189eee7575ce00c6938ff253dc2";
/** code_hash of an account without code. */
export const NO_CODE = "11111111111111111111111111111111";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const BASE_RPC = "https://mainnet.base.org";
const NEW_GAS = teraToGas("100");
/** JSON-RPC methods a dry run lets out: NEAR and Base reads. */
const READS = new Set(["query", "gas_price", "EXPERIMENTAL_protocol_config", "status", "eth_getBalance"]);

/** A fetch that lets out only RPC reads. derive.ts's MPC views (reads) go out through their own fetch;
 *  what makes a dry run unable to send is that it holds no key. */
export function readOnly(f: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = typeof init?.body === "string" ? JSON.parse(init.body).method : undefined;
    if (!READS.has(method)) return Promise.reject(new Error(`dry run: RPC method ${method} refused, only reads go out`));
    return f(input, init);
  }) as typeof fetch;
}

/** The command line; refuses anything else, a misspelt `--dry-run` first: it would otherwise send. */
export function parseArgs(argv: string[], suffix: string) {
  const flags = argv.filter((a) => a.startsWith("-"));
  const [parent, withdrawTo = DEAD, ...extra] = argv.filter((a) => !a.startsWith("-"));
  const dry = flags.includes("--dry-run"), verify = flags.includes("--verify");
  if (!parent?.endsWith(suffix) || !/^0x[0-9a-fA-F]{40}$/.test(withdrawTo) || extra.length || (dry && verify) || flags.some((f) => f !== "--dry-run" && f !== "--verify")) {
    throw new Error(`usage: [NEAR_NETWORK=mainnet] bun app/deploy.ts <parent>${suffix} [owner EVM address] [--dry-run | --verify]`);
  }
  return { parent, withdrawTo, dry, verify };
}

/** What is left to send for `guard`: both transactions when it does not exist; only the second when the first
 *  landed (no code yet) and its key is saved here; otherwise nothing, refused. */
export function stage(guard: string, view: { code_hash: string } | null, keySaved: boolean): "create" | "resume" {
  if (!view) return "create";
  if (view.code_hash !== NO_CODE) throw new Error(`${guard} already has code: check it with --verify`);
  if (!keySaved) throw new Error(`${guard} exists without code and its key is not in this keychain: this script cannot sign as it (docs/mainnet.md#if-a-run-stops)`);
  return "resume";
}

/** Owner and armer: the first two fields of the guard's borsh state (`Guard` in src/lib.rs), which no view returns. */
export function rolesOf(state: Buffer): { owner: string; armer: string } {
  let o = 0;
  const id = () => {
    const n = state.readUInt32LE(o);
    o += 4 + n;
    return state.toString("utf8", o - n, o);
  };
  return { owner: id(), armer: id() };
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
  const { parent, withdrawTo, dry: DRY, verify: VERIFY } = parseArgs(process.argv.slice(2), NET.suffix);
  // near.ts sets the process's fetch (timeout, 429 waited out): imported here, so a test of this file does not.
  const { RPC, account, explorer, humanAccount } = await import("./near");
  if (DRY) globalThis.fetch = readOnly(globalThis.fetch);
  const guard = `guard.${parent}`;
  // The guard's full-access key: written once, before tx 1, and never overwritten. Only its existence is
  // checked here: a dry run reads no key.
  const keyFile = `${homedir()}/.near-credentials/${NETWORK}/${guard}.json`;
  const keySaved = await Bun.file(keyFile).exists();

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
  /** The guard's storage entries under `prefix` (src/lib.rs: "STATE", and one byte per collection). */
  const state = async (prefix: string): Promise<{ key: string; value: string }[]> =>
    (await query({ request_type: "view_state", account_id: guard, prefix_base64: Buffer.from(prefix).toString("base64") })).values;
  const baseBalance = async (address: string) => BigInt(await rpc<string>(BASE_RPC, "eth_getBalance", [address, "latest"]));

  // bun loads ./.env by itself, and the testnet demo's sets NEAR_RPC: the RPC must serve the network named.
  const { chain_id } = await rpc(RPC, "status", []);
  if (chain_id !== NETWORK) throw new Error(`NEAR_NETWORK=${NETWORK} but ${RPC} serves ${chain_id}: unset NEAR_RPC or point it at ${NETWORK}`);

  /** Reads the guard and checks it is the inert one; prints each fact. */
  async function verify(): Promise<boolean> {
    const acct = await viewAccount(guard);
    if (!acct) throw new Error(`${guard} does not exist on ${NETWORK}`);
    const [meta, keys, bounds, limits, sentinels, evm, last, lastExit, derived, [st], agents] = await Promise.all([
      view("contract_source_metadata"),
      query({ request_type: "view_access_key_list", account_id: guard }),
      view("bounds"),
      view("token_limits"),
      view("sentinels"),
      view("evm_config"),
      view("last_check_id"),
      view("last_exit"),
      fetchDerivedAddress(guard, GUARD_PATH),
      state("STATE"),
      state("g"), // agents registered (LookupSet b"g")
    ]);
    const { owner, armer } = rolesOf(Buffer.from(st.value, "base64"));
    const code = Buffer.from(bs58.decode(acct.code_hash)).toString("hex");
    const wei = await baseBalance(evm.address);
    const full: string[] = keys.keys.filter((k: any) => k.access_key.permission === "FullAccess").map((k: any) => k.public_key);
    const calls = keys.keys.length - full.length;
    const saved: string | null = (await Bun.file(keyFile).exists()) ? (await Bun.file(keyFile).json()).public_key : null; // the public key only
    const zero = bounds.max_budget === "0" && bounds.max_7d === "0" && bounds.max_buy_wei === "0" && bounds.max_duration_s === 0;
    const rows: [boolean, string][] = [
      [code === REPRODUCIBLE_SHA256, `code sha256 ${code} (reproducible build of ${SOURCE_REV.slice(0, 7)}: ${REPRODUCIBLE_SHA256.slice(0, 8)}…); storage ${acct.storage_usage} bytes`],
      [String(meta.build_info?.source_code_snapshot).endsWith(SOURCE_REV), `source ${meta.build_info?.source_code_snapshot}`],
      [owner === parent && armer === parent, `owner ${owner}, armer ${armer} (inert: both ${parent})`],
      [sentinels.sentinels.length === 1 && sentinels.sentinels[0] === parent && sentinels.quorum === 1, `sentinels ${JSON.stringify(sentinels.sentinels)}, quorum ${sentinels.quorum} (inert: ${parent} alone, 1)`],
      [agents.length === 0, `agents registered: ${agents.length} (inert: none)`],
      [zero, `bounds ${JSON.stringify(bounds)} (inert: zero, every check refused)`],
      [limits.cap_wei === "0", `per-token cap ${limits.cap_wei} wei (inert: zero, every check refused)`],
      [Number(last) === 0, `checks requested: ${last} (inert: none)`],
      [lastExit === null, `exits or withdrawals signed: ${lastExit === null ? "none" : JSON.stringify(lastExit)} (inert: none)`],
      [evm.mpc === MPC_CONTRACT && evm.address === derived, `signer ${evm.mpc}, Base address ${evm.address} (MPC derives ${derived}); ETH withdrawals only to ${evm.withdraw_to}`],
      [full.length === 1 && calls === 0 && (!saved || full[0] === saved),
        `keys on ${guard}: ${full.length} full access${saved ? (full[0] === saved ? `, the one in ${keyFile}` : `, NOT the one in ${keyFile}`) : ""}, ${calls} function call (inert: one full access, no other)`],
      [wei === 0n, `Base mainnet balance of ${evm.address}: ${wei} wei`],
    ];
    for (const [ok, line] of rows) console.log(`  ${ok ? "ok " : "NOT"} ${line}`);
    return rows.every(([ok]) => ok);
  }

  if (VERIFY) {
    const inert = await verify();
    console.log(inert ? `${guard}: inert guard, as deployed by app/deploy.ts` : `${guard}: NOT inert (rows marked NOT)`);
    process.exit(inert ? 0 : 1);
  }

  const wasmPath = process.env.WASM || "target/near/goblin_near.wasm";
  const wasm = await Bun.file(wasmPath).bytes();
  if (NETWORK === "mainnet" && sha256(wasm) !== REPRODUCIBLE_SHA256) {
    throw new Error(`${wasmPath} is not the reproducible build of ${SOURCE_REV.slice(0, 7)} (sha256 ${sha256(wasm)}): see docs/mainnet.md`);
  }
  const [parentView, guardView] = await Promise.all([viewAccount(parent), viewAccount(guard)]);
  const resume = stage(guard, guardView, keySaved) === "resume";
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
  // The guard's key: the one saved by an earlier run, if any, else a new one, saved at send before tx 1.
  // A dry run reads and builds none: AddKey shows a placeholder.
  let guardKey: KeyPair | null = null;
  if (!DRY && keySaved) {
    const saved = await Bun.file(keyFile).json();
    if (saved.account_id !== guard) throw new Error(`${keyFile} is the key of ${saved.account_id}, not ${guard}`);
    guardKey = KeyPair.fromString(saved.private_key as KeyPairString);
  } else if (!DRY) guardKey = KeyPair.fromRandom("ed25519");
  const pk = guardKey?.getPublicKey() ?? PublicKey.fromString("ed25519:11111111111111111111111111111111");
  if (resume && guardKey) {
    const k = await query({ request_type: "view_access_key", account_id: guard, public_key: pk.toString() }).catch(() => null);
    if (k?.permission !== "FullAccess") throw new Error(`the key in ${keyFile} is not a full-access key of ${guard}: this script cannot sign as it`);
  }
  const all = plan(parent, wasm, pk, guardYocto, init);
  const txs = resume ? all.slice(1) : all;

  const gas1 = fee(tc.action_receipt_creation_config, false) + fee(ac.create_account_cost, false) + fee(ac.transfer_cost, false) + fee(ac.add_key_cost.full_access_cost, false);
  const argBytes = BigInt(JSON.stringify(init).length + "new".length);
  const deployGas = fee(tc.action_receipt_creation_config, true) + fee(ac.deploy_contract_cost, true) + fee(ac.deploy_contract_cost_per_byte, true) * BigInt(wasm.length) + fee(ac.function_call_cost, true) + fee(ac.function_call_cost_per_byte, true) * argBytes;
  const gas2 = deployGas + NEW_GAS; // `new` burns at most what is attached
  // Creating an account costs account_creation_charge in all: its create_account execution fee plus the rest, burnt.
  const creation = BigInt(rc.account_creation_charge) - BigInt(ac.create_account_cost.execution) * gasPrice;
  const spent = guardYocto + gas1 * gasPrice + (creation > 0n ? creation : 0n);
  const OVERHEAD = 1_000n; // account record 100 B, one key ~80 B, the guard's state after `new` ~600 B
  const locked = (BigInt(wasm.length) + OVERHEAD) * perByte;
  const guardHas = resume ? BigInt(guardView.amount) : guardYocto;
  // While tx 2 runs its gas is held at the purchase price; the storage must still be covered then.
  if (guardHas - gas2 * purchase < locked) throw new Error(`${near(guardHas)} NEAR cannot cover ${near(locked)} of storage and ${near(gas2 * purchase)} of gas held`);
  const t = (g: bigint) => `${(Number(g) / 1e12).toFixed(1)} TGas`;
  const keyLabel = keySaved
    ? `${guardKey ? `${pk.toString()}, ` : ""}the key saved in ${keyFile} by an earlier run, reused`
    : guardKey ? `${pk.toString()} (saved to ${keyFile} before tx 1)` : `<new ed25519 key, generated and saved to ${keyFile} at send>`;

  console.log(`${DRY ? "DRY RUN on" : "Deployment to"} NEAR ${NETWORK} (${RPC}): an inert guard, ${resume ? `resumed: ${guard} exists without code, tx 2 only` : "2 transactions"}`);
  const free = parentView ? BigInt(parentView.amount) - BigInt(parentView.storage_usage) * perByte : 0n;
  console.log(`  parent ${parent}: ${resume ? "signs nothing more" : parentView ? `${near(free)} NEAR free (needs ${near(spent + gas1 * purchase)} at send)` : `does not exist on ${NETWORK}: a send would stop here`}`);
  console.log(`  wasm ${wasmPath}: ${wasm.length} bytes, sha256 ${sha256(wasm)}${sha256(wasm) === REPRODUCIBLE_SHA256 ? ` = reproducible build of ${SOURCE_REV.slice(0, 7)}` : ", NOT the reproducible build"}`);
  console.log(`  Base address NEAR would sign for (${MPC_CONTRACT}, path ${GUARD_PATH}): ${address}, the same as the MPC contract's derived_public_key; Base mainnet balance ${await baseBalance(address)} wei`);
  for (const tx of txs) {
    console.log(`\n  tx ${all.indexOf(tx) + 1}: signer ${tx.signer} -> receiver ${tx.receiver}`);
    for (const a of tx.actions) console.log(`    ${describe(a, keyLabel)}`);
  }
  console.log(`\n  Costs at ${NETWORK}'s parameters now: storage ${perByte} yoctoNEAR per byte, gas ${gasPrice} yoctoNEAR per gas (bought at ${purchase}, the difference refunded)`);
  if (!resume) console.log(`  tx 1, paid by ${parent}: ${near(guardYocto)} NEAR moved to ${guard}; gas ${t(gas1)} and the account creation charge: ${near(spent - guardYocto)} NEAR burnt`);
  console.log(`  tx 2, paid by ${guard} from its ${near(guardHas)}: gas ${t(deployGas)} to deploy + at most ${t(NEW_GAS)} for new, at most ${near(gas2 * gasPrice)} NEAR burnt (${near(gas2 * purchase)} held while it runs)`);
  if (!resume) console.log(`  ${parent} spends ${near(spent)} NEAR in all`);
  console.log(`  ${guard} then holds ${near(guardHas - gas2 * gasPrice)} NEAR or more: about ${near(locked)} locked as storage staking (${wasm.length} wasm bytes + about ${OVERHEAD} for the account, its key and state;`);
  console.log(`    recovered only by deleting the account, with its full-access key), the rest, about ${near(guardHas - gas2 * gasPrice - locked)}, free on the guard account`);
  console.log(`  Result: ${guard}, owner, armer and only sentinel ${parent}; no agent, no credit; bounds and per-token cap zero: every check refused, no buy signed, until the owner changes them.`);
  console.log(`  Not created: agent, armer or sentinel accounts, function-call keys, .env files. Base: nothing sent; never fund ${address}.`);
  if (DRY || !guardKey) {
    console.log("\nDRY RUN: nothing sent, no key read or created.");
    process.exit(0);
  }

  if (!resume && !parentView) throw new Error(`${parent} does not exist on ${NETWORK}`);
  if (!resume && free < spent + gas1 * purchase) throw new Error(`${parent} holds ${near(free)} NEAR free, needs ${near(spent + gas1 * purchase)}`);
  if (prompt(`\nSend ${txs.length === 1 ? "this transaction" : `these ${txs.length} transactions`} on NEAR ${NETWORK}? Type ${guard} to confirm:`) !== guard) throw new Error("not confirmed: nothing sent");
  const signers: Record<string, Account> = { [guard]: account(guard, guardKey.toString()) };
  if (!resume) signers[parent] = await humanAccount(parent); // its full key, from ~/.near-credentials/<network>/
  // Saved before the account exists, readable by its owner only, never over another file ("wx"): a key that
  // lands on chain is never lost.
  if (!keySaved) await writeFile(keyFile, JSON.stringify({ account_id: guard, public_key: pk.toString(), private_key: guardKey.toString() }), { mode: 0o600, flag: "wx" });
  try {
    for (const tx of txs) {
      // The RPC spreads reads over nodes more or less up to date: tx 2 needs one that sees the new account.
      for (let n = 0; tx.signer === guard && !(await viewAccount(guard)); n++) {
        if (n === 20) throw new Error(`${guard} not visible 30 s after tx 1`);
        await Bun.sleep(1500);
      }
      const r = await signers[tx.signer].signAndSendTransaction({ receiverId: tx.receiver, actions: tx.actions, waitUntil: "FINAL", throwOnFailure: true });
      console.log(`tx ${all.indexOf(tx) + 1} final: ${explorer(r.transaction.hash)}`);
    }
  } catch (e) {
    throw new Error(`stopped: ${(e as Error).message}\nThe key stays in ${keyFile}. Run the same command again: it sends only what is left (docs/mainnet.md#if-a-run-stops).`, { cause: e });
  }
  // A node behind may not show the code yet: wait for it before the checks.
  const codeHash = bs58.encode(new Bun.CryptoHasher("sha256").update(wasm).digest());
  for (let n = 0; n < 20 && (await viewAccount(guard))?.code_hash !== codeHash; n++) await Bun.sleep(1500);
  console.log(`\n${guard}: full-access key kept in ${keyFile} (docs/mainnet.md: keep or delete)`);
  process.exit((await verify()) ? 0 : 1);
}
