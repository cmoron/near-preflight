# Mainnet

How to deploy the guard on NEAR mainnet as an **inert guard**: deployed and readable, no agent armed, nothing
bought on Base. Prepared and dry-run on 2026-11-13; not deployed yet.

## What is deployed, and what is not

| Created                                                                                                   | Not created                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `guard.<parent>.near`: the reproducible wasm of commit `22e5c32`, then `new`                              | agent, armer or sentinel accounts, and their keys            |
| owner, armer and only sentinel: `<parent>.near`, so no other key can act on the guard                     | an agent registered, a credit deposited, an arming           |
| one full-access key of the guard, in the owner's keychain ([keep or delete](#the-guards-full-access-key)) | `.env` files: no relay, no sentinel, no Base node configured |
| bounds and per-token cap left at zero                                                                     | any transaction on Base                                      |

With `max_buy_wei` and `cap_wei` at zero, `request_check` refuses every amount (`src/lib.rs`: a check needs
`0 < amount_wei <= max_buy_wei` and room under the cap), so no check, no verdict, no signed buy.

## Prerequisites

- **A funded mainnet account `<parent>.near`**, created for this, holding 4.42 NEAR free; its full-access key in
  `~/.near-credentials/mainnet/<parent>.near.json` (near CLI `save-to-keychain`). The prize payout account,
  `plagueis.near`, never signs.
