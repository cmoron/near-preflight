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
export GUARD=guard.goblin-guard-69369.testnet
INDEX_RPC=https://base-rpc.publicnode.com bun app/replay.ts app/fixtures/usdc-base-mainnet.json https://mainnet.base.org --check
#   43 OK lines, then: REPLAY OK: verdict allow confirmed, same as on chain
bun app/attest.ts app/fixtures/decision.json --check 1
#   ATTEST OK: 15 checks hold (1 not verified, see SKIPPED)
```

- `replay` resends check #28 (USDC on Base mainnet) to `mainnet.base.org`, traces it on throwaway anvil
  forks, mines its far sales there again, rebuilds its template index from `INDEX_RPC` (a node that
  serves logs), rejudges it and compares everything with the guard
  ([what it checks](replay.md#what-replay-recomputes)).
- `attest` verifies the model's decision behind check #1; it calls Intel and NVIDIA
  ([what it checks](replay.md#what-attest-verifies)).

Then every trap on a local Base fork, as CI runs it:

```sh
echo GUARD=$GUARD > .env && evm/fork.sh    # Base fork at block 55836672 ready on http://127.0.0.1:8545 (about 30 s)
bun test --timeout 30000                   # in another terminal: 350 pass, 0 fail (6 to 7 min)
```

`evm/fork.sh` starts anvil on a copy of Base at block 55,836,672 and deploys the demo tokens at fixed
addresses ([`evm/tokens.json`](../evm/tokens.json)); `guard_frozen` freezes the guard's derived address,
read from `GUARD`. The sentinel and replay also start throwaway anvil forks of their own. None keeps
block states on disk (`--prune-history`), and each removes its directory when it stops.

The fork mines nothing on its own, while a check waits for real blocks (its reference block, then the
later side's). Each test mines them, a second apart (Base mines five a second, but anvil's
`eth_simulateV1` refuses blocks that share a timestamp) with other users' WETH and ETH transfers, then
reverts the fork; `demo.sh` mines one a second (`bun app/testkit.ts live`).

## Full demo

1. **Build and test the contract.** `cargo test` gives `295 passed`; then `bun install`.
2. **Get a testnet account** holding about 8 NEAR (setup moves 7.1 NEAR). The faucet gives 10:
   `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`.
   If it fails, see [troubleshooting](#troubleshooting).
3. **Deploy.** `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard
   and creates `agent.`, `agent2.`, `sentinel.`, `sentinel2.` and `armer.`, each with a function-call key
   limited to the guard. An `allow` takes both sentinels' votes; the armer, a key apart from the agent's,
   opens the agent's armed budget.
4. **Fork and test.** `evm/fork.sh` in another terminal, then `bun test --timeout 30000` (`350 pass`) and
   `bunx tsc --noEmit` (exit 0).
