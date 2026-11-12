# Threat model

What an attacker can try, what the guard answers, and how to see it for yourself. The
[sentinel](sentinel.md) explains how each check works; this page lists what the checks catch and miss.

Verdicts: 🟢 `allow` (the agent may buy), 🟠 `warn` (buyable once the owner approves), 🔴 `block`.
**Listed**: the guard puts the token on its shared blocklist, refused to every agent until the owner unlists it.

Token names in `code` are keys of [`evm/tokens.json`](../evm/tokens.json), traps that `evm/fork.sh`
deploys on a local copy of Base. Each `bun test -t` needs that fork running ([reproduce](reproduce.md)).
`N` stands for the block a check draws: it changes per check.

## Attacks it stops

### Sale refused after the buy

| Attack                                                                          | Answer (exact reason)                                                                                             | Reproduce                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Every sale refused after the buy, a honeypot (`sell_blocked`)                   | 🔴 listed: `sale refused N blocks after the buy (TransferHelper: TRANSFER_FROM_FAILED)`                           | `bun test -t "sale closed from the buy"` |
| Sales refused from 5 min after the buy (`sell_blocked_later`)                   | 🔴 listed: `sale refused N blocks after the buy`, on the late sale (200 to 255 blocks after the buy)              | `bun test -t "sale closed 5 minutes"`    |
| A 90 % tax on the sale, or on the late sale only (`sell_tax`, `sell_tax_later`) | 🔴 listed: `90 % tax on the sale N blocks after the buy`                                                          | `bun test -t "90 % tax"`                 |
| A token that sells for itself into its pool (`pair_pull_tax`)                   | 🔴 listed: `the pool paid out more WETH than the seller received N blocks after the buy`                          | `bun test -t "swaps 90 % of each sale"`  |
| A buy that delivers almost nothing                                              | 🔴 listed: `simulated buy received no tokens` or `100 % tax on the buy`, when the pool quotes 1,000 units or more | `bun test -t "delivers 500 units"`       |

### The owner takes tokens back

| Attack                                                              | Answer (exact reason)                                                             | Reproduce                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `owner()` moves a buyer's tokens with no approval (`owner_reclaim`) | 🔴 listed: `owner() <address> takes tokens back by transferFrom without approval` | `bun test -t "takeback by the owner"` |

### Template farm

A farm launches copies of one code, funds each pool, then pulls the liquidity. Each new copy is clean.

| Attack                                                                      | Answer (exact reason)                                                                                 | Reproduce                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A clean copy of a template whose earlier pools were drained (`farm_fresh`)  | 🔴 never listed: `template 0x9c69..94c8: 5 of 5 earlier pools drained, median 2 blocks after funding` | `bun test -t "fresh token of a farm template"` |
| Drained copies of an honest token's code, to get it blocked (`usdc_copies`) | 🟢 USDC stays `allow`: only pools funded before the target's own count                                | `bun test -t "copies of a token's code"`       |

### Telling the check from a real sale

A trap can try to sell only when it detects a simulation, or only at the moment and size a check would try.

