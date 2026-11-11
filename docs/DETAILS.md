# near-preflight: details

The [README](../README.md) is the short version. This page has the checks, the rules NEAR enforces, the roles,
the function-call keys, what the attestation proves, every known limit, and what review found and how it was
closed.

## Checks before a buy

The sentinel is `app/verifier.ts`, with `app/index.ts` for template reputation. Every fact a verdict rests on
goes into the evidence, whose sha256 the guard stores with the verdict; `app/replay.ts` re-derives it all.

| Check                | How (read-only, public RPC calls)                                                | Verdict         |
| -------------------- | -------------------------------------------------------------------------------- | --------------- |
| Buy, takeback, sales | `eth_simulateV1`: the guard's own transactions alone; a probe's twins, apart      | see below       |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1,800 blocks (1 h) back             | see below       |
| Template reputation  | the index of V2 WETH pools by code template (`bun app/index.ts`)                 | see below       |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block` |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn` |
| Agent exit quote     | `eth_simulateV1`: the guard's own approve and swap, alone, from its address      | quote = ETH in  |

**Simulation: the exact bytes the guard signs, and nothing else.** The agent states the amount of its buy at
`request_check`; the guard stores it and `buy` accepts no other. The sentinel reads the guard's transactions
from the guard (`preview_check(id, quote)`, `preview_sale(token, amount, deadline)`, unsigned EIP-1559 bytes
built by the same code `buy` and `sell_quoted` sign with) and sends them as is from the guard's EVM address:
same calldata (router function, path, recipient, floor, deadline), value, nonce, gas limit and fee fields,
with the guard's real balance when it covers them. The verdict carries the keccak256 of that buy (the MPC
payload); `post_verdict` refuses an `allow` or a `warn` whose hashes are not what the guard would sign at
that moment, and `buy` signs only a transaction with that hash. A verdict is therefore tied to a nonce: if
another signature happens between the verdict and the buy, or the owner changes gas or fees, the buy is
refused (`transaction differs from the one simulated`) and the agent asks a new check. The swap deadline is
fixed by the check (its request time + 300 s), so it is part of the simulated bytes too.

A check is three `eth_simulateV1` requests on the same block, sharing no state:

- **guard side**: the guard's buy on the block's real state, then a sale of half in the next block and of the
  rest 256 blocks (512 s) after the proof's block, each an approve of the exact amount then
  `swapExactTokensForETHSupportingFeeOnTransferTokens`, as the guard signs an exit. Nothing else: no read, no
  probe, no other sender before or between them;
- **probe side**: the same from a probe, whose address is derived from the check and the EVM block hash (a
  token cannot whitelist it in advance), with the probe as recipient;
- **synthetic calls**: the pool's quote and `owner()`, then both buys and a `transferFrom` without approval
  of each buyer's tokens by `owner()` and by a stranger (a takeback).

Amounts come from logs, never from a read between transactions: tokens bought from the token's `Transfer`
logs; the ETH a sale pays from the logs `traceTransfers` gives ETH transfers; a sale's quote from the pool's
last `Sync` before its approve. Blocks follow Base's cadence: 2 s per block, every block up to the late
sale listed (empty in between; a node fills a gap with 12 s blocks), the real base fee and coinbase, and a
prevrandao per block, keccak256 of the proof block's and the block number, which replay recomputes.

The class this closes: tokens keyed on a difference between the simulation and the real transactions (the
guard's gas price, gas limit, fees, amount, approve, calldata) and on extra calls of the simulation (a
top-level read, a probe's or a stranger's call before a sale). What stays open: a token can behave
differently on the real chain after the buy (an owner action, a sale later than 512 s), and no simulated
future block can be proven indistinguishable from the real one (its prevrandao, base fee, time and number
are unknown in advance).

Verdicts: a revert, a takeback or a tax of 50 % or more is a `block`; a tax from 10 % is a `warn`; no V2 pair
is a `warn`. A sale's tax is measured on the ETH the seller receives, and a pool that pays out more WETH than
the seller receives is a `block` (a token that sells for itself during the sale; honest tokens that swap
their fees during a sale fall here too). A `block` found on the probe side lists the token on the guard. A
failure on the guard's side only (its address is public: anyone can send it tokens or get a token to freeze
it) blocks that check but lists nothing, and its reason starts with `guard address only, not listed`.

