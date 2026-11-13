# Launch corpus: the scripts

The scripts behind [docs/corpus.md](../docs/corpus.md), which holds the method, the labels and the
results. They call the repository's own `checkToken`, `indexer` and `templateOf` (`../app`).

Read only on Base. Nothing is signed or sent, and nothing touches NEAR. Every JSON-RPC call goes through
`proxy.ts`, a local proxy that throttles, waits out HTTP 429 and caches under `cache/` every answer
pinned to a block number. The anvil forks of the check fetch through it too (throwaway, in memory,
their directory under `tmp/`, never port 8545). A second run with `cache/` in place sends only the calls
on `latest` and anvil's two probe methods (`anvil_nodeInfo`, `eth_getAccountInfo`), which the public
node rejects and which are never cached.

Nodes: `https://mainnet.base.org` for state, simulation and the anvil forks (archive, `eth_simulateV1`
on old blocks). `https://base-rpc.publicnode.com` for logs (`eth_getLogs` over 5,000 blocks, up to 10
addresses). You need `bun` and Foundry's `anvil`, and `bun install` at the repository's root.

```sh
cd corpus
# 1-2. Window: every WETH pair, its launch and its outcome over the 24 h after launch (126 s uncached).
bun pools.ts 56068314 56176314 pools.json
# 3. The check of every launched pool, as a sentinel would have run it 60 s after launch (41 min uncached).
bun check.ts pools.json checks.json --workers 2
# The 24 h before the window, the farm's template left out: other families (about 20 min uncached).
FARM=<template>   # the full hash of the template most pools of pools.json share (0x16b3..b5d7)
bun pools.ts 55636314 56068313 pools-prev-day.json --skip-template $FARM
bun check.ts pools-prev-day.json checks-prev-day.json --gap 150
# The farm's history, a day at a time back from the window (6 steps kept in the measurement).
bun farmstart.ts 56068314 $FARM farmstart.json 6
# Who bought the farm's pools (from cache only: the same eth_getLogs as pools.ts).
bun buyers.ts pools.json $FARM
# 4. corpus.json and the tables of docs/corpus.md.
bun report.ts corpus.json window=pools.json:checks.json prev=pools-prev-day.json:checks-prev-day.json > report.txt
```

Any block range works: a small one is a quick trial (`bun pools.ts 56175314 56176314 pools.json`, then
`bun check.ts pools.json checks.json`, about a minute a pool uncached).

`check.ts` resumes: a pool already in its output without an error is skipped. Delete the output file to
check everything again, `cache/` to send every request again. Options: `--every K` checks every K-th
launched pool by pair address (deterministic sampling; not used in the measurement), `--first <template> N`
checks the N earliest launches of a template, `--gap ms` sets the throttle on `mainnet.base.org`
(default 60 ms, at most 6 requests in flight).

The measurement ran the checker of commit `18d8e94`; these scripts run the one checked out.

Outputs, all ignored by git: they are lists of pool and launcher addresses, which this repository does
not publish (see the README's Disclosure).

- `pools*.json`: each pair, its launch, its family and its outcome facts (after launch only), with the
  labelling run's request counts.
- `checks*.json`: the check of each launched pool (facts up to the later block only). Per-rule findings
  are in `by_rule`; `*-stats.json` counts requests per node and method, HTTP 429 and time.
- `corpus.json`: both sets joined, one object per pair (`set`: `window` or `prev`).
- `farmstart.json`: the WETH pairs and templates of the steps walked back.
- `report.txt`: the tables `report.ts` prints.
