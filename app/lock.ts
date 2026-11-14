// Makes a deployed guard's code final: deletes the guard account's full-access key, the only key it has.
// After it nobody can deploy other code on the account, move its NEAR, or call the MPC signer as the guard
// outside its rules (docs/contract.md, upgrade policy). The owner's role is another account's: bounds,
// sentinels and the emergency stop still work. Irreversible: run it last, once the guard is seen working.
// Refuses unless the account runs exactly the wasm named and holds that one key; then reads the key
// list back (view_access_key_list, final) and exits 0 only if it is empty.
// Usage: [WASM=<file.wasm>] bun app/lock.ts guard.<parent>.testnet
import bs58 from "bs58";
import { homedir } from "node:os";
import { NETWORK } from "./derive";
import { account, explorer, RPC } from "./near";

const guard = process.argv[2];
// The mainnet guard keeps its key on its owner's decision (docs/mainnet.md): not this script's to delete.
if (NETWORK !== "testnet" || !guard?.endsWith(".testnet")) throw new Error("usage: [WASM=<file.wasm>] bun app/lock.ts guard.<parent>.testnet");

async function query<T>(params: object): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (!j.result) throw new Error(JSON.stringify(j.error ?? j));
  return j.result;
}
type Keys = { keys: { public_key: string; access_key: { permission: unknown } }[] };
const keys = () => query<Keys>({ request_type: "view_access_key_list", account_id: guard });

const wasmPath = process.env.WASM || "target/near/goblin_near.wasm";
const want = bs58.encode(new Bun.CryptoHasher("sha256").update(await Bun.file(wasmPath).bytes()).digest());
const { code_hash } = await query<{ code_hash: string }>({ request_type: "view_account", account_id: guard });
if (code_hash !== want) throw new Error(`${guard} runs code ${code_hash}, not ${wasmPath} (${want}): nothing deleted`);
const saved = await Bun.file(`${homedir()}/.near-credentials/testnet/${guard}.json`).json();
const before = await keys();
if (before.keys.length !== 1 || before.keys[0].public_key !== saved.public_key || before.keys[0].access_key.permission !== "FullAccess") {
  throw new Error(`${guard} does not hold exactly the full-access key of this keychain (${before.keys.map((k) => k.public_key).join(", ") || "no key"}): nothing deleted`);
}
console.log(`${guard} runs ${wasmPath} (code hash ${code_hash}) and holds one key, ${saved.public_key}, full access.`);
if (prompt(`Delete it? The code can never be changed again. Type ${guard} to confirm:`) !== guard) throw new Error("not confirmed: nothing deleted");
const r = await account(guard, saved.private_key).deleteKey(saved.public_key);
console.log(`key deleted: ${explorer(r.transaction.hash)}`);
// The RPC spreads reads over nodes more or less up to date: wait for one that saw the deletion.
let after = await keys();
for (let i = 0; i < 20 && after.keys.length; i++) {
  await Bun.sleep(1500);
  after = await keys();
}
console.log(`view_access_key_list ${guard} (final): ${JSON.stringify(after)}`);
process.exit(after.keys.length ? 1 : 0);
