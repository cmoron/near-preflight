# Base Sepolia: a signed swap that landed

On 2026-11-14 a guard on NEAR testnet had NEAR sign a buy and its sale, and both landed on Base Sepolia
(chain 84532). Its account's only key was then deleted. Without it, the guard refused a token whose sales
revert, and signed its owner's withdrawal, which landed too. Everything below is public: read it, or
replay it.

The demo guard of the [README](../README.md) signs for Base (chain 8453) and its swaps go to a local fork.
This guard runs the same source at a later commit, `c3c361f`, which fixes the chain at init. It was
initialised with `evm.chain_id: 84532` ([contract](contract.md#signing)), so its swaps can land on a
public chain at no cost.

## Accounts

| What                 | Where                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard                | [`guard.preflight-sepolia-96623.testnet`](https://testnet.nearblocks.io/address/guard.preflight-sepolia-96623.testnet), **no access key**   |
| Owner                | `preflight-sepolia-96623.testnet`: bounds, sentinels, emergency stop; not the code                                                          |
| Agent, armer         | `agent.` and `armer.preflight-sepolia-96623.testnet`, each acting through a function-call key limited to the guard                          |
| Sentinels            | `sentinel.`, `sentinel2.`, `sentinel3.preflight-sepolia-96623.testnet`, quorum 2 of 3                                                       |
| Their other keys     | each of these five accounts also holds a full-access key, in the owner's keychain: only the guard is keyless                                |
| Signer               | `v1.signer-prod.testnet`, derivation path `evm-1`                                                                                           |
| Guard's Base address | [`0x4F87638FB3F58aE20630369eb2e02D6F0C68Ba5E`](https://sepolia.basescan.org/address/0x4F87638FB3F58aE20630369eb2e02D6F0C68Ba5E)             |
| Healthy token        | [`0x79FD62c0B69372EC28932101D6f2C5fDbd9f316b`](https://sepolia.basescan.org/address/0x79FD62c0B69372EC28932101D6f2C5fDbd9f316b) (`HEALTHY`) |
| Sale-closed token    | [`0xd81b8Fb5fF766F4b88241984662b5dB1e718141b`](https://sepolia.basescan.org/address/0xd81b8Fb5fF766F4b88241984662b5dB1e718141b) (`CLOSED`)  |
| Router               | Uniswap V2 `0x1689E7B1F10000AE47eBfE339a4f69dECd19F602`, the one the contract holds for chain 84532                                         |

Both tokens are `evm/src/DemoToken.sol` as it is (trap 0 and trap 2), each with a pool of 0.00001 ETH whose
LP is burned. Their deployment and funding transactions are in
[`evm/base-sepolia.json`](../evm/base-sepolia.json).

## The guard holds no key

```sh
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"guard.preflight-sepolia-96623.testnet"}}'
#   {"jsonrpc":"2.0","result":{"block_hash":"…","block_height":…,"keys":[]},"id":1}
```

Nobody can deploy other code on it, move its NEAR, or call the signer as the guard outside its rules
([upgrade policy](contract.md#upgrade-policy)). The key was deleted by [`app/lock.ts`](../app/lock.ts)
after the purchase below had landed; the refusal and the withdrawal came after it.

Its code is the reproducible build of commit `c3c361f`, published as tag `base-sepolia-guard`, the commit the wasm names
(`contract_source_metadata`): 402,725 bytes, sha256
`f2136c17d830afc5123e9ee80b5b6bc2aa857d6d571c6e1bb7e6c80faef301a9`, in base58 the account's code hash
`HHxqii6btaYAL9zCHx32GX4tqSQXmnM3Jty7PJUUh41n`. Rebuild it as in
[reproduce](reproduce.md#rebuild-the-deployed-wasm): `git checkout base-sepolia-guard && cargo near build reproducible-wasm`.
The commits on `main` are the same source cherry-picked, under other hashes: only the tag builds this wasm,
which embeds its commit.

## What happened

**1. A purchase and its exit, landed.** The agent asked to buy 0.0000002 ETH of the healthy token. Two
sentinels simulated the buy and the resale on Base Sepolia, each on its own provider, and posted the same
`allow`; the guard built the swap and NEAR signed it; a relay with no key broadcast it.

| Step                              | On NEAR testnet                                                                                                                                                                                | On Base Sepolia                                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy and `new`                  | [`2ViB8yUs…`](https://testnet.nearblocks.io/txns/2ViB8yUsAXBVtLmP1MqWK7ie6hyskwm1WxtVihTLeqbk)                                                                                                 |                                                                                                                                                                                                                                                       |
| Check #1 requested                | [`HtPa3zrC…`](https://testnet.nearblocks.io/txns/HtPa3zrCcmqXpdxaP1qY7TDuoLe4A8hPLQQSbNfVnpGF)                                                                                                 |                                                                                                                                                                                                                                                       |
| Two `allow` votes                 | [`946CLP6X…`](https://testnet.nearblocks.io/txns/946CLP6XBBTzVtGYuZAopJTYFU5Y1vbcmXLgtWbMdjJR), [`Gxc4uGn5…`](https://testnet.nearblocks.io/txns/Gxc4uGn5A5jtQfkZxDQTgHHGjA7TiGuMMbSvMniRVWir) | simulated at reference block 58,470,891, the sales again at 58,470,986                                                                                                                                                                                                                       |
| `buy`: built and signed           | [`7uDySyMK…`](https://testnet.nearblocks.io/txns/7uDySyMKFfkBvirkfHutGcJXFmmGUhztsCwJLJbbmVeh)                                                                                                 | [`0x2d5d3776…`](https://sepolia.basescan.org/tx/0x2d5d377655b8f8faf7921b40e2a25cfe95190c1b8a17e6d0733f4b1070e46863), status 1                                                                                                                         |
| Exit quote #2, three quotes       | [`AEgxUmYa…`](https://testnet.nearblocks.io/txns/AEgxUmYaaEEEt3nx7FdAU3yEixrpChXfWm6YgHpEvHpa)                                                                                                 |                                                                                                                                                                                                                                                       |
| `sell_quoted`: approve, then swap | [`CbqF1BnJ…`](https://testnet.nearblocks.io/txns/CbqF1BnJ5sRHThftnHzDVxyT5f7a7rAsroLjo6dJzAFz)                                                                                                 | [`0xd7de7627…`](https://sepolia.basescan.org/tx/0xd7de762732c130366e39ca543ebfeb8ad0fb9708d8cec0604e24f9403d14c4c4) and [`0x7f65205c…`](https://sepolia.basescan.org/tx/0x7f65205ca9c33b80a9228b0ed2c0647c75548fb6aa2e780020355cc4778a21c9), status 1 |
| The guard's key deleted           | [`2JpL71bh…`](https://testnet.nearblocks.io/txns/2JpL71bhLXDs585nmY1pX3nPFL4Srouw3Jwv2HJAS3Mp)                                                                                                 |                                                                                                                                                                                                                                                       |

**2. A refusal, nothing signed.** The agent asked to buy the sale-closed token. Check #3
([`9vTpkRqA…`](https://testnet.nearblocks.io/txns/9vTpkRqAuM7vvbuvu3A6UMCTzh7nStkW9RZcC8bwQPYV)) got
`block` on the first vote
([`97wxc3kw…`](https://testnet.nearblocks.io/txns/97wxc3kwpXhGXDThBbnQKDNpDguE9a2reM1ZKF4kiB2u):
`sale refused 23 s after the buy (TransferHelper::transferFrom: transferFrom failed)`). The guard stores no
signed transaction for it, and quarantined the token for 30 min. Asked again after that, check #4
([`FuptoFEU…`](https://testnet.nearblocks.io/txns/FuptoFEUp97M1pRgELJYLSHC7HVTCxvTM4RCbWotbqqj)) got two
identical `block` votes
([`8gKgfPrE…`](https://testnet.nearblocks.io/txns/8gKgfPrEcyujHUeWzbzFey6T9UcMKREu4RzAVaWoTwJ8),
[`Gf7EmJTs…`](https://testnet.nearblocks.io/txns/Gf7EmJTs2ECZgihC4nA1Fhv3VhnkSSzdTzq5kfTCLSUt)), which
put the token on the guard's shared blocklist: no agent can ask for it again.

**3. The owner's withdrawal, signed by the keyless guard.** `withdraw_eth`
([`BqLKCtjT…`](https://testnet.nearblocks.io/txns/BqLKCtjTroozk2WF43TyfWKQ11uq1oNFXm5q5Tpwu9bS)) sent
0.00006 ETH to the address fixed at init:
[`0x30d09618…`](https://sepolia.basescan.org/tx/0x30d09618730ad7d4500318ed82ab55dfc99dc42d7ac5ef8509adf0d859a80943),
status 1.

## Replay it

No account, no key. `bun` 1.4 and Foundry 1.8, as in the README.

```sh
export GUARD=guard.preflight-sepolia-96623.testnet EVM_CHAIN_ID=84532 INDEX_RPC=https://base-sepolia-rpc.publicnode.com
bun app/replay.ts app/fixtures/base-sepolia-buy.json https://sepolia.base.org --check
#   REPLAY OK: verdict allow confirmed, same as on chain
bun app/replay.ts app/fixtures/base-sepolia-blocked.json https://sepolia.base.org --check
#   REPLAY OK: verdict block confirmed, same as on chain
cast receipt 0x2d5d377655b8f8faf7921b40e2a25cfe95190c1b8a17e6d0733f4b1070e46863 status --rpc-url https://sepolia.base.org
#   true
```

The two files are the proofs of the votes on checks #1 and #3. Replay needs a node that still serves the
state of their blocks.

## Run your own

About 8 testnet NEAR and 0.00015 Base Sepolia ETH on a key of yours (the scripts name ours: change
`DEPLOYER` and `KEY` in `evm/sepolia.sh`).

```sh
cargo near build reproducible-wasm
EVM_CHAIN_ID=84532 ENV_FILE=.env.sepolia bun app/setup.ts <you>.testnet <your EVM address>
evm/sepolia.sh               # the tokens and pools on Base Sepolia, the guard's address funded
./sepolia.sh                 # the purchase lands, the sale lands, the trap is blocked: exit 0
bun app/lock.ts guard.<you>.testnet     # last: deletes the guard's key, for good
```

To rehearse first without spending: `FORK=1 evm/sepolia.sh` keeps a throwaway fork of Base Sepolia in one
terminal, `FORK=1 ./sepolia.sh` runs against it in another. NEAR really signs, so the rehearsal moves
the guard's nonce, and what it signs is valid on Base Sepolia and public on NEAR: anyone can broadcast it.
Give the rehearsal a guard of its own (another parent account, `ENV_FILE=.env.dryrun` on the three
commands).

## Limits

- **Our own tokens.** We deployed both, on a testnet, with 0.00001 ETH of liquidity: this shows the path
  from a check to a mined transaction, not a detection rate. Detection is measured on real Base launches
  ([corpus](corpus.md)).
- **Three sentinels, one machine.** Three accounts and keys run by one operator. They simulated on three
  providers (`sepolia.base.org`, `base-sepolia-rpc.publicnode.com`, `rpc.sentio.xyz`) but read their logs
  from one, publicnode, the only public node we found that serves 5,000 blocks of logs a request. Two
  tie it to their own node by block hash; the third simulates on publicnode itself.
- **One vote on the first refusal.** A single `block` vote refuses, and on check #3 the script stopped
  the other two sentinels once the verdict was in. It now waits for a second vote, as on check #4.
- **Testnet on both sides.** NEAR testnet and its signer; Base Sepolia ETH has no value. Nothing here ran
  on Base mainnet, and the relay refuses to broadcast there.
- **The owner still decides.** No key can change the code, but the owner account sets bounds and
  sentinels, approves a `warn`, and withdraws ETH to the address fixed at init.
- **No upgrade.** A bug in this guard's code is fixed by deploying another guard, at another address.
