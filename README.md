<p align="center">
  <img src="docs/assets/banner.svg" alt="near-preflight. Test the resale before the buy. NEAR signs only what was checked." width="800">
</p>

# near-preflight

[![ci](https://github.com/cmoron/near-preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/cmoron/near-preflight/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![live on NEAR testnet](https://img.shields.io/badge/live-NEAR%20testnet-00c08b.svg)](https://cmoron.github.io/near-preflight/)

A spending cap stops an agent from spending too much. It does not stop a prompt-injected agent from spending a little on a trap.

Before NEAR signs any purchase, three sentinels simulate the buy and its resales, check that the token's own code reads no clock and calls no other contract then, and whether it drained pools before; anyone can replay their verdict.

The agent holds no key for Base, the chain it buys on: the contract builds the transaction and NEAR signs it, within bounds: two of the three sentinels must agree, a `block` on its code quarantines the token for every agent, each token has a cap.

Perimeter today: Uniswap V2 WETH pools on Base; NEAR testnet; in the demo the three sentinels run on one machine.

**Give this to your agent.** To set up your own guard on NEAR testnet and make an agent buy through it, paste this to your coding agent:

```text
Read https://raw.githubusercontent.com/cmoron/near-preflight/main/docs/agent-guide.md and guide me through it step by step. Ask me before anything that creates an account, signs or spends.
```

## One purchase

<p align="center"><img src="docs/assets/flow.svg" alt="One purchase, read left to right. Outside near-preflight, dashed: the AI agent (untrusted, no key for Base), NEAR Chain Signatures and the Base blockchain. Inside the green near-preflight frame: the guard contract on NEAR, three sentinels and the proof anyone can replay. 1: the agent asks the guard to check a token and an amount. 2: each sentinel simulates the buy and the resale on Base. 3: each posts its vote to the guard; an allow takes two matching votes of three. 4: Chain Signatures signs the swap the guard built. Then anyone can broadcast the signed swap to Base, no key needed." width="830"></p>

1. **Asked.** The AI agent asks the guard to check a token and an amount. It is untrusted: a prompt injection may be steering it.
2. **Simulated.** Each sentinel reads the request and simulates on Base the buy the guard would sign, then the resale.
3. **Verdict stored.** Three sentinels each vote `allow`, `warn` or `block`, with the sha256 of their evidence: `allow` and `warn` take two matching votes, one `block` is enough.
4. **Signed by NEAR.** On a fresh `allow` the agent buys, naming no route or recipient: the guard builds the simulated swap and Chain Signatures signs it.

Anyone can then broadcast the signed swap, no key needed; the code calls that broadcaster the **relay**. In the demo it goes to a local fork of Base.

The green frame is near-preflight: the **guard** is the NEAR contract, the **sentinels** are off-chain programs the guard's owner appoints (three in the demo), each with a NEAR key that can only vote on checks. **Chain Signatures**, NEAR's threshold signing network, signs for the guard's Base address.

Do not trust it blindly: anyone can [replay](docs/replay.md) a verdict, and the [threat model](docs/threat-model.md#a-lying-sentinel) says what a lying sentinel can still do.

## Why

- **A cap does not judge the token.** It bounds how much an agent spends, not on what; an allowlist judges only tokens someone already listed.
- **The traps are real.** On Base on 2026-11-11, 24 of the 29 token/WETH pools opened on Uniswap V2 in 2.4 h were drained a median 13 min after funding; all 29 tokens shared one code template ([measurement](docs/sentinel.md#measured-on-real-base)).
- **Measured on 96 real launches.** Checked as they stood 64 s after launch, none got `allow`. Of the 81 that ended badly within 24 h, 73 were blocked, all of one farm by its template's history, and 8 got `warn` ([corpus](docs/corpus.md)).
- **What that means.** The check stops losses written in a token's code, and repeat farms; the first is shown on the project's trap tokens only, as the real launches held no code honeypot. It does not tell an honest fresh launch from one whose liquidity will be pulled: both get `warn`, and the owner decides.
- **Every step can be checked.** NEAR signs only the transaction the sentinel simulated, the agent never picks route, recipient or minimum output, and anyone can re-derive a verdict.

## Verify it yourself

No NEAR account, no key: about a minute without a fork, six more for the trap tests. You need `bun` 1.4, Foundry 1.8 and `jq`; a **fork** below is a local copy of Base run by Foundry's anvil.

First, the [status page](https://cmoron.github.io/near-preflight/journal.html) lists every check of the demo guard and its verdict.

<a href="https://cmoron.github.io/near-preflight/journal.html"><img src="docs/assets/status-page.png" alt="The top of the status page: the verdicts so far, and the four steps of the latest purchase NEAR signed, each step a lit lamp." width="600"></a>

```sh
git clone https://github.com/cmoron/near-preflight && cd near-preflight && bun install
export GUARD=guard.goblin-guard-17826.testnet   # the demo guard on NEAR testnet, read only

# Check #19 (USDC on Base mainnet): resent, traced and its far sales mined on a local fork, its template index rebuilt, re-judged, compared with NEAR
INDEX_RPC=https://base-rpc.publicnode.com bun app/replay.ts app/fixtures/usdc-base-mainnet.json https://mainnet.base.org --check
#   REPLAY OK: verdict allow confirmed, same as on chain

# The model's decision behind check #10: signature, Intel and NVIDIA attestation, the guard's record
bun app/attest.ts app/fixtures/decision.json --check 10
#   ATTEST OK: 15 checks hold (1 not verified, see SKIPPED)

# Every trap below, on a local Base fork, as CI runs it (about 30 s, then 6 min)
echo GUARD=$GUARD > .env && evm/fork.sh   # then, in another terminal:
bun test --timeout 30000                  #   355 pass, 0 fail
```

`INDEX_RPC` serves the logs the template index is rebuilt from; `mainnet.base.org` refuses them.

## What it stops

| Attack                                                                                  | Verdict                                   | Details                                                          |
| --------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| A token you can buy but never sell                                                      | 🔴 block, listed                          | [honeypot](docs/threat-model.md#sale-refused-after-the-buy)      |
| The token's owner takes tokens back without approval                                    | 🔴 block, listed                          | [takeback](docs/threat-model.md#the-owner-takes-tokens-back)     |
| A clean copy of code whose earlier pools were drained                                   | 🔴 block                                  | [farm](docs/threat-model.md#template-farm)                       |
| A token that sells only in a simulation, or only at the sizes and delays a check tries  | 🔴 block, listed                          | [tells](docs/threat-model.md#telling-the-check-from-a-real-sale) |
| A token keyed on WETH or the factory, or that fails on a later Base block               | 🔴 block                                  | [state](docs/threat-model.md#state-base-moves-every-block)       |
| Code that reads values no simulation can match (base fee, coinbase…)                    | 🟠 warn; 🔴 block once the base fee moved | [opcodes](docs/threat-model.md#values-no-simulation-can-match)   |
| A token whose own code reads the time or its pool, to change after the check            | 🟠 warn, the owner decides                | [own code](docs/threat-model.md#what-the-tokens-own-code-did)    |
| A prompt-injected agent changes the route, recipient or minimum output                  | 🔴 ignored: NEAR signs what was simulated | [bypasses](docs/threat-model.md#agent-bypasses)                  |
| One stolen sentinel key, or a Base node only one sentinel reads, says `allow` on a trap | 🔴 no allow: it takes two of the three    | [quorum](docs/threat-model.md#a-lying-sentinel)                  |
| An honest token: USDC on the fork, or read only on Base mainnet                         | 🟢 allow; on the fork NEAR signs the swap | [honest](docs/threat-model.md#honest-tokens)                     |

**Listed**: put on the guard's shared blocklist, refused to every agent. Each link gives the exact reason and the test that shows it.

## What it does not stop

- **Two of the three sentinels lying.** One alone never allows: it can block a buy, or [spoil an exit](docs/threat-model.md#a-lying-sentinel) while another is down. In the demo all run on one machine, each on its own nodes on Base (on the fork, the fork): three keys, not three parties. Replay shows a lie afterwards.
- **What a token does later.** A pause, tax or blacklist after the buy; a change past the check's last sale, 15 min after the buy, by code that read neither the time nor its pool during the check.
- **Asking again, later.** A `block` on the token's code [quarantines](docs/contract.md#token-limits) it for 30 min, for every agent; a `warn` or a split vote does not. Then an agent may ask again, with new draws.
- **A rug by liquidity removal.** On a token that sells normally: `warn` (removable liquidity) at best, `block` only when its code template has drained pools before.
- **What no code shows.** A holder of most of the supply can sell into the pool; liquidity older than one hour is not read; each sentinel believes the Base node it reads.
- **Same-second entries.** A verdict takes about 30 s on Base, 20 s of them a deliberate wait for a later block; NEAR's signature takes 6 s more ([latency, and whom it fits](docs/latency.md)).
- **Front-running.** The signing request is public on NEAR before the swap reaches Base.
- **Template evasion.** Changing the code makes a new template; fewer than 3 earlier pools give no finding.
- **Other pools.** Only Uniswap V2 WETH pools on Base are checked and bought today, where copy-paste trap launches concentrate; Uniswap V3 and V4 pools are not supported yet.

> [!WARNING]
> Never send funds to the guard's address on Base mainnet. A transaction NEAR signs for chain 8453 is valid there; this demo broadcasts only to a local fork.

Every limit, with its reason: [threat model](docs/threat-model.md#what-it-does-not-stop).

## Run the full demo

<details>
<summary>Eight steps with a NEAR testnet account</summary>

1. Install Rust with `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8 and `jq`. `cargo test` gives `354 passed`; then `bun install`.
2. Get a testnet account holding about 8 NEAR. The faucet gives 10; if it answers `429`, see [troubleshooting](docs/reproduce.md#troubleshooting).
3. `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard and creates the agent, armer and three sentinel accounts, each with a key limited to the guard.
4. `evm/fork.sh` in another terminal, then `bun test --timeout 30000`: `355 pass`.
5. `./demo.sh` exits 0 in about 7 min (each check takes 20 to 55 s on the fork): a poisoned message pushes the agent to a trap (blocked), a farm copy (blocked), USDC (allowed, signed by NEAR, broadcast to the fork), then the agent's bypasses (refused).
6. It prints this run's `replay --check` and `attest --check` commands; each exits 0.
7. Optional: `NEAR_AI_API_KEY` in `.env.llm` runs the live model; `./demo.sh --full` adds an exit, an approved `warn`, a second agent and the emergency stop.
8. `./check-mainnet.sh` exits 0 in a minute and a half: USDC simulated on Base mainnet by each sentinel on its own nodes, read only, `allow`, then replayed; nothing is signed.

Expected output of each step and the deployment facts: [reproduce](docs/reproduce.md).

</details>

## Documentation

The [docs index](docs/README.md): architecture, threat model, contract, sentinel, replay, reproduction, glossary.

## Disclosure

Written from 2026-11-11 for the NEAR Hackathon, track AI Security & Defense, in a new repository.

Our team has run trading agents with real money on an EVM chain; the traps and the template-reputation method come from those losses. No code, strategy, wallet, address list or account from that work is reused or published.

Libraries: near-sdk, omni-transaction (Rust), near-api-js, viem, @phala/dcap-qvl-node (TypeScript), Foundry. Agent model: `z-ai/glm-5.3-flash` on NEAR AI Cloud.

Code written with AI assistance (Claude Code). License: MIT.
