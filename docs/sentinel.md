# Sentinel

The sentinel judges a token before the guard lets an agent buy it. It runs off-chain
([`app/sentinel.ts`](../app/sentinel.ts)), reads the guard's new checks, simulates on a Base node
([`app/verifier.ts`](../app/verifier.ts)), and posts a verdict with its one NEAR key, limited to `post_verdict`.

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
- [Environment rule](#environment-rule)
- [Verdicts and listing](#verdicts-and-listing)
- [Removable liquidity](#removable-liquidity)
- [Template reputation](#template-reputation)
- [Exit quotes](#exit-quotes)
- [What a check cannot show](#what-a-check-cannot-show)

## What a check reads

| Check                | How (read-only, public RPC calls)                                                | Verdict                                       |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Buy, takeback, sales | `eth_simulateV1`: four requests, below                                           | see below                                     |
| Far sale             | the late sale again 301 to 900 s after the buy, mined on the trace's local fork  | see below                                     |
| Cadence              | the timestamps of the reference block and of the 100th block before it           | none: it turns the rules' seconds into blocks |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1 h back, by the blocks' timestamps | see below                                     |
| Template reputation  | the index of V2 WETH pools by code template ([`app/index.ts`](../app/index.ts))  | see below                                     |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block`                               |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn`                               |
| Environment          | the guard's transactions replayed on a local fork: what they touch and call      | see below                                     |
| Environment opcodes  | the reachable code of the token and of its implementation                        | found: `warn`                                 |
| Agent exit quote     | `eth_simulateV1`: the guard's own approve and swap, alone, 2 and 3 blocks ahead  | quote = ETH in                                |

A check that fails (an RPC error, an index window not bound to the check) is retried; after 3 tries
the sentinel posts a `block`: `simulation impossible after 3 tries : …`.

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
The sentinel waits for that block: on Base mainnet a verdict came 25 to 31 s after the request (checks #65
to #69), 53 s when the pool traded meanwhile and its trade was re-executed (#70).

What the buy wrote comes from the [trace](#environment-rule): each storage slot it changed and each ETH
balance, before and after. On the later block:

- a slot Base did not write since takes the buy's value;
- when Base also wrote one (`later.moved`: someone traded the pool), others' trades are re-executed after
  the buy, [below](#others-trades-during-the-wait);
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

The two sales are previews of an exit (no floor, a deadline past the late sale and the far sale), not
bytes NEAR will sign. An exit's own approve and swap are simulated again, as signed, by its
[exit quote](#exit-quotes).

Past the four requests, the late sale runs once more minutes later, on a local fork:
[the far sale](#the-far-sale).

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
   pair, or a `Transfer` of the token or of WETH to or from it. Read from each block's receipts
   (`eth_getBlockReceipts`; `mainnet.base.org` refuses `eth_getLogs`), one block at a time: about 11 s
   for 100 blocks. At most 10.
2. **Block by block**, on a throwaway anvil forked at the block before each one: its trades run once on
   Base's own state, and must give back Base's value of every slot that counts (the soundness check);
   then again on that state with the buy's **footprint** set first. Same senders, calldata, value, gas,
   fees, nonces, order, block time, base fee and coinbase.
3. **The footprint**: the slots where the two runs differ, with the second run's values. It starts as
   what the buy wrote. The token's and the pair's slots join it; other contracts' only when the buy wrote
   them (WETH's balance of the pool). A footprint slot may not move between blocks without a trade.
4. **On the later block**, the footprint is set and nothing else: WETH's supply, others' pools, the
   factory, L1Block stay as Base left them.

So the later sales meet the pool as if the guard had bought first and the others traded after it, on
everything else as it really was. A sale that goes through and pays within 1 % of the pool's reserves
there is not downgraded. Each trade's hash is in `later.replayed`; replay fetches the trades again and
re-executes them, and one left out is a `MISMATCH`.

**Measured on Base mainnet**, 2026-11-12, USDC: in 7 real windows where its pool traded during the wait
(check #70, and 6 past windows checked read-only), the trades were re-executed and the resale verified
in 3. In the other 4 the resale is not verified: in three, re-executing the trades did not give back
Base's value of a USDC balance (the one inspected is an arbitrage contract's, which ten other
transactions of the same block also moved; another window hit the same slot), and one window held 14
trades.

The canonical pair and WETH have known code, and their arithmetic could be applied instead; it is not:
re-execution covers them and the token alike, with one code path.

**When it cannot be built**, `later.unverified` says why: a trade anvil cannot replay (a deposit or an
EIP-7702 transaction), a trade whose status differs from Base's, a re-execution that does not give back
Base's values, a footprint slot moved with no trade of the pool, more than 10 trades. The later sales
then run on Base's values for the slots both wrote and the buy's for the rest: a sale that goes through
there is a `warn`, `resale not verified on Base's state of block B: <why>`. A sale refused there, or
paying 1 % less, is still a `block` that lists nothing: `sale refused N s after the buy on Base's state of
block B (…), merged with the buy's values: <why>`. Otherwise a trap would force that fallback (a write
outside its pool to a slot the buy wrote, eleven trades of its pool) to escape the block
(`bun test -t "more trades of its pool than can be re-executed"`).

**Dust sent to the guard.** Anyone can send a token to the guard's public address during a check: on
Base's state the guard then holds the dust, not what it bought, and its sale is refused there. So when
a single slot both wrote moved and nobody traded the pool, that slot gets both changes, Base's and the
buy's (`…; the sales ran with both its changes, Base's and the buy's`): what a balance holds. Nothing the
token returns decides it. USDC dusted during its check: its sale goes through there, a `warn`
(`bun test -t "USDC sent to the guard"`); WethKey dusted: refused there, a `block`
(`bun test -t "dust sent to the guard during WethKey"`). A token whose slot is no balance can accept that
sum where the real chain would refuse: a `warn`, the owner decides. Eleven trades of an honest token's
pool and dust together still block that check, not listed.

**What it approximates.** Each block's trades run on the state at the end of the block before, without
the transactions before them in their block. A transaction that touched neither the pool nor a footprint
slot is Base's, even when it would have acted differently after the buy (an arbitrage that read the pool
and passed). The block's prevrandao is not reproduced.

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

| Draw       | When                                                       | What                                                     |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| First sale | 2 to 25 s after the buy (10 to 125 blocks on Base)         | 13 % to 87 % of the tokens bought, never a whole percent |
| Late sale  | 30 to 51 s after the buy (150 to 255 blocks on Base)       | the rest; the request ends there                         |
| Later side | the first real block 16 to 24 s after the reference block  | the sales whose approve comes after it, again            |
| Far sale   | 301 to 900 s after the buy (1,505 to 4,500 blocks on Base) | the late sale again, on a local fork                     |

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
cadence would cap the late sale at the 256th block. Past it, the far sale.

## The far sale

A token that refuses or taxes a sale from 5 minutes after the buy (`sell_blocked_later`, `sell_tax_later`)
passes every sale `eth_simulateV1` can reach. The far sale plays the late sale again **301 to 900 s after
the buy** (drawn per check, 1,505 to 4,500 blocks on Base), on the throwaway anvil fork the
[trace](#environment-rule) already starts at the reference block, whose clock and block number move
([`app/environment.ts`](../app/environment.ts) `trace`):

- **The guard.** Back before its late approve, the empty blocks up to the far sale mined at once
  (`anvil_mine`), then the late sale's own approve and swap, each in its block, at the number and time a
  real block would have at the cadence measured (`block.number` and `block.timestamp` agree as on Base),
  with the reference block's base fee and coinbase. Traced like the guard side: what they touch and what
  the token's code reaches join `touched` and `token_calls`.
- **The probe.** Back at the reference block, in a run of its own: its buy and first sale at their blocks
  and times, the empty blocks mined at once, then its late approve and swap at the far blocks.

The empty blocks hold no transaction; their times are the fork's clock, not the cadence's (only
BLOCKHASH, a flagged opcode, sees them). They stay in memory: the fork keeps the last 300 states
(`--prune-history`), and its directory is removed with it. Mining 4,500 of them took 0.05 to 0.15 s.

Each result is read from the fork as `eth_simulateV1` gives it (status, return data, logs, and each ETH
transfer as a log) and judged as the other sales: refused, taxed from 10 % (`warn`) or 50 % (`block`)
against the pool's quote after the buy and the first sale, a pool paying out more. Reasons say when, in
seconds: `sale refused 762 s after the buy (TransferHelper: TRANSFER_FROM_FAILED)`. The far sale is the
last sale for [listing](#verdicts-and-listing).

In the proof, the fifth request (`local_fork_mine`, never sent to a node) lists the four far blocks, the
guard's approve and swap then the probe's; the fifth response, their results; `evidence.calls` ends with
their labels (`far: guard: sale late`). Replay rebuilds that request from the guard and probe sides,
mines it again on its own fork and compares every result.

**Cost**, USDC on Base mainnet, read only, blocks already mined (no wait), 2026-11-12: 13.4 to 14.0 s a
check before, 17.1 to 17.3 s with the far sale (no trade of the pool in either); the throwaway anvil's
peak memory 42 to 47 MB before, 85 to 95 MB after. The sentinel runs it while it waits for the later
side's block: on the guard, from the request to the verdict, 24.7 to 30.5 s before (checks #65 to #69),
23.0 to 25.5 s with the far sale (#96 to #98). The probe's run costs about 3 s against a public node: back
at the reference block, the fork fetches the state it reads again. On the local copy of Base: 0.8 to
1.7 s a check.

**What it is not.** A frozen copy of the reference block: nothing Base does in those minutes is in it,
neither others' trades of the pool nor WETH, L1Block or the base fee. A token keyed on time and on that
state together (refusing from 5 minutes on only once WETH moved) passes there; the later side sees 16 to
24 s of real Base. The horizon is the drawn delay: a sale closed from 10 minutes on is caught when the
draw lands past it, about 1 check in 2; one closed from 20 minutes on passes.

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
  transaction's access list taken before it is sent.
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

**`opcodes`**: BLOCKHASH, COINBASE, PREVRANDAO, GASLIMIT, BASEFEE, BLOBHASH, BLOBBASEFEE, GASPRICE and
ORIGIN in the reachable code of the token and of its implementation: a `warn` naming them.

- Reachable: from offset 0 and each valid JUMPDEST until an opcode that halts or jumps.
- Data solc appends (revert strings, metadata) is skipped only when the code before it halts and it holds
  no JUMPDEST. Read as code, a revert string's "H" is BASEFEE: a naive scan flags Uniswap's router.

Decisions, each on purpose:

- GAS is not flagged: solc emits it before every external call, and each simulated transaction carries
  the guard's own gas limit. SELFBALANCE reads the token's own state. BALANCE and EXTCODE* name an
  address, which `touched` judges (anvil's access list reports them: tested).
- TIMESTAMP and NUMBER stay allowed: the simulated blocks follow the cadence measured, and the sales
  exercise them up to the [far sale](#the-far-sale) (301 to 900 s). After it nothing is checked.
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
- The full check of USDC, DAI, AERO, DEGEN, BRETT, TOSHI, VIRTUAL and cbBTC found no environment
  finding; each got `warn` only for its unknown reputation.

**On the fork**, `red_l1_trap` and `helper_trap` (L1Block reached through a delegatecall to a helper
whose address sits in storage) are a `block`, USDC an `allow`. `basefee_trap` is a `warn` for its opcode,
and a `block` once the base fee moved before the later block: on the fork it falls about 2 wei a block,
on Base it sat at its floor in 10 of 11 blocks sampled. `weth_key`, `approve_key` and `busy_tell` call
WETH: a `block`.

[`app/environment.test.ts`](../app/environment.test.ts) shows each real sale failing after one emulated
sequencer block (L1Block's sequence number advanced), a base fee move, or another user's WETH deposit.

## Verdicts and listing

| Finding                                                                   | Verdict |
| ------------------------------------------------------------------------- | ------- |
| A revert, a takeback, or a tax of 50 % or more, the far sale's included   | `block` |
| A pool that pays out more WETH than the seller receives                   | `block` |
| An address outside the token, its pool and Uniswap touched                | `block` |
| The token's code calls or reads WETH or the factory                       | `block` |
| The token's code reads an ETH balance                                     | `block` |
| A sale refused, or paying 1 % less, on the later side, verified or not    | `block` |
| A template whose earlier pools were drained, or a token on the blocklist  | `block` |
| A tax from 10 %, an environment opcode, removable liquidity, code changed | `warn`  |
| Others' trades not re-executed, the resale going through there            | `warn`  |
| No V2 pair, no template index for the chain                               | `warn`  |

A sale's tax is measured on the ETH the seller receives, against the pool's quote.

**Listing.** A `block` lists the token (the sentinel's `list_target`) only for what the probe shows
after a buy that succeeded, when the pool quotes at least 1,000 token units for the agent's amount:

- a takeback;
- a buy that delivers nothing, or a 50 % buy tax;
- a refused sale, or a 50 % sale tax, on a sale the pool quotes at 1,000 wei or more.

A refused sale lists the token only when the **far sale is refused too**, the last sale, 301 to 900 s
after the buy (it took over that role from the late sale). A refusal that clears
with time (`cooldown_60` sells 30 blocks after the buy) blocks that check and lists nothing: otherwise
any agent could repeat checks until one lists an honest token. A token that refuses sales for longer
than 301 s after a buy (an anti-bot delay of 10 minutes) is listed when the far sale lands within it.

These never list: a failed buy, a quote under 1,000 units, a dust sale, a pool that pays out more, a
finding of the later side or of the environment rule, template reputation, and a failure on the guard's
side only (its reason starts with `guard address only, not listed`).

The evidence carries `list_target`; replay recomputes it and `--check` compares it with the guard's.

## Removable liquidity

If at least 90 % of today's LP supply already existed an hour ago (at the first block of the last hour,
by the blocks' timestamps), the liquidity is old and its holders are not read. Otherwise the holders come
from the pair's `Transfer` logs (on Base, at most 4 `eth_getLogs` of 5,000 blocks, then `balanceOf` and
`eth_getCode` per holder, at most 20).

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

The sentinel builds the index for each check, from block `INDEX_FROM` to the reference block, and
judges with no other. Replay reports a `MISMATCH … is not bound to block …`, and rebuilds the whole
index to compare its sha256.

On the fork the index runs from the fork's first block, about 300 blocks spaced over 2.4 h
(`evm/fork.sh` mines 10 blocks 800 s apart). On Base, 2 h are 36,000 blocks: 37 requests, 2.1 s
(measured below). It needs a node that serves `eth_getLogs`; `mainnet.base.org` answers `request limit
reached`, so `check-mainnet.sh`, which uses it, runs without an index (a `warn`).

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

## Exit quotes

When an agent asks to sell (`request_exit`), the sentinel simulates the approve and swap the guard would
sign, from the guard's address, alone: on the first block of the latest second, the approve 2 blocks
ahead, the swap in the next, at the cadence measured there (in the evidence, as for a check).

The quote is the ETH that reached the guard's address; the guard sets the agent's floor from it (quote
minus 3 %). It simulates twice: with no floor to get the quote, then exactly as signed on that quote.

## What a check cannot show

A simulation cannot prove that a token will be sellable later. Still open:

- An owner action after the buy: a pause, a fee raised, a blacklist; any admin, not only `owner()`.
- Behaviour that changes after the far sale, drawn 301 to 900 s after the buy: a sale closed from 20 min
  on passes, one closed from 10 min on is caught in about 1 check in 2. From 5 min on
  (`sell_blocked_later`, `sell_tax_later`) is caught at every check.
- What Base does during those minutes: the far sale runs on a frozen copy of the reference block. A token
  keyed on time and on state Base moves together passes it ([why](#the-far-sale)).
- A sale size or delay the check did not draw: a sale refused only below some share, or only between
  51 s and the far sale's delay. An agent's exit sells its holding (the signed minimum, 97 % of the
  quote), when it chooses.
- State that did not move between the reference block and the later block (16 to 24 s): the token's
  own pool or storage when nobody touched them, a balance nobody moved. A token reading WETH or the
  factory is a `block` whatever moved; one keyed on its own pool is not.
- Others' trades re-executed after the buy run without the transactions before them in their block, and
  a transaction that touched neither the pool nor a footprint slot stays as Base ran it, even if it would
  have acted otherwise after the buy. When the re-execution cannot be built, the resale is not verified:
  a `warn` when the later sales go through, a `block` otherwise. A lone slot moved with no trade (dust
  sent to the guard) gets both changes, which a token whose slot is no balance can accept where the real
  chain would refuse; dust and eleven trades of an honest token's pool together block that check
  ([why](#others-trades-during-the-wait)).
- The later side is not traced: an address its sales touch only on Base's later state goes unseen.
- Uniswap V4 hooks: only V2 WETH pools are read.
- A token that refuses or taxes only some sale sizes can still get listed by a check of that size; the
  owner unlists.

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