| Attack                                                                                                                     | Answer                                                                                                            | Reproduce                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Sells only at zero gas price or base fee (a simulator's defaults) (`sim_detector`)                                         | 🔴 listed: `sale refused N blocks after the buy`                                                                  | `bun test -t "only in simulation"`                    |
| Sells only after a call only a simulator sends (a top-level `balanceOf`) (`judge_trap`, `untouched_buyer`, `stranger_key`) | 🔴 listed                                                                                                         | `bun test -t "JudgeTrap"`                             |
| Sells only after an approve of 2^256 - 1, or a buy of exactly 0.01 ETH (`approve_max_only`, `buy_001_only`)                | 🔴 listed: the check runs the exact bytes the guard signs                                                         | `bun test -t "Trap2"`                                 |
| Sells only in the block right after the buy (`next_block_key`)                                                             | 🔴 listed: the first sale lands 5 to 150 blocks after the buy                                                     | `bun test -t "NextBlockKey"`                          |
| Sells only half or all of the balance (`amount_trap`)                                                                      | 🔴 listed: the first sale sells 13 % to 87 %                                                                      | `bun test -t "AmountTrap"`                            |
| Sells only at the check's late block                                                                                       | 🔴 the late sale is drawn 200 to 255 blocks after the buy; `replay --check` refuses a schedule the sentinel chose | `bun test -t "sales derive"`, `-t "late sale chosen"` |

All three draws come from the check and the hash of the Base block it simulates on, which does not
exist before that block ([how](sentinel.md#sales-drawn-per-check)).

### State Base moves every block

A simulation keeps still what Base changes every block: the L1Block contract (Base's record of
Ethereum), the fee vaults, WETH's supply, the guard's ETH balance, the Uniswap factory.

| Attack                                                                                              | Answer (exact reason)                                                                                 | Reproduce                 |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| Sells only while L1Block is unchanged since the buy (the red team's) (`red_l1_trap`, `helper_trap`) | 🔴 not listed: `reads 0x4200..0015, 0x8bde..9881 during a transfer: state no simulation reproduces`   | `bun test -t "RedL1Trap"` |
| Sells only while nobody else moves WETH's total supply (`weth_key`)                                 | 🔴 not listed: `sale refused N blocks after the buy after others' WETH, factory and ETH activity (…)` | `bun test -t "WethKey"`   |

The first is the [environment rule](sentinel.md#environment-rule); the second is the
[busy side](sentinel.md#the-four-requests), which runs the guard's sales again after others' activity.

### Values no simulation can match

| Attack                                                             | Answer (exact reason)                                                      | Reproduce                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------- |
| Code keyed on the base fee, coinbase, prevrandao… (`basefee_trap`) | 🟠 the owner decides: `code reads BASEFEE: values no simulation can match` | `bun test -t "keyed on the base fee"` |

### Attacks on the guard's address

The guard's Base address is public: anyone can send it tokens or get a token to freeze it.

| Attack                                                              | Answer (exact reason)                                                         | Reproduce                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| A token that freezes only the guard's address (`guard_frozen`)      | 🔴 not listed: `guard address only, not listed: sale refused …`               | `bun test -t "freezes only the guard"`  |
| A sale that needs more gas than the guard signs with (`gas_hungry`) | 🔴 the simulation uses the guard's gas limit; the owner can raise it and sell | `bun test -t "more gas than the guard"` |

### Agent bypasses

| Attack                                                                 | Answer (exact reason)                                                                                                                | Reproduce                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| The agent injects a target, recipient, router or minimum into `buy`    | ignored: NEAR signs the swap the sentinel simulated                                                                                  | `./demo.sh`, moment 4                                   |
| The agent buys on a `block`                                            | `verdict does not allow the purchase`                                                                                                | `./demo.sh`, moment 1                                   |
| The agent calls the MPC signer or moves NEAR directly                  | NEAR protocol: `Access key receiver … does not match transaction receiver v1.signer-prod.testnet`, `Access key requires full access` | `./demo.sh`, moment 4                                   |
| The agent buys another amount than checked, or above the owner's limit | `amount is not the one checked`, `amount above the owner's per-buy limit`                                                            | `cargo test another_amount`, `cargo test per_buy_limit` |
| One signed model decision reused for a second call                     | `decision already anchored on check #n`                                                                                              | `cargo test digest`                                     |
| A buy on a verdict from before the owner's emergency stop              | `check requested before the owner's stop: request a new check`                                                                       | `cargo test before_a_stop`                              |

### A lying sentinel

The sentinel is one NEAR key on one machine, with no TEE (trusted execution environment). Its key can only
post verdicts. What a lie gets:

| Lie                                                     | Answer                                                                                  | Reproduce                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Asks to list an honest token                            | `replay --check`: `on-chain list_target true != evidence.list_target false`             | `bun test -t "list_target true"`                           |
| Chooses the probes, the sales or the busy side's sender | `replay --check` refuses them: they derive from on-chain data                           | `bun test -t "chosen by the sentinel\|the sentinel chose"` |
| Judges a farm on an index window that misses its pools  | the sentinel refuses such a window; `replay` reports a `MISMATCH`                       | `bun test -t "index window"`                               |
| Forges a simulation result or a fact                    | `replay` resends the requests and recomputes every fact                                 | `bun test app/replay.test.ts`                              |
| Posts `allow` on a trap                                 | **not stopped**: bought if the agent buys within 120 s; replay shows the lie afterwards | see below                                                  |

The owner replaces a compromised key with `set_sentinel`; verdicts it already posted stay.

### Honest tokens

| Token                                       | Answer                                                                                       | Reproduce                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| USDC on the fork                            | 🟢 `allow`; the guard builds the swap, NEAR signs it, the relay broadcasts it to the fork    | `bun test -t "USDC, healthy"`, `./demo.sh` |
| An honest 30-block cooldown (`cooldown_60`) | 🟢 `allow`; 🔴 not listed when the first sale is drawn within 30 blocks (about 1 check in 6) | `bun test -t "Cooldown60"`                 |
| USDC on Base mainnet                        | 🟠 `warn`, only because no template index covers mainnet                                     | `./check-mainnet.sh`                       |

A refused sale lists the token only if the late sale is refused too: a refusal that clears with time
blocks that check alone, or any agent could repeat checks until one lists an honest token.

## What it does not stop

- **A lying sentinel's `allow`.** Bought if the agent buys within 120 s. Replay shows a forged simulation
  or an index window not bound to the check only afterwards.
- **A lying exit quote.** It gives the agent a lower floor (minimum output); replay catches it afterwards.
- **What a token does later.** An owner action after the buy (pause, tax, blacklist; any admin, not only
  `owner()`); behaviour that changes after the late sale (400 to 510 s after the buy).
- **Sizes and delays the check did not draw.** A sale refused only below some share, or only after 510 s,
  passes. An agent's exit sells its holding when it chooses.
- **State the busy side does not move.** A token keyed on a WETH transfer between others, a swap in
  another pool, its own pool traded by nobody else, or the real L1 data fee the guard pays.
- **Front-running.** The signing request and the signed transaction are public on NEAR before anyone
  broadcasts them: a token owner can react before the swap's 300 s deadline.
- **Template evasion.** A template is the code with `PUSH32` operands and metadata masked: changing any
  other constant makes a new one. Fewer than 3 earlier pools give no finding.
- **A pool funded before the index window.** It is not judged by reputation (its reasons say so); a
  lying sentinel can still drop a farm's pools funded more than 2,000 blocks (67 min) before the check.
- **The model's decision.** Its digest is optional: a compromised agent can omit it or attach another.
- **Operations.** One signature at a time for all agents; a fixed NEAR/ETH rate, no oracle; only Uniswap
  V2 WETH pools; an exit that reverts on Base keeps the agent's holding debited until the owner restores it.
- **Base mainnet.** A transaction signed for chain 8453 is valid there: never fund the guard's address.
  The relay broadcasts only to a local anvil.

Each limit, with the code that sets it: [contract](contract.md#limits), [sentinel](sentinel.md#what-a-check-cannot-show).

## Closed after review

Seven judge runs, a red team, automated reviews and our own security passes found the bypasses below.
Each now has a test.

| Found                                                                                             | Closed by                                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A token that sells only when `tx.gasprice` or `block.basefee` is 0 (a simulator's defaults)       | calls carry the guard's real fee fields, base fee, prevrandao and coinbase                                |
| An `allow` on USDC used to pay a trap                                                             | the guard builds the swap of the verdict's own target; the agent has no Base key                          |
| A forged proof file fooling replay (swapped labels, another RPC method, another target)           | replay rebuilds the exact request and checks the on-chain target                                          |
| A token that freezes only the guard's public address                                              | the guard's address is simulated too; such a failure blocks without listing                               |
| A colluding sentinel choosing friendly probe addresses                                            | probes derive from the guard, the check and the Base block hash; `replay --check` recomputes them         |
| An armer locking an agent out for 7 days                                                          | the owner resets the arming log and replaces the armer                                                    |
| The agent choosing its sale floor                                                                 | the floor comes from a sentinel exit quote, set by the contract                                           |
| An agent selling tokens bought for another                                                        | exits are capped by the agent's holding, one agent per token; the owner reassigns a stuck holding         |
| A sale that needs more gas than the guard signs with                                              | the simulation uses the guard's gas limit; the owner can raise it to retry                                |
| Copies of an honest token's code listed as a template                                             | templates are never listed; reputation counts only pools funded before the target's                       |
| A farm dating its pools by an empty pair created early, or liquidity added and removed            | pools are dated by net WETH funding                                                                       |
| A token keyed on what the simulation did and the guard did not (fourth run's Trap2)               | the guard side runs the exact bytes the guard signs; the amount is stated at the check                    |
| A token keyed on any approve but the maximum also trapped the owner's exit                        | `sell` takes an approve of the owner's choice, 2^256 - 1 included                                         |
| Drained copies of USDC's code got USDC blocked                                                    | reputation does not apply to a pool that predates the window                                              |
| Anyone could block arming by depositing 1 yoctoNEAR to the agent                                  | `arm` refuses only a credit below what the armer read                                                     |
| The recorded decision package re-anchored on a guard that never called the model                  | the signed request names the guard, the agent and a fresh NEAR block; `attest --check` verifies all three |
| A compromised sentinel key could not be revoked                                                   | `set_sentinel`, owner only, logged                                                                        |
| A sale only after a top-level `balanceOf`, which only the simulation sent (fifth run's JudgeTrap) | the guard side holds the guard's own transactions alone; every other call runs in a request of its own    |
| Simulated blocks told apart from real ones (timestamps, one prevrandao for all)                   | 2 s per block, every block up to the late sale listed, a prevrandao per L1 epoch                          |
| A sale tax hidden by a token that sells for itself into the pool during the sale                  | the tax is the ETH the seller receives; a pool paying out more is a `block`                               |
| One signed decision anchored on two checks                                                        | the guard refuses a digest already anchored; `attest --check` verifies `decision_of`                      |
| A pair created empty before the index window escaped reputation                                   | an older pool must have held 0.5 ETH before the window, otherwise it is dated by its funding inside it    |
| The red team's RedL1Trap (allow, NEAR signed, tokens stuck, `replay --check` OK)                  | the environment rule: addresses traced on a local fork, opcodes scanned; replay recomputes both           |
| A signature the MPC published after the guard's yield timed out (a spend outside the budget)      | a missing signature keeps its nonce, charge and tokens reserved until the owner settles it                |
| `attest --check` trusted the package's own claim; the amount came from unattested code            | the model is pinned; the signed tool call states `amount_wei`, which `attest --check` compares            |
| "The owner can always have NEAR sign a sale" was not true during a signature                      | the sentence says when; a test shows the order after a stop                                               |
| Executable code in a tail shaped like solc's metadata escaped the opcode scan                     | the whole code is scanned; such a tail counts as data only when the code before it halts                  |
| The model's tool call set the buy's amount, bounded only by the armed budget                      | an owner-set per-buy limit (`max_buy_wei`), enforced by `request_check`, `buy` and the wrapper            |
| A verdict from before an emergency stop still bought after `unfreeze`                             | the stop voids every check requested before it, for a buy and for a quoted exit                           |
| An agent whose budget was spent or expired could not sell                                         | a sale never needs buying budget: the exit quote and its gas come from the agent's credit                 |
| A refund accepted before any replacement was signed; a replacement voiding a signed buy           | a refund needs a replacement signed at that nonce; only a reserved nonce can be replaced                  |
| Any agent could get an honest token listed by picking an amount whose buy fails                   | only a finding after a buy that succeeded, on at least 1,000 units, lists; the wrapper refuses dust       |
| A callback that ran out of gas would have held the signing slot forever                           | the owner releases it after 600 s; a late callback names its request                                      |
| Judge pass 6's NextBlockKey and AmountTrap                                                        | the first sale's block and share are drawn per check; `replay --check` recomputes them                    |
| `withdraw_fees` took the prices that paid for storage, then a `refund_credit` failed              | a withdrawal leaves storage, every credit and the escrow covered                                          |
| A sentinel posted an honest proof with `list_target` true and `replay --check` said OK            | `list_target` is in the evidence and stored with the verdict; replay compares both                        |
| A token delivering almost nothing escaped the blocklist                                           | dust is judged on the pool's quote for the agent's amount                                                 |
| A token could sell only at the check's late block, always 255 blocks after the buy                | the late sale is drawn per check, 200 to 255 blocks; `replay --check` refuses a chosen one                |
| Judge pass 7's WethKey: one unrelated `WETH.deposit()` froze every sale                           | the busy side runs the sales again after others' activity; a sale that differs is a `block`               |
| A sentinel could judge a farm copy on an index window that missed its earlier pools               | the window must start 2,000 blocks before the check and end at most 300 before it                         |
| An honest 30-block cooldown was listed whenever the first sale was drawn within it                | a refused sale lists only when the late sale is refused too                                               |
