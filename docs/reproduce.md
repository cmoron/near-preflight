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
| Rust 1.98 with `cargo-near`        | 0.23    | building and testing the contract                         |
| Docker                             | any     | only to rebuild the deployed wasm byte for byte           |
| `near` CLI                         | 0.31    | creating a testnet account                                |

## Without an account

No NEAR account, no key: `GUARD` only names the contract to read.

```sh
git clone https://github.com/cmoron/near-preflight && cd near-preflight && bun install
export GUARD=guard.goblin-guard-17826.testnet
INDEX_RPC=https://base-rpc.publicnode.com bun app/replay.ts app/fixtures/usdc-base-mainnet.json https://mainnet.base.org --check
#   43 OK lines, then: REPLAY OK: verdict allow confirmed, same as on chain
bun app/attest.ts app/fixtures/decision.json --check 10
#   ATTEST OK: 15 checks hold (1 not verified, see SKIPPED)
```

- `replay` resends check #19 (USDC on Base mainnet) to `mainnet.base.org`, traces it on throwaway anvil
  forks, mines its far sales there again, rebuilds its template index from `INDEX_RPC` (a node that
  serves logs), rejudges it and compares everything with the guard
  ([what it checks](replay.md#what-replay-recomputes)).
- `attest` verifies the model's decision behind check #10; it calls Intel and NVIDIA
  ([what it checks](replay.md#what-attest-verifies)).

Then every trap on a local Base fork, as CI runs it:

```sh
echo GUARD=$GUARD > .env && evm/fork.sh    # Base fork at block 55836672 ready on http://127.0.0.1:8545 (about 30 s)
bun test --timeout 30000                   # in another terminal: 355 pass, 0 fail (5 to 7 min)
```

`evm/fork.sh` starts anvil on a copy of Base at block 55,836,672 and deploys the demo tokens at fixed
addresses ([`evm/tokens.json`](../evm/tokens.json)); `guard_frozen` freezes the guard's derived address,
read from `GUARD`. The sentinel and replay also start throwaway anvil forks of their own. None keeps
block states on disk (`--prune-history`), and each removes its directory when it stops. When no anvil is
running, `evm/fork.sh` first deletes the `anvil-state-*` directories stopped anvils left in
`~/.foundry/anvil/tmp` (10 GB and more each).

The fork mines nothing on its own, while a check waits for real blocks (its reference block, then the
later side's). Each test mines them, a second apart (Base mines five a second, but anvil's
`eth_simulateV1` refuses blocks that share a timestamp) with other users' WETH and ETH transfers, then
reverts the fork; `demo.sh` mines one a second (`bun app/testkit.ts live`).

## Full demo

What happens where:

| Step                        | `./demo.sh`                         | `./check-mainnet.sh`                 |
| --------------------------- | ----------------------------------- | ------------------------------------ |
| Simulated, read only        | on a local fork of Base             | on Base mainnet                      |
| Votes and verdict stored    | NEAR testnet                        | NEAR testnet                         |
| Swap signed                 | NEAR testnet (Chain Signatures)     | nothing is signed                    |
| Signed swap broadcast       | to the local fork only              | nothing                              |
| Executed on Base mainnet    | nothing                             | nothing                              |

1. **Build and test the contract.** `cargo test` gives `354 passed`; then `bun install`.
2. **Get a testnet account** holding about 8 NEAR (setup moves 7.6 NEAR). The faucet gives 10:
   `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`.
   If it fails, see [troubleshooting](#troubleshooting).
3. **Deploy.** `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard
   and creates `agent.`, `agent2.`, `sentinel.`, `sentinel2.`, `sentinel3.` and `armer.`, each with a
   function-call key limited to the guard. An `allow` takes two of the three sentinels' matching votes;
   the armer, a key apart from the agent's, opens the agent's armed budget. `WASM=<file>` deploys
   another build than `target/near/goblin_near.wasm` (the demo guard: the reproducible one, below).
4. **Fork and test.** `evm/fork.sh` in another terminal, then `bun test --timeout 30000` (`355 pass`) and
   `bunx tsc --noEmit` (exit 0).
5. **Run the demo.** `./demo.sh` exits 0 in about 7 min (415 and 435 s with the live model and three
   sentinels; each check waits for Base blocks and for two matching votes, 20 to 55 s on the fork), in
   four moments:
   - a poisoned inbox message pushes the agent to a trap: `BLOCK (sale refused N s after the buy …)`,
     and the contract refuses the buy (`verdict does not allow the purchase`);
   - a farm token whose simulation is clean: `BLOCK (template 0x9c69..94c8: 5 of 5 earlier pools drained …)`;
   - USDC: `ALLOW`, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it to the
     fork, `receipt status 1`;
   - the agent bypasses its wrapper, and every attempt fails ([agent bypasses](threat-model.md#agent-bypasses)).
6. **Verify the run.** The demo prints this run's `app/replay.ts … --check` and `app/attest.ts … --check`
   commands; each exits 0.
7. **Optional.** With `NEAR_AI_API_KEY=...` in `.env.llm` ([cloud.near.ai](https://cloud.near.ai)), moment 1
   runs the live model (0.0003 USD here); without it, a recorded decision is verified.
   `./demo.sh --full` (620 to 730 s here, 0.0011 USD) adds an exit sold on the median of the three sentinels'
   quotes, a `warn` the owner approves, a trap aimed at the guard's address, a second agent refused the
   token the first one's check got quarantined, three concurrent model runs, the emergency stop and a
   withdrawal. Without the key its printed steps go from 9 to 11: step 10 is the model's own purchase.
   On a fork just started, the first USDC check took 145 s while anvil fetched Base state.
8. **Real Base.** `./check-mainnet.sh`, below.

The journal reads any guard: `https://cmoron.github.io/near-preflight/journal.html?guard=guard.<you>.testnet`.

## Real Base

`./check-mainnet.sh` exits 0 in about a minute and a half (89 s here, with three sentinels; longer when
its pool trades during the wait). The armer arms; each sentinel simulates USDC on Base mainnet (read
only, nothing broadcast) on its own nodes, traces it on an anvil forked from its node, builds the
template index over the 2 h before the check's block, waits for the later side's block and posts its
vote. Then the armer disarms the agent, and the first vote's proof is replayed with `--check`. Where
the 31 s from request to verdict went: [latency](latency.md).

- **The nodes.** The first sentinel simulates on `mainnet.base.org` and reads logs from
  `base.public.blockpi.network` (`INDEX_RPC`: `mainnet.base.org` refuses `eth_getLogs`); the second reads
  `base-rpc.publicnode.com` for both (`EVM_RPC_2`, `INDEX_RPC_2`), the third `base.rpc.blxrbdn.com` for
  both (`EVM_RPC_3`, `INDEX_RPC_3`): four providers, none read by two sentinels. Each logs node must give
  the check's block and the index window's start the hashes its simulation node gives them. A real
  deployment also gives each sentinel its own machine and operator. On the local fork all read the
  fork. Each proof names its nodes (`nodes`), and the script prints them.
- **The index.** Here each sentinel built the same one (blocks 56,650,621 to 56,686,617, same sha256)
  in 52 requests: 2.7, 3.9 and 7.3 s.
- **The verdict is `allow`**, on the first two votes, here the second and third sentinels'; the first's
  same vote came after and was not taken. USDC's pool held 0.5 ETH before the window, so
  reputation is "not applied", a note. When USDC/WETH trades during the wait, the trades are re-executed
  after the buy, or a second reason says the resale was not verified, a `warn`
  ([sentinel](sentinel.md#others-trades-during-the-wait)).
- **Nothing is signed.** The script never calls `buy`, and it disarms the agent once the verdict is in:
  `buy` needs an armed budget, so the guard signs no swap for that `allow`. The guard's Base address
  holds no ETH on mainnet.
- **The proof.** Check #19's ships as `app/fixtures/usdc-base-mainnet.json` (nobody traded its pool
  during its wait; its far sales ran 301 s, 560 s and 900 s after the buy). Both voting sentinels posted
  that very evidence string, from two providers: the one file is the proof of both votes.

To build an index by hand: `bun app/index.ts <rpc> <from> <to> <out.json> --pace-ms 1000`. The
measurements are in [sentinel](sentinel.md#measured-on-real-base).

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faucet: `429 Too Many Requests`                  | it rate-limits by IP. A failed call leaves `~/.near-credentials/testnet/<you>.testnet.json` and the folder `<you>.testnet/` beside it: delete both before retrying.                                                                        |
| No faucet at all                                 | create the account from any account holding 7.5 NEAR: `near account create-account fund-myself <you>.testnet '7.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as <funded>.testnet network-config testnet sign-with-legacy-keychain send` |
| A role or `replay --check` fails on `429 Rate limits exceeded` | the NEAR RPC limits your IP. Every role, `replay --check` and `attest --check` wait out a 429 (1 s, doubling up to 64 s: about 2 min) and send the same request again; past that, wait a few minutes or read another endpoint: `NEAR_RPC=https://rpc.testnet.near.org bun app/replay.ts … --check` |
| `Not enough allowance for access key`            | the role's gas allowance is spent: replace its key ([contract](contract.md#roles-and-keys))                                                                                                                                                |
| `port 8545 already serves a node: stop it first` | another anvil runs: stop it before `evm/fork.sh`                                                                                                                                                                                           |
| `../.env missing`                                | `evm/fork.sh` needs `GUARD` in `.env` (or `GUARD_EVM`)                                                                                                                                                                                     |
| `transaction differs from the one simulated`     | another signature or a gas change happened since the verdict: request a new check (for an exit, the wrapper asks a new quote itself, three at most)                                                                                                                                                          |
| `verdict expired`                                | more than 120 s since the verdict: request a new check                                                                                                                                                                                     |
| `./demo.sh` was interrupted                      | run it again: a check it left pending is not judged by the new sentinels (they vote only on checks requested since they started); the demo waits out its 300 s |
| `target is quarantined after a block verdict`    | a check blocked that token less than 30 min ago: wait, or the owner lifts it (`app/human.ts lift <token>`)                                                                                                                                |
| `a check of this target is already awaiting its verdict` | one check per token at a time, for all agents: wait for its verdict (at most 300 s)                                                                                                                                              |
| `check requested more than 180 s ago`            | the verdict came late or the buy waited: request a new check                                                                                                                                                                               |
| A check never gets a verdict                     | two sentinels are not running (an `allow` takes two votes of three), or their keys' allowance is spent; after 300 s, `refund_check`                                                                                                                            |

## Deployment

| Fact       | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| Guard      | `guard.goblin-guard-17826.testnet`                            |
| Source     | `src/` at commit `22e5c32`, the one the wasm names            |
| Build      | `cargo near build reproducible-wasm`, near-sdk 5              |
| Wasm       | 401,767 bytes, sha256 `3c5b992f…372f`, the code hash on chain |
| Sentinels  | `sentinel.`, `sentinel2.` and `sentinel3.goblin-guard-17826.testnet`, quorum 2 of 3 |
| MPC signer | `v1.signer-prod.testnet`, derivation path `evm-1`             |

Check the code hash yourself: `view_account` on the guard returns it in base58; decoded, it is the
wasm's sha256.

### Rebuild the deployed wasm

The wasm names the commit it was built from (NEP-330), so its hash belongs to that commit. Read it on chain,
check it out, rebuild it in the Docker image `Cargo.toml` pins by digest (`sourcescan/cargo-near`, Rust 1.98.1):

```sh
near contract call-function as-read-only guard.goblin-guard-17826.testnet contract_source_metadata json-args {} network-config testnet now
#   build_info.source_code_snapshot: git+https://github.com/cmoron/near-preflight?rev=22e5c32ad5387189eee7575ce00c6938ff253dc2
git checkout 22e5c32 && cargo near build reproducible-wasm    # 36 and 40 s here, plus the image pull (500 MB)
#   SHA-256 checksum hex : 3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f
near account view-account-summary guard.goblin-guard-17826.testnet network-config testnet now
#   Local Contract (SHA-256 checksum hex)  3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f
```

Run it in a plain clone, not in a worktree nested in another repository. The build ignores uncommitted
changes. Two clones of that commit, in two directories, gave the same wasm. Later commits change the
off-chain code and these pages, not `src/`: the guard names the commit its wasm was built from.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs on every push to `main`: `cargo fmt`,
`clippy`, `cargo test`, `bunx tsc --noEmit`, then the fork and `bun test`.

Coverage, measured at commit `22e5c32` with `cargo llvm-cov` (cargo-llvm-cov 0.9.1): 98.4 % of
`src/lib.rs`'s lines, its test module included; for the contract code above that module, 95.1 % of lines
(1,503 of 1,581, from the lcov report).

The public pages open on `docs/snapshot.json`, then read only what changed: regenerate it with `bun app/snapshot.ts docs/snapshot.json` after a demo run (`demo.sh` does it) or a redeploy, and commit it.
