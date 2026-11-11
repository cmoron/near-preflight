// Diffuseur, sans aucune cle : lit dans la garde la transaction signee par NEAR pour une demande,
// verifie qu'elle achete la cible de la demande via le routeur, pour l'adresse derivee de la garde
// et signee par elle, puis la diffuse sur le fork local de Base et affiche le recu.
// Usage : bun --env-file=.env app/relay.ts <id>
import {
  createPublicClient,
  decodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ROUTER, WETH } from "./verifier";

const swap = parseAbi([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);
/** Oracle de frais de Base (predeploy OP) : frais de donnees L1 factures en plus du gaz. */
const GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const oracle = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export type Buy = { nonce: number; value: bigint; minOut: bigint; deadline: bigint; gas: bigint; maxFeePerGas: bigint };

/** Accepte `raw` seulement si c'est le swap WETH -> `target` sur le routeur de Base, jetons vers
 *  `address` et signe par `address` ; sinon leve une erreur qui nomme le champ refuse. */
export async function verifyBuy(raw: Hex, target: Address, address: Address): Promise<Buy> {
  const reject = (what: string): never => {
    throw new Error(`signed transaction rejected: ${what}`);
  };
  const tx = parseTransaction(raw);
  if (tx.type !== "eip1559") reject(`type ${tx.type}`);
  if (tx.chainId !== 8453) reject(`chain id ${tx.chainId}, not Base`);
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

if (import.meta.main) {
  // near.ts pose un fetch global et lit .env a l'import : charge ici seulement, pas par les tests.
  const { env, view } = await import("./near");
  const { deriveEvmAddress, fetchMasterPublicKey, GUARD_PATH } = await import("./derive");
  const log = (s: string) => console.log(`  [relay] ${s}`);
  const id = Number(process.argv[2]);
  if (!Number.isInteger(id)) throw new Error("usage: bun --env-file=.env app/relay.ts <id>");

  // Le RPC repartit les lectures sur des noeuds plus ou moins a jour : un achat qui vient d'etre signe
  // peut y manquer encore ; relire jusqu'a 30 s.
  type Stored = { target: Address; verdict: string | null; signed_tx: string | null } | null;
  let check: Stored = null;
  for (let i = 0; i < 20 && !check?.signed_tx; i++) {
    if (i) await Bun.sleep(1500);
    check = await view<Stored>("get_check", { id });
  }
  if (!check?.signed_tx) throw new Error(`#${id}: no signed transaction stored by the guard`);
  const raw = `0x${Buffer.from(check.signed_tx, "base64").toString("hex")}` as Hex;
  // Adresse recalculee ici depuis la cle maitresse du MPC, le compte de la garde et le chemin fixe.
  const address = deriveEvmAddress(await fetchMasterPublicKey(), env("GUARD"), GUARD_PATH);
  const buy = await verifyBuy(raw, check.target, address);
  log(
    `#${id} (verdict ${check.verdict}) signed tx decoded: router ${ROUTER}, path WETH -> ${check.target}, ` +
      `recipient and signer ${address} (derived from ${env("GUARD")}, path ${GUARD_PATH}), nonce ${buy.nonce}, ` +
      `${formatEther(buy.value)} ETH, amountOutMin ${buy.minOut}`,
  );

  const rpc = env("EVM_RPC");
  const client = createPublicClient({ transport: http(rpc) });
  // Diffusion sur le fork local seulement : la transaction est aussi valable sur Base reel.
  await client.request({ method: "anvil_nodeInfo" } as never).catch(() => {
    throw new Error(`refusing to broadcast: ${rpc} is not a local anvil fork`);
  });
  // Preparation du fork : l'adresse derivee n'a rien sur Base ; on lui donne de quoi payer cet achat
  // (valeur, gaz au plafond et frais de donnees L1 de Base, sans quoi le noeud ecarte la transaction),
  // et un fork relance repart du nonce 0 alors que la garde a peut-etre deja signe avant.
  const l1 = await client.readContract({ address: GAS_ORACLE, abi: oracle, functionName: "getL1Fee", args: [raw] });
  const need = buy.value + buy.gas * buy.maxFeePerGas + l1;
  if ((await client.getBalance({ address })) < need) {
    await client.request({ method: "anvil_setBalance", params: [address, toHex(need)] } as never);
    log(`[fork setup] anvil_setBalance ${address} ${formatEther(need)} ETH (value + max gas + ${l1} wei L1 data fee); on Base it would take a real deposit`);
  }
  const nonce = await client.getTransactionCount({ address });
  if (nonce > buy.nonce) throw new Error(`nonce ${buy.nonce} already used by ${address} on this chain`);
  if (nonce < buy.nonce) {
    await client.request({ method: "anvil_setNonce", params: [address, toHex(buy.nonce)] } as never);
    log(`[fork setup] anvil_setNonce ${address} ${buy.nonce} (the fork is behind the guard's nonce: restarted fork, or earlier signed tx not broadcast)`);
  }

  const token = { address: check.target, abi: erc20 } as const;
  const [symbol, decimals, before] = await Promise.all([
    client.readContract({ ...token, functionName: "symbol" }),
    client.readContract({ ...token, functionName: "decimals" }),
    client.readContract({ ...token, functionName: "balanceOf", args: [address] }),
  ]);
  const hash = await client.sendRawTransaction({ serializedTransaction: raw as never });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  const after = await client.readContract({ ...token, functionName: "balanceOf", args: [address] });
  log(
    `#${id} eth_sendRawTransaction ${hash}: receipt status ${receipt.status === "success" ? 1 : 0}, block ${receipt.blockNumber}, ` +
      `gas used ${receipt.gasUsed}; ${address} holds ${formatUnits(after, decimals)} ${symbol} (+${formatUnits(after - before, decimals)})`,
  );
  if (receipt.status !== "success" || after <= before) process.exit(1);
}
