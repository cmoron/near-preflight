// Relay, without any key: reads from the guard the transaction signed by NEAR for a request,
// checks that it buys the request's target via the router, for the guard's derived address
// and signed by it, then broadcasts it on the local Base fork and prints the receipt. A Base Sepolia
// guard's transactions (EVM_CHAIN_ID=84532) also go to Base Sepolia itself; never to another public chain.
// `exit <nonce>`: same for the latest signed exit (sale or ETH withdrawal). A transaction already
// mined is reported with its receipt.
// Usage: bun --env-file=.env app/relay.ts <id> | exit <nonce>
import {
  createPublicClient,
  decodeFunctionData,
  keccak256,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { BASE_SEPOLIA, CHAIN_ID, ROUTER, WETH } from "./verifier";

const swap = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);
/** Base's fee oracle (OP predeploy): L1 data fees billed on top of the gas. */
const GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const oracle = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export type Buy = { nonce: number; value: bigint; minOut: bigint; deadline: bigint; gas: bigint; maxFeePerGas: bigint };

/** Accepts `raw` only if it is the WETH -> `target` swap on Base's router, tokens to
 *  `address` and signed by `address`; otherwise throws an error naming the refused field. */
export async function verifyBuy(raw: Hex, target: Address, address: Address): Promise<Buy> {
  const reject = (what: string): never => {
    throw new Error(`signed transaction rejected: ${what}`);
  };
  const tx = parseTransaction(raw);
  if (tx.type !== "eip1559") reject(`type ${tx.type}`);
  if (tx.chainId !== CHAIN_ID) reject(`chain id ${tx.chainId}, not ${CHAIN_ID}`);
  if (!tx.to || getAddress(tx.to) !== ROUTER) reject(`to ${tx.to}, not the router`);
  const { args } = decodeFunctionData({ abi: swap, data: tx.data ?? "0x" });
  const [minOut, path, to, deadline] = args;
  if (path.length !== 2 || getAddress(path[0]) !== WETH || getAddress(path[1]) !== getAddress(target))
    reject(`path ${path.join(" -> ")}, not WETH -> ${target}`);
  if (getAddress(to) !== getAddress(address)) reject(`recipient ${to}, not ${address}`);
  const from = await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
  if (from !== getAddress(address)) reject(`signer ${from}, not ${address}`);
  return { nonce: tx.nonce ?? 0, value: tx.value ?? 0n, minOut, deadline, gas: tx.gas ?? 0n, maxFeePerGas: tx.maxFeePerGas ?? 0n };
}

const exitAbi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
]);

/** Accepts the exit's signed transactions only if, in order, they are approve(router, approve or
 *  amount) on the token then the swap of `amount` back to `address` (a sale), or the payment of
 *  `amount` to `withdrawTo` (token null: a withdrawal), all signed by `address` on Base. `approve`: the
 *  owner's own approve amount, if any. One line per tx. */
