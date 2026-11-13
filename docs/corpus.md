# Launch corpus

How does the check do on new tokens nobody picked? This page runs it on every Uniswap V2 WETH launch of
a six-hour window of real Base history, as it would have run then, and compares each verdict with what
happened to the pool over the next 24 hours. Measured on 2026-11-12/13, read only.

**Short answer.** Every bad outcome in the corpus was a token that sells normally and whose liquidity
was pulled (or whose reserve was dumped). The simulation and code rules flagged none of them. The
template reputation rule blocked all 73 pools of the one farm that dominates these launches. Every other
bad outcome got the `warn` for removable liquidity that honest launches get too. The check addresses losses written in
a token's code, and repeat farms. It does not separate a rug by liquidity removal from an honest launch
on its first pools.

## Method

**Window.** Base blocks 56,068,314 to 56,176,314: 2026-11-11, 13:33:58 to 19:33:58 UTC, 6 h at five
blocks a second. It ends 27.7 h before the run, so the 24 h after every launch in it are known. The
[documented index window](sentinel.md#measured-on-real-base) is its last 2.4 h.

**Pools.** Every `PairCreated` of the V2 factory against WETH in the window: 76 pairs. A pair is
_launched_ at its first `Mint` (first liquidity added) if that falls in the window; 75 were. All 75 were
checked, with no sampling.

**Other families.** 73 of the 75 share one code template (the farm below). To see other code, the 24 h
before the window were listed too (2026-11-10 13:33:58 to 2026-11-11 13:33:58): 317 WETH pairs, 294 of
them the farm's template, left out. The other 23 were labelled and checked the same way; 21 were launched.

**Outcome labels.** They come from logs _after_ the launch only, over the 24 h after it, and never reach
the check. They were fixed before any verdict was seen, and apply in this order of precedence:

| Label           | Rule                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `honeypot-like` | at least 5 buy recipients besides the launcher, and no sale by anyone else, over at least 30 min (until the LP was pulled, or 24 h) |
| `drained`       | 90 % of the LP ever minted burned within 24 h (the index's definition, counted from the first `Mint`)                               |
| `dumped`        | LP in place, but the WETH reserve at +24 h under 10 % of the launch's                                                               |
| `alive`         | LP in place, a sale by someone other than the launcher, WETH reserve at +24 h at least 50 % of the launch's                         |
| `unclear`       | anything else (no trade, or a reserve between 10 % and 50 %)                                                                        |

- _Launcher_: the sender of the first `Mint`'s transaction.
- _Buys_ and _sales_: the pair's `Swap` events (WETH in and token out, or the reverse) before the LP was
  pulled. A buyer is the `Swap` recipient. A seller is the sale transaction's sender, looked up until
  two sellers other than the launcher are found (at most 40 lookups per pool).
- Bad outcomes: `drained`, `honeypot-like`, `dumped`. Good: `alive`.

**Families.** Pools are grouped by code template (the project's `templateOf`: runtime code with `PUSH32`
operands and metadata masked, taken at the launch block) and by launcher.

**The check, as it would have run then.** `checkToken` was called directly, read only, not through the
guard, with the sentinel's own indexer:

- _Request time_: the launch block's timestamp + 60 s. The reference block is then, as always, the first
  block at least 4 s later: 316 to 320 blocks (about 64 s) after launch. The later side runs on the real
  block 16 to 24 s after it. Nothing after that block is read.
- _Index_: the sentinel's window, the 2 h before the reference block, built by `app/sentinel.ts`
  `indexer` on publicnode.
- _Amount_: 0.00001 ETH, from the guard's Base address used for the
  [well-known tokens](sentinel.md#well-known-tokens-on-real-base). The guard's transactions are built by
  `app/testkit.ts` `localPreviews` (nonce 0, setup fees, 3 % slippage). No NEAR listing and no previous
  verdict.
- _Per rule_: each pool also records the reputation finding, the liquidity finding, and the verdict of
  the remaining rules (simulation and code), judged on the same results with the first two neutralised.

**Nodes.** `mainnet.base.org` served state, `eth_simulateV1` on old blocks and the anvil forks;
`base-rpc.publicnode.com` served logs. Both went through a local proxy that throttles requests, waits
out HTTP 429 and caches every answer pinned to a block.

## Results

### Confusion: verdict at about +64 s against outcome over 24 h

| Set                             | Outcome         | Pools | `block` | `warn` | `allow` |
| ------------------------------- | --------------- | ----: | ------: | -----: | ------: |
| Window (75 launches)            | `drained`       |    64 |      64 |      0 |       0 |
|                                 | `honeypot-like` |     9 |       9 |      0 |       0 |
|                                 | `alive`         |     1 |       0 |      1 |       0 |
|                                 | `unclear`       |     1 |       1 |      0 |       0 |
| Other families, day before (21) | `drained`       |     6 |       0 |      6 |       0 |
|                                 | `honeypot-like` |     1 |       0 |      1 |       0 |
|                                 | `dumped`        |     1 |       0 |      1 |       0 |
|                                 | `alive`         |    10 |       3 |      7 |       0 |
|                                 | `unclear`       |     3 |       3 |      0 |       0 |

No check failed (each was tried once and succeeded). No pool got `allow`.

### Which rule decided

| Deciding rule                            | Bad outcome (81) | `alive` (11) | `unclear` (4) |
| ---------------------------------------- | ---------------: | -----------: | ------------: |
| `block`: template reputation             |               73 |            0 |             0 |
| `block`: simulated buy reverts           |                0 |            2 |             4 |
| `block`: simulated sales refused         |                0 |            1 |             0 |
| `warn`: removable LP only                |                7 |            6 |             0 |
| `warn`: removable LP plus a code finding |                1 |            2 |             0 |

The code findings beside the LP warn: the 1.4 ETH `drained` launch read TIMESTAMP; the 5 ETH `alive`
launch read its own pool and TIMESTAMP; one dust `alive` pool taxed the buy 30 % and read TIMESTAMP.
Without the reputation rule, all 81 bad outcomes are `warn` and none is `block`: the simulation found every one of
these tokens sellable, buy and sales, at every drawn delay up to 900 s.

### Families

| Family                      | Pools | Launchers | Size (ETH)       | Outcomes                                                 | Verdicts                          |
| --------------------------- | ----: | --------: | ---------------- | -------------------------------------------------------- | --------------------------------- |
| Farm `0x16b3..b5d7`         |    73 |        73 | 3.5 to 39.9      | 64 drained, 9 honeypot-like                              | 73 `block` (reputation)           |
| Dust launcher, 11 templates |    11 |         1 | 0.0001           | 9 alive, 2 unclear                                       | 7 `warn`, 4 `block` (buy reverts) |
| Mini-farm `0x13e3..ca6a`    |     4 |         1 | 0.00002          | 4 drained (34 to 113 s)                                  | 4 `warn`                          |
| 8 single-pool templates     |     8 |         8 | under 0.001 to 5 | 2 drained, 1 dumped, 1 honeypot-like, 2 alive, 2 unclear | 5 `warn`, 3 `block`               |

21 templates and 83 launchers over 96 checked pools. The only non-farm launches of real size are two
single pools. A 5 ETH launch stayed `alive` and got `warn`; a 1.4 ETH launch was drained after 15 min
and also got `warn`, for the same reason (LP removable by an EOA).

### First pools of a family

Template reputation needs at least 3 earlier pools of the template in the 2 h window. 23 checks had
fewer: every non-farm pool (21) and the window's two dust pools. Of them, 8 had a bad outcome, all
`warn`, and none was blocked by reputation. The others: 8 `warn` and 7 `block` (a buy or sale that
reverted).

The farm's own first pools are not in this corpus. Walking back from the window, its template had 294,
299, 267, 274 and 263 pools on each of the five days before, and 678 more from 2026-11-03 21:39 to 2026-11-06 13:34 UTC.
Over those 2,075 pools it never paused for more than 8,825 blocks (29 min). Every farm check therefore
had 22 to 28 earlier pools in its window. Measuring its start would need history from before 2026-11-03,
at Base's former 2 s cadence.

### How close the farm came to passing

The farm pulls its LP 2 to 48 min after launch (median 13.4 min), so its newest pools are still
undrained at each check and count against it. The drained share of earlier pools ranged from 0.82 to
1.00 (median 0.86), against a threshold of 0.80. In 8 of the 73 checks, one more undrained pool in the
window would have turned the `block` into a `warn`; in 36 of them, two more would have. A farm that
waits longer before pulling, or launches more often, would fall under it.

## What the labels hide

- **The 9 `honeypot-like` pools are not code honeypots.** All are the farm's 15 ETH size class. Their 10
  "buyers" are the same 10 addresses in all 9 pools, and every pool's LP was pulled 31 to 44 min after
  launch. The farm launches in five fixed sizes (3.5, 3.9, 15, 30.09 and 39.89 ETH), and each size has its
  own set of about 10 wallets that buy into nearly every pool of that size: activity staged by the farm. Across
  the farm's 73 pools there were 102 buy recipients; 44 appear in a single pool (possible real buyers)
  and one appears in 64 pools.
- **9 of the 11 `alive` pools are 0.0001 ETH pools from one launcher**, with 2 buys and 2 sales each:
  activity, not adoption. Two of them reverted the simulated buy 64 s after launch (trading not yet
  open), so a `block` there refused a transaction that would have failed, not a scam.
- **One `alive` pool refused the simulated sales** from 23 s to 301 s after the buy, yet two outside
  addresses sold within 24 h. By the labels this is a false positive; it may also be a sale restriction
  that was lifted later.
- **Two mini-farm pools cycled their liquidity.** 90 % of their first LP was burned 34 and 59 s after
  launch, before the reference block, but liquidity was added again: the check saw a live pool.
- **The one candidate honeypot outside the farm** (0.025 ETH, 8 buyers, no outside sale in 24 h, LP never
  pulled) got `warn`: the simulation could buy and sell it. Logs cannot settle it either way, because a
  failed sale emits none.

## What this shows

- On fresh V2 launches, `allow` never happens: a pool under an hour old whose LP is not burned is always
  at least a `warn`, honest or not. That `warn` hit 8 of the 11 `alive` pools and all 8 non-farm bad
  ones. It tells the owner "fresh launch, removable liquidity". It does not discriminate.
- Losses by liquidity removal or by holders dumping, on a token that sells normally, are outside what a
  buy-and-resale simulation can see: nothing in the code refuses the sale. In this corpus that is every
  loss observed.
- The template reputation rule is what blocked them, and only for a farm that reuses its code, funds at
  least 0.5 ETH and drains within the window often enough to stay above 80 %. A dust farm (the 0.00002
  ETH mini-farm) is invisible to it: its pools never reach the 0.5 ETH funding floor.
- Code-level findings were rare: one pool refused sales, one taxed buys 30 %, six reverted the buy.
  The simulation flagged each of them.

## What this does not show

- **The false-negative rate on code honeypots.** No confirmed code honeypot is in the corpus, so this
  rate is still unmeasured. The trap tokens in the tests remain the only evidence for that class.
- **Other venues.** Only Uniswap V2 WETH pairs. Most Base launches go through other venues (V3, V4,
  Aerodrome, launchpads).
- **Breadth.** One 6 h window, plus one day of non-farm launches. One farm makes up 97 % of the window's
  launches. The non-farm families are few, and mostly dust.
- **Later outcomes.** Labels stop at 24 h. A slow rug after that counts as `alive` or `unclear`.
- **Losses.** Who lost money is not established. Most of the farm's buyers are its own wallets.

## Reproduced historically, and what was not

Reproduced at the historical blocks:

- the reference block;
- `eth_simulateV1` on `mainnet.base.org`, one to two days back;
- the anvil forks (trace, far sales, the later side, others' trades re-executed in 55 checks, never
  unverified);
- the real later block 16 to 24 s on;
- the LP holders;
- the 2 h index on publicnode.

Not reproduced:

- **The NEAR side.** No blocklist entry and no previous verdict were read, as for a token never seen
  before; a listing could only add a `block`.
- **The guard's previews.** Built locally by `localPreviews`, checked against the contract's vectors,
  instead of being read from a guard.
- **The probes.** Derived from a fixed ticket instead of a NEAR one, so the drawn delays differ, but no
  less unpredictably.
- **The quorum.** One sentinel's verdict, not three on different nodes.
- **Quarantine after a `block`.** Not modelled: each pool was checked once.
- **Waiting in real time.** The later block already existed and was read directly. It is the block the
  sentinel would have waited for.

## Cost

| Step                                   | Requests (`mainnet.base.org` / publicnode) | Time         |
| -------------------------------------- | ------------------------------------------ | ------------ |
| Label the window's 76 pairs            | 265 / 807                                  | 126 s        |
| Check 75 launches (2 workers)          | 35,955 / 3,601                             | 2,480 s      |
| Label and check the day before's 23    | 6,600 / 1,603                              | 1,260 s      |
| Walk back the farm's history (6 steps) | 2,159 / 522                                | about 13 min |

About 52,400 requests in all (45,800 to `mainnet.base.org`, 6,600 to publicnode), including a first
timing test and the cached re-run below. A check sends 300 to 500 requests to `mainnet.base.org`, mostly
the anvil forks' state reads. 441 HTTP 429 answers were waited out; none was
refused. 3,800 answers were errors by design: anvil probes `anvil_nodeInfo` and `eth_getAccountInfo`,
which the public node rejects before anvil falls back. A cached re-run of two pools sent only
`latest`-block reads and those probes (220 requests, 19 s), and gave identical verdicts, reasons,
blocks and reputation.

## Reproduce

The window, the label rules and the method above are enough to measure it again: every input is a
public log or state of Base at the blocks named, and the check is the repository's own `checkToken`
and `indexer`. The scripts are in [`corpus/`](../corpus/README.md), with the commands of this run;
a small window is a quick trial, about a minute a pool. The per-pool data is a list of pool and launcher addresses: it is
not published here (see the README's Disclosure), and the scripts' outputs are ignored by git.