**Removable liquidity.** If at least 90 % of today's LP supply already existed 1,800 blocks ago, the
liquidity is old and its holders are not read. Otherwise the holders come from the pair's `Transfer` logs
(at most 4 `eth_getLogs` of 500 blocks, then `balanceOf` and `eth_getCode` per holder, at most 20). At least
half the LP removable (an EOA, a contract, or several summed; only 0x0 and 0xdead count as burned) is a
`warn`, and so are holders that cannot all be read.

**Template reputation.** Template = keccak256 of the runtime code with the CBOR metadata removed and every
`PUSH32` operand zeroed (solc writes immutables there). The index is rebuilt from `PairCreated`, `Mint`,
`Burn` and LP `Transfer` logs. A pool is dated by its funding: the block where the net WETH its providers
added (`Mint` minus `Burn` amounts, floored at 0) reaches 0.5 ETH, not the pair's creation (a pair created
empty long before says nothing); liquidity added and removed again does not add up. It is drained when 90 % of
the LP ever minted is burned after that. Reputation judges a token only against pools funded before its own,
so copies funded and drained after it cannot get it blocked. Its own pool counts from its funding block when
that falls within the index window, and from the window's end (every pool of the index counts) when it was
funded after the window or created after it. A pair created before the window is older than it only by its
funding: if it held 0.5 ETH of WETH in reserve at the block before the window, the rule does not apply and
the verdict says `template reputation not applied: the token's own pool was funded before the index window`;
otherwise it is dated by its funding inside the window, read from its own `Mint` and `Burn` logs. At least 3
counted pools with at least 80 % drained within 1 day of funding is a `block`, which never lists anything.
No index for the chain is a `warn`: an unknown reputation is never a pass, and stays distinct from "not
applied" and from "checked and clean" (no finding).

## What NEAR enforces

| Rule                                                                                           | By                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------- |
| Only the agent's function-call key acts for it, and only on the guard                          | NEAR protocol                 |
| A buy needs an `allow`, or a `warn` the owner approved, within 120 s of the verdict            | `buy`, `approve_warn`         |
| A buy is of the amount stated at the check, which must fit in the armed budget                 | `request_check`, `buy`        |
| The guard builds the swap: chain 8453, router, path, recipient = its address, gas, fees, floor | `buy`, `preview_check`        |
| An allow or warn carries the hashes of what the guard would sign; it signs nothing else        | `post_verdict`, `buy`         |
| A buy needs a token not listed, and at least 60 s left before its swap deadline                | `buy`                         |
| Value plus gas at the cap is debited from the armed budget and the prepaid credit              | `buy`, `sell_quoted`          |
| A token at the guard's EVM address is held for one agent at a time                             | `buy`, `holding`              |
| Only the owner clears or reassigns a token's holding, never during a signature                 | `set_holding`                 |
| An agent sells at most its holding, on a sentinel exit quote at most 120 s old, used once      | `request_exit`, `sell_quoted` |
| An agent's exit signs only the approve and swap its exit quote simulated                       | `sell_quoted`                 |
| The owner sells any token, amount, floor and approve (up to 2^256 - 1), no quote, no budget    | `sell`                        |
| The owner sets gas limit and fees within bounds, never during a signature                      | `set_evm_gas`                 |
| Only the sentinel posts a verdict, once, with the sha256 of its evidence; the owner replaces it | `post_verdict`, `set_sentinel` |
| A block lists its token only with the token's code and the sentinel's `list_target`            | `post_verdict`                |
| Blocklist: tokens only, never a template; entries never overwritten; only the owner unlists    | `report`, `unlist`            |
| An `allow` on code that differs from the reference is refused                                  | `post_verdict`                |
| Arming within the owner's bounds (per arming, duration, 7-day cap), registered agents only     | `set_bounds`, `arm`           |
| Arming refused if the agent's credit dropped below what the armer read (a top-up is fine)      | `arm`                         |
| Emergency stop: `disarm` by the owner freezes the agent until `unfreeze`                       | `disarm`, `unfreeze`          |
| One signature at a time; a failed signature returns credit and budget, the nonce stays free    | `on_signed`                   |
| A decision digest backs one call: a digest already anchored is refused                         | `request_check`, `buy`        |
| A check's price (0.019 NEAR) covers its worst-case storage, 1,900 bytes, measured by tests     | `request_check`               |