export async function verifyExit(raws: Hex[], exit: { token: Address | null; amount: bigint; approve?: bigint | null }, address: Address, withdrawTo: Address): Promise<string[]> {
  const reject = (what: string): never => {
    throw new Error(`signed exit rejected: ${what}`);
  };
  const out: string[] = [];
  for (const [i, raw] of raws.entries()) {
    const tx = parseTransaction(raw);
    if (tx.type !== "eip1559" || tx.chainId !== CHAIN_ID) reject(`tx ${i}: type ${tx.type}, chain id ${tx.chainId}`);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
    if (from !== getAddress(address)) reject(`tx ${i}: signer ${from}, not ${address}`);
    const to = getAddress(tx.to ?? reject(`tx ${i}: no recipient`));
    if (!exit.token) {
      if (raws.length !== 1 || to !== getAddress(withdrawTo) || tx.value !== exit.amount || (tx.data ?? "0x") !== "0x")
        reject(`withdrawal to ${to} of ${tx.value} wei, not ${exit.amount} wei to ${withdrawTo}`);
      out.push(`withdraw ${formatEther(exit.amount)} ETH to ${withdrawTo} (fixed at init), nonce ${tx.nonce}`);
      continue;
    }
    const { functionName, args } = decodeFunctionData({ abi: exitAbi, data: tx.data ?? "0x" });
    if (i === 0) {
      const allowed = exit.approve ?? exit.amount;
      if (functionName !== "approve" || to !== getAddress(exit.token) || getAddress(args[0] as Address) !== ROUTER || args[1] !== allowed)
        reject(`tx 0 is not approve(router, ${allowed}) on ${exit.token}`);
      out.push(`approve(router, ${allowed}) on ${exit.token}, nonce ${tx.nonce}`);
    } else {
      if (i !== 1 || functionName !== "swapExactTokensForETHSupportingFeeOnTransferTokens" || to !== ROUTER) reject(`tx ${i} is not the swap on the router`);
      const [amount, min, path, recipient] = args as readonly [bigint, bigint, readonly Address[], Address, bigint];
      if (amount !== exit.amount || path.length !== 2 || getAddress(path[0]) !== getAddress(exit.token) || getAddress(path[1]) !== WETH)
        reject(`path ${path.join(" -> ")} for ${amount}, not ${exit.amount} ${exit.token} -> WETH`);
      if (getAddress(recipient) !== getAddress(address)) reject(`recipient ${recipient}, not ${address}`);
      out.push(`swap ${amount} ${exit.token} -> ETH for at least ${min} wei, to ${address}, nonce ${tx.nonce}`);
    }
  }
  return out;
}

/** anvil applies anvil_setBalance and anvil_setNonce to the state of its latest block, even once that
 *  block is history: a block a proof simulated on would change after the fact, and its replay with it.
 *  An empty block first keeps every earlier block as it was. */
const mineFirst = (client: PublicClient) => client.request({ method: "evm_mine" } as never);

/** Where the relay broadcasts: a local anvil fork (`fork`, with the setup a real chain would not need),
 *  or Base Sepolia itself, a public testnet (`sepolia`: no setup, the address holds real test ETH). Any
 *  other node is refused, Base mainnet first: what NEAR signs for chain 8453 is valid there. A fork is a
 *  node of this machine: any node can answer `anvil_nodeInfo`, so one on another host is not taken for one. */
export async function nodeKind(client: PublicClient): Promise<"fork" | "sepolia"> {
  const url = (client.transport as { url?: string }).url;
  const local = url !== undefined && ["127.0.0.1", "[::1]", "localhost"].includes(new URL(url).hostname);
  const anvil = local && (await client.request({ method: "anvil_nodeInfo" } as never).then(() => true, () => false));
  if (anvil) return "fork";
  const id = await client.getChainId();
  if (id !== BASE_SEPOLIA) throw new Error(`refusing to broadcast: the EVM node is neither a local anvil fork nor Base Sepolia (chain id ${id})`);
  return "sepolia";
}

/** `address` must hold the value, max gas and L1 data fee of `raws`. On a fork it is topped up to them
 *  (setup Base would not need); on Base Sepolia a shortfall is an error naming it. */
export async function fund(client: PublicClient, raws: Hex[], address: Address, log: (s: string) => void, kind: "fork" | "sepolia" = "fork"): Promise<void> {
  let need = 0n;
  for (const raw of raws) {
    const tx = parseTransaction(raw);
    const l1 = await client.readContract({ address: GAS_ORACLE, abi: oracle, functionName: "getL1Fee", args: [raw] });
    need += (tx.value ?? 0n) + (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) + l1;
  }
  const held = await client.getBalance({ address });
  if (held >= need) return;
  if (kind === "sepolia") throw new Error(`${address} holds ${formatEther(held)} ETH on Base Sepolia, ${raws.length} tx need ${formatEther(need)} (value + max gas + L1 data fee): send it test ETH`);
  await mineFirst(client);
  await client.request({ method: "anvil_setBalance", params: [address, toHex(need)] } as never);
  log(`[fork setup] anvil_setBalance ${address} ${formatEther(need)} ETH (value + max gas + L1 data fee of ${raws.length} tx); on Base it would take a real deposit`);
}

