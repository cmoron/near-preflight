# near-preflight: a pre-buy guard for AI agents, purchases signed by NEAR

[![ci](https://github.com/cmoron/near-preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/cmoron/near-preflight/actions/workflows/ci.yml)

On one day of real Base (2026-11-11), 24 of the 29 new Uniswap V2 WETH pools were drained a median 2.2 hours after funding, and all 29 shared one code template: given that day's index, near-preflight blocks the template's next copy before NEAR signs a buy.

NEAR Hackathon, track **AI Security & Defense**. Live status page: [cmoron.github.io/near-preflight](https://cmoron.github.io/near-preflight/).

## What it is

A spending cap stops an AI agent from spending too much, not from spending a little on a token it can never sell. Here the agent can buy on Base only through a NEAR contract, the **guard**, in three steps. The agent asks the guard to check a token and an amount. The **sentinel**, an off-chain service holding one NEAR key, simulates the exact buy NEAR would sign and two later sales of what it bought (previews: an exit is simulated again when the agent sells); the same trades from a fresh address, the sales again after others wrap WETH, create a pair and pay the guard, and transfers attempted without approval, run in separate requests. It posts a verdict, `allow`, `warn` (buyable once the owner approves) or `block`, and whether to put the token on a shared blocklist, with the sha256 of its evidence: anyone can replay it to re-derive both. On `allow`, the guard builds the swap itself and NEAR Chain Signatures (NEAR's threshold signing network, the MPC) signs it. Unlike a cap plus an allowlist, it judges tokens nobody has listed yet, and the agent never holds an EVM key nor picks the route, recipient or floor (the minimum output) of what gets signed.

The demo agent is `z-ai/glm-5.3-flash` on NEAR AI Cloud, whose replies are signed inside an attested TEE. The agent may attach a reply's sha256 to its guard call; the guard stores it and refuses it a second time, and `app/attest.ts` verifies the reply afterwards. The guard neither requires nor verifies it: it does not rely on the model.

## Verify without any account, in five minutes

1. Open the [status page](https://cmoron.github.io/near-preflight/): the journal of the demonstration guard on NEAR testnet, each check and its verdict.
2. With `bun` 1.4, Foundry 1.8 and `jq` (no NEAR account, no key; `GUARD` only names the contract to read):

   ```sh
   git clone https://github.com/cmoron/near-preflight && cd near-preflight && bun install
   # Check #5, USDC on Base mainnet: resent to mainnet.base.org, traced on a local anvil fork, re-judged, compared with NEAR (10 s)
   GUARD=guard.goblin-guard-13713.testnet bun app/replay.ts app/fixtures/usdc-base-mainnet.json https://mainnet.base.org --check
   #   -> REPLAY OK: verdict warn confirmed, same as on chain
   # The model decision anchored on check #1: signature, TDX quote (asks Intel and NVIDIA), the guard's record of it
   GUARD=guard.goblin-guard-13713.testnet bun app/attest.ts app/fixtures/decision.json --check 1
   #   -> ATTEST OK: 15 checks hold (1 not verified, see SKIPPED)
   ```

3. Every trap below on a local Base fork, as CI runs it: `echo GUARD=guard.goblin-guard-13713.testnet > .env && evm/fork.sh` (ready in about 1 min), then in another terminal `bun test --timeout 30000` -> `260 pass`, `0 fail` (about 2.5 min).

## Attacks and what the guard answers

Token names in parentheses are keys of `evm/tokens.json`. Each `bun test -t` needs `evm/fork.sh` running; `./demo.sh` needs a testnet account (Full reproduction).

| Attack                                                                                                                    | What it answers (exact reason)                                                                                                                                       | Reproduce                                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Sale refused after the buy (`sell_blocked`)                                                                               | `block`, token listed: `sale refused 104 blocks after the buy (TransferHelper: TRANSFER_FROM_FAILED)`                                                                | `bun test -t "sale closed from the buy"`                |
| Owner takes tokens back without approval (`owner_reclaim`)                                                                | `block`, listed: `owner() 0x60B1…0001 takes tokens back by transferFrom without approval`                                                                            | `bun test -t "takeback by the owner"`                   |
| Template farm: a clean copy of code whose earlier pools were drained (`farm_fresh`)                                       | `block`, never listed: `template 0x9c69..94c8: 5 of 5 earlier pools drained, median 2 blocks after funding`                                                          | `bun test -t "fresh token of a farm template"`          |
| Transfers touch an address beyond the token, its pool and Uniswap, here Base's L1Block (`red_l1_trap`, `helper_trap`)     | `block`, not listed: `reads 0x4200..0015, 0x8bde..9881 during a transfer: state no simulation reproduces`                                                            | `bun test -t "RedL1Trap"`                               |
| Code reads a value no simulation can match: BASEFEE, PREVRANDAO, COINBASE… (`basefee_trap`)                               | `warn`, the owner decides: `code reads BASEFEE: values no simulation can match`                                                                                      | `bun test -t "keyed on the base fee"`                   |
| Sells only inside a simulation: zero gas price or base fee (`sim_detector`), a read only a simulator sends (`judge_trap`) | `block`, listed: `sale refused N blocks after the buy`                                                                                                               | `bun test -t "only in simulation"`, `-t "JudgeTrap"`    |
| Sale only in the block right after the buy (`next_block_key`)                                                             | `block`, listed, `sale refused N blocks after the buy`: the first sale lands 5 to 150 blocks after the buy, drawn per check                                          | `bun test -t "NextBlockKey"`                            |
| Sale only of half or all of the balance (`amount_trap`)                                                                   | `block`, listed, `sale refused N blocks after the buy`: the first sale sells 13 % to 87 %, drawn per check                                                           | `bun test -t "AmountTrap"`                              |
| Sale only at the check's late block                                                                                       | `block`, the first sale refused; listed when the late sale, drawn 200 to 255 blocks after the buy per check, is refused too; `replay --check` refuses a chosen one   | `bun test -t "sales derive"`, `-t "late sale chosen"`   |
| Sale only while nobody else moves WETH's total supply (`weth_key`)                                                        | `block`, not listed: `sale refused N blocks after the buy after others' WETH, factory and ETH activity (…)`                                                          | `bun test -t "WethKey"`                                 |
| Honest token: sale only 30 blocks after the buy (`cooldown_60`)                                                           | `allow`; `block`, never listed, when the first sale is drawn within 30 blocks (1 check in 6): `sale refused N blocks after the buy`                                  | `bun test -t "Cooldown60"`                              |
| Freezes only the guard's public EVM address (`guard_frozen`)                                                              | `block`, not listed: `guard address only, not listed: sale refused …`                                                                                                | `bun test -t "freezes only the guard"`                  |
| Agent injects a target, recipient, router or `min_out` into `buy`                                                         | ignored: NEAR signs the swap the sentinel simulated                                                                                                                  | `./demo.sh`, moment 4                                   |
| Agent calls the MPC signer, or moves NEAR, directly                                                                       | NEAR protocol: `Access key receiver … does not match transaction receiver v1.signer-prod.testnet`, `Access key requires full access`                                 | `./demo.sh`, moment 4                                   |
| Agent buys another amount than checked, or above the owner's limit                                                        | `amount is not the one checked`, `amount above the owner's per-buy limit`                                                                                            | `cargo test another_amount`, `cargo test per_buy_limit` |
| One signed model decision reused for a second call                                                                        | `decision already anchored on check #n`                                                                                                                              | `cargo test digest`                                     |
| A lying sentinel asks to list an honest token                                                                             | `replay --check`: `on-chain list_target true != evidence.list_target false`                                                                                          | `bun test -t "list_target true"`                        |
| **Not stopped:** a lying sentinel posts `allow` on a trap                                                                 | bought if the agent buys within 120 s; `replay --check` shows the lie only afterwards, as it shows a farm judged on an index window not bound to the check           | `bun test -t "index window"`                            |
| **Not stopped:** the token's owner pauses, taxes or blacklists after the buy                                              | nothing: the simulation saw the token before                                                                                                                         | none                                                    |
| **Not stopped:** a token that changes after the late sale (over 510 s after the buy)                                      | nothing: no later sale is simulated                                                                                                                                  | none                                                    |

## Full reproduction

1. With Rust and `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8 and `jq`: `cargo test` -> `247 passed`, then `bun install`.
2. Get a testnet account holding about 7 NEAR (setup moves 6.35 NEAR). The faucet gives 10: `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`. It rate-limits by IP (`429 Too Many Requests`); a failed call leaves `~/.near-credentials/testnet/<you>.testnet.json` and the folder `<you>.testnet/` beside it: delete both before retrying, or create the account from any account holding 7.5 NEAR (`near account create-account fund-myself <you>.testnet '7.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <funded>.testnet network-config testnet sign-with-keychain send`).
3. `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard and creates `agent.`, `agent2.`, `sentinel.` and `armer.`, each with a function-call key limited to the guard. The armer, a key apart from the agent's, opens the agent's armed budget: what it may spend before a deadline.
4. `evm/fork.sh` in another terminal starts an anvil fork of Base with the demo tokens; the sentinel and replay also start throwaway anvil forks. Then `bun test --timeout 30000` -> `260 pass` and `bunx tsc --noEmit` -> exit 0.
5. `./demo.sh` -> exit 0 in about 1 to 2 min (99 s here), four moments: a poisoned inbox message pushes the agent to a trap, `BLOCK (sale refused N blocks after the buy …)`, and the contract refuses the buy (`verdict does not allow the purchase`); a farm token whose simulation is clean, `BLOCK (template 0x9c69..94c8: 5 of 5 earlier pools drained …)`; USDC, `ALLOW`, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it to the fork, `receipt status 1`; the agent bypasses its wrapper and every attempt fails as in the table.
6. The demo ends by printing this run's `app/replay.ts … --check` and `app/attest.ts … --check` commands: each exits 0. If a role logs `429 Rate limits exceeded`, the NEAR RPC is limiting your IP: wait a few minutes.
7. Optional: with `NEAR_AI_API_KEY=...` in `.env.llm` ([cloud.near.ai](https://cloud.near.ai)), moment 1 runs the live model (0.0003 USD here); without it, a recorded decision is verified. `./demo.sh --full` (213 s here) adds an exit, a `warn` the owner approves, a trap aimed at the guard's address, a second agent, three concurrent model runs, the emergency stop and a withdrawal.
8. `./check-mainnet.sh` -> exit 0 in 23 s: USDC simulated on Base mainnet (read-only), traced on a fork of it, replayed with `--check`; verdict `warn`, since there is no template index for mainnet and an unknown reputation is never a pass.

Deployed: `guard.goblin-guard-13713.testnet`, built from `src/` at commit `d832e22` (`cargo near build non-reproducible-wasm`, near-sdk 5): wasm of 361,064 bytes, sha256 `35bbcc91…f52d`, the code hash on chain. A rebuild on another machine may differ until the reproducible build ships ([DETAILS](docs/DETAILS.md#limits)).

## What NEAR enforces

- The agent's key can call only the guard's `request_check`, `buy`, `refund_check`, `request_exit` and `sell_quoted`: no transfer, no MPC call. Its 0.5 NEAR allowance only caps gas.
- A buy needs an `allow`, or a `warn` the owner approved, less than 120 s old, requested after the owner's last stop, for the amount stated at the check (at most the owner's per-buy limit), on a token neither listed nor held for another agent, within the armed budget.
- The guard signs only the transaction whose hash the verdict carries, built by the guard itself: chain 8453, router, path, recipient = its own EVM address, floor = the sentinel's quote minus 3 %, nonce, gas and fees. If anything moved since, it signs nothing and the agent asks a new check.
- A sale never needs buying budget: an exit's quote and gas come from the agent's credit (an agent frozen by the owner's emergency stop cannot sell; the owner can, any token the guard's address holds, at any floor, once the signature in progress returns).
- A signature that does not come back keeps its nonce and charge reserved until the owner settles it ([DETAILS](docs/DETAILS.md#what-near-enforces)).

## What we do not stop

- **A lying sentinel.** One key on one machine, no TEE: its `allow` on a trap can be bought within 120 s, and replay catches the lie only afterwards. The owner replaces the key (`set_sentinel`).
- **What a token does later.** An owner action after the buy (pause, tax, blacklist; any admin, not only `owner()`); behaviour that changes after the late sale (400 to 510 s after the buy); a sale size or delay the check did not sample (an exit sells the agent's holding, when it chooses); a token keyed on the guard's own ETH balance, or on state others move, in a way the check's busy run (others wrap WETH, create a pair, pay the guard) does not show.
- **Front-running.** The signing request and the signed transaction are public on NEAR before anyone broadcasts them: a token owner can react before the swap's 300 s deadline.
- **Template evasion.** A template is the code with `PUSH32` operands and metadata masked, so changing any other constant makes a new one; a template with fewer than 3 earlier pools gets no finding; a pool that held 0.5 ETH before the index window is not judged; the window need only cover the 2,000 blocks (67 min) before the check, so a lying sentinel can still drop a farm's older pools; without an index (as in `check-mainnet.sh`) the verdict is `warn`.
- **The model's decision.** Its digest is optional: a compromised agent can omit it or attach another one.
- **Operations.** One signature at a time for all agents; the NEAR/ETH rate is fixed by the owner, with no oracle; only Uniswap V2 WETH pools are read; a transaction signed for chain 8453 is valid on Base mainnet (never fund the derived address; the relay broadcasts only to anvil); the build is not reproducible yet.

Every check, rule, role and key, and what review found: [docs/DETAILS.md](docs/DETAILS.md).

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain; the traps and the template-reputation method come from those losses. No code, strategy, wallet, address list or account from that work is reused or published. Libraries: near-sdk, omni-transaction (Rust), near-api-js, viem, @phala/dcap-qvl-node (TypeScript), Foundry. Agent model: `z-ai/glm-5.3-flash` on NEAR AI Cloud. Code written with AI assistance (Claude Code). License: MIT.
