# goblin-near: a spending guard and a pre-buy sentinel for AI agents on NEAR

NEAR Hackathon, track **AI Security & Defense**.

- The agent pays only through a NEAR contract (the guard) that holds its prepaid credit and a budget an armer set within the human's bounds. The agent's key can call nothing else.
- Before an EVM token purchase, a sentinel simulates buy and sales read-only on Base (`eth_simulateV1`) and posts `allow`, `warn` or `block` to the guard. The guard stores the sha256 of the posted evidence.
- Anyone can replay a proof against a Base node and check it against the verdict stored on NEAR.

Deployed on testnet: `guard.goblin-guard-72130.testnet` (source `src/lib.rs`, near-sdk 5).

## Rules

| Rule                                                                                                                                                      | Enforced by                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Agent key: only `request_check`, `spend`, `refund_check` on the guard; no transfer, no deposit                                                            | NEAR protocol (function-call key)     |
| Armer key: only `arm`, `disarm` on the guard                                                                                                              | NEAR protocol (function-call key)     |
| Payment only on a sentinel `allow` for that request, once, at most 120 s after the verdict                                                                | `spend`                               |
| Only the sentinel posts a verdict, once; the guard stores `sha256(evidence)` with it                                                                      | `post_verdict`, `get_check`           |
| Payment only to a recipient the human allowed                                                                                                             | `allow_recipient`, `spend`            |
| Fees and purchases stay within the armed budget, before its expiry                                                                                        | `arm`, `request_check`, `spend`       |
| Only the armer arms, only agents the human registered, within the human's bounds: budget per arming, max duration, 7-day rolling cap of armed budgets     | `set_bounds`, `register_agent`, `arm` |
| Emergency stop: the human's `disarm` freezes the agent; the armer cannot re-arm it until the human calls `unfreeze`. The armer's `disarm` does not freeze | `disarm`, `unfreeze`                  |
| The human replaces a compromised armer                                                                                                                    | `set_armer`                           |
| Verdict fee refunded if no verdict within 5 min                                                                                                           | `refund_check`                        |

Sentinel checks (`app/verifier.ts`, Uniswap V2 WETH -> token on Base, fresh random buyer and stranger per check):
`transferFrom` without approval by `owner()` and by a stranger -> `block`; sale in the next block and 1 h later -> `block` if it reverts;
tax against the pool quote on the buy and both sales -> `warn` from 10 %, `block` from 50 %.

## Try it