/** Broadcasts `raw`, signed by `address`: on a local anvil fork, after the fork setup Base would not
 *  need (balance for value, max gas and L1 data fee by anvil_setBalance, nonce aligned after a fork
 *  restart by anvil_setNonce); or on Base Sepolia, as it is, when it is signed for Base Sepolia. */
export async function broadcast(client: PublicClient, raw: Hex, address: Address, log: (s: string) => void): Promise<{ receipt: TransactionReceipt; already: boolean }> {
  // Never on another public chain: a transaction signed for 8453 is valid on real Base.
  const kind = await nodeKind(client);
  const tx = parseTransaction(raw);
  if (kind === "sepolia" && tx.chainId !== BASE_SEPOLIA) throw new Error(`refusing to broadcast: transaction signed for chain ${tx.chainId}, not Base Sepolia`);
  const nonce = tx.nonce ?? 0;
  let current = await client.getTransactionCount({ address });
  // A public node may answer from a block behind the one that mined the transaction before: reread for 10 s.
  for (let i = 0; kind === "sepolia" && current < nonce && i < 10; i++) {
    await Bun.sleep(1000);
    current = await client.getTransactionCount({ address });
  }
  if (current > nonce) {
    // Already broadcast (by this relay or anyone: the signed tx is public on NEAR): report it.
    const mined = await client.getTransactionReceipt({ hash: keccak256(raw) }).catch((e: unknown) => {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    });
    if (!mined) throw new Error(`nonce ${nonce} of ${address} already used by another transaction on this chain`);
    log(`${mined.transactionHash} already broadcast: receipt status ${mined.status === "success" ? 1 : 0}, block ${mined.blockNumber}`);
    return { receipt: mined, already: true };
  }
  await fund(client, [raw], address, log, kind);
  if (current < nonce) {
    if (kind === "sepolia") throw new Error(`nonce ${nonce} of ${address} is ahead of Base Sepolia's ${current}: an earlier signed transaction was not broadcast`);
    await mineFirst(client);
    await client.request({ method: "anvil_setNonce", params: [address, toHex(nonce)] } as never);
    log(`[fork setup] anvil_setNonce ${address} ${nonce} (the fork is behind the guard's nonce: restarted fork, or earlier signed tx not broadcast)`);
  }
  const hash = await client.sendRawTransaction({ serializedTransaction: raw as never });
  return { receipt: await client.waitForTransactionReceipt({ hash, timeout: 30_000 }), already: false };
}

