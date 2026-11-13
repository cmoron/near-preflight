# Threat model

What an attacker can try, what the guard answers, and how to see it for yourself. The
[sentinel](sentinel.md) explains how each check works; this page lists what the checks catch and miss.

Verdicts: 🟢 `allow` (the agent may buy), 🟠 `warn` (buyable once the owner approves), 🔴 `block`.
**Listed**: the guard puts the token on its shared blocklist, refused to every agent until the owner unlists it.

Token names in `code` are keys of [`evm/tokens.json`](../evm/tokens.json), traps that `evm/fork.sh`
deploys on a local copy of Base. Each `bun test -t` needs that fork running ([reproduce](reproduce.md)).
`N` stands for when the sale a check draws lands, in seconds after the buy: it changes per check.

## Attacks it stops

### Sale refused after the buy

| Attack                                                                          | Answer (exact reason)                                                                                             | Reproduce                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Every sale refused after the buy, a honeypot (`sell_blocked`)                   | 🔴 listed: `sale refused N s after the buy (TransferHelper: TRANSFER_FROM_FAILED)`                                | `bun test -t "sale closed from the buy"` |
| Sales refused from 5 min after the buy (`sell_blocked_later`)                   | 🔴 listed: `sale refused N s after the buy (…)`, on the far sales (301 s, 900 s, a delay drawn between)           | `bun test -t "sale closed 5 minutes"`    |
| A 90 % tax on the sale (`sell_tax`)                                             | 🔴 listed: `90 % tax on the sale N s after the buy`                                                               | `bun test -t "90 % tax on the sale"`     |
| A 90 % tax from 5 min after the buy (`sell_tax_later`)                          | 🔴 listed: `90 % tax on the sale N s after the buy`, on the far sales                                             | `bun test -t "90 % tax from 5 minutes"`  |
| A token that sells for itself into its pool (`pair_pull_tax`)                   | 🔴 listed: `the pool paid out more WETH than the seller received N s after the buy`                               | `bun test -t "swaps 90 % of each sale"`  |
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
| Sells only at zero gas price or base fee (a simulator's defaults) (`sim_detector`)                                         | 🔴 listed: `sale refused N s after the buy`                                                                       | `bun test -t "only in simulation"`                    |
| Sells only after a call only a simulator sends (a top-level `balanceOf`) (`judge_trap`, `untouched_buyer`, `stranger_key`) | 🔴 listed                                                                                                         | `bun test -t "JudgeTrap"`                             |
| Sells only after an approve of 2^256 - 1, or a buy of exactly 0.01 ETH (`approve_max_only`, `buy_001_only`)                | 🔴 listed: the check runs the exact bytes the guard signs                                                         | `bun test -t "Trap2"`                                 |
| Sells only in the block right after the buy (`next_block_key`)                                                             | 🔴 listed: the first sale lands 2 to 25 s after the buy (10 to 125 blocks on Base)                                | `bun test -t "NextBlockKey"`                          |
| Sells only half or all of the balance (`amount_trap`)                                                                      | 🔴 listed: the first sale sells 13 % to 87 %                                                                      | `bun test -t "AmountTrap"`                            |
| Refuses a sale of 88 % to 99.99 % of the balance, what an agent's exit sells (`exit_size`)                                | 🔴 not listed: `exit-size sale (97 %) refused N s after the buy (…)`: every check also sells the agent's holding | `bun test -t "ExitSizeTrap"`                          |
| Sells only at the check's late block, or only at its far block                                                             | 🔴 the late sale is drawn 30 to 51 s after the buy, a far sale 301 to 900 s, beside the far sales at 301 s and 900 s; `replay --check` refuses a schedule the sentinel chose | `bun test -t "drawn in seconds"`, `-t "late sale chosen"`, `-t "far sale drawn"` |
| Tells a simulated block by its timestamp against its number                                                                | 🔴 not a tell: simulated blocks get the times real ones would have at the cadence measured, five a second on Base | `bun test -t "five share each second"`                |

Every draw comes from the check and the hash of its reference block, the first Base block 4 s after the
request on NEAR, which does not exist when the agent asks ([how](sentinel.md#sales-drawn-per-check)).

### State Base moves every block

A simulation keeps still what Base changes between a buy and a sale: the L1Block contract (Base's
record of Ethereum), the fee vaults, WETH's supply, the base fee, the Uniswap factory, the token's own pool.

| Attack                                                                                                    | Answer (exact reason)                                                                                         | Reproduce                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Sells only while L1Block is unchanged since the buy (the red team's) (`red_l1_trap`, `helper_trap`)       | 🔴 not listed: `reads 0x4200..0015, 0x8bde..9881 during a transfer: state no simulation reproduces`           | `bun test -t "RedL1Trap"`                  |
| Sells only while nobody else moves WETH's supply (`weth_key`), checked at the approve (`approve_key`)     | 🔴 not listed: `sale refused N s after the buy on Base's state of block B (…)` and `token calls or reads WETH …` | `bun test -t "keyed on state Base moves"` |
| The same, unless a pair was created between the approve and the swap, as the busy side did (`busy_tell`) | 🔴 not listed: the same, and `token calls or reads WETH and the V2 factory during a transfer: state all of Base moves` | `bun test -t "BusyTell"`                   |
| Reads WETH's or the guard's state without a call (BALANCE, EXTCODE*), in its own code or its implementation's, in the proxy's context or the implementation's own | 🔴 not listed: `token calls or reads WETH …`, `token reads the ETH balance of the guard during a transfer …`  | `bun test -t "reads an ETH balance"`, `-t "implementation in the proxy"`, `-t "STATICCALL from the proxy"` |
| Any of these, its pool traded by others during the check                                                 | 🔴 still blocked: others' trades are re-executed after the buy; when they cannot be, a sale refused there is a block | `bun test -t "its pool traded too"`, `-t "more trades of its pool"` |
| Marks the guard in its implementation's own storage when someone buys after it, then refuses its sale (`impl_mark`, judge pass 9) | 🔴 not listed: `sale refused N s after the buy on Base's state of block B (…)`: every slot of the token's own addresses is carried | `bun test -t "J9ImplMark"` |
| Upgraded during the check to code at a new address, which sells as before                               | 🔴 not listed: `reads 0x… during a transfer`: the later side is traced like the guard side | `bun test -t "upgraded during the check"` |

The first row is the [environment rule](sentinel.md#environment-rule). The others meet two answers:

- the [later side](sentinel.md#the-four-requests) runs the guard's sales again on the first real block
  16 to 24 s after the reference block, with the buy's state change applied: whatever Base did in
  between, before the approve too, with no recipe to recognise; others' trades of the pool are
  [re-executed](sentinel.md#others-trades-during-the-wait) after the buy;
- the token's own code may not call WETH or the factory, whose state all of Base moves: the factory
  got 16 V2 pairs in an hour measured on Base, too few for the window a check can wait.

### Values no simulation can match

| Attack                                                             | Answer (exact reason)                                                      | Reproduce                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------- |
| Code keyed on the base fee, coinbase, prevrandao… (`basefee_trap`) | 🟠 the owner decides: `code reads BASEFEE: values no simulation can match`; 🔴 not listed once the base fee moved before the later block (on the fork it falls every block) | `bun test -t "keyed on the base fee"` |

### What the token's own code did

Sampling sales does not converge: each review found the delay, the size or the state the samples missed.
So an `allow` also means that, on the guard's own buy, approves and sales, the token's code called nothing
but its implementation and the precompiles, ran no TIMESTAMP, NUMBER or SELFBALANCE, and created no
contract ([how](sentinel.md#environment-rule)).

| Attack                                                                                         | Answer (exact reason)                                                                                             | Reproduce                   |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Sales closed for everyone 20 min after the owner arms it, past the check's last sale (`late_close`) | 🟠 the owner decides: `token reads TIMESTAMP during a transfer: it can act otherwise after the check's last sale` | `bun test -t "LateClose"`   |
| The same, the time read from its own pool (`sync`, `getReserves`), no TIMESTAMP run (`pool_clock`) | 🟠 the owner decides: `token calls or reads its pool during a transfer: reserves and a clock any trade moves`    | `bun test -t "PoolClock"`   |
| Either one, bought: the sale goes through at once and fails 20 min later                        | what the `warn` is for                                                                                            | `bun test -t "fails 20 minutes later"` |
| Reads the time in the init code of a contract it creates, handed back as revert data           | 🔴 not listed: `token creates a contract during a transfer: code no rule reads`                                   | `bun test -t "init code runs TIMESTAMP"` |

Both got `allow` before: every sale a check draws goes through. A `warn`, not a `block`: an honest launch
cooldown reads the time too, and the owner decides with the reason in hand.

### Attacks on the guard's address

The guard's Base address is public: anyone can send it tokens or get a token to freeze it.

| Attack                                                              | Answer (exact reason)                                                         | Reproduce                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| A token that freezes only the guard's address (`guard_frozen`)      | 🔴 not listed: `guard address only, not listed: sale refused …`               | `bun test -t "freezes only the guard"`  |
| Closes the guard's sales only, 8 min after its buy (`guard_later`, judge pass 9) | 🔴 not listed, at every check: `guard address only, not listed: sale refused 900 s after the buy (…)` | `bun test -t "J9GuardLater"` |
| Sends the guard tokens during a check                               | 🟢 USDC stays `allow`: the transfer is re-executed after the buy              | `bun test -t "USDC sent to the guard"` |
| A sale that needs more gas than the guard signs with (`gas_hungry`) | 🔴 the simulation uses the guard's gas limit; the owner can raise it and sell | `bun test -t "more gas than the guard"` |

### Agent bypasses

| Attack                                                                 | Answer (exact reason)                                                                                                                | Reproduce                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| The agent injects a target, recipient, router or minimum into `buy`    | ignored: NEAR signs the swap the sentinel simulated                                                                                  | `./demo.sh`, moment 4                                   |
| The agent buys on a `block`                                            | `verdict does not allow the purchase`                                                                                                | `./demo.sh`, moment 1                                   |
| The agent calls the MPC signer or moves NEAR directly                  | NEAR protocol: `Access key receiver … does not match transaction receiver v1.signer-prod.testnet`, `Access key requires full access` | `./demo.sh`, moment 4                                   |
| The agent buys another amount than checked, or above the owner's limit | `amount is not the one checked`, `amount above the owner's per-buy limit`                                                            | `cargo test another_amount`, `cargo test per_buy_limit` |
| One signed model decision reused for a second call                     | `decision already anchored on check #n`                                                                                              | `cargo test digest`                                     |
| The agent asks again right after a `block`, or buys on an earlier `allow` | `target is quarantined after a block verdict`                                                       | `cargo test blocked_token`, `cargo test later_check_blocked` |
| Several checks of one token at once, as many draws                     | `a check of this target is already awaiting its verdict`                                                                             | `cargo test second_check_of_a_token`                    |
| Buys of one token beyond the owner's cap, by any agents                | `amount above what the owner's per-token cap leaves`                                                                             | `cargo test token_cap`                                  |
| A buy on a verdict from before the owner's emergency stop              | `check requested before the owner's stop: request a new check`                                                                       | `cargo test before_a_stop`                              |

### A lying sentinel

A sentinel is one NEAR key and its Base nodes (simulation, logs), with no TEE (trusted execution environment); its key can
only vote on checks. The guard takes votes from the sentinels its owner names: an `allow` or a `warn`
needs the quorum's identical votes, and any one sentinel blocks ([quorum](contract.md#sentinel-quorum)).

The demo guard has three sentinels, two needed. What one stolen key, or one lying node, gets:

| One sentinel alone                                      | Answer                                                                                  | Reproduce                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| Posts `allow` on a trap                                 | no verdict on one vote; another sentinel's `block` decides, and overturns an `allow` until its buy is sent to signing | `cargo test one_allow_vote`, `cargo test vetoes` |
| Posts `allow` with another quote, transaction or code   | 🔴 the votes disagree: `sentinels disagree on …`, not listed, nothing quarantined       | `cargo test disagree`                      |
| Posts `block` on an honest token                        | 🔴 that check is blocked and the token quarantined 30 min, before or after the others' `allow` (within 180 s of the request); **not stopped**, the owner lifts it and replaces the key | `cargo test single_block_vote` |
| Asks to list an honest token                            | not listed: listing takes the quorum's identical `block` votes                          | `cargo test listing_takes_the_quorum`      |
| Posts a low exit quote, or a `block` on one             | the median of the three quotes stands; a block is no quote, and costs a 15 s wait for the two others' quotes. A low quote stands only after 60 s with no other sentinel quoting (down, or its simulation failing) | `cargo test median_of_three`, `cargo test does_not_refuse_an_exit`, `cargo test does_not_make_an_exit_ready` |
| Posts an exit quote above what the pool pays            | the three answering: the sale waits for the three quotes and the median stands. **Not stopped** when another sentinel does not quote within 15 s: the higher of two stands, the sale reverts on Base, the agent's charge is spent and its holding stays debited until the owner restores it; no token lost | `cargo test before_the_third`, `cargo test costs_one_exit` |
| Posts an exit quote while both others are down          | **not stopped**: after 60 s one vote is enough, so that sentinels down never block a sale; that key then sets the floor | `cargo test enough_60_s` |
| Voted, then is removed by the owner                     | its votes count no more, at once: no quorum, no buy, no approval, no sale on them      | `cargo test removed_sentinel`              |
| Posts `block` on an old check, to quarantine again a token the owner lifted | refused: a check takes votes for 300 s from its request, an `allow` a block for 180 s | `cargo test older_than_300_s`, `cargo test too_old_to_buy` |

Two sentinels lying together are the quorum: they get what one got before it. What replay then shows, afterwards:

| Lie                                                     | Answer                                                                                  | Reproduce                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Asks to list an honest token                            | `replay --check`: `on-chain list_target true != evidence.list_target false`             | `bun test -t "list_target true"`                           |
| Chooses the block, the probes, the sales or the later side's block | `replay --check` refuses them: the block must be the request's reference block, the rest derive from its hash | `bun test -t "reference block\|chosen by the sentinel\|the sentinel chose"` |
| Judges a farm on an index window that misses its pools  | `replay` reports a `MISMATCH`: the window must start 2 h before the check's block and end at it | `bun test -t "index window"`                               |
| Leaves out a trade of the pool it should re-execute     | `replay` reports a `MISMATCH`: it fetches the trades again from the node                 | `bun test -t "leaves out a trade"`                         |
| States another cadence                                  | `replay` reports a `MISMATCH`: it measures the cadence again at the block               | `bun test -t "cadence other than"`                         |
| Forges a simulation result or a fact                    | `replay` resends the requests and recomputes every fact                                 | `bun test app/replay.test.ts`                              |
| Post `allow` on a trap, two of them                     | **not stopped**: bought if the agent buys within 120 s, at most the owner's per-token cap per period; replay shows the lie afterwards, from each proof file | see below                                                  |

The owner replaces a compromised key with `set_sentinels`: from that call its votes count no more, on
the checks it already voted on too ([votes that count](contract.md#sentinel-quorum)).

**The demo deployment, plainly.** Three keys are not three independent parties: here one operator
runs the same program three times on one machine.

| Demo guard                        | As deployed                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Sentinels, quorum                 | three accounts and keys; two matching votes for an `allow` or a `warn`, one `block` vote blocks     |
| Machines, operators               | one machine, one operator, one OS user that holds the three keys                                    |
| Code                              | the same program for all three ([`app/sentinel.ts`](../app/sentinel.ts))                            |
| Base nodes, `./demo.sh`           | all three read the one local fork, the only node holding the demo tokens                            |
| Base nodes, `./check-mainnet.sh`  | 1: `mainnet.base.org`, logs from `base.public.blockpi.network`; 2: `base-rpc.publicnode.com`; 3: `base.rpc.blxrbdn.com`. Four providers, none read by two sentinels |
| What the quorum tolerates         | one sentinel down; one key stolen alone; on real Base, one provider that lies or lags              |
| What it does not                  | the machine, its OS user or the operator compromised (all three keys); a bug in the shared program; two providers lying alike; on the fork, the fork's node |

A real deployment gives each sentinel its own machine, operator and providers (`EVM_RPC`, `INDEX_RPC`);
only then is one lying node or one stolen key alone.

### Honest tokens

| Token                                       | Answer                                                                                       | Reproduce                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| USDC on the fork                            | 🟢 `allow`; the guard builds the swap, NEAR signs it, the relay broadcasts it to the fork    | `bun test -t "USDC, healthy"`, `./demo.sh` |
| USDC on the fork, its pool traded by others while the check waits | 🟢 `allow`: their trades re-executed after the buy, the resale verified      | `bun test -t "their trades re-executed"`   |
| An honest 30-block cooldown (`cooldown_60`) | 🟠 `warn` naming NUMBER, which its code reads; 🔴 not listed when the first sale is drawn within 30 blocks (about 1 check in 6 on Base, every check on the fork) | `bun test -t "Cooldown60"`                 |
| An honest one-block hold (`hold_one_block`) | 🟠 `warn` naming NUMBER and TIMESTAMP; its resale goes through, the owner approves           | `bun test -t "holding block"`              |
| USDC on Base mainnet, read only             | 🟢 `allow` on two sentinels' votes, each on its own nodes (check #19): reputation not applied, its pool predates the index window; nothing signed. When its pool trades during the wait, those trades are re-executed after the buy, or a `warn` says the resale was not verified | `./check-mainnet.sh`                       |

A refused sale lists the token only if the far sale at 900 s is refused too: a refusal that clears with
time blocks that check alone, or any agent could repeat checks until one lists an honest token. The
price: a trap that refuses sales only until 15 min after the buy is blocked at every check but never
reaches the shared blocklist; an honest token that refuses sales for more than 15 min after a buy is
listed.

## What it does not stop

- **A quorum of sentinels lying, or all on one machine.** An `allow` two of the three post on a trap is bought if
  the agent buys within 120 s, up to the owner's per-token cap. Replay shows a forged simulation, a block
  or draw they chose, or an index window not bound to the check, only afterwards, and only from the proof
  files (a sentinel may withhold its own) and a node that still serves both blocks' state.
- **Nodes that lie alike.** Each sentinel believes the nodes it reads. `./check-mainnet.sh` gives each
  its own simulation and logs nodes, four providers, none read by two sentinels, each logs node tied to
  its simulation node by block hash; on the local fork all read the fork. Two sentinels whose nodes lie
  alike post the same wrong verdict: the quorum.
- **One sentinel blocking.** A stolen key blocks every buy and quarantines the tokens it votes on,
  until the owner replaces it; a sentinel whose node fails blocks the checks it cannot simulate, without
  quarantine (one that is down stops nothing: two votes decide). An exit another sentinel quotes is not
  refused by one key.
- **A lying exit quote.** With the three sentinels answering, the sale waits for the three quotes and
  the median stands. With two quotes (the third not in within 15 s), the higher: one key can post one
  above what the pool pays, and the agent's sale reverts on Base (charge spent, holding debited until
  the owner restores it). With no other sentinel quoting, one vote is enough after 60 s, so that
  sentinels down never block a sale: that key then sets the floor (minimum output), or leaves the exit
  without a quote. Replay catches it afterwards.
- **What a token does after 900 s.** `eth_simulateV1` reaches 256 blocks past a real block, 51 s at
  Base's five blocks a second; the far sales play the late sale again 301 s and 900 s after the buy, and
  at a delay drawn between, on a local fork. A sale closed or taxed from 5 to 15 min on, for anyone or for
  the guard alone, is caught at every check (`bun test -t "5 minutes"`, `-t "J9GuardLater"`). From 15 min
  on, a token whose own code read the time or its pool on the guard's transactions is a `warn`; one that
  read neither there passes (a time test in a branch they never took, behind a flag set later or reached
  once others traded). Nor is an owner action after the buy stopped (pause, tax, blacklist; any admin,
  not only `owner()`).
- **A holder of most of the supply.** It sells into the pool with no trap in the code: the check reads
  who holds the LP, never who holds the token.
- **Old liquidity.** LP that already existed an hour before the check is not read: its holders can
  still remove it.
- **What Base does during those minutes.** The far sales run on a frozen copy of the reference block:
  others' trades, WETH, L1Block and the base fee stay as they were. A token keyed on time and on state
  Base moves together passes them; the later side sees 16 to 24 s of real Base.
- **Sizes and delays the check did not draw.** A sale refused only below some share, or only during a
  window that reopens before 900 s and misses the drawn delays, passes. A refusal in force at 301 s or
  at 900 s is met at every check, and so is one of the share an agent's exit sells (97 %), at the late
  sale's time; an agent exits when it chooses.
- **Asking again, later.** One check per token runs at a time, and a `block` that rests on the token's
  code quarantines it for every agent, 30 min by default: a re-draw after such a block costs that wait.
  A `warn`, a disagreement between sentinels or a check that could not run quarantines nothing: no
  sentinel found a refusal, and the agent asks again at once, for one price
  ([why no cool-down](contract.md#limits)). After a quarantine it may ask again too, with new draws
  ([token limits](contract.md#token-limits)).
- **State that does not move within the later side's window.** A token keyed on its own pool or storage
  passes when nobody touched them during those 16 to 24 s, and fails once someone does. Others' trades of
  the pool are re-executed after the buy, without the transactions before them in their block; when that
  cannot be built (on Base's USDC/WETH pool, in 4 of 7 windows with a trade; in the one inspected, an
  arbitrage contract whose balance other transactions of the block also moved), the resale is not
  verified: a `warn` when it goes through there, a `block` (not listed) when it does not. A trap can force
  that `warn`: eleven trades of its pool, or others' trades whose gas runs out once it does more after the
  buy. Dust sent to the guard is re-executed like a trade; dust plus ten trades of an honest token's pool
  block that check. A transaction that touched neither the pool nor a footprint slot stays as Base ran
  it, even if it would have acted otherwise after the buy.
- **Front-running.** The signing request and the signed transaction are public on NEAR before anyone
  broadcasts them: a token owner can react before the swap's 300 s deadline.
- **A rug by liquidity removal.** A token that sells normally and whose liquidity is pulled, or whose
  reserve is dumped, shows nothing to a buy-and-resale simulation. It gets the `warn` for removable
  liquidity that an honest fresh launch gets too; a `block` only when its template has drained pools
  before. On 96 real launches that was every bad outcome: 73 blocked by reputation, 8 `warn`
  ([corpus](corpus.md)).
- **Template evasion.** A template is the code with `PUSH32` operands and metadata masked: changing any
  other constant makes a new one. Fewer than 3 earlier pools give no finding: the first pools of a
  family pass the reputation rule (8 bad outcomes in the corpus, all `warn`).
- **A farm near the threshold.** The reputation block had a thin margin on the farm measured: 0.82 to
  1.00 of its earlier pools drained, against the 0.80 threshold. A farm that pulls later, or launches
  more often, would fall under it; one that funds under 0.5 ETH is not counted at all.
- **A pool funded before the index window.** It is not judged by reputation (its reasons say so); a
  lying sentinel can still drop a farm's pools funded more than 2 h before the check.
- **The model's decision.** Its digest is optional: a compromised agent can omit it or attach another.
- **Operations.** One signature at a time for all agents; a fixed NEAR/ETH rate, no oracle; only Uniswap
  V2 WETH pools; an exit that reverts on Base keeps the agent's holding debited until the owner restores it.
  A refund of an agent's failed exit waits while another agent holds the token, and fees withdrawn
  between a verdict and its buy can leave that buy's storage to the credits
  ([contract](contract.md#recovery)).
- **Base mainnet.** A transaction signed for chain 8453 is valid there: never fund the guard's address.
  The relay broadcasts only to a local anvil.

Each limit, with the code that sets it: [contract](contract.md#limits), [sentinel](sentinel.md#what-a-check-cannot-show).

## Closed after review

Nine judge runs, a red team, automated reviews and our own security passes found the bypasses below.
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
| A compromised sentinel key could not be revoked                                                   | `set_sentinels` (first `set_sentinel`), owner only, logged                                                |
| A sale only after a top-level `balanceOf`, which only the simulation sent (fifth run's JudgeTrap) | the guard side holds the guard's own transactions alone; every other call runs in a request of its own    |
| Simulated blocks told apart from real ones (timestamps, one prevrandao for all)                   | every block up to the late sale listed, a prevrandao per L1 epoch; since batch 9, the cadence measured     |
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
| A token could sell only at the check's late block, always 255 blocks after the buy                | the late sale is drawn per check (now 30 to 51 s); `replay --check` refuses a chosen one                  |
| Judge pass 7's WethKey: one unrelated `WETH.deposit()` froze every sale                           | first a busy side (a fixed recipe of others' activity), replaced in pass 8, below                         |
| A sentinel could judge a farm copy on an index window that missed its earlier pools               | the window must start 2 h before the check (2,000 blocks until batch 9); since pass 8 it ends at the check's block |
| An honest 30-block cooldown was listed whenever the first sale was drawn within it                | a refused sale lists only when the late sale is refused too                                               |
| Judge pass 8's ApproveKey and BusyTell: the busy side's recipe, keyed around or recognised        | the later side, on a real block mined 16 to 24 s on; the token's code may not call WETH or the factory     |
| The sentinel could pick any block from 60 s before the request to 60 s after its verdict, and so the draws | the reference block is the first block 4 s after the request; `replay --check` recomputes it              |
| An index window could end 300 blocks before the check and drop a farm's newest pools              | the window ends at the check's block                                                                      |
| Base mines five blocks a second, the check counted 2 s a block: every span a tenth of what it said, simulated blocks spaced as no real block | every rule in seconds, turned into blocks with the cadence measured at the reference block; replay measures it again |
| An honest token was capped at `warn` whenever someone traded its pool during the check             | others' trades re-executed after the buy, block by block, checked against Base; replay fetches them again   |
| Replay traced a proof's request on a local fork before checking it was the sentinel's              | the trace runs only once the requests are rebuilt and match                                               |
| A token reading WETH's or the guard's state without a call (BALANCE, EXTCODE*) escaped the rule    | a tracer records what the token's own code calls or reads; an ETH balance read is a `block`               |
| A resale on a merge of Base's and the buy's values read as a verified one                          | its reason says `resale not verified`, a `warn` when the sale goes through there                          |
| Base's 0.2 s blocks cut the check's last sale to 51 s: a sale closed or taxed from 5 min got `allow` | the far sale: the late sale again 301 to 900 s after the buy, drawn per check, on the trace's local fork |
| A trap forcing that merge (a write to a slot the buy wrote, eleven trades of its pool) turned its refusal there into a `warn` | a refusal there is a `block`, not listed; a lone slot moved with no trade (dust sent to the guard) gets both changes, decided by no value the token returns |
| A token reading WETH or a balance from its implementation's own context (a plain call to it) escaped the rule | the tracer records every frame running the token's or its implementation's code, whatever the context |
| Judge pass 9's J9ImplMark: a mark written in the implementation's own storage when others traded was not carried to the later side | every slot of the addresses the token's code may read with no finding is carried, the rule's own set |
| Judge pass 9's J9GuardLater: a refusal for the guard alone from 8 min on was escaped by requesting checks until the far sale was drawn earlier | the far sale also runs at both ends of its range, 301 s and 900 s, at every check |
| The later side was not traced: a token could act differently there unseen (a proxy upgraded during the check) | the later side runs on a local fork too, traced by the same rule |
| Dust sent to the guard was merged as a sum, exact for a balance only: another slot could turn a block into a warn | no value is summed: transfers to or from the guard are re-executed after the buy; any other slot keeps Base's value |
| The tracer's stack of code addresses could lose its place on a frame that enters without exiting | a frame's code is found by its depth |
| Design review: a check that samples sales does not converge, each pass found the delay, size or state it missed | an allow-list for the token's own code on the guard's transactions: it calls only its implementation and the precompiles and runs no TIMESTAMP, NUMBER or SELFBALANCE, or the verdict is at most `warn` |
| A token keyed on its own pool (its reserves, or `sync()` then `getReserves()` for the time) had no finding | its own code reaching its pool or the router is a `warn` naming it |
| A gap of empty blocks left to the local fork's clock could end past the next block's time on a slow node: the check failed | a gap starts at the time of the block before it |
| An agent could ask again until a draw missed a trap, N checks at once were N draws, and one trap could take every armed budget | a quarantine after a block on the token's code, one check per token, a cap per token for all agents ([token limits](contract.md#token-limits)) |
| One sentinel key, or the one node it read, was enough for an `allow` on a trap                    | a quorum of sentinels: identical votes for an `allow` or a `warn`, any one blocks, listing takes the quorum |
| The sentinel alone could `report` any token to the blocklist                                      | a sentinel is no reporter: its votes list with the quorum                                                 |
| No sale was the size an agent's exit sells (its holding, 97 % of the balance): a token refusing 88 % to 99.99 % passed every check | every check also sells exactly that share, the guard's slippage bound read from the guard; replay recomputes it |
| Both sentinels read one Base node, and the logs (index, LP holders) a node nothing tied to the simulation's | each its own nodes on Base, four providers for three sentinels, none read by two; each logs node must give the check's block and the index window's start the simulation node's hashes |
| A restarted sentinel voted on old checks, fork checks too from a mainnet run                       | a sentinel votes only on checks requested since it started, and only while the guard says its vote is due (`vote_due`) |
| A removed sentinel's vote still completed a quorum; a `block` after the quorum's `allow` was refused, and the buy went through | votes are weighed when used, the current sentinels' only; a `block` overturns an `allow` until its buy is sent to signing, and every `block` on the code quarantines |
| A `block` on an hour-old check quarantined again a token the owner had lifted                      | a check takes votes for 300 s from its request, an `allow` a `block` for 180 s                            |
| One key refused an agent's exit with a `block`, or set its floor with a low quote                  | every sentinel quotes: the median of three stands, the highest of fewer; a `block` is no quote            |
| With two quotes of three in, a liar's high quote sold at once, before the median applied           | an exit sells once every sentinel quoted, 15 s after its request on the quorum's quotes, 60 s on one vote |
| An `allow` still bought after a later check's approved `warn` had moved the token's reference code | `buy` refuses a check whose code is no longer the reference                                               |
| After the guard's nonce moved, one fresh exit quote sold on the older votes and the time elapsed   | such an exit quote takes no more votes and never sells; the agent asks another, quoted afresh by all     |