Details:

- **Floor.** The sentinel's quote (tokens the guard's address received in its simulated buy of the amount
  stated) minus 3 %. The exit floor is the exit quote's ETH received minus 3 %. The agent never chooses a floor.
- **Arming integrity.** The armer passes the credit it read; `arm` refuses a lower one (the agent spent or
  was drained since) and accepts a higher one: anyone may top up an agent with `deposit_credit`, and refusing
  any change let one yoctoNEAR every 2 s block every arming. The extra credit is still capped by the armed
  budget.
- **Holdings.** Each signed buy credits its signed minimum to the agent. The guard's EVM address holds every
  agent's tokens together, so `buy` refuses a token another agent still holds: a credit whose buy reverted on
  Base can then sell only tokens no other agent has a claim on. The exit's simulated sale, from the guard's
  address, also needs the tokens to be there. Such a credit, or an agent that never sells, would lock the
  token for every other agent: the owner clears or reassigns the holding (`set_holding`, event
  `holding_set`; `bun --env-file=.env app/human.ts holding <token> <agent> [amount]`, 0 frees it). A new
  holder sells through `request_exit` on a buy of that token signed for it; otherwise the owner sells.
- **Owner's exit.** `sell` signs approve and swap from the guard's address for any amount and floor; the
  approve is of the amount sold unless the owner passes another, as `0x` + up to 64 hex digits (amounts are
  U128 elsewhere): `bun --env-file=.env app/human.ts sell <token> <amount> 0 max` approves 2^256 - 1, for a
  token that lets only that sell. If a sale
  needs more gas than the guard signs with, the owner raises it (`bun --env-file=.env app/human.ts gas <limit>`,
  21,000 to 2,000,000, fees up to 10 gwei) and sells again. Measured on the fork with `gas_hungry` (a sale
  needs 500,000 gas left): at 250,000 the swap reverted (receipt status 0), at 600,000 the same sale went
  through. Whether a token lets any sale through is up to its code.
- **Decision digest.** `request_check` and `buy` take an optional `decision_sha256`, stored on the check,
  logged in `check_requested` and `sign_requested`, and anchored: a digest already anchored is refused
  (`decision already anchored on check #n`), so one signed decision backs one guard call; `decision_of`
  names the check it backs. A refunded check or a failed signature frees its digest. Each anchor (at most
  117 bytes) is paid by the check's price. The guard does not check the package itself (see Limits).

## Roles

- **Owner (human)**, full-access key in the near-cli keychain: sets bounds, registers agents and reporters,
  replaces the armer (`set_armer`) and the sentinel (`set_sentinel`, event `sentinel_changed`), approves
  `warn`s, unlists, sets gas, sells, withdraws ETH to the address fixed at init, clears or reassigns
  holdings, emergency stop. CLI: `bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset |
withdraw <wei> | sell <token> <amount> [min wei] [max | 0x approve] | unlist <token> | holding <token> <agent>
[amount] | gas <limit>`.
- **Armer**, function-call key `arm`, `disarm`: arms a registered agent within the owner's bounds.
- **Agent**, function-call key `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted`; no EVM key.
- **Sentinel**, function-call key `post_verdict`: reads the guard's previews of what it would sign, simulates
  them, posts verdicts and quotes with their hashes. A compromised sentinel key is replaced by the owner.
- **Relay**, no key: reads a signed transaction from the guard, checks it, broadcasts it (here only to anvil).

## Function-call keys

`app/setup.ts` gives each role a function-call key limited to the guard and its methods, with a gas
allowance: 0.5 NEAR for the agent, 0.25 NEAR for the others. The allowance is not money moved: it caps the
gas the key may buy. When a transaction is sent, NEAR reserves the attached gas at the purchase price against
the allowance (about 0.1 NEAR for a `buy`, which attaches 100 TGas, 0.15 NEAR for `sell_quoted`) and gives
back what was not burnt. Measured here: 10 agent transactions, 3 of them signed buys, took 0.0045 NEAR from
the agent's 0.5 NEAR.

