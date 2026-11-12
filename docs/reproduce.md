# Reproduce

Everything the README claims, step by step. Times and outputs below were measured on 2026-11-12.

## Contents

- [Prerequisites](#prerequisites)
- [Without an account](#without-an-account)
- [Full demo](#full-demo)
- [Real Base](#real-base)
- [Troubleshooting](#troubleshooting)
- [Deployment](#deployment)

## Prerequisites

| Tool                               | Version | Needed for                                                |
| ---------------------------------- | ------- | --------------------------------------------------------- |
| `bun`                              | 1.4     | everything off-chain                                      |
| Foundry (`anvil`, `forge`, `cast`) | 1.8     | the local Base fork, and the trace in sentinel and replay |
| `jq`                               | any     | `evm/fork.sh`, `demo.sh`                                  |
| Rust with `cargo-near`             | 0.23    | building and testing the contract                         |
| `near` CLI                         | 0.31    | creating a testnet account                                |

## Without an account

No NEAR account, no key: `GUARD` only names the contract to read.

```sh
git clone https://github.com/cmoron/near-preflight && cd near-preflight && bun install
export GUARD=guard.goblin-guard-13713.testnet
bun app/replay.ts app/fixtures/usdc-base-mainnet.json https://mainnet.base.org --check
#   33 OK lines, then: REPLAY OK: verdict warn confirmed, same as on chain
bun app/attest.ts app/fixtures/decision.json --check 1
#   ATTEST OK: 15 checks hold (1 not verified, see SKIPPED)
```

- `replay` resends check #64 (USDC on Base mainnet) to `mainnet.base.org`, traces it on a throwaway anvil
  fork, rejudges it and compares everything with the guard ([what it checks](replay.md#what-replay-recomputes)).
- `attest` verifies the model's decision behind check #1; it calls Intel and NVIDIA
  ([what it checks](replay.md#what-attest-verifies)).

Then every trap on a local Base fork, as CI runs it:

```sh
echo GUARD=$GUARD > .env && evm/fork.sh    # Base fork at block 55836672 ready on http://127.0.0.1:8545 (about 1 min)
bun test --timeout 30000                   # in another terminal: 273 pass, 0 fail (about 13 min)
```

`evm/fork.sh` starts anvil on a copy of Base at block 55,836,672 and deploys the demo tokens at fixed
addresses ([`evm/tokens.json`](../evm/tokens.json)); `guard_frozen` freezes the guard's derived address,
read from `GUARD`. The sentinel and replay also start throwaway anvil forks of their own.

The fork mines nothing on its own, while a check waits for real blocks (its reference block, then the
later side's). Each test mines them, 2 s apart with other users' WETH and ETH transfers, then reverts the
fork; `demo.sh` mines one every 2 s (`bun app/testkit.ts live`).

## Full demo

1. **Build and test the contract.** `cargo test` gives `249 passed`; then `bun install`.
2. **Get a testnet account** holding about 7 NEAR (setup moves 6.35 NEAR). The faucet gives 10:
   `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`.
   If it fails, see [troubleshooting](#troubleshooting).
3. **Deploy.** `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard
   and creates `agent.`, `agent2.`, `sentinel.` and `armer.`, each with a function-call key limited to the
   guard. The armer, a key apart from the agent's, opens the agent's armed budget.
4. **Fork and test.** `evm/fork.sh` in another terminal, then `bun test --timeout 30000` (`273 pass`) and
   `bunx tsc --noEmit` (exit 0).
5. **Run the demo.** `./demo.sh` exits 0 in about 3 min (180 s here; each check waits for Base blocks), in four moments:
   - a poisoned inbox message pushes the agent to a trap: `BLOCK (sale refused N blocks after the buy …)`,
     and the contract refuses the buy (`verdict does not allow the purchase`);
   - a farm token whose simulation is clean: `BLOCK (template 0x9c69..94c8: 5 of 5 earlier pools drained …)`;
   - USDC: `ALLOW`, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it to the
     fork, `receipt status 1`;
   - the agent bypasses its wrapper, and every attempt fails ([agent bypasses](threat-model.md#agent-bypasses)).
6. **Verify the run.** The demo prints this run's `app/replay.ts … --check` and `app/attest.ts … --check`
   commands; each exits 0.
7. **Optional.** With `NEAR_AI_API_KEY=...` in `.env.llm` ([cloud.near.ai](https://cloud.near.ai)), moment 1
   runs the live model (0.0003 USD here); without it, a recorded decision is verified.
   `./demo.sh --full` (213 s here) adds an exit, a `warn` the owner approves, a trap aimed at the guard's
   address, a second agent, three concurrent model runs, the emergency stop and a withdrawal.
8. **Real Base.** `./check-mainnet.sh`, below.

The status page reads any guard: `https://cmoron.github.io/near-preflight/?guard=guard.<you>.testnet`.

## Real Base

`./check-mainnet.sh` exits 0 in about 23 s. The armer arms; the sentinel simulates USDC on Base mainnet
(`mainnet.base.org`, read only, nothing broadcast), traces it on an anvil forked from it and posts the
verdict; then the proof is replayed with `--check`.

The verdict is `warn`, and its only reason is the unknown reputation: there is no template index for
mainnet. That run's proof ships as `app/fixtures/usdc-base-mainnet.json`.

To build an index, use a node that serves `eth_getLogs` (`mainnet.base.org` does not):
`bun app/index.ts <rpc> <from> <to> <out.json> --pace-ms 1000`. The one-day measurement is in
[sentinel](sentinel.md#measured-on-real-base).

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faucet: `429 Too Many Requests`                  | it rate-limits by IP. A failed call leaves `~/.near-credentials/testnet/<you>.testnet.json` and the folder `<you>.testnet/` beside it: delete both before retrying.                                                                        |
| No faucet at all                                 | create the account from any account holding 7.5 NEAR: `near account create-account fund-myself <you>.testnet '7.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <funded>.testnet network-config testnet sign-with-keychain send` |
| A role logs `429 Rate limits exceeded`           | the NEAR RPC is limiting your IP: wait a few minutes                                                                                                                                                                                       |
| `Not enough allowance for access key`            | the role's gas allowance is spent: replace its key ([contract](contract.md#roles-and-keys))                                                                                                                                                |
| `port 8545 already serves a node: stop it first` | another anvil runs: stop it before `evm/fork.sh`                                                                                                                                                                                           |
| `../.env missing`                                | `evm/fork.sh` needs `GUARD` in `.env` (or `GUARD_EVM`)                                                                                                                                                                                     |
| `transaction differs from the one simulated`     | another signature or a gas change happened since the verdict: request a new check                                                                                                                                                          |
| `verdict expired`                                | more than 120 s since the verdict: request a new check                                                                                                                                                                                     |
| A check never gets a verdict                     | the sentinel is not running, or its key's allowance is spent; after 300 s, `refund_check`                                                                                                                                                  |

## Deployment

| Fact       | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| Guard      | `guard.goblin-guard-13713.testnet`                            |
| Source     | `src/` at commit `d832e22` (unchanged since)                  |
| Build      | `cargo near build non-reproducible-wasm`, near-sdk 5          |
| Wasm       | 361,064 bytes, sha256 `35bbcc91…f52d`, the code hash on chain |
| MPC signer | `v1.signer-prod.testnet`, derivation path `evm-1`             |

Check the code hash yourself: `view_account` on the guard returns it in base58; decoded, it is the
wasm's sha256.

A rebuild on another machine may differ. `cargo near build reproducible-wasm` works here (Docker), but
its metadata names the git commit it was built from, so it can be published only from a pushed commit.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs on every push to `main`: `cargo fmt`,
`clippy`, `cargo test`, `bunx tsc --noEmit`, then the fork and `bun test`.
