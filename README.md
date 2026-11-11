# goblin-near: a spending guard and a pre-buy sentinel for AI agents, purchases signed by NEAR

NEAR Hackathon, track **AI Security & Defense**.

- The agent buys only through a NEAR contract (the guard). Its key can call nothing else, and it holds no EVM key.
- Before a token purchase, a sentinel simulates buy and sales read-only on Base (`eth_simulateV1`) and posts `allow`, `warn` or `block`, the sha256 of its evidence and its quote (tokens received for 0.01 ETH).
- On `allow`, the guard builds the Base transaction itself (Uniswap V2 swap WETH -> the checked token, tokens to the guard's own address, minimum from the quote) and has it signed by NEAR Chain Signatures. A relay with no key broadcasts it.
- Anyone can replay a proof against a Base node and check it against the verdict and quote stored on NEAR.

Deployed on testnet: `guard.goblin-guard-35811.testnet` (source `src/lib.rs`, near-sdk 5, wasm 232,940 bytes, code sha256 `34f0870f…20c7`, equal to the local build).
It signs through `v1.signer-prod.testnet`, path `evm-1`; its EVM address is `0x914E3A1A426faCf1F6d145337392c75220506b0A`.

## What NEAR enforces

| Rule                                                                                                                                                                                                 | Enforced by                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Agent key: only `request_check`, `buy`, `refund_check` on the guard; no transfer, no deposit, no call to the MPC                                                                                     | NEAR protocol (function-call key)             |
| Armer key: only `arm`, `disarm` on the guard                                                                                                                                                         | NEAR protocol (function-call key)             |
| A purchase only on a sentinel `allow` for that request, once, at most 120 s after the verdict                                                                                                        | `buy`                                         |
| The guard builds the transaction: chain id 8453, router, WETH, path [WETH, checked token], recipient = its address, nonce, gas (250,000) and fees (0.05 / 0.001 gwei) set by the contract or at init | `buy`                                         |
| Minimum output = sentinel quote scaled to the amount, minus 3 % (owner's bound); deadline 300 s                                                                                                      | `buy`                                         |
| Signature by the MPC for the guard's account and a fixed path: the EVM key belongs to the guard, not to the agent                                                                                    | Chain Signatures (`sign` called by the guard) |
| One signature at a time; a failed signature returns credit and budget and leaves the nonce unused; a signed purchase settles the request                                                             | `buy`, `on_signed`                            |
| Only the sentinel posts a verdict, once, with `sha256(evidence)` and a quote, non-zero on `allow`                                                                                                    | `post_verdict`, `get_check`                   |
| Value + max gas in wei, at the owner's fixed rate (1 ETH = 1000 NEAR), come off the armed budget and the credit                                                                                      | `arm`, `buy`                                  |
| Only the armer arms, only registered agents, within the human's bounds: budget per arming, max duration, 7-day rolling cap                                                                           | `set_bounds`, `register_agent`, `arm`         |
| Emergency stop: the human's `disarm` freezes the agent until `unfreeze`; the armer's does not; the human replaces a compromised armer                                                                | `disarm`, `unfreeze`, `set_armer`             |
| Verdict fee refunded if no verdict within 5 min                                                                                                                                                      | `refund_check`                                |

Sentinel checks (`app/verifier.ts`, fresh random buyer and stranger per check): `transferFrom` without approval by `owner()` and by a stranger -> `block`;
sale in the next block and 1 h later -> `block` if it reverts; tax against the pool quote on the buy and both sales -> `warn` from 10 %, `block` from 50 %.
Calls pay the real block's base fee plus a tip, with a 1 M gas limit: a zero gas price does not give the simulation away.

## Try it

Requirements: Rust with `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8, `jq`. No API key.

1. `cargo test` -> `97 passed` (the hash sent to the MPC and the signed transaction equal viem vectors). `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` -> exit 0.
2. `cargo near build non-reproducible-wasm`, then `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`.
3. `bun install && bun app/setup.ts <name>.testnet` -> creates `guard.`, `agent.`, `sentinel.`, `armer.<name>.testnet`, derives the guard's EVM address, deploys and initializes the guard, adds one function-call key per role, deposits 1 NEAR of credit:
   ```text
   derived EVM address of guard.goblin-guard-35811.testnet (path evm-1, signer v1.signer-prod.testnet): 0x914E3A1A426faCf1F6d145337392c75220506b0A
   function-call key of agent.goblin-guard-35811.testnet: guard.goblin-guard-35811.testnet [request_check, buy, refund_check], 0.5 NEAR gas allowance
   ```
4. In another terminal, `evm/fork.sh` -> anvil fork of Base on `127.0.0.1:8545` with USDC and eight demo tokens. `bun test` -> `64 pass`, `0 fail`; `bunx tsc --noEmit` -> exit 0.
5. `./demo.sh` -> exit 0. Each role runs in its own process with its own key; the relay runs with none. Excerpt (ids grow with every run; simulation lines and links cut):
   ```text
   [sentinel] #4 : BLOCK (sale refused 1 h after the buy (TransferHelper: TRANSFER_FROM_FAILED)), quote 995015938219190933279 for 0.01 ETH, block 55836706, proof proofs/4.json
   [contract] buy(#4) of 0.00001 ETH, no signature requested : REFUSED (Contract panicked: verdict does not allow the purchase)
   [protocol] sign on v1.signer-prod.testnet directly : REFUSED (Access key receiver guard.goblin-guard-35811.testnet does not match transaction receiver v1.signer-prod.testnet)
   [sentinel] #5 : ALLOW (buy, takeback probes and sales simulated without anomaly), quote 20434899 for 0.01 ETH, block 55836706, proof proofs/5.json
   [wrapper] #5 : ALLOW, buy of 0.00001 ETH signed by NEAR in 7.9 s (14.8 TGas, 0.0014113206737526 NEAR burnt): 0x02f9015782210502...
   [relay] [fork setup] anvil_setBalance 0x914E3A1A426faCf1F6d145337392c75220506b0A 0.000022500918471228 ETH (value + max gas + 918471228 wei L1 data fee); on Base it would take a real deposit
   [relay] #5 eth_sendRawTransaction 0xaba5826096c7975668f79941094809738a4e4b1891d39e55eaf1dc5fbd3e7a26: receipt status 1, block 55836707, gas used 115074; 0x914E3A1A426faCf1F6d145337392c75220506b0A holds 0.061305 USDC (+0.020435)
   [contract] buy(#6) of 1 ETH : REFUSED (Contract panicked: budget exceeded)
   [agent] buy(#6) with target 0xaabfF6E27fdc021573753978741a5F88e01000C8, recipient and router 0x000000000000000000000000000000000000dEaD, min_out 0 added to the arguments
   [contract] signed for router 0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24: path WETH -> 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (the checked USDC), recipient 0x914E3A1A426faCf1F6d145337392c75220506b0A, amountOutMin 19820 (sentinel quote minus 3 %); buy has no such parameters, the injected ones were ignored
   [human] emergency stop: agent.goblin-guard-35811.testnet disarmed and frozen
   [armer] arm 0.08 NEAR for 900 s: REFUSED (Contract panicked: agent frozen by the owner)
   ```
   A signed purchase: 7 to 9 s from `buy` to the signed transaction (three runs), 14.8 TGas and 0.0014 NEAR burnt, 100 TGas attached. Exit code 1 if a trapped attempt goes through, a refusal has another reason or a healthy purchase is not executed on the fork.
6. `bun --env-file=.env app/replay.ts proofs/5.json --check` -> exit 0; among its lines:
   ```text
   OK       quote 20434899 tokens for 0.01 ETH recomputed identically
   OK       on-chain quote 20434899 matches evidence
   OK       on-chain verdict allow for #5 matches (same target, same reasons)
   REPLAY OK: verdict allow confirmed, same as on chain (1 check(s) not verified on this node, see SKIPPED)
   ```
   A copy with `quote` set to 1 in `evidence` -> `REPLAY FAILED: 3 check(s) not confirmed` (quote recomputed, evidence hash, on-chain quote), exit 1.
7. `./check-mainnet.sh` -> the same check against Base mainnet (read-only simulation on `https://mainnet.base.org`, nothing broadcast) -> exit 0:
   ```text
   OK       EVM block time 2026-11-11T15:04:13Z lies between the NEAR request 2026-11-11T15:04:11Z and verdict 2026-11-11T15:04:15Z (+/- 60 s)
   REPLAY OK: verdict allow confirmed, same as on chain
   ```
8. `near contract call-function as-read-only guard.<name>.testnet get_check json-args '{"id":5}' network-config testnet now` -> `"quote": "20434899"`, `"settled": true`, `"signed_tx": "AvkBV4Ih…"` (base64 of the transaction above). `bun --env-file=.env app/relay.ts <id>` rebroadcasts any stored one on the fork.

Roles by hand: `bun --env-file=.env --env-file=.env.armer app/arm.ts <NEAR> <seconds>` (armer), `bun --env-file=.env app/human.ts stop|unfreeze` (human).

## Limits

- **A transaction signed for chain id 8453 is valid on Base mainnet. The derived address holds no funds there: never send funds to it.** The relay stops before broadcasting if the node does not answer `anvil_nodeInfo` (local anvil only).
- Fork setup, not possible on Base: the relay funds the derived address with `anvil_setBalance` (value, max gas, L1 data fee) and aligns its nonce after a fork restart.
- The rate is fixed by the owner, no oracle; Base's L1 data fee (~1e9 wei here) is not counted in the budget.
- One signature at a time for all agents (one address, one nonce sequence). A signed transaction nobody broadcasts holds back the next nonces until someone does (it is stored on chain). The emergency stop does not recall a signature already requested.
- The derived address is computed off-chain and given at init; the guard does not check it, the relay does (recovered signer = recipient).
- The minimum output scales the 0.01 ETH quote linearly: a much larger buy may revert on price impact (safe, but gas is spent).
- The agent is scripted (it obeys the injection); no LLM. `warn` stops the purchase like `block`. Uniswap V2 route only; V4 hooks and the token creator are not checked.
- The sentinel is one key on one machine (no TEE). A lying verdict or quote is caught only by a later replay.
- The block-time check needs a node on real time: on the local fork it is reported `SKIPPED`. Replay was tested on blocks minutes old.
- Not realistic in the simulation: the +1 h sale is 256 blocks ahead, not 1800 (`eth_simulateV1` limit); probes are fresh addresses with balances set by state override.
- All roles run under one OS user; the guard account keeps a full-access key.
- Previous deployments `goblin-guard-00044`, `-72130`, `-18949` (NEAR-transfer `spend`), `-67396` (`buy` with an agent-chosen minimum) and `-22360` (agent allowance too low to send `buy`) are not used.

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain;
the traps checked here come from those losses. No code, strategy, wallet or account from that work is reused or published.
Libraries: near-sdk, omni-transaction (EVM encoding) (Rust), near-api-js, viem (TypeScript), Foundry. Code written with AI assistance (Claude Code). License: MIT.