Requirements: Rust with `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8. No API key.

1. `cargo test` -> `83 passed`. `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` -> exit 0.
2. `cargo near build non-reproducible-wasm` -> `target/near/goblin_near.wasm`.
3. `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` -> `New account <name.testnet> created successfully.`
4. `bun install && bun app/setup.ts <name>.testnet` -> creates `guard.`, `agent.`, `sentinel.`, `armer.`, `shop.<name>.testnet`, deploys the guard, adds one function-call key per role, sets the bounds, registers the agent, deposits 1 NEAR of credit:
   ```text
   function-call key of armer.goblin-guard-72130.testnet: guard.goblin-guard-72130.testnet [arm, disarm], 0.25 NEAR gas allowance
   bounds: 0.1 NEAR per arming, 3600 s max, 0.5 NEAR per 7 days; agent.goblin-guard-72130.testnet registered
   ```
   Writes `.env` (no key) and `.env.agent`, `.env.sentinel`, `.env.armer` (one key each, mode 0600).
5. In another terminal, `evm/fork.sh` -> anvil fork of Base on `127.0.0.1:8545` with USDC and seven demo tokens (`evm/tokens.json`).
6. `bun test` -> `49 pass`, `0 fail`. `bunx tsc --noEmit` -> exit 0.
7. `./demo.sh` -> exit 0. Each role runs in its own process with its own key file. Ids grow with every new demo; the ones below are those of a first demo on a new account. Excerpt (simulated-call lines and links cut; block numbers and amounts vary):
   ```text
     [armer] arm 0.2 NEAR for 900 s: REFUSED (Contract panicked: budget above the human's bound)
     [armer] agent.goblin-guard-72130.testnet armed: 0.06 NEAR for 900 s
       [sentinel] #1 : BLOCK (sale refused 1 h after the buy (TransferHelper: TRANSFER_FROM_FAILED)), block 55836700, proof proofs/1.json
     [wrapper] #1 : BLOCK, I REFUSE TO SIGN the purchase (sale refused 1 h after the buy (TransferHelper: TRANSFER_FROM_FAILED))
     [contract] spend(#1) of 0.5 NEAR to attacker.goblin-guard-72130.testnet : REFUSED (Contract panicked: verdict does not allow the purchase)
     [protocol] direct transfer of 0.01 NEAR to attacker.goblin-guard-72130.testnet : REFUSED (Access key requires full access)
     [wrapper] #2 : ALLOW, purchase signed, 0.02 NEAR paid to shop.goblin-guard-72130.testnet
     [contract] spend(#3) of 1 NEAR to the allowed shop : REFUSED (Contract panicked: budget exceeded)
     [human] emergency stop: agent.goblin-guard-72130.testnet disarmed and frozen
     [armer] arm 0.06 NEAR for 900 s: REFUSED (Contract panicked: agent frozen by the owner)
     [human] agent.goblin-guard-72130.testnet unfrozen: the armer may arm it again, within the bounds
   ```
   Exit code 1 if a trapped attempt goes through or a refusal has another reason.
8. `bun --env-file=.env app/replay.ts proofs/1.json --check` -> exit 0 (excerpt):
   ```text
   OK       probe addresses are fresh (no code, not router/WETH/target/owner(), distinct)
   OK       verdict block rejudged identically (same reasons)
   OK       on-chain evidence_sha256 <sha256> is the sha256 of the evidence replayed above
   OK       on-chain verdict block for #1 matches (same target, same reasons)
   SKIPPED  EVM block time vs NEAR request/verdict time: not verifiable on this node, its latest block is 12.8 h behind the local clock (a local fork keeps the forked block's time)
   REPLAY OK: verdict block confirmed, same as on chain (1 check(s) not verified on this node, see SKIPPED)
   ```
   A copy with `verdict` and `reasons` changed to an allow -> `REPLAY FAILED: 2 check(s) not confirmed`, exit 1;
   a copy with one label changed inside `evidence` -> `on-chain evidence_sha256 ... != sha256 of the file's evidence ...`, exit 1.
9. Same check against Base mainnet, in one command (arms 0.03 NEAR, runs the sentinel on `https://mainnet.base.org`, requests a check on USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, replays its proof against `https://mainnet.base.org`; no fork needed) -> exit 0 if the replay matches (excerpt, ids and times vary):
   ```sh
   ./check-mainnet.sh
   ```
   ```text
   #8 verdict=allow reasons=buy, takeback probes and sales simulated without anomaly proof=proofs/8.json
   OK       EVM block time 2026-11-11T13:28:46Z lies between the NEAR request 2026-11-11T13:28:45Z and verdict 2026-11-11T13:28:48Z (+/- 60 s)
   REPLAY OK: verdict allow confirmed, same as on chain
   ```
10. `near contract call-function as-read-only guard.<name>.testnet get_check json-args '{"id":1}' network-config testnet now`
    -> `"evidence_sha256": "<sha256>"`, equal to `jq -j .evidence proofs/1.json | sha256sum`.
11. `near account list-keys armer.<name>.testnet network-config testnet now` -> one full-access key (human's keychain) and
    `only do ["arm", "disarm"] function calls on guard.<name>.testnet`.

Roles by hand: `bun --env-file=.env --env-file=.env.armer app/arm.ts <NEAR> <seconds>` (armer),
`bun --env-file=.env app/human.ts stop|unfreeze` (human, full-access key from the near-cli keychain).

## Limits

- The agent is scripted (it obeys the injection); no LLM.
- On testnet the purchase is a NEAR payment to an allowlisted account; the EVM buy is not executed.
- `warn` stops the purchase like `block`; no human approval of a `warn`.
- Uniswap V2 route only; V4 hooks and the token creator are not checked.
- The verdict covers the token only; amount and recipient rely on the budget and the allowlist.
- The sentinel is one key on one machine (no TEE). A lying sentinel is caught only by a later replay.
- The block-time check needs a node on real time: on the local fork it is reported `SKIPPED`.
- Replay was tested on blocks minutes old; older blocks need a node that serves `eth_simulateV1` on archive state.
- `proofs/<id>.json` stays on the sentinel's machine; NEAR keeps only the hash and the evidence summary. A post retried after a client timeout can overwrite the file; replay `--check` then reports the hash mismatch.
- Each `./demo.sh` arms 0.06 NEAR: about 8 runs per agent per 7 days under the 0.5 NEAR cap.
- All roles run under one OS user; the guard account keeps a full-access key; `spend` has no callback for a deleted recipient.
- The previous deployment `guard.goblin-guard-00044.testnet` has an incompatible state and is not used.

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain;
the traps checked here come from those losses. No code, strategy, wallet or account from that work is reused or published.
Libraries: near-sdk (Rust), near-api-js, viem, Foundry. Code written with AI assistance (Claude Code). License: MIT.
