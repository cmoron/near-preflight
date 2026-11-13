# Sentinel

A sentinel judges a token before the guard lets an agent buy it. It runs off-chain
([`app/sentinel.ts`](../app/sentinel.ts)), reads the guard's new checks, simulates on a Base node
([`app/verifier.ts`](../app/verifier.ts)), and posts its vote with its one NEAR key, limited to `post_verdict`.

The guard takes votes from the sentinels its owner names: the demo runs three, each with its own account
and key, and an `allow` needs two matching votes ([quorum](contract.md#sentinel-quorum)). Everything
below is what each one does; they agree because nothing in a check is theirs to choose.

Nothing is signed or sent on Base: every call is a read-only simulation (`eth_simulateV1`) or a log query.
Every fact a verdict rests on goes into the **evidence**, whose sha256 the guard stores with the verdict.
[Replay](replay.md) re-derives all of it.

## Contents

- [What a check reads](#what-a-check-reads)
- [The four requests](#the-four-requests)
- [Others' trades during the wait](#others-trades-during-the-wait)
- [Base's cadence](#bases-cadence)
- [Sales drawn per check](#sales-drawn-per-check)
- [The far sale](#the-far-sale)
- [The agent's exit size](#the-agents-exit-size)
- [Environment rule](#environment-rule)
- [Verdicts and listing](#verdicts-and-listing)
- [Removable liquidity](#removable-liquidity)
- [Template reputation](#template-reputation)
- [Well-known tokens on real Base](#well-known-tokens-on-real-base)
- [Exit quotes](#exit-quotes)
- [What a check cannot show](#what-a-check-cannot-show)

## What a check reads

| Check                | How (read-only, public RPC calls)                                                | Verdict                                       |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Buy, takeback, sales | `eth_simulateV1`: four requests, below                                           | see below                                     |
| Far sales            | the late sale again 301 s and 900 s after the buy, and at a delay drawn between  | see below                                     |
| Agent exit size      | a sale of the agent's holding (quote minus the slippage bound), at the late sale | see below                                     |
| Cadence              | the timestamps of the reference block and of the 100th block before it           | none: it turns the rules' seconds into blocks |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1 h back, by the blocks' timestamps | see below                                     |
| Template reputation  | the index of V2 WETH pools by code template ([`app/index.ts`](../app/index.ts))  | see below                                     |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block`                               |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn`                               |
| Environment          | the guard's transactions replayed on local forks: what they touch and call       | see below                                     |
| Environment opcodes  | the reachable code of the token and of its implementation                        | found: `warn`                                 |
| The token's own code | the same replay: what its frames call, and the TIMESTAMP, NUMBER, SELFBALANCE they run | found: `warn`; a CREATE: `block`        |
| Agent exit quote     | `eth_simulateV1`: the guard's own approve and swap, alone, 2 and 3 blocks ahead  | quote = ETH in                                |

A check that fails (an RPC error, an index window not bound to the check, a logs node on another chain)
is retried; after 3 tries the sentinel posts a `block`: `simulation impossible after 3 tries : …`. One
sentinel's block is enough to block the check; posted without the token's code, it quarantines nothing.

A sentinel votes only on checks requested since it started (30 s of margin for the clocks): an older
one is another run's, perhaps on another chain (the fork and Base share chain id 8453 and the demo
guard); left undecided, it times out after 300 s and its agent takes its price back (`refund_check`). A
vote the guard refuses because the check takes no more, or because this account left the set, makes the
sentinel read the set and the quorum again; out of the set, it stops.

## The four requests

The sentinel simulates **the exact buy the guard signs, and nothing else**. The agent states the amount
at `request_check`; `buy` accepts no other.

The sentinel reads the guard's own unsigned transactions (`preview_check`, `preview_sale`: the bytes
`buy` and `sell_quoted` sign) and sends them as they are, from the guard's Base address: same calldata,
value, nonce, gas limit and fees.

The verdict carries the keccak256 of that buy (the MPC payload). `post_verdict` refuses an `allow` or a
`warn` whose hashes are not what the guard would sign then, and `buy` signs only that hash.

**The reference block** is the first Base block whose timestamp is at least 4 s after the check's
request on NEAR (`requested_ns`). It is mined after the request is public, so nobody knows its hash when
asking, and the sentinel cannot pick another: `replay --check` recomputes it.

A check is four `eth_simulateV1` requests sharing no state. Three run on the reference block:

- **Guard side.** The guard's buy on the block's real state, then a first sale and the rest, each an
  approve of the exact amount then `swapExactTokensForETHSupportingFeeOnTransferTokens`, each in a block
  of its own. No read, no probe, no other sender before or between them.
- **Probe side.** The same trades from a **probe**, a fresh address derived from the check and the
  reference block's hash, so a token cannot whitelist it in advance.
- **Synthetic calls.** The pool's quote and `owner()`, then both buys, then a `transferFrom` without
  approval by `owner()` and by a stranger (a **takeback**).

The fourth runs on a real block Base mined later:

- **Later side.** The guard side's approves and swaps again, at the same block numbers and simulated
  times, on the first real block `t` seconds after the reference block (`t` drawn per check, 16 to 24 s),
  with what the guard's buy wrote applied to it, but never past the block before the late sale's approve.
  A sale whose approve would come before that block is left out (on Base that block is 80 to 120 blocks
  on, often past the first sale, never past the late one).

A simulation keeps Base still between the buy and the sales; Base does not. On the later side, whatever
Base really did in those `t` seconds is there, before the approve as well as before the swap: others'
WETH, the base fee, the factory, the token's own pool. Nothing in it is a recipe a token could recognise.
The sentinel waits for that block: on Base mainnet a verdict came 25 to 31 s after the request (on an earlier guard, checks #65
to #69), 53 s when the pool traded meanwhile and its trade was re-executed (#70).

What the buy wrote comes from the [trace](#environment-rule): each storage slot it changed and each ETH
balance, before and after. On the later block:

- a slot Base did not write since takes the buy's value;
- when Base also wrote one (`later.moved`: someone traded the pool or sent the guard tokens), those
  transactions are re-executed after the buy, [below](#others-trades-during-the-wait);
- an ETH balance adds the buy's change to Base's (WETH's balance is its total supply);
- the guard gets what its own transactions spend, as on the other sides; a token that reads an ETH
  balance is a `block` by the [environment rule](#environment-rule).

A sale that goes through on the guard side and is refused on the later side, or pays more than 1 % less
there against the pool's quote, is a `block` that lists nothing: `sale refused N s after the buy on
Base's state of block B (…)`. Replay rebuilds the later side on the same block and rejudges it;
`--check` recomputes `t` and the block.

Measured on Base mainnet on 2026-11-12: WETH's supply moved in 160 of 600 consecutive blocks (2 min);
the Uniswap V2 factory got 16 new pairs in the last hour, 312 in a day. State that slow often stays
still for 24 s: a token that reads WETH or the factory is a `block` by the
[environment rule](#environment-rule), whatever moved.

The two sales are previews of an exit (no floor, a deadline past the late sale and the far sales), not
bytes NEAR will sign. An exit's own approve and swap are simulated again, as signed, by its
[exit quote](#exit-quotes).

Past the four requests, the late sale runs three more times, minutes later, on a local fork:
[the far sales](#the-far-sale), and a sale of what an agent's exit sells runs there too:
[the agent's exit size](#the-agents-exit-size). The later side runs on a local fork too, traced like the
guard side ([environment rule](#environment-rule)).

**Amounts come from logs**, never from a read between transactions: tokens bought from the token's
`Transfer` logs; the ETH a sale pays from the ETH transfers `traceTransfers` logs; a sale's quote from
the pool's last `Sync` before its approve (on the later side, before any sale, from the pool's reserves
on that block: `later.reserves`).

**Blocks follow Base's cadence**, measured at the reference block ([below](#bases-cadence)): every block
up to the late sale listed (empty in between: a node fills a gap with 12 s blocks), the time a real
block would have, the real base fee and coinbase, and one prevrandao per L1 epoch (12 s, 60 blocks), as
on Base. Replay recomputes them.

**What this closes**: tokens keyed on

- a difference between the simulation and the real transactions (gas price, gas limit, fees, amount,
  approve, calldata);
- extra calls of the simulation (a top-level read, a probe's call before a sale);
- where or what the check sells (the next block, the late block, half the balance);
- state Base moved between the buy and the later block, including before the approve, others' trades of
  the pool re-executed after the buy;
- WETH and the factory, whether or not they moved (the environment rule).

What stays open is in [what a check cannot show](#what-a-check-cannot-show).

## Others' trades during the wait

A pool that trades every few seconds (a liquid token, or a new one during its launch, which is what agents
buy) is often traded during the wait: USDC/WETH's V2 pool on Base traded in 125 of 360 windows of 20 s
over 2 h on 2026-11-12. The buy and those trades then wrote the same slots: the pool's reserves, the
token's and WETH's balances of the pool.

Merging values is not sound: a token decides how its own slots change (a hash chain, a "last trader"),
and a merged state can be one no chain ever had, which the token can recognise or which hides a refusal.
So the sentinel re-executes instead ([`app/later.ts`](../app/later.ts)):

1. **The trades.** Every transaction of blocks (reference, later] that traded the pool: any log of the
   pair, or a `Transfer` of the token or of WETH to or from it; and every `Transfer` of the token to or
   from the guard (dust anyone can send it). Read from each block's receipts (`eth_getBlockReceipts`;
   `mainnet.base.org` refuses `eth_getLogs`), one block at a time: about 11 s for 100 blocks. At most 10.
2. **Block by block**, on a throwaway anvil forked at the block before each one: its trades run once on
   Base's own state, and must give back Base's value of every slot that counts (the soundness check);
   then again on that state with the buy's **footprint** set first. Same senders, calldata, value, gas,
   fees, nonces, order, block time, base fee and coinbase.
3. **The footprint**: the slots where the two runs differ, with the second run's values. It starts as
   what the buy wrote. Every slot of the token's own addresses joins it: the token, its implementation,
   its pool, the router and the guard, the addresses whose state the token's code may read with no
   finding ([environment rule](#environment-rule)). Other contracts' join only when the buy wrote them
   (WETH's balance of the pool). A footprint slot may not move between blocks without a transaction
   re-executed.

4. **On the later block**, the footprint is set and nothing else: WETH's supply, others' pools, the
   factory, L1Block stay as Base left them.

The set is the rule's own, not a list of slots: a sale that reads any other address is a `block`, so a
token cannot keep a mark where the footprint does not look, and adding a contract only adds a finding.
Judge pass 9's J9ImplMark (`impl_mark`) kept its mark in its implementation's own storage, written by a
plain call when someone bought after the guard: `allow` before, now `sale refused N s after the buy on
Base's state of block B` (`bun test -t "J9ImplMark"`). Blocking a plain call to the implementation would
also close it, but would block honest proxies for it and leave the next such address to find.

So the later sales meet the pool as if the guard had bought first and the others traded after it, on
everything else as it really was. A sale that goes through and pays within 1 % of the pool's reserves
there is not downgraded. Each trade's hash is in `later.replayed`; replay fetches the trades again and
re-executes them, and one left out is a `MISMATCH`.

**Measured on Base mainnet**, 2026-11-12, USDC: in 7 real windows where its pool traded during the wait
(an earlier guard's check #70, and 6 past windows checked read-only), the trades were re-executed and the resale verified
in 3. In the other 4 the resale is not verified: in three, re-executing the trades did not give back
Base's value of a USDC balance (the one inspected is an arbitrage contract's, which ten other
transactions of the same block also moved; another window hit the same slot), and one window held 14
trades.

The canonical pair and WETH have known code, and their arithmetic could be applied instead; it is not:
re-execution covers them and the token alike, with one code path.

**When it cannot be built**, `later.unverified` says why: a trade anvil cannot replay (a deposit or an
EIP-7702 transaction), a trade whose status differs from Base's, a re-execution that does not give back
Base's values, a footprint slot moved with no transaction re-executed, more than 10 trades. The later
sales then run on Base's values for the slots both wrote and the buy's for the rest: a sale that goes
through there is a `warn`, `resale not verified on Base's state of block B: <why>`. A sale refused there,
or paying 1 % less, is still a `block` that lists nothing: `sale refused N s after the buy on Base's state
of block B (…), merged with the buy's values: <why>`. Otherwise a trap would force that fallback (a write
outside its pool to a slot the buy wrote, eleven trades of its pool) to escape the block
(`bun test -t "more trades of its pool than can be re-executed"`).

**Dust sent to the guard.** Anyone can send a token to the guard's public address during a check. That
transfer is re-executed after the buy like a trade: the guard then holds what it bought plus the dust.
USDC dusted during its check: its sale goes through there, verified, `allow`
(`bun test -t "USDC sent to the guard"`); WethKey dusted: refused there, a `block`
(`bun test -t "dust sent to the guard during WethKey"`). No value is ever summed: a sum is exact for a
balance only, and for any other slot makes a state no chain had. A slot the buy wrote that moves with
no transaction to re-execute (an owner's write without a `Transfer` log) keeps Base's value, so a sale
refused there stays a `block` (`bun test -t "no transfer at all"`). Eleven trades of an honest token's
pool, or dust and ten, block that check, not listed.

**What it approximates.** Each block's trades run on the state at the end of the block before, without
the transactions before them in their block. A transaction that touched neither the pool nor a footprint
slot is Base's, even when it would have acted differently after the buy (an arbitrage that read the pool
and passed). Each trade keeps its own gas limit: one that no longer suffices after the buy (the token
does more work then) reverts there, unlike on Base, and the resale is not verified. The block's
prevrandao is not reproduced.

## Base's cadence

Base mined a block every 2 s until a day between 2026-08-15 (block 50,000,000: 1,000 blocks in 2,000 s)
and 2026-11-09 (block 55,000,000: 1,000 blocks in 200 s), and five a second since. Its timestamps are
whole seconds: five consecutive blocks share one.

So no duration is counted in blocks. Each rule is in seconds; the **cadence** turns it into blocks: the
timestamps of the reference block and of the 100th block before it (20 s on Base: `{"blocks": 100,
"seconds": 20}`), in the evidence, measured again by replay. Simulated block `k` after the reference
block gets its time plus ⌊k · seconds / blocks⌋: on Base, five blocks a second as real ones, so a token
comparing `block.timestamp` with `block.number` sees nothing apart. Windows in the past (liquidity,
index) are bound by the blocks' own timestamps.

The local fork mines a block a second: anvil's `eth_simulateV1` refuses two blocks with one timestamp,
which Base's node accepts. The same code measures it.

## Sales drawn per check

| Draw       | When                                                       | What                                                       |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| First sale | 2 to 25 s after the buy (10 to 125 blocks on Base)         | 13 % to 87 % of the tokens bought, never a whole percent   |
| Late sale  | 30 to 51 s after the buy (150 to 255 blocks on Base)       | the rest; the request ends there                           |
| Later side | the first real block 16 to 24 s after the reference block  | the sales whose approve comes after it, again              |
| Far sale   | 301 to 900 s after the buy (1,505 to 4,500 blocks on Base) | the late sale again on a local fork, as at 301 s and 900 s |
| Exit size  | at the late sale, not drawn                                | the agent's holding: the quote minus the slippage bound    |

The probes, the sales and the later side's wait are drawn by `deriveProbes` from:

```text
sha256("goblin-near probe|<guard>|<check id>|<requested_ns>|<reference block hash>|<role>")
```

That block hash does not exist before the block, so a token owner watching NEAR cannot expect any
sale's block, the amount or the later block. The draws are in the evidence as `sales` (`first`, `bps`,
`late`, `far`) and `later.block`; `replay --check` recomputes them.

**`eth_simulateV1` reaches 51 s.** It refuses a block more than 256 above its real base block (`too
many blocks`, measured on `mainnet.base.org`): at five blocks a second, 51 s after the reference block.
The late sale uses that budget to its last block. A second request further ahead needs a real base
block that far ahead, which does not exist yet. At 2 s a block the same limit reached 512 s; a faster
cadence would cap the late sale at the 256th block. Past it, the far sales.

## The far sale

A token that refuses or taxes a sale from 5 minutes after the buy (`sell_blocked_later`, `sell_tax_later`)
passes every sale `eth_simulateV1` can reach. The far sales play the late sale again **301 s and 900 s
after the buy, and at a delay drawn between** (1,505 to 4,500 blocks on Base), on the throwaway anvil
fork the [trace](#environment-rule) already starts at the reference block, whose clock and block number
move ([`app/environment.ts`](../app/environment.ts) `trace`):

- **The guard.** For each delay, back before its late approve, the empty blocks up to the far sale mined
  at once (`anvil_mine`), then the late sale's own approve and swap, each in its block, at the number and
  time a real block would have at the cadence measured (`block.number` and `block.timestamp` agree as on
  Base), with the reference block's base fee and coinbase. Traced like the guard side: what they touch and
  what the token's code reaches join `touched` and `token_calls`.
- **The probe.** Back at the reference block, in runs of its own: its buy and first sale at their blocks
  and times, then for each delay the empty blocks mined at once and its late approve and swap.

Both ends are fixed, and land at least 301 s and 900 s after the buy at any cadence: in blocks a cadence
slower than a block a second rounds short (a fork whose 100 blocks took 201 s put "900 s" 898 s after the
buy), so the count is raised until the time is reached; Base's 1,505 and 4,500 blocks do not move. A
`block` for the guard's address alone lists nothing and nothing remembers it, so a
drawn delay alone let an agent request checks until it fell before the trap: judge pass 9's J9GuardLater
(`guard_later`) closes the guard's sales 8 minutes after its buy and got `allow` in 4 of 8 checks (2 of 8 here). Now
every check meets it at 900 s: `guard address only, not listed: sale refused 900 s after the buy (…)`
(`bun test -t "J9GuardLater"`).

The empty blocks hold no transaction; their times are the fork's clock, not the cadence's (only
BLOCKHASH, a flagged opcode, sees them). They stay in memory: the fork keeps the last 300 states
(`--prune-history`), and its directory is removed with it. Mining 4,500 of them took 0.05 to 0.15 s.

Each result is read from the fork as `eth_simulateV1` gives it (status, return data, logs, and each ETH
transfer as a log) and judged as the other sales: refused, taxed from 10 % (`warn`) or 50 % (`block`)
against the pool's quote after the buy and the first sale, a pool paying out more. Reasons say when, in
seconds: `sale refused 762 s after the buy (TransferHelper: TRANSFER_FROM_FAILED)`. The far sale at 900 s
is the last sale for [listing](#verdicts-and-listing).

In the proof, the fifth request (`local_fork_mine`, never sent to a node) lists sixteen blocks: the
guard's approve and swap at 301 s, at the drawn delay and at 900 s, then its
[exit-size sale](#the-agents-exit-size), then the probe's; the fifth response, their results;
`evidence.calls` ends with their labels (`far 301 s: guard: sale late`, `far: guard: sale late`,
`far 900 s: guard: sale late`, `guard: sale exit`). Replay rebuilds that request from the guard and probe
sides, mines it again on its own fork and compares every result.

**Cost**, measured on 2026-11-12, read only, blocks already mined (no wait), one check at a time:
the later side's trace and the two fixed far sales added about 0.4 s a check on the local copy of Base
(USDC 1.15 to 1.26 s before, 1.54 to 1.63 s after; the healthy demo token 0.58 to 0.62 s, 0.98 to
1.04 s), of which 0.28 s is the later side's trace; on Base mainnet, USDC, 15.6 to 16.5 s before, 22.1
to 22.8 s after, of which 5.7 s is the later side's trace (its fork fetches the state it reads from the
node). The sentinel runs the far sales while it waits for the later side's block, and the later side's
trace beside its simulation, after the wait: on the guard, from the request to the verdict, 23.0 to
25.5 s before (an earlier guard's checks #96 to #98), 32.6 to 33.4 s after (#103, #104), 74.9 s when the
pool traded during the wait (#105). The throwaway anvils' peak memory: 85 to 95 MB, measured with one far sale.

The [allow-list](#environment-rule) for the token's own code reads the same trace: no measurable cost
(the same day: USDC 1.64 to 1.83 s before, 1.69 to 1.93 s after on the local copy; 23.1 and 24.3 s
before, 22.0 s after on Base mainnet).

**What it is not.** A frozen copy of the reference block: nothing Base does in those minutes is in it,
neither others' trades of the pool nor WETH, L1Block or the base fee. A token keyed on time and on that
state together (refusing from 5 minutes on only once WETH moved) passes there; the later side sees 16 to
24 s of real Base. The horizon is 900 s: a sale closed from 15 minutes on passes them, and is left to
the [allow-list](#environment-rule) for the token's own code.

## The agent's exit size

An agent's exit sells its holding: the guard credits a buy at its signed minimum, the quote minus its
slippage bound (`max_slippage_bps`, 3 % in the demo), so 97 % of what the guard received. No drawn sale
sells that share: the first sells 13 % to 87 %, the late and far sales all the rest. ExitSizeTrap
(`exit_size`) refuses a sale of 88 % to 99.99 % of a balance: every drawn sale went through, `allow`;
now `exit-size sale (97 %) refused N s after the buy (…)`, a `block` that lists nothing
(`bun test -t "ExitSizeTrap"`).

- **What.** The guard's approve and swap of exactly that share of what its buy received (the sentinel
  reads the bound from the guard's `evm_config`, the contract's own), from its whole balance, after its
  buy alone, at the late sale's blocks; the probe's twin, its own share. Judged like the other sales.
- **Where.** On the trace's local fork, beside the far sales, traced like the guard side: what the
  token's code reaches on that sale joins the [environment rule](#environment-rule). The fifth request
  holds it after each side's far sales (`guard: approve router exit`, `guard: sale exit`), and
  `evidence.slippage_bps` the bound; replay mines it again, `--check` compares the bound with the guard's.
- **Not on the later side, nor at the far delays.** Time and Base's state are the allow-list's: a token
  refusing that size only later reads a clock on that sale (TIMESTAMP, NUMBER, its pool), a `warn`; one
  keyed on WETH or the factory is a `block`. A size keyed on its own storage that others' trades move is
  what the later side cannot show for any sale ([below](#what-a-check-cannot-show)). Either would cost an
  `eth_simulateV1` or a trace more on Base mainnet.
- **Cost**, measured on 2026-11-12, one check at a time, blocks already mined, with the tie between the
  two nodes ([template reputation](#template-reputation)): on the local copy of Base, USDC 1.59 to 1.91 s
  before, 1.75 to 1.91 s after; the healthy demo token 0.98 to 1.19 s, 1.08 to 1.38 s. On Base mainnet,
  USDC read only, 25.0 and 26.1 s before, 26.7 and 27.6 s after: about 1.5 s a check.

## Environment rule

**A token whose transfers depend on what the simulation cannot reproduce is not allowed.**
`eth_simulateV1` never runs Base's per-block system update (the L1 attributes deposit that rewrites the
L1Block contract `0x4200…0015`, the fee vaults' credits) and cannot know a future block's fields.

The red team's RedL1Trap sold only while L1Block was unchanged since the buy: every simulated sale
passed, every real one failed. Rather than guess the next tell, three facts, all in the evidence and
recomputed by replay ([`app/environment.ts`](../app/environment.ts)):

**`touched`**: every address the guard's own transactions read or call, at any depth (BALANCE,
EXTCODESIZE, EXTCODEHASH, EXTCODECOPY, CALL, STATICCALL, DELEGATECALL, CALLCODE).

- A throwaway anvil forks the same node at the proof's block and replays the guard side for real, each
  transaction's access list taken before it is sent; the far sales run on it too.
- Another forks the later side's block, sets the buy's footprint and runs the later side's sales the same
  way: a token cannot act otherwise on Base's later state unseen (a proxy upgraded during the check to
  code at a new address: `bun test -t "upgraded during the check"`). This costs 0.28 s a check on
  the local copy of Base, 5.7 s on Base mainnet, run beside the later side's simulation.
- Allowed: the token, its implementation, its V2 pool, the router, WETH, the factory, the guard and the
  precompiles. Any other address is a `block` naming it:
  `reads 0x4200..0015, 0x8bde..9881 during a transfer` (the second is L1Block's implementation).

**`token_calls`**: what the token's own code reaches in those transactions: the addresses it calls, or
whose code or ETH balance it reads (CALL, STATICCALL, DELEGATECALL, CALLCODE, BALANCE, EXTCODE*). Each
transaction is traced with a JS tracer that records these opcodes in every frame run in the token's
context (an implementation's code behind a proxy runs there) or running the token's or its
implementation's code, whatever the context: a plain call from the token to its implementation, an
expected address, runs the implementation in its own (`bun test -t "STATICCALL from the proxy"`).
`callTracer` saw only calls.

- WETH and the factory are allowed above for the router's sake, yet all of Base moves their state. A
  token that reaches either one is a `block` naming it: `token calls or reads WETH and the V2 factory
during a transfer: state all of Base moves`, whether or not that state moved during the check.
- Judge pass 8's ApproveKey, BusyTell and pass 7's WethKey all call WETH (BusyTell the factory too).

**`token_balances`**: the addresses whose ETH balance the token's own code reads, itself aside. Any is
a `block`: `token reads the ETH balance of the guard during a transfer: a value no simulation can
match`. Others' balances move with all of Base; the guard's moves with the L1 fee no simulation bills,
and the later side gives it what its transactions spend, not Base's.

The same trace gives the buy's state change (`prestateTracer`, its values read before and after its
block), which the [later side](#the-four-requests) applies.

**An allow-list for the token's own code.** Sampling sales does not converge: each judge pass found the
delay, the size or the state the samples missed. The rule above holds because it lists what is allowed.

So `allow` also means that on the traced runs (the guard's buy, approves and sales on the reference
block, the far sales, the later side's sales) the token's own frames did only this:

- **Called nothing but its implementation and the precompiles** (`token_calls`). Its pool, the router or
  the guard reached from its own code is a `warn` naming them: `token calls or reads its pool during a
transfer: reserves and a clock any trade moves`.
- **Executed no TIMESTAMP, NUMBER or SELFBALANCE** (`token_opcodes`): a `warn` naming them, `token reads
TIMESTAMP during a transfer: it can act otherwise after the check's last sale`.
- **Created no contract** (CREATE, CREATE2, in `token_opcodes` too): a `block`, `token creates a contract
during a transfer: code no rule reads`. Init code runs at a new address, outside the token's frames and
  outside any access list: it could read the time for the token and hand it back as revert data.

Why the pool: keyed on its reserves a token sells until anyone trades, and `pair.sync()` then
`getReserves()` hands it the block's time with no TIMESTAMP of its own. Hence both rules together.

**What ran, not what the code holds.** USDC's `permit` compares a deadline with TIMESTAMP; the guard's
buy, approve and sales never take that path, so USDC ran none. A BALANCE of the token's own address
counts as SELFBALANCE.

**A `warn`, not a `block`.** A launch cooldown, a fee swap through the router, a pool `sync()` after a
burn are honest: the owner reads what the token reaches, then approves or not. WETH, the factory, an ETH
balance and any address outside the list stay a `block`, as before.

`LateClose` (`late_close`, `pool_clock`) closes every sale 20 minutes after its owner arms it, past the
last far sale, by TIMESTAMP or by its pool's clock. Every sale a check draws goes through: `allow` before,
`warn` now (`bun test -t "LateClose"`, `-t "PoolClock"`), and the real sale fails 20 minutes later
(`bun test -t "fails 20 minutes later"`).

**`opcodes`**: BLOCKHASH, COINBASE, PREVRANDAO, GASLIMIT, BASEFEE, BLOBHASH, BLOBBASEFEE, GASPRICE and
ORIGIN in the reachable code of the token and of its implementation: a `warn` naming them.

- Reachable: from offset 0 and each valid JUMPDEST until an opcode that halts or jumps.
- Data solc appends (revert strings, metadata) is skipped only when the code before it halts and it holds
  no JUMPDEST. Read as code, a revert string's "H" is BASEFEE: a naive scan flags Uniswap's router.

Decisions, each on purpose:

- GAS is not flagged: solc emits it before every external call, and each simulated transaction carries
  the guard's own gas limit. BALANCE and EXTCODE* name an address, which `touched` and `token_calls`
  judge (anvil's access list reports them: tested).
- TIMESTAMP, NUMBER and SELFBALANCE are judged on what ran, never on the code: most tokens hold a
  TIMESTAMP (a permit's deadline). The simulated blocks still follow the cadence measured, and the
  [far sales](#the-far-sale) exercise time up to 900 s: a second line of defence.
- The coinbase is not an expected address: on Base it is the sequencer fee vault `0x4200…0011`, whose
  balance moves every block; the access list reports it only when code reads it.
- A token whose transfers call any other contract (a dividend tracker, a library, a beacon proxy) is a
  `block`: honest ones are lost.
- A token that swaps its own fees through the router during a sale was already a `block` (the pool
  pays out more WETH than the seller receives); the wallet its fees go to adds a reason.

**Why a local fork.**

- Base's public RPC (reth 2.5.2) answers `eth_createAccessList` but ignores block overrides, so it cannot
  replay a sale at its simulated block; `debug_*` is filtered. anvil (Foundry) does both.
- Without anvil, the check fails closed.
- The trace gives each sender 1 ETH more, for the L1 data fee anvil bills.
- Not reproduced on the fork, hence read only through the flagged opcodes: prevrandao, the gas price an
  access list sees, block hashes.

**Measured read-only on Base mainnet (2026-11-12).**

- No flagged opcode in USDC (proxy and implementation), WETH, USDbC, DAI, cbETH, AERO, DEGEN, BRETT,
  TOSHI, VIRTUAL, cbBTC, nor the Uniswap V2 router.
- The full check of 21 well-known tokens, the index on: 18 `allow`
  ([table](#well-known-tokens-on-real-base)).

**The allow-list measured before it changed a verdict** (2026-11-12, read only, a buy of 0.00001 ETH
each): 21 tokens whose Uniswap V2 WETH pool held at least 0.001 WETH.

| Tokens                                                                                                       | Before  | After   | What the two rules found       |
| ------------------------------------------------------------------------------------------------------------ | ------- | ------- | ------------------------------ |
| USDC, DAI, AERO, DEGEN, BRETT, TOSHI, VIRTUAL, cbBTC, cbETH, USDbC, WELL, MOCHI, KEYCAT, MIGGLES, ZORA, USDT, BOOMER, mfer | `warn`  | `warn`  | nothing                        |
| SKI                                                                                                          | `warn`  | `warn`  | nothing (its code holds ORIGIN) |
| BENJI                                                                                                        | `warn`  | `warn`  | its code ran NUMBER (and holds ORIGIN) |
| AIXBT                                                                                                        | `block` | `block` | nothing (it reads another contract) |

- No verdict changed. Each `warn` was the unknown reputation (that run had no index); with the index,
  18 of the 21 get `allow` ([measured](#well-known-tokens-on-real-base)).
- Their own code called an implementation only (USDC, cbBTC, cbETH, USDbC, WELL) or nothing.
- BENJI is the one token the rules add a reason to: `token reads NUMBER during a transfer`.

**A third rule, measured and not shipped**: the token's code reads no storage slot the guard's own
transactions did not write. On the guard's approves and sales, 16 of the 21 read at least one (USDC 4,
BRETT 13, TOSHI 11, cbETH and USDbC 1).

Only DAI, AERO, VIRTUAL, KEYCAT and USDT read none. It would cap USDC at `warn`: the owner's decision.

**On the fork**, `red_l1_trap` and `helper_trap` (L1Block reached through a delegatecall to a helper
whose address sits in storage) are a `block`, USDC an `allow`. `basefee_trap` is a `warn` for its opcode,
and a `block` once the base fee moved before the later block: on the fork it falls about 2 wei a block,
on Base it sat at its floor in 10 of 11 blocks sampled. `weth_key`, `approve_key` and `busy_tell` call
WETH: a `block`.

Two honest demo tokens changed verdict with the allow-list: `hold_one_block` (a one-block hold) and
`cooldown_60` (when its first sale is drawn past the cooldown) were `allow` and are `warn`, naming the
NUMBER and TIMESTAMP their code reads. Every other demo token keeps its verdict.

[`app/environment.test.ts`](../app/environment.test.ts) shows each real sale failing after one emulated
sequencer block (L1Block's sequence number advanced), a base fee move, or another user's WETH deposit.

## Verdicts and listing

| Finding                                                                   | Verdict |
| ------------------------------------------------------------------------- | ------- |
| A revert, a takeback, or a tax of 50 % or more, the far sales' included   | `block` |
| A pool that pays out more WETH than the seller receives                   | `block` |
| An address outside the token, its pool and Uniswap touched                | `block` |
| The token's code calls or reads WETH or the factory                       | `block` |
| The token's code reads an ETH balance                                     | `block` |
| A sale refused, or paying 1 % less, on the later side, verified or not    | `block` |
| A template whose earlier pools were drained, or a token on the blocklist  | `block` |
| A tax from 10 %, an environment opcode, removable liquidity, code changed | `warn`  |
| The token's own code calls its pool, the router or the guard              | `warn`  |
| The token's own code runs TIMESTAMP, NUMBER or SELFBALANCE                | `warn`  |
| The token's own code creates a contract                                   | `block` |
| Others' trades not re-executed, the resale going through there            | `warn`  |
| No V2 pair, no template index for the chain                               | `warn`  |

A sale's tax is measured on the ETH the seller receives, against the pool's quote.

**Listing.** A `block` lists the token (the sentinel's `list_target`) only for what the probe shows
after a buy that succeeded, when the pool quotes at least 1,000 token units for the agent's amount:

- a takeback;
- a buy that delivers nothing, or a 50 % buy tax;
- a refused sale, or a 50 % sale tax, on a sale the pool quotes at 1,000 wei or more.

A refused sale lists the token only when the **far sale at 900 s is refused too**, the last sale. A
refusal that clears with time (`cooldown_60` sells 30 blocks after the buy, an anti-bot delay of 10
minutes) blocks that check and lists nothing: otherwise any agent could repeat checks until one lists an
honest token. A token that refuses sales for more than 15 minutes after a buy is listed.

These never list: a failed buy, a quote under 1,000 units, a dust sale, a pool that pays out more, a
finding of the later side or of the environment rule, template reputation, and a failure on the guard's
side only (its reason starts with `guard address only, not listed`).

The evidence carries `list_target`; replay recomputes it and `--check` compares it with the guard's.

## Removable liquidity

If at least 90 % of today's LP supply already existed an hour ago (at the first block of the last hour,
by the blocks' timestamps), the liquidity is old and its holders are not read. Otherwise the holders come
from the pair's `Transfer` logs (on Base, at most 4 `eth_getLogs` of 5,000 blocks on `INDEX_RPC`, then
`balanceOf` and `eth_getCode` per holder, at most 20).

At least half the LP removable (an EOA, a contract, or several summed; only 0x0 and 0xdead count as
burned) is a `warn`, and so are holders that cannot all be read.

## Template reputation

A **template** is the keccak256 of the runtime code with the metadata removed and every `PUSH32`
operand zeroed (solc writes immutables there).

The index ([`app/index.ts`](../app/index.ts)) is rebuilt from `PairCreated`, `Mint`, `Burn` and LP
`Transfer` logs: anyone gets the same file, same sha256, from the same chain state.

- A pool is **funded** at the block where the net WETH its providers added (`Mint` minus `Burn`, floored
  at 0) reaches 0.5 ETH, not at the pair's creation.
- It is **drained** once 90 % of the LP ever minted is burned after that.
- A token is judged only against pools funded before its own, so copies funded later cannot get it blocked.
- The token's own pool counts from its funding block inside the window, or from the window's end when
  it was funded or created after it. A pair created before the window but funded inside it is dated by
  that funding, read from its own `Mint` and `Burn` logs.
- At least 3 earlier pools with at least 80 % drained within 1 day of funding (in blocks at the check's
  cadence) is a `block`, never listed.
- A pool that held 0.5 ETH of WETH before the index window is not judged:
  `template reputation not applied: the token's own pool was funded before the index window`.
- No index for the chain is a `warn`: an unknown reputation is never a pass.
  It stays distinct from "not applied" and from "checked and clean" (no finding).

**The index window is bound to the check.** It must start at least 2 h before the check's reference
block, by their timestamps, and end at that very block: a window cannot miss a farm's earlier pools, nor
drop its newest ones. 2 h: the farm measured below opened 29 pools in 2.4 h and drained them 13 to 48 min
after funding, so 2 h hold several of its drained pools.

The sentinel builds the index for each check, up to the reference block, and judges with no other.
Replay reports a `MISMATCH … is not bound to block …`, and rebuilds the whole index to compare its sha256.

- **On Base** the window starts at the last block 2 h before the reference block, by their timestamps.
  Every sentinel gets the same window, so the same sha256. About 36,000 blocks: 49 to 54 requests to
  build it and about 10 to find its start, 3 s on publicnode (2026-11-12).
- **On the fork** it starts at block `INDEX_FROM`, the fork's first (`demo.sh` sets it): about 300 blocks
  spaced over 2.4 h (`evm/fork.sh` mines 10 blocks 800 s apart).
- **The node** is `INDEX_RPC`, `EVM_RPC` by default: it serves every log a check reads, the index's,
  the token's own pool's and its LP holders'; state comes from `EVM_RPC`. It must serve `eth_getLogs`:
  `mainnet.base.org` answers `request limit reached`. A node that refuses logs fails the check, so a
  `block` whose reason names `INDEX_RPC`.
- **Tied to the simulation's.** The logs node must give the check's block and the index window's first
  the hashes `EVM_RPC` gives them: a hash commits to every block before it. Otherwise the check fails
  (`the logs node … answers another hash for block …`), and replay reports a `MISMATCH`.
- **Each sentinel its own.** `check-mainnet.sh` gives the first `mainnet.base.org` (simulation) and
  `base.public.blockpi.network` (logs), the second `base-rpc.publicnode.com` for both (`EVM_RPC_2`,
  `INDEX_RPC_2`), the third `base.rpc.blxrbdn.com` for both (`EVM_RPC_3`, `INDEX_RPC_3`): four
  providers, none read by two sentinels. Measured read only on 2026-11-12: `base.drpc.org`, blockpi and
  thirdweb serve a check's calls but answered the trace's anvil with HTTP 429; drpc, 1rpc, tenderly and
  thirdweb refuse 5,000-block log ranges, 1rpc block receipts. On the local fork all read the fork, the
  only node holding the demo tokens.
- `INDEX_FROM=none` runs without an index: every buy verdict is then at least `warn`.

### Measured on real Base

One run on 2026-11-11, read-only, at most one request per second (it would have stopped on the first
error or `429`; none came):

```sh
bun app/index.ts https://base-rpc.publicnode.com 56133114 56176314 base-index.json --pace-ms 1000
```

- Blocks 56,133,114 to 56,176,314: 43,201 blocks, from 17:09:58 to 19:33:58 UTC (2.4 h, five blocks a
  second), ending at the chain head.
- 283 requests in 298.5 s (eth_getLogs over 500 blocks); index sha256 `0x16f519b6…96ea`.
- 29 Uniswap V2 WETH pools with code, all of one code template, all funded (at least 0.5 ETH net).
- 24 drained within a day of funding: from 3,907 to 14,467 blocks, median 4,027 (13 min to 48 min,
  median 13.4 min).
- A copy of that template whose pool is created after the window gets `block` (24 of 29 is above 80 %).

Re-run on 2026-11-12 with eth_getLogs over 5,000 blocks: same sha256, 57 requests in 60.7 s.

A 2 h window ending at the chain head the same day, blocks 56,501,166 to 56,537,166, at one request a
second: 37 requests in 39.8 s (2.1 s unpaced), sha256 `0x91751f85…f3ff`. 17 pools: the same template's
15, 12 of them drained 3,793 to 12,362 blocks after funding (median 13.6 min), and 2 others. 12 of 15 is
80 %: a copy funded after that window gets `block`.

The index lists the pools' token and pair addresses; none is published here. A pruned node refuses the
old state; an archive node does not.

## Well-known tokens on real Base

Do safe tokens get `allow`? Measured on 2026-11-12, read only, with the index on: 18 of 21.

- **Method.** The check a sentinel runs (`checkToken`), called directly, not through the guard: a buy of
  0.00001 ETH from the guard's Base address, simulated on `mainnet.base.org`. The index is built by the
  sentinel's own code on `https://base-rpc.publicnode.com`.
- **Block.** One reference block for all, 56,639,492 (21:17:54 UTC). Index: blocks 56,603,496 to
  56,639,492 (exactly 2 h), 27 pools, sha256 `0x465f1b9a…`, 49 requests, 2.8 s. About 24 s a token.
- **Tokens.** The 21 of the [allow-list measurement](#environment-rule): a Uniswap V2 WETH pool holding
  at least 0.001 WETH.

| Token   | Verdict | Reasons                                                                  |
| ------- | ------- | ------------------------------------------------------------------------ |
| DAI     | `allow` | none                                                                     |
| AERO    | `allow` | none                                                                     |
| VIRTUAL | `allow` | reputation not applied                                                   |
| KEYCAT  | `allow` | reputation not applied                                                   |
| USDT    | `allow` | none                                                                     |
| USDC    | `allow` | reputation not applied                                                   |
| DEGEN   | `allow` | none                                                                     |
| BRETT   | `allow` | none                                                                     |
| TOSHI   | `allow` | none                                                                     |
| cbBTC   | `allow` | reputation not applied                                                   |
| cbETH   | `allow` | none                                                                     |
| USDbC   | `allow` | none                                                                     |
| WELL    | `allow` | none                                                                     |
| MOCHI   | `allow` | none                                                                     |
| MIGGLES | `allow` | reputation not applied                                                   |
| ZORA    | `allow` | none                                                                     |
| BOOMER  | `allow` | reputation not applied                                                   |
| mfer    | `allow` | reputation not applied                                                   |
| SKI     | `warn`  | code reads ORIGIN; reputation not applied                                |
| BENJI   | `warn`  | code reads ORIGIN; token reads NUMBER during a transfer; reputation not applied |
| AIXBT   | `block` | reads `0x082c..5d94` during a transfer: state no simulation reproduces   |

- **None**: the simulation found nothing, and the reputation was checked and clean. Their V2 pool held
  under 0.5 ETH before the window and was not funded in it, so every pool of the index counted: none
  shares their template.
- **Reputation not applied**: their pool held 0.5 ETH before the window. An `allow`-level note.
- **SKI, BENJI**: ORIGIN is a value no simulation can match; BENJI's code ran NUMBER on a transfer.
  The owner decides.
- **AIXBT** reads another contract during a transfer: a `block`, as before.
- In no check did others trade the pool during the wait.

`./check-mainnet.sh` then ran USDC through the guard: check #19, `allow` on two of the three sentinels'
votes, each on its own nodes, replayed (`app/fixtures/usdc-base-mainnet.json`).

## Exit quotes

When an agent asks to sell (`request_exit`), the sentinel simulates the approve and swap the guard would
sign, from the guard's address, alone: on the first block of the latest second, the approve 2 blocks
ahead, the swap in the next, at the cadence measured there (in the evidence, as for a check).

The quote is the ETH that reached the guard's address. It simulates twice: with no floor to get the
quote, then exactly as signed on that quote.

**Every sentinel quotes.** They quote at different Base blocks, so their quotes differ and none is asked
to match. The guard sets the agent's floor from the median of three quotes, the highest of fewer (that
quote minus 3 %); a `block` is no quote and cancels none. It sells at once when every sentinel quoted,
15 s after the request on the quorum's quotes, 60 s after it on one vote
([quorum](contract.md#sentinel-quorum)); the agent's wrapper waits for the guard's `exit_ready`.

A sentinel asks the guard whether its vote can still count (`vote_due`) before it simulates, on a buy
check as on an exit. If another signature moves the guard's nonce under the quotes, the guard takes no
more votes on that exit quote and the wrapper asks a new one, three at most.

How long a quote takes is in the [latency budget](latency.md).

## What a check cannot show

A simulation cannot prove that a token will be sellable later. Still open:

- An owner action after the buy: a pause, a fee raised, a blacklist; any admin, not only `owner()`.
- Behaviour that changes after 900 s, the last far sale, when the token's code read neither the time
  nor its pool on the guard's transactions: a time test in a branch they never took (behind a flag its
  owner sets later, or reached only once others traded), or a time someone else writes into its storage.
  A token whose code reads TIMESTAMP, NUMBER or its pool there is a `warn`
  ([allow-list](#environment-rule)); a sale closed from 5 to 15 min on is caught at every check.
- What Base does during those minutes: the far sales run on a frozen copy of the reference block. A token
  keyed on time and on state Base moves together passes them ([why](#the-far-sale)).
- A sale size or delay the check did not draw: a sale refused only below some share, or only during a
  window that reopens before 900 s and misses the drawn delays. Each check draws the first and late
  sales, the far sale between 301 and 900 s, and the later side's block anew; the guard takes one check
  per token at a time, and quarantines the token after a `block` that rests on its code, 30 min by
  default, not after a `warn`, a disagreement or a check that could not run
  ([token limits](contract.md#token-limits)). What a re-draw can escape is bounded: a refusal in force at
  301 s or at 900 s is met at every check, the late and far sales always sell the whole rest, and the
  [exit-size sale](#the-agents-exit-size) what an agent's exit sells; the agent exits when it chooses.
- State that did not move between the reference block and the later block (16 to 24 s): the token's
  own pool or storage when nobody touched them, a balance nobody moved. A token reading WETH or the
  factory is a `block` whatever moved; one keyed on its own pool is not.
- Others' trades re-executed after the buy run without the transactions before them in their block, and
  a transaction that touched neither the pool nor a footprint slot stays as Base ran it, even if it would
  have acted otherwise after the buy. When the re-execution cannot be built, the resale is not verified:
  a `warn` when the later sales go through, a `block` otherwise. A trap can force that `warn`: eleven
  trades of its pool, or others' trades whose own gas runs out once it does more after the buy. Dust and
  ten trades of an honest token's pool together block that check ([why](#others-trades-during-the-wait)).
- Uniswap V4 hooks: only V2 WETH pools are read.
- A token that refuses or taxes only some sale sizes can still get listed by a check of that size; the
  owner unlists.

- A holder of most of the supply: it sells into the pool with no trap in the code. The check reads who
  holds the LP, never who holds the token.
- The node: each sentinel believes the Base nodes it reads (`EVM_RPC`, `INDEX_RPC`). The guard takes
  two sentinels' identical votes for an `allow` ([quorum](contract.md#sentinel-quorum)), so one lying
  node no longer allows alone when no two read the same: on Base `check-mainnet.sh` gives the three
  four providers, none read by two; on the local fork all read the fork.

When the guard's address cannot pay for its transactions at the check, its balance is set to exactly
what they spend.

Block fields on Base: the coinbase is constant, the base fee sat at its floor (0.005 gwei in 10 of 11
blocks sampled on 2026-11-11), prevrandao is constant over an L1 epoch as simulated.

**Liquidity.** Liquidity older than an hour passes without its holders read, and so does liquidity
removed and re-added within the window that keeps 90 % of the supply. LP in a lock contract counts as
removable (false `warn`s).

**Reputation.**

- A widely used template has a mixed history; the 80 % share is what keeps it from blocking.
- A drain counts only as LP burned.
- On Base a farm spreads its pools over hours, so the 2 h minimum window lets a lying sentinel drop a
  farm's older pools.
- An operator who keeps 0.5 ETH in its target's pool from before the window escapes the farm's history.