When the free allowance is below what a call needs, NEAR rejects the transaction before it reaches the
guard: nothing is debited and the guard's state does not change. Measured: a key with a 0.01 NEAR allowance
sending `request_check` got `Not enough allowance for access key ... (allowance: 0.01 NEAR, cost: 0.0309
NEAR)`. The allowance cannot
be raised in place. The human recovers with the account's full-access key: delete the function-call key, add
a new one with a fresh allowance (`near account add-key <agent> grant-function-call-access --allowance ...
--contract-account-id <guard> --function-names ...`), and put its private key in `.env.agent`.

## Upgrade policy of the guard account

`app/setup.ts` deploys the guard with a full-access key of the guard account, kept in the deployer's near-cli
keychain: whoever holds it can deploy other code on the guard, which replaces every rule above, or move its
NEAR. The demo deployment keeps that key so it can be redeployed. A production deployment removes it after
the deployment and the `new` call, which leaves the code immutable (`near account delete-keys
guard.<parent>.testnet public-keys <its full-access key> network-config testnet sign-with-keychain send`),
or hands it to a DAO or multisig that upgrades only by a vote and a delay, so that users can leave first.
The owner role is separate: it is an account named at init, and its key changes bounds and roles, not code.

## The attested agent

The agent is `z-ai/glm-5.3-flash`, served by NEAR AI Cloud on NEAR-hosted Intel TDX VMs with NVIDIA H100 GPUs
in confidential mode (`app/llm.ts`). Each completion is archived as a decision package: the exact request and
response, the model's signature over both, and the TDX and GPU attestation fetched with our nonce. The model
holds no key: its tools call the agent's wrapper (`app/agent.ts`).

`bun app/attest.ts <package> [--check <id>]` verifies cryptographically: the signature, the hashes of the
archived request and response, the TDX quote (DCAP, `@phala/dcap-qvl-node` as in `nearai-cloud-verifier`),
its report_data (signing address and our nonce), the docker compose measured in `mr_config_id`, and with
`--check` the sha256 on chain, that the guard anchors it on that check alone (`decision_of`), and that the
signed response asked for that very action. Taken on trust:
NVIDIA NRAS's GPU verdict (over TLS, its JWT signature not checked, as in the official verifiers) and
Intel PCS's collateral. `attest` calls Intel and NVIDIA, not NEAR AI.

A package is bound to its check. The system message of every signed request ends with `Context: guard <guard>,
agent <agent>, NEAR block <hash> (height <n>).`, the latest final block read when the run starts. With
`--check <id>`, `attest` requires that guard to be the one it reads (GUARD), that agent to be the check's,
and that block (fetched from the NEAR RPC) to be at most 600 s before the check's request, never after. A
package recorded for one deployment cannot be anchored on another, nor replayed on a check more than 600 s
later; within those 600 s, the guard refuses its digest on a second check or on a buy, so one decision
backs one guard call.

Without a key, the demo verifies `app/fixtures/decision.json`: the model's decision on the same poisoned
inbox, anchored as check #5 of this deployment, `guard.goblin-guard-63518.testnet` (its signed request names
that guard, `agent.goblin-guard-63518.testnet` and a block 6 s before the check).

Injection count: `./demo.sh --full` with a key runs the model 3 times on the poisoned inbox and prints how
many runs resisted; `bun --env-file=.env --env-file=.env.agent --env-file=.env.llm app/llm.ts 20` measures
more runs against the live guard. Resisted = ignored the message, or checked the trap and stopped at the
guard's answer. The guard does not rely on the model: the scripted agent that obeys is stopped all the same.

## Real Base

`./check-mainnet.sh` simulates USDC on Base mainnet (`mainnet.base.org`, read-only, nothing broadcast) and
replays the proof. With no template index for mainnet, the verdict is `warn` (reputation unknown).
`bun app/index.ts <rpc> <from> <to> <out.json> --pace-ms 1000` builds an index from a node that serves
`eth_getLogs` (`mainnet.base.org` does not).

**One-off measurement, 2026-11-11** (on this repository's final code, read-only, one run, at most one
request per second; it would have stopped on the first error or 429, none came):

```sh
bun app/index.ts https://base-rpc.publicnode.com 56133114 56176314 base-index.json --pace-ms 1000
```

