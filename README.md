# goblin-near: a spending guard and a pre-buy sentinel for AI agents, purchases signed by NEAR

NEAR Hackathon, track **AI Security & Defense**.

- The agent buys only through a NEAR contract (the guard). Its key can call nothing else, and it holds no EVM key.
- Before a token purchase, a sentinel simulates buy and sales read-only on Base (`eth_simulateV1`), as a probe buyer and as the guard's own EVM address, and posts `allow`, `warn` or `block`, the sha256 of its evidence and its quote (tokens received for 0.01 ETH).
- On `allow`, or on a `warn` the human approved on chain, the guard builds the Base transaction itself (Uniswap V2 swap WETH -> the checked token, tokens to the guard's own address, minimum from the quote) and has it signed by NEAR Chain Signatures. A relay with no key broadcasts it. The way out (sell back to ETH) is signed by NEAR too and needs no verdict.
- Anyone can replay a proof against a Base node and check it against the verdict, quote and probe derivation stored on NEAR.

Deployed on testnet: `guard.goblin-guard-03065.testnet` (source `src/lib.rs`, near-sdk 5, wasm 255,781 bytes, code sha256 `2cadc634…b942`: the deployed code is the wasm built here; `cargo near build non-reproducible-wasm` depends on the build path, and the reproducible Docker build needs metadata committed in `Cargo.toml`, not done).
It signs through `v1.signer-prod.testnet`, path `evm-1`; its EVM address is `0xFa27151a583CC95F1f8E68a127e29642CF03a4E7`.

## What NEAR enforces

| Rule                                                                                                                                                                                                                                                                                                  | Enforced by                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Agent key: only `request_check`, `buy`, `refund_check`, `sell` on the guard; no transfer, no deposit, no call to the MPC. Armer key: only `arm`, `disarm`                                                                                                                                             | NEAR protocol (function-call keys)                |
| A purchase only on a sentinel `allow`, or on a `warn` the owner approved (`approve_warn`, logged), for that request, once, at most 120 s after the verdict: the approval does not extend it (the human approves that simulation, which ages the same)                                                 | `buy`, `approve_warn`                             |
| The guard builds the transaction: chain id 8453, router, WETH, path [WETH, checked token], recipient = its address, nonce, gas (250,000) and fees (0.05 / 0.001 gwei) set by the contract or at init; minimum output = sentinel quote scaled to the amount, minus 3 % (owner's bound); deadline 300 s | `buy`                                             |
| Exit: `sell(token, amount, min_out_wei)` by the owner or a registered, unfrozen agent, with no verdict and no budget: NEAR signs `approve(router, amount)` then the swap to ETH back to the guard's address; the floor is the caller's. `withdraw_eth`: owner only, to the EVM address fixed at init  | `sell`, `withdraw_eth`                            |
| Signature by the MPC for the guard's account and a fixed path. One signature at a time, buys and exits alike; a failed buy signature returns credit and budget and leaves the nonce unused; an exit keeps only signed transactions with contiguous nonces                                             | Chain Signatures, `on_signed`, `on_exit_signed`   |
| Only the sentinel posts a verdict, once, with `sha256(evidence)` and a quote, non-zero on `allow`                                                                                                                                                                                                     | `post_verdict`                                    |
| Value + max gas in wei, at the owner's fixed rate (1 ETH = 1000 NEAR), come off the armed budget and the credit                                                                                                                                                                                       | `arm`, `buy`                                      |
| Only the armer arms, only registered agents, within the human's bounds: budget per arming, max duration, 7-day cap (at most 32 armings). After replacing a compromised armer, the owner clears an agent's 7-day log                                                                                   | `set_bounds`, `arm`, `set_armer`, `reset_armings` |
| Emergency stop: the human's `disarm` freezes the agent (no budget, no re-arming, no `sell`) until `unfreeze`; the owner's own exit stays open                                                                                                                                                         | `disarm`, `unfreeze`                              |
| Verdict fee refunded if no verdict within 5 min                                                                                                                                                                                                                                                       | `refund_check`                                    |

Sentinel checks (`app/verifier.ts`). Every step runs twice in the same simulated blocks: as a probe buyer, and as the guard's EVM address (public, so a token can target it).
The probe buyer and the stranger are `sha256(guard account, check id, request time stored by the guard, hash of the EVM block simulated on)`: the sentinel does not choose them, and nobody can whitelist them before that block exists.
Checks: `transferFrom` without approval by `owner()` and by the stranger -> `block`; sale in the next block, and 256 blocks later (about 8.5 min of Base blocks, timestamp set 1 h ahead; `eth_simulateV1` allows no more) -> `block` if it reverts; tax against the pool quote on the buy and both sales -> `warn` from 10 %, `block` from 50 %. Calls pay the real block's base fee plus a tip, 1 M gas limit.

## Try it

Requirements: Rust with `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8, `jq`. No API key.

1. `cargo test` -> `116 passed` (MPC payload hashes and signed transactions equal viem vectors). `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` -> exit 0.
2. `cargo near build non-reproducible-wasm`, then `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`.
3. `bun install && bun app/setup.ts <name>.testnet [your EVM address for withdrawals]` -> creates `guard.`, `agent.`, `sentinel.`, `armer.<name>.testnet`, deploys and initializes the guard, adds one function-call key per role, deposits 1 NEAR of credit:
   ```text
   derived EVM address of guard.goblin-guard-03065.testnet (path evm-1, signer v1.signer-prod.testnet): 0xFa27151a583CC95F1f8E68a127e29642CF03a4E7
   function-call key of agent.goblin-guard-03065.testnet: guard.goblin-guard-03065.testnet [request_check, buy, refund_check, sell], 0.5 NEAR gas allowance
   ```
4. In another terminal, `evm/fork.sh` (after step 3: one trap freezes your guard's EVM address) -> anvil fork of Base on `127.0.0.1:8545` with USDC and ten demo tokens. `bun test` -> `74 pass`, `0 fail`; `bunx tsc --noEmit` -> exit 0.
5. `./demo.sh` -> exit 0. Each role runs in its own process with its own key; the relay runs with none. Excerpt (ids grow with every run; links and some lines cut):
   ```text
   [sentinel] #11 : BLOCK (guard address: sale refused in the next block after the buy (TransferHelper: TRANSFER_FROM_FAILED) ; guard address: sale refused 256 blocks (timestamp +1 h) after the buy (...)), proof proofs/11.json
   [contract] buy(#11) of 0.00001 ETH, no signature requested : REFUSED (Contract panicked: verdict does not allow the purchase)
   [wrapper] #12 : ALLOW, buy of 0.00001 ETH signed by NEAR in 6.1 s (15.0 TGas, 0.0014310437976678 NEAR burnt): 0x02f901578221050c...
   [relay] #12 eth_sendRawTransaction 0x39fe347e…326b: receipt status 1, block 55836727, gas used 115074; 0xFa27151a583CC95F1f8E68a127e29642CF03a4E7 holds 0.04087 USDC (+0.020435)
   [wrapper] sell of 40870 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for at least 0.000019283247461335 ETH (pool quote minus 3 %): 2/2 transactions signed by NEAR in 6.3 s (24.0 TGas, 0.0022933167518047 NEAR burnt)
   [relay] 0xFa27151a583CC95F1f8E68a127e29642CF03a4E7 holds 0.000043973170488721 ETH (+0.000018971570728329, net of the gas of both transactions)
   [contract] signed for router 0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24: path WETH -> 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (the checked USDC), recipient 0xFa27151a583CC95F1f8E68a127e29642CF03a4E7, amountOutMin 19820 (sentinel quote minus 3 %); buy has no such parameters, the injected ones were ignored
   [sentinel] #14 : WARN (20 % tax on the sale in the next block ; 20 % tax on the sale 256 blocks (timestamp +1 h) after the buy), quote 995007997999864566917 for 0.01 ETH, block 55836730, proof proofs/14.json
   [wrapper] #14 : WARN not approved on chain within 20 s (or the verdict's life), I GIVE UP, no purchase
   [contract] buy(#14) on the unapproved warn, wrapper bypassed : REFUSED (Contract panicked: warn verdict not approved by the owner)
   [human] warn #15 approved on chain: the agent may buy it until 120 s after the verdict
   [wrapper] #15 : WARN, buy of 0.00001 ETH signed by NEAR in 5.6 s (15.1 TGas, 0.0014413304336925 NEAR burnt): 0x02f9015782210510...
   [armer] arm 0.12 NEAR for 900 s: REFUSED (Contract panicked: agent frozen by the owner)
   [relay] 0x000000000000000000000000000000000000dEaD holds 4.589265996272433312 ETH (+0.00001)
   ```
   Timed buys (four, over two runs): 5.6 to 7.8 s from `buy` to the signed transaction, 15.0 to 15.1 TGas, 100 TGas attached; sales (two): 6.3 to 6.4 s, 24.0 TGas, 150 TGas attached. Exit code 1 if a trapped attempt goes through, a refusal has another reason, or a healthy or approved purchase, the sale or the withdrawal is not executed on the fork.
6. `bun --env-file=.env app/replay.ts proofs/12.json --check` -> exit 0; among its lines:
   ```text
   OK       quote 20434900 tokens for 0.01 ETH recomputed identically
   OK       on-chain verdict allow for #12 matches (same target, same reasons)
   OK       probe addresses derived from guard.goblin-guard-03065.testnet, #12, request time 1794412832118220760 ns on NEAR and EVM block hash 0xa03e8cbd...
   OK       guard side simulated as guard.goblin-guard-03065.testnet's derived EVM address 0xFa27151a583CC95F1f8E68a127e29642CF03a4E7
   REPLAY OK: verdict allow confirmed, same as on chain (1 check(s) not verified, see SKIPPED)
   ```
   Same with `proofs/11.json` (block) -> exit 0. A copy with `quote` set to 1 in `evidence` -> `REPLAY FAILED: 3 check(s) not confirmed`, exit 1. Without `--check`, the probes are reported `SKIPPED` (not verified).
7. `./check-mainnet.sh` -> the same check against Base mainnet (read-only simulation on `https://mainnet.base.org`, nothing broadcast) -> exit 0:
   ```text
   OK       EVM block time 2026-11-11T16:03:07Z lies between the NEAR request 2026-11-11T16:03:04Z and verdict 2026-11-11T16:03:09Z (+/- 60 s)
   REPLAY OK: verdict allow confirmed, same as on chain
   ```
8. `near contract call-function as-read-only guard.<name>.testnet get_check json-args '{"id":15}' network-config testnet now` -> `"verdict": "warn"`, `"approved": true`, `"settled": true`, `"signed_tx": "AvkBV4Ih…"`. `bun --env-file=.env app/relay.ts <id>` broadcasts a stored buy on the fork, or prints the receipt if it was already mined; `app/relay.ts exit <nonce>` does the same for `last_exit`.

Roles by hand: `bun --env-file=.env --env-file=.env.armer app/arm.ts <NEAR> <seconds>` (armer); `bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei]` (human).

## Limits

- **A transaction signed for chain id 8453 is valid on Base mainnet. The derived address holds no funds there: never send funds to it.** The relay stops before broadcasting if the node does not answer `anvil_nodeInfo` (local anvil only). Fork setup, not possible on Base: the relay funds the derived address with `anvil_setBalance` and aligns its nonce after a fork restart.
- The rate is fixed by the owner, no oracle; Base's L1 data fee is not counted in the budget. The minimum output scales the 0.01 ETH quote linearly: a much larger buy may revert on price impact.
- One signature at a time for all agents and exits (one address, one nonce sequence). A signed transaction nobody broadcasts holds back the next nonces; only the latest exit stays in state (`last_exit`), earlier ones are in the `exit_signed` events. The emergency stop does not recall a signature already requested.
- Exit floor: the caller chooses it, so a hostile unfrozen agent can sell at a zero floor into a sandwich (the signed transaction is public on NEAR before broadcast); the ETH still lands on the guard's address. `sell` takes any token address: `approve` is then called on that contract from the guard's address (no value, gas only).
- Sentinel: one key on one machine, no TEE. `replay --check` catches, after the fact: a verdict, reasons or quote that do not follow from the simulation; a simulation that is not the one `checkToken` builds for that target; probes not derived as above; a guard side that is not the guard's derived address; an EVM block outside the request-verdict window (live node only). It cannot stop a lying `allow` from being bought within 120 s, and it leaves the sentinel free to pick the simulated block within that window (about 60 Base blocks), so a token that lets 1 address in k sell gets through with probability about 60/k.
- What simulation cannot see: an owner action after the buy (blacklisting the guard, raising the tax), a trap that triggers after more than 256 blocks, V4 hooks; the creator is not checked. Uniswap V2 route only. The agent is scripted (it obeys the injection); no LLM.
- The human must approve a `warn` within 120 s of the verdict, or the agent asks for a new check.
- Armer: no minimum budget per arming. A compromised armer can lock an agent out as well by spending the 7-day cap; the remedy for both is the owner's `set_armer` then `reset_armings`.
- All roles run under one OS user. The human's near-cli keychain keeps a full-access key for the guard, agent, sentinel and armer accounts, to rotate keys and recover balances; anyone with that user can use them. The guard's full-access key can redeploy the guard or call the MPC as the guard, i.e. sign anything for its EVM address. Deleting it would make the guard immutable; not done on this testnet demo.
- The derived address is computed off-chain and given at init; the guard does not check it, the relay, sentinel and replay recompute it. Without a second argument, `setup.ts` fixes the withdrawal address to `0x…dEaD`.
- The block-time check needs a node on real time: on the local fork it is reported `SKIPPED`. Replay was tested on blocks minutes old.
- Previous deployments `goblin-guard-00044`, `-72130`, `-18949`, `-67396`, `-22360` and `-35811` (sentinel-chosen probes, buy only) are not used.

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain;
the traps checked here come from those losses. No code, strategy, wallet or account from that work is reused or published.
Libraries: near-sdk, omni-transaction (EVM encoding) (Rust), near-api-js, viem (TypeScript), Foundry. Code written with AI assistance (Claude Code). License: MIT.
