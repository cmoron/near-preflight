// The inert deployment: what it sends, and that a dry run cannot send. No network call.
import { expect, test } from "bun:test";
import { PublicKey } from "near-api-js";
import { initArgs, plan, readOnly } from "./deploy";
import { MPC_CONTRACT } from "./derive";

test("a dry run's fetch lets out RPC reads only", async () => {
  const sent: string[] = [];
  const f = readOnly((async (_: unknown, init?: RequestInit) => (sent.push(String(init?.body)), Response.json({}))) as typeof fetch);
  const call = (method: string) => f("http://rpc", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
  for (const read of ["query", "gas_price", "EXPERIMENTAL_protocol_config", "status", "eth_getBalance"]) await call(read);
  for (const send of ["send_tx", "broadcast_tx_commit", "broadcast_tx_async", "eth_sendRawTransaction"]) {
    await expect(call(send)).rejects.toThrow("only reads go out");
  }
  await expect(f("http://rpc", { method: "POST", body: new Uint8Array([1]) })).rejects.toThrow("only reads go out");
  await expect(f("http://rpc")).rejects.toThrow("only reads go out");
  expect(sent.length).toBe(5);
});

test("the inert guard: one account, its code and new, every role the owner's, nothing else", () => {
  const key = PublicKey.fromString("ed25519:11111111111111111111111111111111");
  const txs = plan("owner.near", new Uint8Array(3), key, 7n, initArgs("owner.near", "0x00000000000000000000000000000000000000aa", "0x000000000000000000000000000000000000dEaD"));
  expect(txs.map((t) => [t.signer, t.receiver, t.actions.map((a) => a.enum)])).toEqual([
    ["owner.near", "guard.owner.near", ["createAccount", "transfer", "addKey"]],
    ["guard.owner.near", "guard.owner.near", ["deployContract", "functionCall"]],
  ]);
  expect(txs[0].actions[1].transfer?.deposit).toBe(7n);
  expect(txs[0].actions[2].addKey?.accessKey.permission.enum).toBe("fullAccess");
  const call = txs[1].actions[1].functionCall!;
  expect([call.methodName, call.deposit]).toEqual(["new", 0n]);
  const args = JSON.parse(new TextDecoder().decode(call.args));
  expect([args.owner, args.armer, args.sentinel, args.evm.mpc]).toEqual(["owner.near", "owner.near", "owner.near", MPC_CONTRACT]);
  expect(Object.keys(args).sort()).toEqual(["armer", "evm", "owner", "price", "sentinel"]); // bounds and cap stay zero
});