Blocks 56,133,114 to 56,176,314 (43,201 blocks, 24 h, ending at the chain head at 19:33 UTC), 283 requests in
298.5 s, index sha256 `0x16f519b6…96ea`. Result: 29 Uniswap V2 WETH pools with code, all of one code
template, all 29 funded (at least 0.5 ETH net, each in its creation block), 24 drained within a day of
funding (from 3,907 to 14,467 blocks, median 4,027, about 2.2 h). Applied to a copy of that template whose
pool is created after the window, the farm rule gives `block` (24 of 29 is above 80 %). The index lists the pools'
token and pair addresses; none of them is published here. Re-running the command on the same window gives
the same sha256 as long as the node still serves the logs and the state at block 56,176,314 (code is read
there); a pruned node refuses old state, an archive node does not.

## Limits

- **Base mainnet.** A transaction signed for chain id 8453 is valid on Base mainnet: never send funds to the
  derived address. The relay broadcasts only to a local anvil. The demo's withdrawal address, `0x…dEaD`, is
  a burn-address placeholder: pass your own to `setup.ts`.
- **Sentinel.** One key on one machine, no TEE. A lying `allow` can be bought within 120 s; replay catches it
  only afterwards. A lying exit quote gives a lower floor; replay catches it afterwards. The owner replaces a
  compromised key (`set_sentinel`); verdicts it already posted stay.
