# Latency and fit

How long a purchase takes through near-preflight, where the time goes, and whom that suits today.
Measured on 2026-11-12 and 13 on the demo guard: three sentinels on one machine, each on its own public
Base nodes, all behind one public NEAR testnet RPC.

## One buy, on real Base

Check #19 (`./check-mainnet.sh`: USDC on Base mainnet, read only, `allow`):

| Step                                          | Seconds after the request | Why                                                                                           |
| --------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| The sentinels read the request                | 2.2                       | each reads the guard every 2.5 s                                                              |
| Reference block                               | 4.8                       | the first Base block at least 4 s after the request: no sentinel picks it                     |
| Later real block                              | 20.8                      | 16 s after the reference block here, drawn per check between 16 and 24 s                      |
| Two sentinels have simulated the later side   | 23.6 and 29.5             | the buy's simulations, trace, far sales and template index (2.7 to 7.3 s) ran during the wait |
| **Verdict on NEAR**, the second matching vote | **30.8**                  | a vote is one NEAR transaction, about 2 s                                                     |

Of those 30.8 s, 20.8 s are a deliberate wait; a draw of 24 s makes the verdict come at 39 s. The run
before (check #18) gave its verdict in 32.7 s. Both times the first sentinel's same vote came after the
quorum's and was not taken.

Then the buy:

| Step                            | Seconds             | Why                                                             |
| ------------------------------- | ------------------- | --------------------------------------------------------------- |
| `buy` to the signed transaction | 6.1 to 6.6 (4 buys) | one NEAR transaction: the guard, Chain Signatures, the callback |
| **Request to a signed swap**    | **about 40**        | 37 to 46 s by the draw, plus 2 s for the request itself         |

## One exit

| Step                                                | Seconds    | Measured on                                                                                        |
| --------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| An exit quote simulated on real Base, twice         | 0.5 to 1.9 | three public nodes, read only                                                                      |
| Request to each sentinel's vote, on real Base nodes | 4.8 to 5.6 | exit quote #23 (no sale: the guard holds nothing on Base mainnet, so each sentinel simulated once) |
| Request to each sentinel's vote, on the fork        | 3.2 to 3.9 | `./demo.sh --full`: three quotes in, sold at once on the median                                    |
| `sell_quoted` to the signed approve and swap        | 6.5        | two signatures in one NEAR transaction                                                             |

The guard waits 15 s for a third quote before it sells on two: these times fit. They did not when the
public NEAR RPC rate-limited the machine: three sentinels just restarted read the guard's past checks at
once, and their votes came 9 to 46 s after the request (exit quotes #20 to #22). The rule's fallback then
applies: the quorum's quotes after 15 s, one vote after 60 s ([quorum](contract.md#sentinel-quorum)).
Each sentinel needs its own NEAR RPC, as it needs its own Base node.

## What this is not built for

Same-second entries: a copy-trading snipe, a launch bought in its first block. About 10 s is the floor
for any purchase signed through NEAR here: the request, a vote and the signature are three NEAR
transactions, 2 s, 2 s and 6 s. The other 20 s are the price of judging the resale on state Base
produced after the check began, which no token can know in advance.

Checking candidates ahead of the buy, so that a verdict is waiting when the agent decides, is the
natural next step. It is not built: today a verdict buys for 120 s, within 180 s of its request.

## Who it is for

An operator of an agent or bot that buys newly launched tokens on Uniswap V2 on Base, who can wait tens
of seconds and wants a refusal that states its reason and can be replayed.

A `warn` goes to the owner: they read the reasons and approve it on chain within 120 s, or let it
lapse. Nothing is bought on a `warn` alone.

Running it takes the guard contract on NEAR and three sentinel processes: each a NEAR account whose key
can only vote, a Base node that serves `eth_simulateV1` and logs, and Foundry's anvil for the trace.
Ideally three machines and three operators; the demo runs all three on one
([what that covers](threat-model.md#a-lying-sentinel)).
