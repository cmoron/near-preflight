# Contract

The guard is one NEAR contract, [`src/lib.rs`](../src/lib.rs) (near-sdk 5). It holds each agent's
prepaid credit and armed budget, stores checks and verdicts, keeps the shared blocklist, and builds every
Base transaction that NEAR Chain Signatures signs for its address.

## Contents

- [Roles and keys](#roles-and-keys)
- [Methods](#methods)
- [Events](#events)
- [What NEAR enforces](#what-near-enforces)
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
| Owner    | full-access key of the account named at init (a human)                                   | bounds, roles, emergency stop, approve a `warn`, unlist, sell, withdraw, settle |
| Armer    | function-call key: `arm`, `disarm`                                                       | arm a registered agent within the owner's bounds                                |
| Agent    | function-call key: `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted` | ask checks, buy on `allow`, sell its holding                                    |
| Sentinel | function-call key: `post_verdict`                                                        | post verdicts and exit quotes with their hashes                                 |
| Relay    | none                                                                                     | read a signed transaction, check it, broadcast it (here only to anvil)          |

The owner's CLI is [`app/human.ts`](../app/human.ts):

```sh
bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei>
    | sell <token> <amount> [min wei] [max | 0x approve] | unlist <token>
    | holding <token> <agent> [amount] | gas <limit> | replace <nonce> | clear <nonce> refund|spent | release
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

The sentinel's key pays the gas of every verdict agents pay for, so an agent sending paid checks can
exhaust its 0.25 NEAR.

Verdicts then stop until the owner gives the sentinel a new key; unjudged checks
are refunded after 300 s (`refund_check`). An operational limit, not a bypass: no verdict means no buy.

## Methods

| Caller           | Methods                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployer, once   | `new`                                                                                                                                                                                                                                                                                                          |
| Agent            | `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted`                                                                                                                                                                                                                                          |
| Sentinel         | `post_verdict` (with `list_target`, a `block` lists the token)                                                                                                                                                                                                                                                 |
| Armer            | `arm`, `disarm` (no freeze)                                                                                                                                                                                                                                                                                    |
| Owner            | `set_bounds`, `register_agent`, `set_sentinel`, `set_armer`, `set_reporter`, `disarm` (freezes), `unfreeze`, `reset_armings`, `approve_warn`, `unlist`, `sell`, `withdraw_eth`, `withdraw_fees`, `set_evm_gas`, `set_holding`, `sign_replacement`, `clear_unsettled`, `release_signing`                        |
| Reporter         | `report`                                                                                                                                                                                                                                                                                                       |
| Anyone           | `deposit_credit` (payable), `refund_credit` (own credit)                                                                                                                                                                                                                                                       |
| The guard itself | `on_signed`, `on_exit_signed` (MPC callbacks)                                                                                                                                                                                                                                                                  |
| Views            | `get_check`, `last_check_id`, `decision_of`, `preview_check`, `preview_sale`, `get_entry`, `list_entries`, `last_code`, `holding`, `credit_of`, `budget_left`, `armed_7d`, `bounds`, `evm_config`, `fees`, `escrow`, `credits_total`, `is_frozen`, `stopped_at`, `signing_since`, `last_exit`, `get_unsettled` |

Each method's contract is its doc comment in `src/lib.rs`.

## Events

NEP-297 logs (`EVENT_JSON:`), standard `goblin_guard`. The
[status page](https://cmoron.github.io/near-preflight/) reads them.

| About     | Events                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Roles     | `armed`, `disarmed`, `frozen`, `unfrozen`, `armer_changed`, `sentinel_changed`, `armings_reset`, `reporter_set` |
| Checks    | `check_requested`, `verdict_posted` (with the full evidence string), `check_refunded`, `warn_approved`          |
| Blocklist | `listed`, `unlisted`                                                                                            |
| Signing   | `sign_requested`, `signed`, `exit_requested`, `exit_signed`                                                     |
| Recovery  | `sign_unsettled`, `unsettled_cleared`, `signing_released`, `holding_set`, `evm_gas_set`                         |

## What NEAR enforces

| Rule                                                                                                                       | By                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Only the agent's function-call key acts for it, and only on the guard                                                      | NEAR protocol                         |
| A buy needs an `allow`, or a `warn` the owner approved, within 120 s of the verdict                                        | `buy`, `approve_warn`                 |
| A buy is of the amount stated at the check, at most the owner's per-buy limit, within the budget                           | `request_check`, `buy`, `set_bounds`  |
| The guard builds the swap: chain 8453, router, path, recipient = its address, gas, fees, floor                             | `buy`, `preview_check`                |
| An allow or warn carries the hashes of what the guard would sign; it signs nothing else                                    | `post_verdict`, `buy`                 |
| A buy needs a token not listed, and at least 60 s left before its swap deadline                                            | `buy`                                 |
| A buy's value plus gas at the cap is debited from the armed budget and the prepaid credit                                  | `buy`                                 |
| A sale never needs buying budget: an exit's quote and gas come from the agent's credit (a frozen agent cannot ask for one) | `request_exit`, `sell_quoted`         |
| A token at the guard's address is held for one agent at a time                                                             | `buy`, `holding`                      |
| Only the owner clears or reassigns a token's holding, never during a signature                                             | `set_holding`                         |
| An agent sells at most its holding, on a sentinel exit quote at most 120 s old, used once                                  | `request_exit`, `sell_quoted`         |
| An agent's exit signs only the approve and swap its exit quote simulated                                                   | `sell_quoted`                         |
| The owner sells any token, amount, floor and approve (up to 2^256 - 1), no quote, no budget                                | `sell`                                |
| The owner sets gas limit and fees within bounds, never during a signature                                                  | `set_evm_gas`                         |
| Only the sentinel posts a verdict, once, with the sha256 of its evidence; the owner replaces it                            | `post_verdict`, `set_sentinel`        |
| A block lists its token only with the token's code and the sentinel's `list_target`, stored                                | `post_verdict`                        |
| Blocklist: tokens only, never a template; entries never overwritten; only the owner unlists                                | `report`, `unlist`                    |
| An `allow` on code that differs from the reference is refused                                                              | `post_verdict`                        |
| Arming within the owner's bounds (per arming, duration, 7-day cap), registered agents only                                 | `set_bounds`, `arm`                   |
| Arming refused if the agent's credit dropped below what the armer read (a top-up is fine)                                  | `arm`                                 |
| Emergency stop: `disarm` by the owner freezes the agent until `unfreeze`, and voids every check requested before it        | `disarm`, `unfreeze`                  |
| One signature at a time; one that does not come back keeps its nonce, charge and tokens                                    | `on_signed`, `on_exit_signed`         |
| A slot whose callback never ran is released by the owner after 600 s, its transactions reserved                            | `release_signing`                     |
| Only the owner replaces a transaction, at a reserved nonce only, and settles it                                            | `sign_replacement`, `clear_unsettled` |
| A decision digest backs one call: a digest already anchored is refused                                                     | `request_check`, `buy`                |
| A check's price (0.019 NEAR) is at least its worst-case storage, 1,900 bytes, measured by tests                            | `request_check`                       |
| Fees leave only while the balance left pays for storage, every credit and the escrow                                       | `withdraw_fees`                       |

## Accounting

- **Credit.** Prepaid NEAR per account (`deposit_credit`; the agent's key cannot attach any). Anyone may
  top up an agent; `refund_credit` returns the rest.
- **Price.** A check costs 0.019 NEAR, from the credit and the armed budget.
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

`buy` calls the MPC contract `v1.signer-prod.testnet` with derivation path `evm-1`; `on_signed` stores the
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
NEAR. The demo keeps that key so it can be redeployed.

A production deployment removes it after the deployment and the `new` call, which leaves the code
immutable, or hands it to a DAO or multisig that upgrades only after a vote and a delay:

```sh
near account delete-keys guard.<parent>.testnet public-keys <its full-access key> network-config testnet sign-with-keychain send
```

The owner role is separate: an account named at init, whose key changes bounds and roles, not code.

## Limits

- **Verdicts tied to a nonce.** A signature for another check, or a gas or fee change, between the
  verdict and the buy refuses that buy; the agent pays a new check. Busy agents race for one nonce sequence.
- **Holdings.** Credited at the signed minimum, not the amount received. A credit whose buy reverted on
  Base stays until the owner clears it; two agents cannot hold the same token at once.
- **Blocklist.** A registered reporter can list honest tokens until the owner unlists them, paying
  0.005 NEAR of its own credit per entry.
- **Code changed.** Compared with the reference only; a change between the verdict and the buy (at most
  120 s), or after the buy, goes unseen.
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
  then moves to the fees and covers its storage when it is the larger (the demo's 0.0225 NEAR against
  at most 1,900 bytes, 0.019 NEAR); a buy whose signature does not come back reserves its nonce out of
  what the credits and the escrow are owed (`cargo test fees_withdrawn_before_a_buy`), until the owner
  deposits. Leaving one price in the fees per verdict less than 120 s old avoids it.
- **Base mainnet.** A transaction signed for chain 8453 is valid on Base mainnet: never send funds to the
  guard's address. The demo's withdrawal address, `0x…dEaD`, is a burn-address placeholder: pass your own
  to `setup.ts`.
