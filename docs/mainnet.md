# Mainnet

How to deploy the guard on NEAR mainnet as an **inert guard**: deployed and readable, no agent armed, nothing
bought on Base. Prepared and dry-run on 2026-11-13, rehearsed on testnet the same day; not deployed yet.

**Inert means: until the owner changes it.** The owner (`<parent>.near`) can later call `set_bounds`,
`set_token_cap`, `register_agent`, `sell`, `withdraw_eth` or `sign_replacement`, and the guard's own
full-access key can deploy other code: either one can make NEAR sign a transaction valid on Base mainnet.
Keep both keys as safely as funds.

## What is deployed, and what is not

| Created                                                                                                   | Not created                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `guard.<parent>.near`: the reproducible wasm of commit `22e5c32`, then `new`                              | agent, armer or sentinel accounts, and their keys            |
| owner, armer and only sentinel: `<parent>.near`, so no other key can act on the guard                     | an agent registered, a credit deposited, an arming           |
| one full-access key of the guard, in the owner's keychain ([keep or delete](#the-guards-full-access-key)) | `.env` files: no relay, no sentinel, no Base node configured |
| bounds and per-token cap left at zero                                                                     | any transaction on Base                                      |

With `max_buy_wei` and `cap_wei` at zero, `request_check` refuses every amount (`src/lib.rs`: a check needs
`0 < amount_wei <= max_buy_wei` and room under the cap), so no check, no verdict, no signed buy. On testnet,
`request_check` of 1 wei from the owner and from a stranger both failed with `amount above the owner's
per-buy limit`. What anyone else can do is harmless: `deposit_credit` (their own NEAR, refunded to them by
`refund_credit`); `report` needs a reporter the owner named, and there is none.

`withdraw_to` is fixed by `new` and never changes: the default `0x…dEaD` is the only destination of
`withdraw_eth`. ETH sent to the guard's Base address can therefore only be burnt.

## Prerequisites

- **A fresh mainnet account `<parent>.near`, dedicated to this.** Do not sign with an account that holds
  funds you care about. It holds at least 4.42 NEAR free (send 4.5); its full-access key is in
  `~/.near-credentials/mainnet/<parent>.near.json`, where the script reads it (near CLI
  `save-to-legacy-keychain`; on Linux `save-to-keychain` writes that file too).