- **The reproducible wasm**, in a plain clone outside any other repository (see [reproduce](reproduce.md#rebuild-the-deployed-wasm)):
  `git clone https://github.com/cmoron/near-preflight && cd near-preflight && git checkout 22e5c32 && cargo near build reproducible-wasm`
  gives `target/near/goblin_near.wasm`, 401,767 bytes, sha256 `3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f`.
  `app/deploy.ts` refuses any other wasm on mainnet.
- This repository's `main`, with `bun install`.

The commands below set `NEAR_RPC`: bun loads `./.env` by itself, and the testnet demo's names the
testnet RPC (the script refuses an RPC of another network).

## Dry run

```sh
export NEAR_NETWORK=mainnet NEAR_RPC=https://free.rpc.fastnear.com WASM=<clone>/target/near/goblin_near.wasm
bun app/deploy.ts <parent>.near --dry-run
```

It prints the two transactions, their actions and what they cost, and exits 0. It sends nothing by
construction: it reads no key, generates none, builds no signer, and its `fetch` lets out only RPC reads.
It also checks that the Base address it derives equals `v1.signer`'s own `derived_public_key`.

Measured for `near-preflight.near` (not an existing account):

```
tx 1: signer <parent>.near -> receiver guard.<parent>.near
  CreateAccount
  Transfer 4.4000 NEAR
  AddKey <new ed25519 key, generated and saved to the keychain at send>, full access
tx 2: signer guard.<parent>.near -> receiver guard.<parent>.near
  DeployContract 401767 bytes, sha256 3c5b992f…372f
  FunctionCall new {"owner","armer","sentinel": <parent>.near, "price": 0.025 NEAR, "evm": {"mpc":"v1.signer", "address": <derived>, ...}}, 100 TGas, deposit 0
```

| NEAR                        | Amount  | Why                                                                               |
| --------------------------- | ------- | --------------------------------------------------------------------------------- |
| Leaves `<parent>.near`      | 4.4071  | 4.4 to the guard, 0.0071 burnt (account creation 0.007, gas)                      |
| Locked as storage staking   | ~4.028  | 401,767 wasm bytes + ~1 KB of account, key and state, at 10^19 yoctoNEAR per byte |
| Gas of tx 2, from the guard | ≤ 0.013 | 30 TGas to deploy + at most the 100 TGas attached to `new`                        |
| Free on the guard           | ~0.36   | recovered with the account                                                        |

The testnet setup moves 7.6 NEAR: the same 4.4 for the guard, plus six role accounts (1.6) and the agents'
credit (1.55). The inert guard needs neither.

## Deploy

```sh
bun app/deploy.ts <parent>.near            # same environment as the dry run
```

It prints the same plan, asks you to type `guard.<parent>.near`, saves the guard's new key to
`~/.near-credentials/mainnet/guard.<parent>.near.json` before creating the account, sends the two
transactions (waiting for finality), then runs the checks below. If `new` fails, tx 2 is undone as a whole,
or if the script stops between the two: the account exists without code; [undo](#undo) and run it again.
Right after a deploy a lagging RPC node may still show no code: run `--verify` again.

## Verify

Anyone, no key:

```sh
bun app/deploy.ts <parent>.near --verify                 # same environment; exit 0 when inert
near account view-account-summary guard.<parent>.near network-config mainnet now   # Local Contract SHA-256: 3c5b992f…372f
near contract call-function as-read-only guard.<parent>.near contract_source_metadata json-args {} network-config mainnet now
near contract call-function as-read-only guard.<parent>.near bounds json-args {} network-config mainnet now
near contract call-function as-read-only guard.<parent>.near token_limits json-args {} network-config mainnet now
near account list-keys guard.<parent>.near network-config mainnet now
```

`--verify` checks: the code hash is the reproducible build of `22e5c32`, and the source metadata names that
commit; bounds and per-token cap are zero; no check was requested (`last_check_id` 0) and no exit or
withdrawal signed (`last_exit` null); the signer is `v1.signer` and the Base address is the one it derives;
that address holds 0 wei on Base. Any later change to the guard is a public transaction to it on
[nearblocks](https://nearblocks.io).

## The guard's full-access key

`docs/contract.md` deletes it after `new` in production. Here:

|                     | Keep it (owner's keychain)                                    | Delete it                                                |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Code                | the owner can redeploy; each redeploy is a public transaction | immutable: `list-keys` shows none                        |
| The 4.39 NEAR       | recovered by deleting the account                             | locked forever, storage staking and free balance         |
| A bug found later   | fixed on the same account                                     | a new guard account, 4.4 NEAR more                       |
| What visitors trust | the owner, for the code; the hash is checked at a block       | nobody, for the code; the owner still holds the settings |

**Recommendation: keep it** for this deployment. The guard holds no one's money: no credit, no agent, an
unfunded Base address, so the power to redeploy endangers nothing, and keeping it can still be undone
later, not the reverse. Delete it, or hand it to a multisig, before an agent is ever armed:
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

Signed with the guard's full-access key: everything on the guard returns to the parent, storage staking
included. Lost: the 0.007 NEAR account creation and the gas, about 0.02 NEAR. Impossible once that key is
deleted. Only `<parent>.near` can create `guard.<parent>.near` again, which would derive the same Base address.

## Safety rules

- **Never fund the guard's Base address.** A transaction NEAR signs for chain 8453 is valid on Base mainnet.
- **The relay never broadcasts to Base mainnet.** `app/deploy.ts` writes no `.env`; never give `app/relay.ts`
  an `EVM_RPC` on Base mainnet for this guard.
- **No agent armed.** Never call `set_bounds`, `set_token_cap` or `register_agent` on it; `app/setup.ts`,
  `demo.sh` and `check-mainnet.sh` are testnet tools (`setup.ts` refuses mainnet).
- **The owner signs nothing on Base.** `sell`, `withdraw_eth` and `sign_replacement` each have NEAR sign a
  Base mainnet transaction: never call them on this guard.

## Sources

| Value                                                      | Source                                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPC signer `v1.signer` (testnet `v1.signer-prod.testnet`)  | NEAR docs, `chain-abstraction/chain-signatures/implementation.mdx`; on chain, both run the same code (hash `CpGX8ywX…PERJ`), so the guard's `sign` call is unchanged |
| Derivation, `derived_public_key`                           | `near/mpc`: `crates/near-mpc-crypto-types/src/kdf.rs`, `crates/contract/src/api/keys.rs`; checked against `v1.signer` (`app/derive.test.ts`)                         |
| RPC `https://free.rpc.fastnear.com`                        | NEAR docs, `api/rpc/providers.mdx` (FastNEAR, mainnet)                                                                                                               |
| Explorer `https://nearblocks.io`                           | NEAR docs, `chain-abstraction/chain-signatures.mdx`                                                                                                                  |
| Storage price, account creation charge, gas purchase price | mainnet `EXPERIMENTAL_protocol_config` (protocol 88); nearcore `docs/RuntimeSpec/Fees/Fees.md`                                                                       |