- **Public before broadcast.** The signing request (`sign_requested`, with the transaction's hash) and the
  signed transaction (`signed`) are public on NEAR before anyone broadcasts it on Base: a token owner watching
  the guard can react (change its token's state, front-run the buy) before the swap's 300 s deadline.
- **Simulation.** The guard side runs the exact bytes the guard signs and nothing else, at the verdict's
  block. A token can still behave differently on the real chain after the buy (owner actions, a sale later
  than 512 s, V4 hooks), and no simulated future block can be proven indistinguishable: its prevrandao, base
  fee, time and number are not known in advance (the simulation derives a prevrandao per block and reuses
  the proof block's base fee). The check's sales are previews (no floor, a fixed deadline): an exit's own
  bytes are simulated only by its exit quote, after the buy, and an exit of another amount too. When the
  guard's address cannot pay for its transactions at the check, its balance is set to exactly what they
  spend. A token whose public state a third party can move (a pool emptied of tokens, for instance) can still
  fail the probe's buy and get listed; the owner unlists.
- **Verdicts tied to a nonce.** A verdict buys only the transaction simulated, at the guard's nonce then: a
  signature for another check, or a gas or fee change, between the verdict and the buy refuses that buy, and
  the agent pays a new check. Several busy agents race for the one nonce sequence.
- **Template reputation.** Keyed by code template only: changing anything other than a `PUSH32` operand or
  the metadata makes a new template. A token is judged only against pools funded before its own, so copies
  cannot get it blocked; a token whose pool already held 0.5 ETH of WETH before the index window is not judged
  by reputation at all (its reasons say so): an operator who keeps 0.5 ETH in its target's pool from before
  the window escapes the farm's history. A widely used template has a mixed
  history, and the 80 % share is what keeps it from blocking. The sentinel chooses the index window; replay
  does not judge it. A drain counts only as LP burned.
- **Removable liquidity.** Liquidity older than 1,800 blocks passes without its holders being read, and so
  does liquidity removed and re-added within the window that keeps 90 % of the supply. LP in a lock contract
  counts as removable (false `warn`s). Only the Uniswap V2 WETH pair is checked.
- **Holdings.** Credited at the signed minimum, not the amount received. A credit whose buy reverted on Base
  stays: the agent's exit fails in simulation for lack of tokens, and no other agent can buy that token until
  the owner clears it (`set_holding`). Two agents cannot hold the same token at once.
- **Blocklist.** A registered reporter can list honest tokens until the owner unlists them, paying 0.005 NEAR
  of its own credit per entry.
- **Code changed.** Compared with the reference only; a change between the verdict and the buy (at most
  120 s), or after the buy, goes unseen.
- **Gas.** One gas limit for every transaction the guard signs. Raising it to get a sale through also raises
  what each buy reserves from the budget, and refuses every verdict not yet bought.
- **Attestation.** Measurements (MRTD, RTMRs, the compose's image digests) are not compared to a published
  reference, since none is published. The same signing address signed every run here: a signature ties a
  response to that key, not to one machine. The GPU evidence is tied to the quote by our nonce only. How long
  NEAR AI keeps a signature is unknown, hence the archived packages (`proofs/llm/`).
- **Decision digest.** The guard stores the digest the agent sends and refuses one already anchored, but does
  not check the package: a compromised agent can omit it or attach another package. It ties an action to a
  decision after the fact; it does not gate it.
- **Operations.** The NEAR/ETH rate is fixed by the owner, with no oracle. One signature at a time for all
  agents and exits. The emergency stop does not recall a signature already requested. All roles run under
  one OS user, whose near-cli keychain holds full-access keys.
- **Build.** `cargo near build non-reproducible-wasm`: its sha256 matches the deployed code hash, but nobody
  can rebuild it bit for bit elsewhere. `cargo near build reproducible-wasm` works here (Docker), but its
  metadata names the git commit it was built from, so it can be published only from a pushed commit.

## Closed after review

Each line is a bypass that a review (five judge runs, automated reviews and our own security passes) found,
then how it was closed. Each has a test.

- A token that sells only when `tx.gasprice` or `block.basefee` is 0 (the simulation's defaults): calls carry the guard's real fee fields, base fee, prevrandao and coinbase.
- An `allow` on USDC used to pay a trap: the guard builds and NEAR signs the swap of the verdict's own target; the agent has no EVM key.
- A forged proof file fooling replay (swapped labels, another RPC method, another target's verdict): replay rebuilds the exact request and checks the on-chain target.
- A token that freezes only the guard's public EVM address: the guard's address is simulated too, and such a failure blocks without listing.
- A colluding sentinel choosing friendly probe addresses: probes derive from the guard, the check and the EVM block hash; `replay --check` recomputes them.
- An armer locking an agent out for 7 days: the owner resets the arming log and replaces the armer.
- The agent choosing its sale floor: the floor comes from a sentinel exit quote, set by the contract.
- An agent selling tokens bought for another: exits are capped by the agent's holding, one agent per token, the owner reassigns a stuck holding.
- A sale that needs more gas than the guard signs with: the simulation uses the guard's gas limit, and the owner can raise it to retry a sale.
- Copies of an honest token's code listed as a template: templates are never listed; reputation counts only pools funded before the target's.
- A farm dating its pools by an empty pair created early, or by liquidity added and removed again: pools are dated by net WETH funding.
- A token keyed on what the simulation did and the guard did not (an approve other than 2^256 - 1, a buy other than 0.01 ETH: the fourth run's Trap2): the guard side runs the exact bytes the guard signs, the amount is stated at the check, and `buy` signs only the hashes the verdict carries; `approve_max_only` and `buy_001_only` on the fork are blocked.
- A token keyed on any approve but the maximum also trapped the owner's exit: `sell` takes an approve of the owner's choice, 2^256 - 1 included.
- Drained copies of USDC's code got USDC blocked (its older pool was judged on the whole window): reputation does not apply to a pool that predates the window; three such copies are on the fork and USDC stays `allow`.
- Anyone could block arming by depositing 1 yoctoNEAR to the agent: `arm` refuses only a credit below what the armer read.
- The recorded decision package re-anchored on a guard that never called the model: the signed request names the guard, the agent and a fresh NEAR block, and `attest --check` verifies all three.
- A compromised sentinel key could not be revoked: `set_sentinel`, owner only, logged.
- A token that sells only after a top-level `balanceOf`, which only the simulation sent (the fifth run's JudgeTrap): the guard side holds the guard's own transactions alone, from the block's real state; the probe, the quote, `owner()` and the takebacks run in requests of their own, and replay refuses any other call on the guard side. `judge_trap` and two siblings are on the fork, blocked and listed: `untouched_buyer` (a buyer that never called the token before its buy never sells) and `stranger_key` (a sale keyed by a stranger's failed `transferFrom`).
- Simulated blocks told apart from real ones (the late sale 256 blocks but 1 h later, one prevrandao for all): 2 s per block, every block up to the late sale listed, a prevrandao per block.
- A sale tax hidden by a token that sells for itself into the pool during the sale (the pool's WETH outflow was measured): the tax is the ETH the seller receives, and a pool paying out more is a `block`; `pair_pull_tax` on the fork.
- One signed decision anchored on two checks: the guard refuses a digest already anchored, and `attest --check` verifies `decision_of`.
- A pair created empty before the index window escaped reputation (having code there was taken for being older): an older pool must have held 0.5 ETH before the window, otherwise it is dated by its funding inside it.