if (import.meta.main) {
  // near.ts installs a global fetch and reads .env at import: loaded here only, not by the tests.
  const { env, view } = await import("./near");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  const log = (s: string) => console.log(`  [relay] ${s}`);
  const usage = "usage: bun --env-file=.env app/relay.ts <check id> | exit <nonce>";
  const [arg, nonceArg] = process.argv.slice(2);
  // Address recomputed here from the MPC master key, the guard's account and the fixed path.
  const address = deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH);
  const client = createPublicClient({ transport: http(env("EVM_RPC")) });
  // Refused here, before anything is read: a node that is neither a local anvil fork nor Base Sepolia.
  const kind = await nodeKind(client);
  /** On Base Sepolia the receipt is public: its explorer page. */
  const page = (hash: Hex) => (kind === "sepolia" ? `  https://sepolia.basescan.org/tx/${hash}` : "");
  /** The RPC spreads reads over nodes that are more or less up to date: what was just signed may
   *  still be missing there; reread for up to 30 s. */
  const reread = async <T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    let v = await read();
    for (let i = 1; i < 20 && !done(v); i++) {
      await Bun.sleep(1500);
      v = await read();
    }
    return v;
  };

  if (arg === "exit") {
    const nonce = Number(nonceArg);
    if (!Number.isInteger(nonce)) throw new Error(usage);
    type Exit = { by: string; token: Address | null; amount: string; approve: Hex | null; nonce: number; signed_txs: string[] } | null;
    const exit = await reread(() => view<Exit>("last_exit"), (e) => e?.nonce === nonce);
    if (exit?.nonce !== nonce) throw new Error(`no signed exit at nonce ${nonce} stored by the guard (latest: ${exit?.nonce ?? "none"})`);
    const { withdraw_to } = await view<{ withdraw_to: Address }>("evm_config");
    const raws = exit.signed_txs.map((b) => `0x${Buffer.from(b, "base64").toString("hex")}` as Hex);
    const lines = await verifyExit(raws, { token: exit.token, amount: BigInt(exit.amount), approve: exit.approve ? BigInt(exit.approve) : null }, address, withdraw_to);
    for (const l of lines) log(`exit by ${exit.by}, signed tx decoded: ${l}`);
    const watched = exit.token ? address : withdraw_to;
    await fund(client, raws, address, log, kind); // once for all, so the balance change below is the real one
    const before = await client.getBalance({ address: watched });
    for (const raw of raws) {
      const { receipt, already } = await broadcast(client, raw, address, log);
      if (!already) log(`eth_sendRawTransaction ${receipt.transactionHash}: receipt status ${receipt.status === "success" ? 1 : 0}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed}${page(receipt.transactionHash)}`);
      if (receipt.status !== "success") process.exit(1);
    }
    const after = await client.getBalance({ address: watched });
    log(`${watched} holds ${formatEther(after)} ETH (${after >= before ? "+" : ""}${formatEther(after - before)}${exit.token ? ", net of the gas of both transactions" : ""})`);
    process.exit(raws.length === (exit.token ? 2 : 1) ? 0 : 1);
  }

  const id = Number(arg);
  if (!Number.isInteger(id)) throw new Error(usage);
  type Stored = { target: Address; verdict: string | null; signed_tx: string | null } | null;
  const check = await reread(() => view<Stored>("get_check", { id }), (c) => !!c?.signed_tx);
  if (!check?.signed_tx) throw new Error(`#${id}: no signed transaction stored by the guard`);
  const raw = `0x${Buffer.from(check.signed_tx, "base64").toString("hex")}` as Hex;
  const buy = await verifyBuy(raw, check.target, address);
  log(
    `#${id} (verdict ${check.verdict}) signed tx decoded: router ${ROUTER}, path WETH -> ${check.target}, ` +
      `recipient and signer ${address} (derived from ${env("GUARD")}, path ${GUARD_PATH}), nonce ${buy.nonce}, ` +
      `${formatEther(buy.value)} ETH, amountOutMin ${buy.minOut}`,
  );
  const token = { address: check.target, abi: erc20 } as const;
  const [symbol, decimals, before] = await Promise.all([
    client.readContract({ ...token, functionName: "symbol" }),
    client.readContract({ ...token, functionName: "decimals" }),
    client.readContract({ ...token, functionName: "balanceOf", args: [address] }),
  ]);
  const { receipt, already } = await broadcast(client, raw, address, log);
  if (already) process.exit(receipt.status === "success" ? 0 : 1);
  // Read at the receipt's block: a public node behind it would still answer the balance before the buy.
  const after = await client.readContract({ ...token, functionName: "balanceOf", args: [address], blockNumber: receipt.blockNumber });
  log(
    `#${id} eth_sendRawTransaction ${receipt.transactionHash}: receipt status ${receipt.status === "success" ? 1 : 0}, block ${receipt.blockNumber}, ` +
      `gas used ${receipt.gasUsed}; ${address} holds ${formatUnits(after, decimals)} ${symbol} (+${formatUnits(after - before, decimals)})${page(receipt.transactionHash)}`,
  );
  if (receipt.status !== "success" || after <= before) process.exit(1);
}
