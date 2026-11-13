# Contract

The guard is one NEAR contract, [`src/lib.rs`](../src/lib.rs) (near-sdk 5). It holds each agent's
prepaid credit and armed budget, stores checks and verdicts, keeps the shared blocklist, and builds every
Base transaction that NEAR Chain Signatures signs for its address.

## Contents

- [Roles and keys](#roles-and-keys)
- [Methods](#methods)
- [Events](#events)
- [What NEAR enforces](#what-near-enforces)
- [Sentinel quorum](#sentinel-quorum)
- [Token limits](#token-limits)
- [Accounting](#accounting)
- [Signing](#signing)
- [Recovery](#recovery)
- [Upgrade policy](#upgrade-policy)
- [Limits](#limits)

Names: the repository is `near-preflight`; the Cargo package (and the string the probes derive from) is
`goblin-near` and the event standard `goblin_guard`, earlier working names kept because renaming them
would change the deployed contract and every recorded proof.

## Roles and keys

| Role     | Key                                                                                      | Can                                                                             |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Owner    | full-access key of the account named at init (a human)                                   | bounds, token limits, roles and sentinels, emergency stop, approve a `warn`, unlist, sell, withdraw, settle |
| Armer    | function-call key: `arm`, `disarm`                                                       | arm a registered agent within the owner's bounds                                |
| Agent    | function-call key: `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted` | ask checks, buy on `allow`, sell its holding                                    |
| Sentinel | function-call key: `post_verdict`, one account and key per sentinel (three in the demo)  | vote on checks and post exit quotes, with their hashes                          |
| Relay    | none                                                                                     | read a signed transaction, check it, broadcast it (here only to anvil)          |

The owner's CLI is [`app/human.ts`](../app/human.ts):

```sh
bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei>
    | sell <token> <amount> [min wei] [max | 0x approve] | unlist <token>
    | holding <token> <agent> [amount] | gas <limit> | replace <nonce> | clear <nonce> refund|spent | release
    | lift <token> | quarantine <seconds> | cap <wei> <period s> | sentinels <quorum> <account>...
```

**Function-call keys.** [`app/setup.ts`](../app/setup.ts) gives each role a key limited to the guard and
its methods, with a gas allowance: 0.5 NEAR for the agent, 0.25 NEAR for the others.

The allowance is not money moved: it caps the gas the key may buy. NEAR reserves the attached gas against
it (about 0.1 NEAR for a `buy` at 100 TGas, 0.15 NEAR for `sell_quoted`) and gives back what was not burnt.

Measured: 10 agent transactions, 3 of them signed buys, took 0.0045 NEAR of the agent's 0.5.

When the free allowance is too low, NEAR rejects the transaction before it reaches the guard:
`Not enough allowance for access key ... (allowance: 0.01 NEAR, cost: 0.0309 NEAR)`.

The allowance cannot be raised in place. The account's full-access key deletes the key and adds a new
one, whose private key goes in `.env.agent`:
`near account add-key <agent> grant-function-call-access --allowance ... --contract-account-id <guard> --function-names ...`.

A sentinel's key pays the gas of every vote on a check agents pay for, so an agent sending paid checks can
exhaust its 0.25 NEAR.

Verdicts then stop until the owner gives the sentinel a new key; unjudged checks
are refunded after 300 s (`refund_check`). An operational limit, not a bypass: no verdict means no buy.

## Methods

| Caller           | Methods                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployer, once   | `new`                                                                                                                                                                                                                                                                                                          |
| Agent            | `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted`                                                                                                                                                                                                                                          |
| Sentinel         | `post_verdict`: one vote per sentinel (with `list_target`, the quorum's `block` lists the token)                                                                                                                                                                                                               |
| Armer            | `arm`, `disarm` (no freeze)                                                                                                                                                                                                                                                                                    |
| Owner            | `set_bounds`, `register_agent`, `set_sentinels`, `set_armer`, `set_reporter`, `disarm` (freezes), `unfreeze`, `reset_armings`, `approve_warn`, `unlist`, `sell`, `withdraw_eth`, `withdraw_fees`, `set_evm_gas`, `set_holding`, `sign_replacement`, `clear_unsettled`, `release_signing`, `set_quarantine`, `set_token_cap`, `lift_quarantine` |
| Reporter         | `report`                                                                                                                                                                                                                                                                                                       |
| Anyone           | `deposit_credit` (payable), `refund_credit` (own credit)                                                                                                                                                                                                                                                       |
| The guard itself | `on_signed`, `on_exit_signed` (MPC callbacks)                                                                                                                                                                                                                                                                  |
| Views            | `get_check`, `last_check_id`, `decision_of`, `preview_check`, `preview_sale`, `get_entry`, `list_entries`, `last_code`, `holding`, `credit_of`, `budget_left`, `armed_7d`, `bounds`, `evm_config`, `fees`, `escrow`, `credits_total`, `is_frozen`, `stopped_at`, `signing_since`, `last_exit`, `get_unsettled`, `token_limits`, `quarantined_until`, `pending_check`, `token_bought`, `sentinels`, `vote_due`, `exit_ready` |

Each method's contract is its doc comment in `src/lib.rs`.

## Events

NEP-297 logs (`EVENT_JSON:`), standard `goblin_guard`. The
[journal](https://cmoron.github.io/near-preflight/journal.html) reads them.

| About     | Events                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Roles     | `armed`, `disarmed`, `frozen`, `unfrozen`, `armer_changed`, `sentinels_changed`, `armings_reset`, `reporter_set` |
| Checks    | `check_requested`, `verdict_posted` (one per vote: the sentinel, its full evidence string, the votes so far and what they decide), `verdict_decided` (votes already in, decided at the buy or the approval after the owner lowered the quorum), `check_refunded`, `warn_approved` |
| Blocklist | `listed`, `unlisted`                                                                                            |
| Limits    | `quarantined`, `quarantine_lifted`, `quarantine_set`, `token_cap_set`                                           |
| Signing   | `sign_requested`, `signed`, `exit_requested`, `exit_signed`                                                     |
| Recovery  | `sign_unsettled`, `unsettled_cleared`, `signing_released`, `holding_set`, `evm_gas_set`                         |

## What NEAR enforces

| Rule                                                                                                                       | By                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Only the agent's function-call key acts for it, and only on the guard                                                      | NEAR protocol                         |
| A buy needs an `allow`, or a `warn` the owner approved, within 120 s of the verdict and 180 s of the check's request       | `buy`, `approve_warn`                 |
| A buy is of the amount stated at the check, at most the owner's per-buy limit, within the budget                           | `request_check`, `buy`, `set_bounds`  |
| The guard builds the swap: chain 8453, router, path, recipient = its address, gas, fees, floor                             | `buy`, `preview_check`                |
| An allow or warn carries the hashes of what the guard would sign; it signs nothing else                                    | `post_verdict`, `buy`                 |
| A buy needs a token neither listed nor quarantined, whose code is still the reference its verdict saw; signed within 180 s of the request, it has 120 s left to its deadline | `buy` |
| A `block` vote that carries the token's code quarantines it, listed or not, whatever was decided before it: no check, no buy, for any agent, 30 min at init | `post_verdict`, `request_check`, `buy` |
| One buy check per token awaits its verdict, for all agents; the slot frees at the verdict, the refund, or after 300 s     | `request_check`                       |
| All agents together buy at most the owner's cap of one token per rolling period; zero at init: no check until it is set   | `request_check`, `buy`, `set_token_cap` |
| Only the owner sets the quarantine (10 min to 24 h) and the cap's period (1 h to 7 days), and lifts a quarantine          | `set_quarantine`, `set_token_cap`, `lift_quarantine` |
| A buy's value plus gas at the cap is debited from the armed budget and the prepaid credit                                  | `buy`                                 |
| A sale never needs buying budget: an exit's quote and gas come from the agent's credit (a frozen agent cannot ask for one) | `request_exit`, `sell_quoted`         |
| A token at the guard's address is held for one agent at a time                                                             | `buy`, `holding`                      |
| Only the owner clears or reassigns a token's holding, never during a signature                                             | `set_holding`                         |
| An agent sells at most its holding, on the sentinels' exit quote (the median of three, the highest of fewer), at most 120 s old, used once, 60 s before its swap deadline | `request_exit`, `sell_quoted` |
| An agent's exit signs only the approve and swap its exit quote simulated                                                   | `sell_quoted`                         |
| The owner sells any token, amount, floor and approve (up to 2^256 - 1), no quote, no budget                                | `sell`                                |
| The owner sets gas limit and fees within bounds, never during a signature                                                  | `set_evm_gas`                         |
| Only a sentinel votes, once per check, within 300 s of its request and never once it is sent to signing, with the sha256 of its evidence; the owner names the sentinels and the quorum | `post_verdict`, `set_sentinels` |
| A vote counts only while its sentinel is one of the guard's: a sentinel removed stops counting at once, on the checks it voted on too | `post_verdict`, `buy`, `approve_warn`, `sell_quoted` |
| An `allow` or a `warn` takes the quorum's votes, identical on verdict, quote, transaction hashes, code and listing; the quorum is the one in force when the vote, the buy or the approval comes | `post_verdict`, `buy`, `approve_warn` |
| One `block` vote blocks at once, and overturns an `allow` or a `warn` that can still buy (180 s from the request, not yet sent to signing); votes that disagree block too; the 120 s run from the vote that completes the quorum | `post_verdict` |
| An exit quote takes every sentinel's vote: the median of three quotes stands, the highest of fewer; a `block` never cancels another sentinel's quote; it sells once every sentinel quoted, 15 s after the request with the quorum's quotes, or 60 s after it with one vote | `post_verdict`, `sell_quoted` |
| An exit quote whose transactions the guard no longer signs (its nonce, gas or fees moved) takes no more votes and never sells: the agent asks another | `post_verdict`, `sell_quoted` |
| A block lists its token only with the token's code and the quorum's identical `block` votes, each asking to list           | `post_verdict`                        |
| Blocklist: tokens only, never a template; entries never overwritten; only the owner unlists; a sentinel is no reporter     | `report`, `unlist`                    |
| An `allow` on code that differs from the reference is refused                                                              | `post_verdict`                        |
| Arming within the owner's bounds (per arming, duration, 7-day cap), registered agents only                                 | `set_bounds`, `arm`                   |
| Arming refused if the agent's credit dropped below what the armer read (a top-up is fine)                                  | `arm`                                 |
| Emergency stop: `disarm` by the owner freezes the agent until `unfreeze`, and voids every check requested before it        | `disarm`, `unfreeze`                  |
| One signature at a time; one that does not come back keeps its nonce, charge and tokens                                    | `on_signed`, `on_exit_signed`         |
| A slot whose callback never ran is released by the owner after 600 s, its transactions reserved                            | `release_signing`                     |
| Only the owner replaces a transaction, at a reserved nonce only, and settles it                                            | `sign_replacement`, `clear_unsettled` |
| A decision digest backs one call: a digest already anchored is refused                                                     | `request_check`, `buy`                |
| A check's price is at least its worst-case storage, 2,450 bytes (0.0245 NEAR), measured by tests                           | `new`, `request_check`                |
| Fees leave only while the balance left pays for storage, every credit and the escrow                                       | `withdraw_fees`                       |

## Sentinel quorum

One sentinel is one key on one machine reading one Base node: stolen or lied to, it posts an `allow` on a
trap. The owner names up to three sentinels and a quorum (`set_sentinels`; one at init, as before).

`post_verdict` is a vote, one per sentinel. The check's verdict is set once the votes decide:

- **Allow or warn**: `quorum` votes identical on the verdict, the quote, the transaction hashes, the
  code and `list_target`. The verdict's 120 s run from the vote that completes the quorum.
- **Block**: one `block` vote, at once. Any sentinel that has not voted vetoes an `allow` or a `warn`
  already decided too (so never when the quorum equals the number of sentinels), while that verdict
  can still buy: within 180 s of the request and until the buy is sent to signing. A signature
  requested is not recalled: a check sent to signing takes no more votes, whether its signature came
  back or its nonce is reserved.
- **Disagreement**: a vote that differs on any of those fields blocks too, lists nothing and
  quarantines nothing (no sentinel found a refusal). Reasons: `sentinels disagree on …`.
- **Listing**: the quorum's `block` votes, identical, each asking to list. One key lists nothing, and a
  sentinel no longer has the reporter's right to `report`.

**Why those fields and not the evidence.** The reference block is fixed by the request and every draw
derives from its hash, so two honest sentinels on two nodes simulate the same thing: same quote, same
transactions, same code, same listing. Their evidence strings can still differ by a byte (the NEAR facts
each read at its own moment), so each vote's sha256 is stored and none is compared.

**Votes that count.** A vote counts while its sentinel is one of the guard's. `set_sentinels` takes
effect in its own block, with no delay: `buy`, `approve_warn` and `sell_quoted` count the votes again,
so a vote from a sentinel removed since (a stolen key) makes no quorum, on the checks it already voted
on too. The guard cannot walk its checks, so nothing is rewritten at the change: a vote is weighed
when it is used, and the next vote on a buy check drops the removed sentinels' votes (their
`verdict_posted` events stay). A check never holds more than three votes; after the owner shrinks the
set, it keeps its old votes until its next vote, stored and not counted.

**Votes have a time limit.** A check takes votes for 300 s from its request: after it, a check
without a verdict is refunded and a decided one is too old to buy, so a vote would only quarantine
again a token the owner has lifted since. A late vote is refused with `verdict already posted`.

**A quorum changed while a check waits** is the one its votes are weighed with. Raised: one more
vote is needed. Lowered: the next vote decides; when none is left to come, the agent's `buy` (or the
owner's `approve_warn`) decides with the votes in, within 180 s of the request (event
`verdict_decided`, the 120 s run from that call), and the token's slot is free at once. A verdict
decided under a lower quorum, or that lost a vote, neither buys nor is approved: `verdict below the
sentinels' quorum`.

**Exit quotes.** Two sentinels quote an exit at two Base blocks: their quotes differ, so no identical
vote can be asked for. Every sentinel may vote until the exit is sent to signing, and:

- with **three** `allow` quotes in, the **median** stands: one liar moves the floor neither way;
- with fewer, the **highest** stands. With two quotes no rule resists one liar both ways: a floor too
  high makes the sale revert on Base, the tokens still held; a floor too low lets the pool's next
  trader take the difference;
- a `block` never cancels another sentinel's quote, and is no quote;
- a quote is of the transactions simulated. Once another signature moved the guard's nonce, or the
  owner its gas, under a quote already posted, the sentinels that quoted cannot quote again: the exit
  quote takes no more votes and never sells (`sell_quoted` refuses it, `exit_ready` is true), and the
  agent asks another, which every sentinel quotes afresh. A later quote never stands on older votes;
- a quote a sentinel removed since voted on no longer sells: the agent asks another.

**When it sells** (`sell_quoted`, view `exit_ready`), counting quotes only:

- at once, when **every** sentinel's quote is in: one key never sets the floor while the others
  answer;
- 15 s after the request, with the **quorum's** quotes: a sentinel that is down, or whose simulation
  fails, costs an exit a short wait. An exit quote simulates in 0.5 to 2 s on real Base, plus the
  sentinel's 2.5 s poll and about 2 s for the vote's inclusion on NEAR: an honest quote was in within
  6 s, and later than 15 s only while the public NEAR RPC rate-limited the sentinels
  ([measured](latency.md));
- 60 s after the request, with **one** vote: no sentinel down ever refuses an exit. A lone `allow`
  quote then stands even when the two other sentinels voted `block` (their simulation failed): a
  `block` is no quote.

With two sentinels, both needed, that is both quotes or the 60 s. The quote's 120 s run from the
first quote.

**What one stolen key can still do**, until the owner replaces it:

- on a buy check less than 300 s old: block it, before or after the others' `allow` (within 180 s,
  until the buy is sent to signing), and quarantine its token. No `allow`, no `warn`, no listing.
  A `block` arriving once the buy is at the signing network is refused: it neither quarantines nor
  lists;
- on an exit, three sentinels all answering: nothing. The sale waits for the three quotes and the
  median stands; a `block` or no vote from that key delays it by 15 s, on the others' quotes;
- on an exit, three sentinels of which another does not quote within 15 s, or two sentinels: post
  the higher of two quotes. The sale reverts on Base, the agent's charge is spent and its holding
  stays debited until the owner [restores it](#recovery): one exit lost per holding, no token lost,
  and the owner's `sell` takes no quote;
- on an exit, two sentinels: post a `block`, or nothing, which delays the sale to 60 s after the
  request (the other sentinel's quote then stands);
- on an exit no other sentinel quotes within 60 s (down, or its own simulation failing): set its
  floor with a low quote, or leave it without a quote.

An account removed and named again counts again on the checks it voted on, unless a vote since
dropped its own (those less than 180 s old still buy; `cargo test named_again`): after a theft, name
another account.

**For a sentinel process.** `vote_due(id, sentinel)` says in one call whether its vote on a check
can still count. False once it voted, once the check is 300 s old, signed, reserved or being signed;
for a block that holds the quorum's votes; for an `allow` or a `warn` once 180 s have passed since
its request; always false for an account that is not a sentinel. True for an exit quote until then
(every quote counts toward the floor), unless the guard's nonce or gas moved under a quote posted. A restarted sentinel skips every old check on it, and the guard
refuses the same votes with `verdict already posted`.

**What it costs.** A vote that arrives after another signature moved the guard's nonce carries other
transaction hashes: that check blocks (no quarantine) and the agent asks again. One sentinel down, or
its node failing three times (a fail-closed `block` vote), stops every buy: the quorum fails closed.

With three sentinels and a quorum of two, the first two votes decide and one sentinel down stops
nothing; the third is not waited for, and its `block` still stops the buy when it comes before the
agent buys.

## Token limits

A check samples sales at drawn delays and sizes; a design review after several review passes concluded that sampling
alone does not converge. So the contract bounds what any wrong `allow` costs, whatever missed the trap: a
draw, a rule, or a lying sentinel.

**Quarantine.** A `block` vote that carries the token's code, on a buy check, keeps its token from
being checked or bought, by any agent, until `now + quarantine_s` (30 min at init; the owner sets
10 min to 24 h, never zero). In every order the guard takes the vote in: as the first vote, after a
fallback block or a disagreement already decided the check, or after the quorum's `allow`. A later one
never shortens a quarantine already running. Listed or not: a block that lists nothing is the one an
agent would otherwise ask again until a draw misses the trap.

Two blocks quarantine nothing, because no sentinel found a refusal: the fail-closed fallback, posted
without the token's code when a simulation could not run (a node that times out must not close an
honest token), and a disagreement between votes that are not blocks.

- `buy` refuses a quarantined token too: an `allow` no longer buys once a later check blocked its token.
- An exit is never blocked: `request_exit` and `sell_quoted` ignore the quarantine, and an exit quote
  without a sale quarantines nothing.
- The owner ends one with `lift_quarantine`; `unlist` is apart. A quarantine already running keeps its
  end when the period changes.

**What it costs an honest token.** A block on an honest token needs a lying sentinel (which could refuse
it anyway) or a real refusal: an amount whose buy fails, eleven trades of its pool during the check.

Whoever causes one, an armed agent paying its checks or a third party paying Base gas, now closes that
token on this guard alone for the period, where it closed one check before. Nothing is bought, other
guards are untouched, and the owner lifts it.

**One check per token.** `request_check` refuses a token whose buy check still awaits its verdict
(`pending_check`), whoever asked it: N parallel checks would be N draws, the first lucky one bought.

Per guard, not per agent: two agents of one owner are one buyer for the token (it is held for one agent
at a time). The slot frees at the verdict, at `refund_check`, or 300 s after the request: an agent that
never asks its refund cannot close a token. Exit quotes take no slot.

**Per-token cap.** `set_token_cap(cap_wei, period_s)`: all agents together send at most `cap_wei` of one
token to signing over a rolling period (1 h to 7 days). `request_check` refuses an amount the cap no
longer leaves, before the agent pays; `buy` enforces it and logs the buy.

- Zero at init, like the bounds: no check until the owner sets it.
- A buy whose signature does not come back stays counted, also once the owner refunded it: the MPC
  may still publish it.
- A token's log keeps 32 buys per period (24 bytes each, paid by their checks). A 33rd merges the two
  oldest into one, counted until the newer of them leaves the period: never less than what was
  bought, and 32 small buys do not close a token to every agent.
- One trap, or one lying `allow`, takes at most the cap per period, not every agent's armed budget.

**Freshness from the request.** The sentinel judges the reference block, 4 s after the request, however
late its verdict comes. `buy` also refuses a check requested more than 180 s ago: a flooded sentinel
queue no longer stretches the judged state's age to the swap deadline's 240 s.

## Accounting

- **Credit.** Prepaid NEAR per account (`deposit_credit`; the agent's key cannot attach any). Anyone may
  top up an agent; `refund_credit` returns the rest.
- **Price.** A check costs the price set at init, at least 0.0245 NEAR (2,450 bytes of storage, three
  votes included); 0.025 NEAR on the demo guard. From the credit and the armed budget.
- **Armed budget.** What an agent may spend before a deadline, opened by the armer within the owner's
  bounds: per arming, duration, 7-day cap, and `max_buy_wei` per buy.
- **Buy debit.** A buy's value plus its gas at the cap, from the budget and the credit, at the owner's
  fixed rate (the demo: 1 ETH = 1,000 NEAR).
- **Arming integrity.** The armer passes the credit it read; `arm` refuses a lower one (spent or drained)
  and accepts a higher one: refusing any change let one yoctoNEAR every 2 s block every arming.
- **Escrow.** NEAR owned by nobody yet: prices of checks awaiting a verdict, charges of a signature in
  progress and of reserved transactions. `credits_total`, `escrow` and `fees` are public views.
- **Fees.** `withdraw_fees` leaves the balance paying for storage, every credit and the escrow.

**Holdings.** Each signed buy credits its signed minimum to the agent. The guard's address holds every
agent's tokens together, so `buy` refuses a token another agent still holds.

The owner clears or reassigns a stuck holding: `app/human.ts holding <token> <agent> [amount]` (0 frees
it). A new holder sells through `request_exit` on a buy of that token signed for it; otherwise the owner sells.

**Decision digest.** `request_check` and `buy` take an optional `decision_sha256`, the model's signed
decision. It is stored, logged and anchored: one digest backs one call (`decision_of`), and a second use
gets `decision already anchored on check #n`.

A refunded check frees its digest; each anchor (at most 117 bytes) is paid by the check's price. The
guard does not check the package itself ([attest](replay.md#what-attest-verifies) does).

## Signing

The guard builds every transaction itself: chain 8453, Uniswap V2 router, path WETH to token, recipient
its own derived address, the nonce, gas and fees the owner set. The agent never picks any of it.

The **floor** (minimum output) is the sentinel's quote minus 3 %; an exit's floor is the exit quote's ETH
minus 3 %. The swap deadline is the check's request time + 300 s, so it is part of the simulated bytes.

A verdict is tied to a nonce. If another signature happens between the verdict and the buy, or the owner
changes gas or fees, the buy is refused (`transaction differs from the one simulated`): request a new check.

`buy` calls the MPC contract named at init (`v1.signer-prod.testnet`; on mainnet `v1.signer`, [mainnet](mainnet.md)) with derivation path `evm-1`; `on_signed` stores the
signed transaction with the check. One signature runs at a time for all agents and exits.

## Recovery

**Signatures that do not come back.** The MPC may publish a signature after the guard's yield timed out.
So a missing signature never frees its nonce: the transaction is reserved (`sign_unsettled`) with its
charge and tokens until the owner settles it:

1. `app/human.ts replace <nonce>` signs 0 wei to the owner's address at that nonce (raise the fees first
   with `gas` if the base fee is above them); the relay broadcasts it.
2. `clear <nonce> refund` returns the charge and tokens, or `clear <nonce> spent` if the late signature
   was mined first.

A refund is refused until a replacement was signed at that nonce, and only a reserved nonce can be
replaced: a buy signed and charged is never voided. Later transactions wait behind the gap. A reservation
takes no more storage than the signed transaction.

**A refund that meets another agent's holding.** An exit reserves two nonces, its approve's and its
swap's; the swap's carries the tokens. Agent A's exit debits A's holding when it starts, so if neither
signature comes back, the token is free and agent B may buy it. Then `clear <swap nonce> refund` panics:
`token held for another agent: set_holding first`. One agent holds a token at a time, and a refund never
takes B's holding:

1. Sign and broadcast both replacements (`replace <nonce>`, step 1 above).
2. `clear <approve nonce> refund` returns the approve's charge now: it carries no tokens.
3. Once B holds none of the token (B sold it all), `clear <swap nonce> refund` returns A's charge and
   tokens (`cargo test a_refund_blocked_by_another_holder`).
4. Or settle at once: `clear <swap nonce> spent`, sell A's tokens with the owner's `sell`, and credit A
   with `deposit_credit`. `holding <token> A <amount>` is no way out: it takes the token from B.

**A callback that never runs.** If `on_signed` or `on_exit_signed` failed (out of gas, say), the owner
frees the slot 600 s after the request (`app/human.ts release`, event `signing_released`). What it was
signing is reserved as above.

Measured on testnet: `on_signed` burnt 2.75 TGas, `on_exit_signed` 2.93 TGas for an exit's two
signatures and 2.02 for a withdrawal, against 10 TGas reserved for each (plus the call's unused gas:
80 to 131 TGas attached in these runs).

**An exit that reverts on Base** (a floor missed after a price move, a deadline passed, a token that now
refuses). `sell_quoted` debits the holding before signing and gives it back only when nothing was signed,
so the agent cannot ask that exit again although the tokens are still at the guard's address.

The owner reads the reverted receipt on Base and restores it: `holding <token> <agent> <held + amount>`.
On purpose: the guard cannot see Base, so a restore on the agent's word could re-credit an exit that went through.

**Owner's exit.** `sell` signs approve and swap for any amount and floor. The approve is of the amount
sold unless the owner passes another: `app/human.ts sell <token> <amount> 0 max` approves 2^256 - 1.

If a sale needs more gas, the owner raises it (`gas <limit>`, 21,000 to 2,000,000, fees up to 10 gwei)
and sells again. Measured with `gas_hungry` (needs 500,000 gas): at 250,000 the swap reverted, at 600,000
it went through. Whether a token lets any sale through is up to its code.

The owner's sale waits for a signature in progress (about 6 s); after an emergency stop it takes the
nonces after the buy in flight.

## Upgrade policy

`app/setup.ts` deploys the guard with a full-access key of the guard account, kept in the deployer's
near-cli keychain: whoever holds it can deploy other code, which replaces every rule above, or move its
NEAR. It can also call the MPC signer's `sign` as the guard account: the signer derives the Base address
from the calling account and the path (`evm-1`, public), so that key gets any transaction signed for the
guard's Base address, with none of the rules above. The demo keeps that key so it can be redeployed.

A production deployment removes it after the deployment and the `new` call, which leaves the code
immutable, or hands it to a DAO or multisig that upgrades only after a vote and a delay:

```sh
near account delete-keys guard.<parent>.testnet public-keys <its full-access key> network-config testnet sign-with-keychain send
```

The owner role is separate: an account named at init, whose key changes bounds and roles, not code.

## Limits

- **Quarantine and pending slot.** Anyone who can make a check of an honest token end in a `block` closes
  it on this guard for the quarantine; an agent keeps a token's slot for up to 300 s per paid check. The
  owner lifts a quarantine; nothing lifts a slot but its verdict, its refund or the 300 s.
- **One draw per quarantine, not none.** After the quarantine an agent may ask again, with new draws.
- **Asking again after a `warn` or a disagreement costs one price, no wait.** Only a block that found
  a refusal quarantines. No cool-down on the others, on purpose: no sentinel found a refusal, so the
  draw that missed a trap is not one the agent escapes by asking again; and a cool-down would let
  whoever can force a `warn` (eleven trades of a pool) or a disagreement (a signature that moves the
  nonce between two votes) close an honest token to every agent. The per-token cap bounds what a
  wrong `allow` costs, however many draws led to it.
- **Per-token cap.** Counted in wei at signing, not in what Base mined: a buy that reverted on Base, or
  was never broadcast, still counts until it leaves the period. It bounds one token, not a farm's copies.
- **A signed transaction that is never mined.** Only a nonce whose signature did not come back can be
  replaced. A signed buy that nobody broadcast can still be sent by anyone, and fills its nonce (it
  reverts once its 300 s deadline has passed). If Base's base fee stays above its fee cap it cannot be
  mined, nothing can be signed at its nonce, and every later transaction waits until the fee falls.
- **Verdicts tied to a nonce.** A signature for another check, or a gas or fee change, between the
  verdict and the buy refuses that buy; the agent pays a new check. An exit quote the same: it takes no
  more votes, and the agent's wrapper asks a new one, three at most. Busy agents race for one nonce sequence.
- **Holdings.** Credited at the signed minimum, not the amount received. A credit whose buy reverted on
  Base stays until the owner clears it; two agents cannot hold the same token at once.
- **Blocklist.** A registered reporter can list honest tokens until the owner unlists them, paying
  0.005 NEAR of its own credit per entry.
- **Code changed.** Compared with the reference only. A change between the verdict and the buy (at most
  120 s) goes unseen unless another check saw it: once the owner approved that check's `warn`, the
  reference moved and the earlier `allow` no longer buys. A change after the buy goes unseen.
- **A buy sent to signing is used.** Its check takes no more votes and buys no more, signed or
  reserved: a `block` that comes after the request to the MPC is refused, not recorded.
- **Gas.** One gas limit for every transaction the guard signs. Raising it to get a sale through also
  raises what each buy reserves, and refuses every verdict not yet bought.
- **Rate.** The NEAR/ETH rate is fixed by the owner, with no oracle.
- **Emergency stop.** It does not recall a signature already requested; it voids the checks requested
  before it.
- **Late signatures.** Each signature that does not come back needs the owner, and a late signature
  broadcast before the replacement is mined goes through (within the budget already debited).
- **Keys on one machine.** All roles run under one OS user here, whose near-cli keychain holds
  full-access keys.
- **Storage after a fee withdrawal.** Storage the guard pays for afterwards (an agent registered, an
  arming, a stop) comes out of what is left: a withdrawal to the limit can leave the last credit refund a
  little short until the owner deposits.
- **Fees withdrawn before a buy.** A check's price moves to the fees at its verdict, while the storage it
  pays for at worst (the signed transaction, the holding, the decision anchors, a reservation) is written
  by the buy and its callback. A withdrawal in between can take that price. A signed buy's own charge
  then moves to the fees and covers that storage when it is the larger (the demo's 0.0225 NEAR; the buy
  and its callback write under 1,000 of the check's 2,450 bytes); a buy whose signature does not come back reserves its nonce out of
  what the credits and the escrow are owed (`cargo test fees_withdrawn_before_a_buy`), until the owner
  deposits. Leaving one price in the fees per verdict less than 120 s old avoids it.
- **Base mainnet.** A transaction signed for chain 8453 is valid on Base mainnet: never send funds to the
  guard's address. The demo's withdrawal address, `0x…dEaD`, is a burn-address placeholder: pass your own
  to `setup.ts`.
