# Agent guide

For an AI coding agent (Claude Code, Codex…) helping a human set up their own guard and make a trading
agent buy through it. Humans can skim it. Every command is from this repository; the code is the reference.

near-preflight is a NEAR contract, the **guard**, and three off-chain **sentinels**. An agent asks the
guard to check a token and an amount; the sentinels simulate the buy and the resale on Base and vote;
on `allow` the guard builds the swap and NEAR Chain Signatures signs it. The agent holds no Base key.

There is no SDK, npm package, MCP server or hosted service. You deploy your own guard from this
repository, run its sentinels yourself, and the trading agent calls the guard through
[`app/agent.ts`](../app/agent.ts) or any NEAR client. The demo guard cannot be reused: only its owner
registers agents.

## Limits, before you start

- **NEAR testnet only.** Nothing here runs on NEAR mainnet.
- **A buy executes on a local fork of Base only.** The relay refuses any node that is not anvil. On Base
  mainnet you get verdicts, read only (`./check-mainnet.sh <token>`), and you stop there.
- **Uniswap V2 WETH pools on Base only.** No V3, no V4, no other chain.
- **About 30 s per verdict** on real Base, 20 to 55 s on the fork, plus 6 s for the signature. A verdict
  buys for 120 s, within 180 s of its request. Not for same-second entries ([latency](latency.md)).