- **The reproducible wasm**, in a plain clone outside any other repository (see [reproduce](reproduce.md#rebuild-the-deployed-wasm)):
  `git clone https://github.com/cmoron/near-preflight && cd near-preflight && git checkout 22e5c32 && cargo near build reproducible-wasm`
  gives `target/near/goblin_near.wasm`, 401,767 bytes, sha256 `3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f`.
  `app/deploy.ts` refuses any other wasm on mainnet.
- This repository's `main`, with `bun install`.

Each command below names the network, the RPC and the wasm itself: bun loads `./.env` by itself, and the
testnet demo's names the testnet RPC (the script refuses an RPC of another network). Do not `export` them:
the other scripts of this repository would then talk to mainnet too.

## Dry run

```sh
NEAR_NETWORK=mainnet NEAR_RPC=https://free.rpc.fastnear.com WASM=<clone>/target/near/goblin_near.wasm bun app/deploy.ts <parent>.near --dry-run
```

It prints the two transactions, their actions and what they cost, and exits 0. It sends nothing: it reads
no key, generates none and builds no signer, so it has nothing to sign. It also checks that the Base
address it derives equals `v1.signer`'s own `derived_public_key`. Any other flag, a misspelt `--dry-run`
included, is refused.

```
tx 1: signer <parent>.near -> receiver guard.<parent>.near
  CreateAccount
  Transfer 4.4000 NEAR
  AddKey <new ed25519 key, generated and saved to ~/.near-credentials/mainnet/guard.<parent>.near.json at send>, full access
tx 2: signer guard.<parent>.near -> receiver guard.<parent>.near
  DeployContract 401767 bytes, sha256 3c5b992f…372f
  FunctionCall new {"owner","armer","sentinel": <parent>.near, "price": 0.025 NEAR, "evm": {"mpc":"v1.signer", "address": <derived>, ...}}, 100 TGas, deposit 0
```

| NEAR                        | Predicted | Measured on testnet (same protocol 88 and fees) | Why                                                    |
| --------------------------- | --------- | ----------------------------------------------- | ------------------------------------------------------ |
| Leaves `<parent>.near`      | 4.4071    | 4.40711                                         | 4.4 to the guard, 0.0071 burnt (account creation, gas) |
| Locked as storage staking   | ~4.028    | 4.02543 (402,543 bytes)                         | the wasm + the account, its key and state, 10^19/byte  |
| Gas of tx 2, from the guard | ≤ 0.013   | 0.0031                                          | 30 TGas to deploy + at most the 100 TGas of `new`      |
| Free on the guard           | ≥ 0.36    | 0.3715                                          | recovered with the account                             |

The testnet setup moves 7.6 NEAR: the same 4.4 for the guard, plus six role accounts (1.6) and the agents'
credit (1.55). The inert guard needs neither.

## Deploy

```sh
NEAR_NETWORK=mainnet NEAR_RPC=https://free.rpc.fastnear.com WASM=<clone>/target/near/goblin_near.wasm bun app/deploy.ts <parent>.near
```

It prints the same plan (the new key's public part in place of the placeholder), asks you to type
`guard.<parent>.near` (anything else sends nothing), saves the guard's new key to
`~/.near-credentials/mainnet/guard.<parent>.near.json` (mode 0600, never printed, never overwritten) before
creating the account, sends the two transactions (waiting for finality), then runs the checks below. Run
on the same parent once deployed, it refuses: `already has code`.

### If a run stops

Run the same command again. If tx 1 landed and tx 2 did not (the process killed, the network gone, `new`
failed: tx 2 is undone as a whole), it says `resumed: … tx 2 only` and sends only tx 2, signed with the saved
key; the parent pays nothing more. If tx 1 did not land, it sends both, with the key already saved. Rehearsed
on testnet: killed right after tx 1, the account held 4.4 NEAR, no code and the saved key; the second run
deployed it, and the parent had spent the same 4.4071 as an uninterrupted run.

## Verify

Anyone, no key:

```sh
NEAR_NETWORK=mainnet NEAR_RPC=https://free.rpc.fastnear.com bun app/deploy.ts <parent>.near --verify   # exit 0 when inert
near account view-account-summary guard.<parent>.near network-config mainnet now   # Local Contract SHA-256: 3c5b992f…372f
near contract call-function as-read-only guard.<parent>.near contract_source_metadata json-args {} network-config mainnet now
near account list-keys guard.<parent>.near network-config mainnet now
```

`--verify` checks, one row each, exit 1 if any fails: the code hash is the reproducible build of `22e5c32`
and the source metadata names that commit; owner and armer are `<parent>.near` (read from the contract's
state) and it is the only sentinel, quorum 1; no agent registered; bounds and per-token cap zero; no check
requested and no exit or withdrawal signed; the signer is `v1.signer` and the Base address the one it
derives, holding 0 wei on Base; exactly one full-access key (the saved one, when its file is here) and no
other key. The testnet demo guard fails seven of these rows (roles, sentinels, agents, bounds, cap, checks,
exits), as it should. Any later change to the guard is a public transaction to it on
[nearblocks](https://nearblocks.io).

## The guard's full-access key

`docs/contract.md` deletes it after `new` in production. Here:

|                     | Keep it (owner's keychain)                                    | Delete it                                                |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Code                | the owner can redeploy; each redeploy is a public transaction | immutable: `list-keys` shows none                        |
| The 4.39 NEAR       | recovered by deleting the account                             | locked forever, storage staking and free balance         |
| A bug found later   | fixed on the same account                                     | a new guard account, 4.4 NEAR more                       |
| What visitors trust | the owner, for the code; the hash is checked at a block       | nobody, for the code; the owner still holds the settings |

**Recommendation: keep it** for this deployment, as safely as the owner's key. The guard holds no one's
money: no credit, no agent, an unfunded Base address, so the power to redeploy endangers nothing, and
keeping it can still be undone later, not the reverse. Delete it, or hand it to a multisig, before an agent
is ever armed (`--verify` then reads NOT on its key row, which checks the deployment as made):
`near account delete-keys guard.<parent>.near public-keys <its key> network-config mainnet sign-with-keychain send`.

## Site

The site reads testnet only: `docs/app.js` and `docs/landing.js` hold testnet RPCs
(`test.rpc.fastnear.com`, `rpc.testnet.near.org`), `DEFAULT_GUARD` is the testnet guard, and the pages say
"NEAR testnet". `?guard=guard.<parent>.near` would ask a testnet node for a mainnet account. A mainnet
journal would need the network chosen from the guard's suffix (`.near`: mainnet RPCs such as
`free.rpc.fastnear.com`), those texts made to follow it, and no snapshot (`docs/snapshot.js` already
ignores a snapshot of another guard). Not built.

## Undo

```sh
near account delete-account guard.<parent>.near beneficiary <parent>.near network-config mainnet sign-with-keychain send
```

Signed with the guard's full-access key (the near CLI finds the saved file: checked on testnet by signing
without sending): everything on the guard returns to the parent, storage staking included. Lost: the 0.007
NEAR account creation and the gas, about 0.01 NEAR. Impossible once that key is deleted. Only `<parent>.near`
can create `guard.<parent>.near` again, which would derive the same Base address; a new deploy reuses the
saved key.

## Safety rules

- **Never fund the guard's Base address.** A transaction NEAR signs for chain 8453 is valid on Base mainnet,
  and ETH there can only be withdrawn to `withdraw_to` (`0x…dEaD`).
- **The relay never broadcasts to Base mainnet.** `app/deploy.ts` writes no `.env`; never give `app/relay.ts`
  an `EVM_RPC` on Base mainnet for this guard.
- **No agent armed.** Never call `set_bounds`, `set_token_cap` or `register_agent` on it; `app/setup.ts`,
  `demo.sh` and `check-mainnet.sh` are testnet tools (`setup.ts` refuses mainnet).
- **The owner signs nothing on Base.** `sell`, `withdraw_eth` and `sign_replacement` each have NEAR sign a
  Base mainnet transaction: never call them on this guard.

## Rehearse on testnet

The same script with no network variable, on a fresh faucet account (10 NEAR):

```sh
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
WASM=<clone>/target/near/goblin_near.wasm bun app/deploy.ts <name>.testnet --dry-run
WASM=<clone>/target/near/goblin_near.wasm bun app/deploy.ts <name>.testnet
bun app/deploy.ts <name>.testnet --verify
```

## Sources

| Value                                                      | Source                                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPC signer `v1.signer` (testnet `v1.signer-prod.testnet`)  | NEAR docs, `chain-abstraction/chain-signatures/implementation.mdx`; on chain, both run the same code (hash `CpGX8ywX…PERJ`), so the guard's `sign` call is unchanged |
| Derivation, `derived_public_key`                           | `near/mpc`: `crates/near-mpc-crypto-types/src/kdf.rs`, `crates/contract/src/api/keys.rs`; checked against `v1.signer` (`app/derive.test.ts`)                         |
| RPC `https://free.rpc.fastnear.com`                        | NEAR docs, `api/rpc/providers.mdx` (FastNEAR, mainnet)                                                                                                               |
| Explorer `https://nearblocks.io`                           | NEAR docs, `chain-abstraction/chain-signatures.mdx`                                                                                                                  |
| Storage price, account creation charge, gas purchase price | mainnet `EXPERIMENTAL_protocol_config` (protocol 88, the same on testnet); nearcore `docs/RuntimeSpec/Fees/Fees.md`                                                  |
