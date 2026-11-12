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
- [Sales drawn per check](#sales-drawn-per-check)
- [Environment rule](#environment-rule)
- [Verdicts and listing](#verdicts-and-listing)
- [Removable liquidity](#removable-liquidity)
- [Template reputation](#template-reputation)
- [Exit quotes](#exit-quotes)
- [What a check cannot show](#what-a-check-cannot-show)

## What a check reads

| Check                | How (read-only, public RPC calls)                                                | Verdict         |
| -------------------- | -------------------------------------------------------------------------------- | --------------- |
| Buy, takeback, sales | `eth_simulateV1`: four requests, below                                           | see below       |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1,800 blocks (1 h) back             | see below       |
| Template reputation  | the index of V2 WETH pools by code template ([`app/index.ts`](../app/index.ts))  | see below       |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block` |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn` |
| Environment          | the guard's transactions replayed on a local fork: what they touch and call      | see below       |
| Environment opcodes  | the reachable code of the token and of its implementation                        | found: `warn`   |
| Agent exit quote     | `eth_simulateV1`: the guard's own approve and swap, alone, 2 and 3 blocks ahead  | quote = ETH in  |

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
  times, on the first real block `t` seconds after the reference block (`t` drawn per check, 16 to 24 s), with what
  the guard's buy wrote applied to it. A sale whose approve would come before that block is left out
  (on Base, which mines a block every 0.2 s, that block is about 100 blocks on, often past the first sale).

A simulation keeps Base still between the buy and the sales; Base does not. On the later side, whatever
Base really did in those `t` seconds is there, before the approve as well as before the swap: others'
WETH, the base fee, the factory, the token's own pool. Nothing in it is a recipe a token could recognise.
The sentinel waits for that block: a verdict now comes 23 to 32 s after the request (measured on Base
mainnet and on the fork, against 8 to 10 s before).

What the buy wrote comes from the [trace](#environment-rule): each storage slot it changed and each ETH
balance, before and after. On the later block:

- a slot Base did not write since takes the buy's value;
- a slot Base also wrote keeps Base's value, and the check is a `warn` at best (`N slot(s) the buy wrote
  moved on Base before block B`). When someone traded the pool, the later sales meet the pool as Base
  left it, without the buy's trade;
- an ETH balance adds the buy's change to Base's (WETH's balance is its total supply);
- the guard gets what its own transactions spend, as on the other sides.

A sale that goes through on the guard side and is refused on the later side, or pays more than 1 % less
there against the pool's quote, is a `block` that lists nothing: `sale refused N blocks after the buy on
Base's state of block B (…)`. Replay rebuilds the later side on the same block and rejudges it;
`--check` recomputes `t` and the block.

Measured on Base mainnet on 2026-11-12: WETH's supply moved in 160 of 600 consecutive blocks (2 min);
the Uniswap V2 factory got 16 new pairs in the last hour, 312 in a day. State that slow often stays
still for 24 s: a token that reads WETH or the factory is a `block` by the
[environment rule](#environment-rule), whatever moved.

The two sales are previews of an exit (no floor, a deadline past the late sale), not bytes NEAR will
sign. An exit's own approve and swap are simulated again, as signed, by its [exit quote](#exit-quotes).

**Amounts come from logs**, never from a read between transactions: tokens bought from the token's
`Transfer` logs; the ETH a sale pays from the ETH transfers `traceTransfers` logs; a sale's quote from
the pool's last `Sync` before its approve (on the later side, before any sale, from the pool's reserves
on that block: `later.reserves`).

**Blocks follow Base's cadence**: 2 s per block, every block up to the late sale listed (empty in
between: a node fills a gap with 12 s blocks), the real base fee and coinbase, and one prevrandao per
L1 epoch of 6 blocks, as on Base. Replay recomputes them.

**What this closes**: tokens keyed on

- a difference between the simulation and the real transactions (gas price, gas limit, fees, amount,
  approve, calldata);
- extra calls of the simulation (a top-level read, a probe's call before a sale);
- where or what the check sells (the next block, the late block, half the balance);
- state Base moved between the buy and the later block, including before the approve;
- WETH and the factory, whether or not they moved (the environment rule).

What stays open is in [what a check cannot show](#what-a-check-cannot-show).

## Sales drawn per check

| Draw       | When                                                            | What                                                     |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| First sale | 5 to 150 blocks after the buy (10 to 300 s)                     | 13 % to 87 % of the tokens bought, never a whole percent |
| Late sale  | 200 to 255 blocks after the buy (400 to 510 s)                  | the rest; the request ends there                         |
| Later side | the first real block 16 to 24 s after the reference block       | the sales whose approve comes after it, again            |

The probes, both sales and the later side's wait are drawn by `deriveProbes` from:

```text
sha256("goblin-near probe|<guard>|<check id>|<requested_ns>|<reference block hash>|<role>")
```

That block hash does not exist before the block, so a token owner watching NEAR cannot expect either
sale's block, the amount or the later block. The draws are in the evidence as `sales` and `later.block`;
`replay --check` recomputes them.

Times here assume Base's former 2 s per block, which the simulated blocks and the fork keep. Base has
mined a block every 0.2 s since a day between 2026-08-15 (block 50,000,000: 1,000 blocks in 2,000 s) and
2026-11-09 (block 55,000,000: 1,000 blocks in 200 s). On Base today every span counted in blocks on this
page (sales, liquidity window, index window, drains) lasts a tenth of the time it states, and a simulated
block's time is not a real one's: see [what a check cannot show](#what-a-check-cannot-show).

`eth_simulateV1` refuses blocks more than 256 above the base block: that bounds the late sale.

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

**`token_calls`**: the contracts the token's own code calls in those transactions (each traced with
`callTracer`), its implementation for a proxy.

- WETH and the factory are allowed above for the router's sake, yet all of Base moves their state. A
  token that calls either one is a `block` naming it: `token calls WETH and the V2 factory during a
  transfer: state all of Base moves`, whether or not that state moved during the check.
- Judge pass 8's ApproveKey, BusyTell and pass 7's WethKey all call WETH (BusyTell the factory too).

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
- TIMESTAMP and NUMBER stay allowed: the simulated blocks follow Base's cadence, and the two sales
  exercise them. After the late sale nothing is checked.
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
| A revert, a takeback, or a tax of 50 % or more                            | `block` |
| A pool that pays out more WETH than the seller receives                   | `block` |
| An address outside the token, its pool and Uniswap touched                | `block` |
| The token's code calls WETH or the factory                                | `block` |
| A sale refused, or paying 1 % less, on the later side                     | `block` |
| A template whose earlier pools were drained, or a token on the blocklist  | `block` |
| A tax from 10 %, an environment opcode, removable liquidity, code changed | `warn`  |
| A slot the buy wrote that Base also wrote before the later block          | `warn`  |
| No V2 pair, no template index for the chain                               | `warn`  |

A sale's tax is measured on the ETH the seller receives, against the pool's quote.

**Listing.** A `block` lists the token (the sentinel's `list_target`) only for what the probe shows
after a buy that succeeded, when the pool quotes at least 1,000 token units for the agent's amount:

- a takeback;
- a buy that delivers nothing, or a 50 % buy tax;
- a refused sale, or a 50 % sale tax, on a sale the pool quotes at 1,000 wei or more.

A refused sale lists the token only when the **late sale is refused too**. A refusal that clears with time
(`cooldown_60` sells 30 blocks after the buy) blocks that check and lists nothing: otherwise any agent
could repeat checks until one lists an honest token.

These never list: a failed buy, a quote under 1,000 units, a dust sale, a pool that pays out more, a
finding of the later side or of the environment rule, template reputation, and a failure on the guard's
side only (its reason starts with `guard address only, not listed`).

The evidence carries `list_target`; replay recomputes it and `--check` compares it with the guard's.

## Removable liquidity

If at least 90 % of today's LP supply already existed 1,800 blocks ago, the liquidity is old and its
holders are not read. Otherwise the holders come from the pair's `Transfer` logs (at most 4
`eth_getLogs` of 500 blocks, then `balanceOf` and `eth_getCode` per holder, at most 20).

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
- At least 3 earlier pools with at least 80 % drained within 1 day of funding is a `block`, never listed.
- A pool that held 0.5 ETH of WETH before the index window is not judged:
  `template reputation not applied: the token's own pool was funded before the index window`.
- No index for the chain is a `warn`: an unknown reputation is never a pass.
  It stays distinct from "not applied" and from "checked and clean" (no finding).

**The index window is bound to the check.** It must start at least 2,000 blocks (67 min) before the
check's reference block and end at that very block: a window cannot miss a farm's earlier pools, nor
drop its newest ones.

The sentinel builds the index for each check, from block `INDEX_FROM` to the reference block, and
judges with no other. Replay reports a `MISMATCH … is not bound to block …`, and rebuilds the whole
index to compare its sha256.

On the fork the index runs from the fork's first block, about 2,200 blocks. The real-Base one below spans
43,201: rebuilt for each check, it would cost 283 requests (about 5 min at one per second), so
`check-mainnet.sh` runs without one (a `warn`).

### Measured on real Base

One run on 2026-11-11, read-only, at most one request per second (it would have stopped on the first
error or `429`; none came):

```sh
bun app/index.ts https://base-rpc.publicnode.com 56133114 56176314 base-index.json --pace-ms 1000
```

- Blocks 56,133,114 to 56,176,314: 43,201 blocks, from 17:09:58 to 19:33:58 UTC (2.4 h at 0.2 s a
  block; this page first said 24 h, counting 2 s), ending at the chain head.
- 283 requests in 298.5 s; index sha256 `0x16f519b6…96ea`.
- 29 Uniswap V2 WETH pools with code, all of one code template, all funded (at least 0.5 ETH net).
- 24 drained within 43,200 blocks of funding: from 3,907 to 14,467 blocks, median 4,027 (about 13 min
  at 0.2 s a block).
- A copy of that template whose pool is created after the window gets `block` (24 of 29 is above 80 %).

The index lists the pools' token and pair addresses; none is published here. Re-run on 2026-11-12 with
the same command: same sha256, 283 requests in 296.9 s. A pruned node refuses the old state; an archive
node does not. `mainnet.base.org` does not serve `eth_getLogs`.

## Exit quotes

When an agent asks to sell (`request_exit`), the sentinel simulates the approve and swap the guard would
sign, from the guard's address, alone: the approve 2 blocks ahead, the swap in the next.

The quote is the ETH that reached the guard's address; the guard sets the agent's floor from it (quote
minus 3 %). It simulates twice: with no floor to get the quote, then exactly as signed on that quote.

## What a check cannot show

A simulation cannot prove that a token will be sellable later. Still open:

- An owner action after the buy: a pause, a fee raised, a blacklist; any admin, not only `owner()`.
- Behaviour that changes after the late sale (400 to 510 s after the buy), through TIMESTAMP or NUMBER.
- A sale size or delay the check did not draw: a sale refused only below some share, or only after
  510 s. An agent's exit sells its holding (the signed minimum, 97 % of the quote), when it chooses.
- State that did not move between the reference block and the later block (16 to 24 s): the token's
  own pool or storage when nobody touched them, a balance nobody moved. A token reading WETH or the
  factory is a `block` whatever moved; one keyed on its own pool is not.
- A slot the buy wrote that Base also wrote (someone traded the pool): the later sales run on Base's
  value, without the buy's trade; such a check is a `warn` at best.
- The later side is not traced: an address its sales touch only on Base's later state goes unseen.
- The guard's own ETH balance: each side gives it what its transactions spend, not Base's.
- Base's cadence: the simulated blocks advance 2 s each, Base's real ones 0.2 s (several share a second).
  A token that compares `block.timestamp` with `block.number` since its buy tells the check from a real
  sale, and the late sale lands 40 to 51 s after the buy on Base, not 400 to 510 s. Re-deriving every
  block count from 0.2 s is not done in this pass.
- Uniswap V4 hooks: only V2 WETH pools are read.
- A token that refuses or taxes only some sale sizes can still get listed by a check of that size; the
  owner unlists.

When the guard's address cannot pay for its transactions at the check, its balance is set to exactly
what they spend.

Block fields on Base: the coinbase is constant, the base fee sat at its floor (0.005 gwei in 10 of 11
blocks sampled on 2026-11-11), prevrandao is constant over an L1 epoch as simulated.

**Liquidity.** Liquidity older than 1,800 blocks passes without its holders read, and so does liquidity
removed and re-added within the window that keeps 90 % of the supply. LP in a lock contract counts as
removable (false `warn`s).

**Reputation.**

- A widely used template has a mixed history; the 80 % share is what keeps it from blocking.
- A drain counts only as LP burned.
- On Base a farm spreads its pools over hours, so the 2,000-block minimum window lets a lying sentinel
  drop a farm's older pools.
- An operator who keeps 0.5 ETH in its target's pool from before the window escapes the farm's history.