- **Three sentinels on one machine are three keys, not three parties** ([threat model](threat-model.md#a-lying-sentinel)).

## What the human does, and confirms

Ask before each of these. Never do them on your own.

| Step                                            | Why it is theirs                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Create and fund a NEAR testnet account (step 2) | its full-access key is the owner's key                                             |
| Run `app/setup.ts` (step 3)                     | it moves 7.6 testnet NEAR and creates seven accounts                               |
| Arm the agent, and choose the budget (step 5)   | the armed budget is what the agent may spend                                       |
| Approve a `warn` (`app/human.ts approve <id>`)  | the owner reads the reasons and decides; any `app/human.ts` command is the owner's |

## Prerequisites

`bun` 1.4, Foundry 1.8 (`anvil`, `forge`, `cast`), `jq`, Rust 1.98 with `cargo-near` 0.23, `near` CLI
0.31, and about 8 testnet NEAR. Check: `bun --version`, `anvil --version`,
`cargo near --version`, `near --version`.

## Setup

1. **Clone.** `git clone https://github.com/cmoron/near-preflight && cd near-preflight && bun install`
2. **Testnet account** (the human). The faucet gives 10 NEAR:
   `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
   Check: `~/.near-credentials/testnet/<you>.testnet.json` exists; setup reads the key there. On `429`,
   see [troubleshooting](reproduce.md#troubleshooting).
3. **Build and deploy** (the human confirms).
   `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet`
   It deploys `guard.<you>.testnet`, creates `agent.`, `agent2.`, `sentinel.`, `sentinel2.`, `sentinel3.`
   and `armer.`, gives each a function-call key limited to the guard, sets the bounds and deposits
   1.5 NEAR of credit for the agent. Last line:
   `.env, .env.agent, .env.agent2, .env.sentinel, .env.sentinel2, .env.sentinel3, .env.armer written; agent credit: 1499… yoctoNEAR`
   (about 1.499 NEAR: the last digits vary with storage)
   Check: `near contract call-function as-read-only guard.<you>.testnet sentinels json-args {} network-config testnet now`
   returns three accounts and `"quorum": 2`.
4. **Fork and sentinels.** `./start.sh` starts the local Base fork (`evm/fork.sh`), its block miner
   and the three sentinels, as [`demo.sh`](../demo.sh) does, waits until each sentinel listens, then prints
   `ready: …` with its log files (about 35 s) and stays in the foreground. Ctrl-C stops them all.
   Check: each sentinel's log has `sentinel N of 3 (quorum 2), listening to guard.<you>.testnet`.
   A sentinel votes only on checks requested after it started.
5. **Arm** (the human chooses the budget): `bun --env-file=.env --env-file=.env.armer app/arm.ts 0.4 900`
   arms 0.4 NEAR for 900 s. Bounds set by setup: 0.5 NEAR per arming, 3,600 s, 5 NEAR per 7 days.
   Check: `near contract call-function as-read-only guard.<you>.testnet budget_left json-args '{"account":"agent.<you>.testnet"}' network-config testnet now`
   returns `"400000000000000000000000"`. A read in the first seconds after arming may still say `"0"`: read again.
6. **Smoke test.** `./demo.sh` runs the whole path in about 7 min and exits 0 ([reproduce](reproduce.md#full-demo)).
   It starts its own miner and sentinels on a fork alone: stop those of step 4 first (Ctrl-C on
   `./start.sh`), then run `evm/fork.sh` in another terminal. It stops its sentinels when it ends: to buy
   afterwards, stop that fork, run `./start.sh` again, and arm again if the budget is spent or expired (step 5).

## Buy through the guard

`app/buy.ts <token> [ETH]` (default 0.00001) runs the wrapper's `guardedBuy`
([`app/agent.ts`](../app/agent.ts)): it prints the check's id, the verdict and its reasons, then the
relay command, or why there is no buy (exit code 1). The first check on a fork just started can take up
to about 3 min while anvil fetches Base state; if its `allow` comes too late to buy, `buy.ts` asks once
more by itself. Each check debits 0.025 NEAR of credit and budget, and one that got a verdict, even too
late, is not refunded (`refund_check` only refunds a check with no verdict after 300 s).

```sh
bun --env-file=.env --env-file=.env.agent app/buy.ts 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # USDC, on the fork
bun --env-file=.env app/relay.ts <id>     # the command buy.ts prints; no key: broadcasts the signed swap to the fork, receipt status 1
```

The fork's trap tokens are in [`evm/tokens.json`](../evm/tokens.json); `sell_blocked` gets a `block`
the first time, which lists it: later checks of it are refused (`target is on the shared blocklist`).
`bun --env-file=.env --env-file=.env.agent app/check.ts <token> [ETH]` asks for a verdict and buys nothing.

From another codebase, make the same calls with near-api-js, signed by the agent's function-call key
(`AGENT_KEY` in `.env.agent`), as [`app/near.ts`](../app/near.ts) does. All on `guard.<you>.testnet`,
deposit 0, amounts as decimal strings:

| #   | Call                                                    | Gas      | Notes                                                                                           |
| --- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 1   | `request_check({target, amount_wei})` returns the id    | default  | `target`: 0x + 40 hex. Debits the price (0.025 NEAR). `amount_wei` at most `bounds.max_buy_wei` |
| 2   | view `get_check({id})`, every 1.5 s                     | none     | until `verdict` is `"allow"`, `"warn"` or `"block"`; `reasons` says why. `null`: read again     |
| 3   | `buy({id, amount_wei})` returns the signed transaction  | 100 TGas | on `allow` only; the same `amount_wei`. Debits the value plus gas at the cap                    |
| 4   | `refund_check({id})`                                    | default  | no verdict 300 s after the request: the price comes back                                        |
| 5   | `request_exit({buy_id, amount})` returns the quote's id | default  | `amount`: tokens, at most the view `holding({agent, token})`. 0.025 NEAR from the credit        |
| 6   | views `get_check({id})`, then `exit_ready({id})`        | none     | until `verdict` is `"allow"` and `exit_ready` is `true` (60 s at most)                          |
| 7   | `sell_quoted({id})` returns approve and swap, signed    | 150 TGas | within 120 s of the quote. Then `app/relay.ts exit <nonce>`                                     |

`sellAll(buyId)` in `app/agent.ts` does 5 to 7. `app/sell.ts <id>` runs it on what check `<id>` bought:

```sh
bun --env-file=.env --env-file=.env.agent app/sell.ts <id>
bun --env-file=.env app/relay.ts exit <nonce>   # the command sell.ts prints: approve then swap, both receipt status 1
```

Both `request_check` and `buy` take an optional
`decision_sha256`. A check and a buy of 0.00001 ETH cost 0.0475 NEAR of budget and credit; an exit
0.05 NEAR of credit. The agent picks only the token and the amount: never route, recipient or floor.

**On each verdict.**

- `allow`: buy within 120 s of the verdict and 180 s of the request.
- `warn`: do not buy. Show the human the `reasons` and
  `bun --env-file=.env app/human.ts approve <id>`. Buy only once `get_check` shows `approved: true`,
  in the same 120 s. Otherwise give up.
- `block`: do not buy. A `block` on the token's code quarantines it 30 min for every agent. Do not
  ask again in a loop.
- No verdict in 300 s: `refund_check`, then check that two sentinels run.

**Refusals you will meet** (the contract's panic text):

| Text                                                     | Do                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `budget not armed`, `budget expired`, `budget exceeded`  | the human arms again (step 5)                                                                         |
| `insufficient credit`                                    | the owner tops up: `deposit_credit({account_id})`, payable                                            |
| `amount above the owner's per-buy limit`                 | lower the amount (setup: 0.0001 ETH)                                                                  |
| `amount above what the owner's per-token cap leaves`     | wait (setup: 0.0005 ETH per token an hour)                                                            |
| `a check of this target is already awaiting its verdict` | one check per token at a time: wait for it                                                            |
| `target is quarantined after a block verdict`            | stop; only the owner lifts it                                                                         |
| `target is on the shared blocklist`                      | stop                                                                                                  |
| `verdict expired`, `check requested more than 180 s ago` | request a new check                                                                                   |
| `transaction differs from the one simulated`             | another signature or a gas change happened: request a new check                                       |
| `a signature is already in progress`                     | one signature at a time: retry after a few seconds                                                    |
| `Not enough allowance for access key`                    | the key's gas allowance is spent: the owner replaces the key ([contract](contract.md#roles-and-keys)) |

`buy` returning `null` means the MPC gave no signature: the nonce, credit and budget stay reserved
until the owner settles it ([recovery](contract.md#recovery)). Do not buy again to compensate.

## Never

- Never ask for, read or copy the owner's full-access key (`~/.near-credentials`). The trading agent
  gets `.env` and `.env.agent` only: not `.env.armer`, not a sentinel's file.
- Never send funds to the guard's Base address on Base mainnet (view `evm_config`, field `address`). A
  transaction NEAR signs for chain 8453 is valid there.
- Never broadcast a signed transaction to anything but the local fork.
- Never treat `warn` as `allow`, and never run `app/human.ts approve` yourself.
- Never arm, raise a bound or a cap, lift a quarantine or unlist a token to get a buy through.
- Never commit or print `.env*`: they hold keys.
- Nothing on NEAR mainnet.

More: [contract](contract.md) for every method and rule, [reproduce](reproduce.md) for each step's
output, [architecture](architecture.md) for who holds which key.