5. **Run the demo.** `./demo.sh` exits 0 in 3 to 5 min (255 and 290 s with the live model, measured with one sentinel; each check waits for Base blocks and for both votes), in four moments:
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
   `./demo.sh --full` (697 s here, the fork's upstream node timing out twice) adds an exit, a `warn` the owner approves, a trap aimed at the guard's
   address, a second agent refused the token the first one's check got quarantined, three concurrent
   model runs, the emergency stop and a withdrawal.
8. **Real Base.** `./check-mainnet.sh`, below.

The journal reads any guard: `https://cmoron.github.io/near-preflight/journal.html?guard=guard.<you>.testnet`.

## Real Base

`./check-mainnet.sh` exits 0 in about a minute and a half (68 s here, with both sentinels; longer when
its pool trades during the wait). The armer arms; each sentinel simulates USDC on Base mainnet (read
only, nothing broadcast) on its own nodes, traces it on an anvil forked from its node, builds the
template index over the 2 h before the check's block, waits for the later side's block and posts its
vote. Then the armer disarms the agent, and the first sentinel's proof is replayed with `--check`.

- **The nodes.** The first sentinel simulates on `mainnet.base.org` and reads logs from
  `base.public.blockpi.network` (`INDEX_RPC`: `mainnet.base.org` refuses `eth_getLogs`); the second reads
  `base-rpc.publicnode.com` for both (`EVM_RPC_2`, `INDEX_RPC_2`). Each logs node must give the check's
  block and the index window's start the hashes its simulation node gives them. A real deployment gives
  each sentinel its own machine and providers no other sentinel reads, in the same variables. On the local
  fork both read the fork. Each proof names its nodes (`nodes`), and the script prints them.
- **The index.** Here each sentinel built the same one (blocks 56,623,006 to 56,659,002, same sha256)
  in 52 requests, 3.0 and 3.9 s.
- **The verdict is `allow`**, from both sentinels: USDC's pool held 0.5 ETH before the window, so
  reputation is "not applied", a note. When USDC/WETH trades during the wait, the trades are re-executed
  after the buy, or a second reason says the resale was not verified, a `warn`
  ([sentinel](sentinel.md#others-trades-during-the-wait)).
- **Nothing is signed.** The script never calls `buy`, and it disarms the agent once the verdict is in:
  `buy` needs an armed budget, so the guard signs no swap for that `allow`. The guard's Base address
  holds no ETH on mainnet.
- **The proof.** Check #28's ships as `app/fixtures/usdc-base-mainnet.json` (nobody traded its pool
  during its wait; its far sales ran 301 s, 831 s and 900 s after the buy). Both sentinels posted that
  very evidence string, from three providers: the one file is the proof of both votes.

To build an index by hand: `bun app/index.ts <rpc> <from> <to> <out.json> --pace-ms 1000`. The
measurements are in [sentinel](sentinel.md#measured-on-real-base).

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Faucet: `429 Too Many Requests`                  | it rate-limits by IP. A failed call leaves `~/.near-credentials/testnet/<you>.testnet.json` and the folder `<you>.testnet/` beside it: delete both before retrying.                                                                        |
| No faucet at all                                 | create the account from any account holding 7.5 NEAR: `near account create-account fund-myself <you>.testnet '7.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <funded>.testnet network-config testnet sign-with-keychain send` |
| A role or `replay --check` fails on `429 Rate limits exceeded` | the NEAR RPC limits your IP. Every role, `replay --check` and `attest --check` wait out a 429 (1 s, doubling up to 64 s: about 2 min) and send the same request again; past that, wait a few minutes or read another endpoint: `NEAR_RPC=https://rpc.testnet.near.org bun app/replay.ts … --check` |
| `Not enough allowance for access key`            | the role's gas allowance is spent: replace its key ([contract](contract.md#roles-and-keys))                                                                                                                                                |
| `port 8545 already serves a node: stop it first` | another anvil runs: stop it before `evm/fork.sh`                                                                                                                                                                                           |
| `../.env missing`                                | `evm/fork.sh` needs `GUARD` in `.env` (or `GUARD_EVM`)                                                                                                                                                                                     |
| `transaction differs from the one simulated`     | another signature or a gas change happened since the verdict: request a new check                                                                                                                                                          |
| `verdict expired`                                | more than 120 s since the verdict: request a new check                                                                                                                                                                                     |
| `./demo.sh` was interrupted                      | run it again: a check it left pending is not judged by the new sentinels (they vote only on checks requested since they started); the demo waits out its 300 s |
| `target is quarantined after a block verdict`    | a check blocked that token less than 30 min ago: wait, or the owner lifts it (`app/human.ts lift <token>`)                                                                                                                                |
| `a check of this target is already awaiting its verdict` | one check per token at a time, for all agents: wait for its verdict (at most 300 s)                                                                                                                                              |
| `check requested more than 180 s ago`            | the verdict came late or the buy waited: request a new check                                                                                                                                                                               |
| A check never gets a verdict                     | a sentinel is not running (an `allow` takes both), or its key's allowance is spent; after 300 s, `refund_check`                                                                                                                            |

## Deployment

| Fact       | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| Guard      | `guard.goblin-guard-69369.testnet`                            |
| Source     | `src/` at commit `62f0a49`                             |
| Build      | `cargo near build non-reproducible-wasm`, near-sdk 5          |
| Wasm       | 387,314 bytes, sha256 `0fdc4f6a…89d1`, the code hash on chain |
| Sentinels  | `sentinel.` and `sentinel2.goblin-guard-69369.testnet`, quorum 2 of 2 |
| MPC signer | `v1.signer-prod.testnet`, derivation path `evm-1`             |

Check the code hash yourself: `view_account` on the guard returns it in base58; decoded, it is the
wasm's sha256.

### Rebuild the deployed wasm

The wasm names the commit it was built from (NEP-330), so its hash belongs to that commit. Read it on chain,
check it out, rebuild it in the Docker image `Cargo.toml` pins by digest (`sourcescan/cargo-near`, Rust 1.98.1):

```sh
near contract call-function as-read-only guard.goblin-guard-69369.testnet contract_source_metadata json-args {} network-config testnet now
#   build_info.source_code_snapshot: git+https://github.com/cmoron/near-preflight?rev=<commit>
git checkout <commit> && cargo near build reproducible-wasm    # about 35 s here, plus the image pull (500 MB)
#   SHA-256 checksum hex : <hash, filled in after the final deployment>
near account view-account-summary guard.goblin-guard-69369.testnet network-config testnet now
#   Local Contract (SHA-256 checksum hex)  <the same hash>
```

The build ignores uncommitted changes. Two clones of one commit, in two directories, gave the same wasm.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs on every push to `main`: `cargo fmt`,
`clippy`, `cargo test`, `bunx tsc --noEmit`, then the fork and `bun test`.

The public pages open on `docs/snapshot.json`, then read only what changed: regenerate it with `bun app/snapshot.ts docs/snapshot.json` after a demo run (`demo.sh` does it) or a redeploy, and commit it.
