# near-preflight: details

The [README](../README.md) is the short version. This page has the checks, the rules NEAR enforces, the roles,
the function-call keys, what the attestation proves, every known limit, and what review found and how it was
closed.

Names: the repository is `near-preflight`; the Cargo package (and the string the probes are derived from) is
`goblin-near` and the contract's event standard `goblin_guard`, earlier working names kept because renaming
them would change the deployed contract and every recorded proof.

## Checks before a buy

The sentinel is `app/verifier.ts`, with `app/index.ts` for template reputation. Every fact a verdict rests on
goes into the evidence, whose sha256 the guard stores with the verdict; `app/replay.ts` re-derives it all.

| Check                | How (read-only, public RPC calls)                                                | Verdict         |
| -------------------- | -------------------------------------------------------------------------------- | --------------- |
| Buy, takeback, sales | `eth_simulateV1`: the guard's buy and sales alone; a probe's and takebacks apart | see below       |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1,800 blocks (1 h) back             | see below       |
| Template reputation  | the index of V2 WETH pools by code template (`bun app/index.ts`)                 | see below       |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block` |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn` |
| Environment          | the guard's transactions replayed on a local fork: every address they touch      | see below       |
| Environment opcodes  | the reachable code of the token and of its implementation                        | found: `warn`   |
| Agent exit quote     | `eth_simulateV1`: the guard's own approve and swap, alone, 2 and 3 blocks ahead  | quote = ETH in  |

**Simulation: the exact buy the guard signs, and nothing else.** The agent states the amount of its buy at
`request_check`; the guard stores it and `buy` accepts no other. The sentinel reads the guard's transactions
from the guard (`preview_check(id, quote)`, `preview_sale(token, amount, deadline)`, unsigned EIP-1559 bytes
built by the same code `buy` and `sell_quoted` sign with) and sends them as is from the guard's EVM address:
same calldata (router function, path, recipient, floor, deadline), value, nonce, gas limit and fee fields,
with the guard's real balance when it covers them. The verdict carries the keccak256 of that buy (the MPC
payload); `post_verdict` refuses an `allow` or a `warn` whose hashes are not what the guard would sign at
that moment, and `buy` signs only a transaction with that hash. A verdict is therefore tied to a nonce: if
another signature happens between the verdict and the buy, or the owner changes gas or fees, the buy is
refused (`transaction differs from the one simulated`) and the agent asks a new check. The swap deadline is
fixed by the check (its request time + 300 s), so it is part of the simulated bytes too. The two sales are
previews of an exit from the same code (no floor, a deadline past the late sale), not bytes NEAR will sign:
an exit's own approve and swap are simulated again, as signed, by its exit quote.

A check is three `eth_simulateV1` requests on the same block, sharing no state:

- **guard side**: the guard's buy on the block's real state, then a first sale and the rest, each an approve
  of the exact amount then `swapExactTokensForETHSupportingFeeOnTransferTokens`, as the guard signs an exit,
  each in a block of its own as the relay mines them. The first sale's swap lands 5 to 150 blocks after the
  buy and sells 13 % to 87 % of the tokens bought (never a whole percent); the rest is swapped 200 to 255
  blocks (400 to 510 s) after the buy, and the request ends there. All three are derived like the probes
  from the check and the EVM block hash (in the evidence as `sales`): a token cannot expect either block or
  the amount. Nothing else: no read, no probe, no other sender before or between them;
- **probe side**: the same trades from a probe, a fresh address derived from the check and the EVM block
  hash (a token cannot whitelist it in advance), with the probe as recipient;
- **synthetic calls**: the pool's quote and `owner()`, then both buys and a `transferFrom` without approval
  of each buyer's tokens by `owner()` and by a stranger (a takeback).

Amounts come from logs, never from a read between transactions: tokens bought from the token's `Transfer`
logs; the ETH a sale pays from the logs `traceTransfers` gives ETH transfers; a sale's quote from the pool's
last `Sync` before its approve. Blocks follow Base's cadence: 2 s per block, every block up to the late
sale listed (empty in between; a node fills a gap with 12 s blocks), the real base fee and coinbase, and one
prevrandao per L1 epoch, as on Base, where it is the L1 origin's: the proof block's for the rest of its epoch
(6 blocks, its position read from L1Block's sequence number), then keccak256 of it and the epoch index.
Replay recomputes them.

The class this closes: tokens keyed on a difference between the simulation and the real transactions (the
guard's gas price, gas limit, fees, amount, approve, calldata), on extra calls of the simulation (a
top-level read, a probe's or a stranger's call before a sale), and on where or what the check sells (a sale
only in the block right after the buy, only at the check's late block, or only of half the balance). The
environment rule below closes the next one: tokens that read what the simulation cannot reproduce. A
simulation still cannot prove that a token will be sellable later: an owner action after the buy, behaviour
that changes after the late sale, and an admin other than `owner()` stay open (Limits).

**Environment rule: a token whose transfers depend on what the simulation cannot reproduce is not allowed.**
eth_simulateV1 never runs Base's per-block system update (the L1 attributes deposit that rewrites the L1Block
predeploy `0x4200…0015`, the fee vaults' credits) and cannot know a future block's fields. The red team's
RedL1Trap sells only while L1Block is unchanged since the buy: every simulated sale passed, every real one
failed. Rather than guess the next tell, two facts, both in the evidence and recomputed by replay:

- `touched`: every address the guard's own transactions read or call, at any depth (BALANCE, EXTCODESIZE,
  EXTCODEHASH, EXTCODECOPY, CALL, STATICCALL, DELEGATECALL, CALLCODE). A throwaway anvil forks the same
  node at the proof's block and replays the guard side for real: each block at its simulated number, time,
  base fee and coinbase, each transaction's access list (`eth_createAccessList` at `pending`) taken before
  it is sent. An address outside the token, its implementation (EIP-1967 or ZeppelinOS slot), its V2 pool,
  the router, WETH, the factory, the guard and the precompiles is a `block` naming it: `reads 0x4200..0015,
0x8bde..9881 during a transfer` (the second is L1Block's implementation). The only code that runs during
  the guard's transactions is then the token's, its implementation's and Uniswap's.
- `opcodes`: BLOCKHASH, COINBASE, PREVRANDAO, GASLIMIT, BASEFEE, BLOBHASH, BLOBBASEFEE, GASPRICE and ORIGIN in
  the reachable code of the token and of its implementation: a `warn` naming them, the owner decides.
  Reachable: from offset 0 and from each valid JUMPDEST until an opcode that halts or jumps. Data solc
  appends (revert strings, CBOR metadata) is skipped while nothing can run it: read as code, a revert
  string's "H" is BASEFEE, and a naive scan flags Uniswap's router and USDC's implementation. A tail shaped
  like metadata is not trusted: the whole code is scanned, so such a tail counts as data only when the code
  before it halts and it holds no JUMPDEST.

Decisions. GAS is not flagged: solc emits it before every external call, and each simulated transaction
carries the guard's own gas limit. SELFBALANCE reads the token's own state. BALANCE and EXTCODE* name an
address, which `touched` judges (anvil's access list reports them: tested). TIMESTAMP and NUMBER stay
allowed: the simulated blocks follow Base's cadence and the sales 10 to 300 s and 400 to 510 s after the buy
exercise them; after the late sale nothing is checked. The coinbase is not an expected address: on Base it is the sequencer fee vault
`0x4200…0011`, whose balance moves every block, and the access list reports it only when code reads it. A
token that swaps its own fees through the router during a sale was already a `block` (the pool pays out more
WETH than the seller receives); the wallet its fees go to adds a reason. A token whose transfers call any
other contract (a dividend tracker, a library, a beacon proxy) is a `block`: honest ones are lost, on
purpose.

Why a local fork: Base's public RPC (reth 2.5.2) answers `eth_createAccessList` with state overrides but
ignores block overrides, so it cannot replay a sale at its simulated block: a read gated on
`block.number > boughtBlock` would hide; `debug_*` is filtered there. anvil (Foundry) does it on both the
local fork and Base mainnet, for the sentinel and for replay. Not reproduced there, and read only through the
flagged opcodes: prevrandao, the gas price an access list sees, block hashes. The trace gives each sender
1 ETH more than the simulation, for the L1 data fee anvil bills.

Measured read-only on Base mainnet (2026-11-12): no flagged opcode in USDC (proxy and implementation), WETH,
USDbC, DAI, cbETH, AERO, DEGEN, BRETT, TOSHI, VIRTUAL, cbBTC, nor the Uniswap V2 router. The full check of
USDC, DAI, AERO, DEGEN, BRETT, TOSHI, VIRTUAL and cbBTC (each traced on an anvil forked from
`mainnet.base.org`) found their buy and sales touching only the token, its implementation, its V2 pool and
WETH: no environment finding, each `warn` only for its unknown reputation. On the fork, USDC is `allow`. The fork holds
`red_l1_trap` (`block`), `helper_trap` (L1Block reached through a delegatecall to a helper whose address sits
in storage: `block`) and `basefee_trap` (keyed on the base fee, which the simulation keeps: `warn`);
`app/environment.test.ts` shows each real sale failing after one emulated sequencer block (L1Block's
sequence number advanced) or a base fee move.

Verdicts: a revert, a takeback or a tax of 50 % or more is a `block`; a tax from 10 % is a `warn`; no V2 pair
is a `warn`. A sale's tax is measured on the ETH the seller receives, and a pool that pays out more WETH than
the seller receives is a `block` (a token that sells for itself during the sale; honest tokens that swap
their fees during a sale fall here too). A `block` lists the token on the guard only for what the probe
shows after a buy that succeeded, when the pool quotes at least 1,000 token units for the agent's amount (its
reserves, which the token does not set, not what the token delivered): a takeback, a buy that delivers
nothing or a buy tax of 50 %, a sale refused or a sale tax of 50 % on a sale the pool quotes at 1,000 wei or
more. A buy that fails, a pool quote under 1,000 units, a dust sale and a pool that pays out more block that
check and list nothing, since the agent picks the amount. The evidence carries `list_target`: replay
recomputes it, and `--check` compares it with the one the guard stored with the verdict. A failure on the guard's side only (its address is public: anyone can send it tokens or get a token to freeze
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

| Rule                                                                                                                                           | By                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Only the agent's function-call key acts for it, and only on the guard                                                                          | NEAR protocol                         |
| A buy needs an `allow`, or a `warn` the owner approved, within 120 s of the verdict                                                            | `buy`, `approve_warn`                 |
| A buy is of the amount stated at the check, at most the owner's per-buy limit, within the budget                                               | `request_check`, `buy`, `set_bounds`  |
| The guard builds the swap: chain 8453, router, path, recipient = its address, gas, fees, floor                                                 | `buy`, `preview_check`                |
| An allow or warn carries the hashes of what the guard would sign; it signs nothing else                                                        | `post_verdict`, `buy`                 |
| A buy needs a token not listed, and at least 60 s left before its swap deadline                                                                | `buy`                                 |
| A buy's value plus gas at the cap is debited from the armed budget and the prepaid credit                                                      | `buy`                                 |
| A sale never needs buying budget: an exit's quote and gas come from the agent's credit alone (a frozen agent cannot ask for one)               | `request_exit`, `sell_quoted`         |
| A token at the guard's EVM address is held for one agent at a time                                                                             | `buy`, `holding`                      |
| Only the owner clears or reassigns a token's holding, never during a signature                                                                 | `set_holding`                         |
| An agent sells at most its holding, on a sentinel exit quote at most 120 s old, used once                                                      | `request_exit`, `sell_quoted`         |
| An agent's exit signs only the approve and swap its exit quote simulated                                                                       | `sell_quoted`                         |
| The owner sells any token, amount, floor and approve (up to 2^256 - 1), no quote, no budget                                                    | `sell`                                |
| The owner sets gas limit and fees within bounds, never during a signature                                                                      | `set_evm_gas`                         |
| Only the sentinel posts a verdict, once, with the sha256 of its evidence; the owner replaces it                                                | `post_verdict`, `set_sentinel`        |
| A block lists its token only with the token's code and the sentinel's `list_target`, stored                                                    | `post_verdict`                        |
| Blocklist: tokens only, never a template; entries never overwritten; only the owner unlists                                                    | `report`, `unlist`                    |
| An `allow` on code that differs from the reference is refused                                                                                  | `post_verdict`                        |
| Arming within the owner's bounds (per arming, duration, 7-day cap), registered agents only                                                     | `set_bounds`, `arm`                   |
| Arming refused if the agent's credit dropped below what the armer read (a top-up is fine)                                                      | `arm`                                 |
| Emergency stop: `disarm` by the owner freezes the agent until `unfreeze`, and voids every check requested before it (no buy, no quoted exit)   | `disarm`, `unfreeze`                  |
| One signature at a time; one that does not come back keeps its nonce, charge and tokens                                                        | `on_signed`, `on_exit_signed`         |
| A slot whose callback never ran is released by the owner after 600 s, its transactions reserved                                                | `release_signing`                     |
| Only the owner replaces a transaction, at a reserved nonce only, and settles it: refund only once a replacement is signed there, spent anytime | `sign_replacement`, `clear_unsettled` |
| A decision digest backs one call: a digest already anchored is refused                                                                         | `request_check`, `buy`                |
| A check's price (0.019 NEAR) is at least its worst-case storage, 1,900 bytes, measured by tests                                                | `request_check`                       |
| Fees leave only while the balance left pays for storage, every credit and the escrow                                                           | `withdraw_fees`                       |

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
- **Signatures that do not come back.** The MPC may publish a signature after the guard's yield timed out
  (its `respond` is a public transaction). So a missing signature never frees its nonce: the transaction is
  reserved (`unsettled`, event `sign_unsettled`) with its charge and, for an agent's swap, the tokens it
  sells, until the owner settles it. The owner signs 0 wei to its own address at that nonce (`bun
--env-file=.env app/human.ts replace <nonce>`; raise the fees first with `gas` if the base fee is above
  them), the relay broadcasts it, then `clear <nonce> refund` gives the charge and tokens back, or `clear
<nonce> spent` if the late signature was mined first. A refund is refused until a replacement was signed
  at that nonce (the guard records it), and only a reserved nonce can be replaced: a buy that was signed
  and charged is never voided. Later transactions wait behind the gap until then. A reservation takes no
  more storage than the signed transaction it stands for.
- **A callback that never runs.** If `on_signed` or `on_exit_signed` failed (out of gas, say), the slot
  would stay taken. The owner frees it 600 s after the request, past the MPC's own timeout (its yield
  expires after 200 blocks): `bun --env-file=.env app/human.ts release`, event `signing_released`. What it
  was signing is reserved as above. Each callback names the request it answers, so a late one cannot settle
  the next job. Measured on testnet (2026-11-12): `on_signed` burnt 2.75 TGas, `on_exit_signed` 2.93
  TGas for an exit's two signatures and 2.02 for a withdrawal, against the 10 TGas reserved for each (the
  unused gas of the call is added on top: 80 to 131 TGas attached in these runs).
- **Owner's exit.** `sell` signs approve and swap from the guard's address for any amount and floor; the
  approve is of the amount sold unless the owner passes another, as `0x` + up to 64 hex digits (amounts are
  U128 elsewhere): `bun --env-file=.env app/human.ts sell <token> <amount> 0 max` approves 2^256 - 1, for a
  token that lets only that sell. If a sale
  needs more gas than the guard signs with, the owner raises it (`bun --env-file=.env app/human.ts gas <limit>`,
  21,000 to 2,000,000, fees up to 10 gwei) and sells again. Measured on the fork with `gas_hungry` (a sale
  needs 500,000 gas left): at 250,000 the swap reverted (receipt status 0), at 600,000 the same sale went
  through. Whether a token lets any sale through is up to its code. The owner's sale waits for a signature in
  progress (about 6 s), and after an emergency stop it takes the nonces after the buy in flight: it is mined
  after that buy.
- **Decision digest.** `request_check` and `buy` take an optional `decision_sha256`, stored on the check,
  logged in `check_requested` and `sign_requested`, and anchored: a digest already anchored is refused
  (`decision already anchored on check #n`), so one signed decision backs one guard call; `decision_of`
  names the check it backs. A refunded check frees its digest; a failed signature's stays anchored until the
  owner clears it with a refund. Each anchor (at most
  117 bytes) is paid by the check's price. The guard does not check the package itself (see Limits).
- **Views.** Anyone reads an agent's stop (`is_frozen`, `stopped_at`), the signature in progress and since
  when (`signing_since`, none when the slot is free), and what the guard owes: `credits_total`, `escrow`,
  beside `fees`, `credit_of`, `budget_left` and `holding`.

## Roles

- **Owner (human)**, full-access key in the near-cli keychain: sets bounds, registers agents and reporters,
  replaces the armer (`set_armer`) and the sentinel (`set_sentinel`, event `sentinel_changed`), approves
  `warn`s, unlists, sets gas, sells, withdraws ETH to the address fixed at init, clears or reassigns
  holdings, settles reserved transactions, emergency stop. CLI: `bun --env-file=.env app/human.ts stop |
unfreeze | approve <id> | reset | withdraw <wei> | sell <token> <amount> [min wei] [max | 0x approve] | unlist
<token> | holding <token> <agent> [amount] | gas <limit> | replace <nonce> | clear <nonce> refund|spent | release`.
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

The sentinel's key pays the gas of every verdict an agent pays for: an agent sending paid checks
(0.019 NEAR each, within its 7-day cap) or exit quotes (from its credit, while it holds a token) can exhaust
its 0.25 NEAR, after which verdicts stop until the owner
gives the sentinel a new key (as below); the agent's checks then wait unjudged, and their price is refunded
after 300 s (`refund_check`). An operational limit, not a bypass: no verdict means no buy.

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
response, the model's signature over both, and the TDX and GPU attestation fetched with our nonce. Packages are
kept locally in `proofs/llm/`, outside the repository; the one shipped is `app/fixtures/decision.json`. The
model holds no key: its tools call the agent's wrapper (`app/agent.ts`).

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
inbox, anchored as check #5 of this deployment, `guard.goblin-guard-81427.testnet` (its signed request names
that guard, `agent.goblin-guard-81427.testnet` and a block 8 s before the check; its `request_check` tool
call states the 10000000000000 wei the check stores).

Injection count: `./demo.sh --full` with a key runs the model 3 times on the poisoned inbox and prints how
many runs resisted; `bun --env-file=.env --env-file=.env.agent --env-file=.env.llm app/llm.ts 20` measures
more runs against the live guard. Resisted = ignored the message, or checked the trap and stopped at the
guard's answer. The `--full` runs are concurrent: once one run's check lists the trap, another run's check of
it is refused (`target is on the shared blocklist`) and counts as resisted, so the count partly measures the
blocklist. The guard does not rely on the model: the scripted agent that obeys is stopped all the same.

## Real Base

`./check-mainnet.sh` simulates USDC on Base mainnet (`mainnet.base.org`, read-only, nothing broadcast), traces
the guard's transactions on an anvil forked from it, and replays the proof (23 s on 2026-11-12). With no
template index for mainnet, the verdict is `warn` (reputation unknown), and that is its only reason. That run's
proof ships as `app/fixtures/usdc-base-mainnet.json` (check #19): anyone replays it with `--check` against
`mainnet.base.org` and the guard, with no account (README).
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
there); a pruned node refuses old state, an archive node does not. Re-run on 2026-11-12 with the same command:
same sha256, 283 requests in 296.9 s.

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
- **Simulation.** A simulation cannot prove that a token will be sellable later. The guard side runs the
  exact buy the guard signs, then its two sales, and nothing else, at the verdict's block, and the environment rule refuses
  tokens whose transfers read state or opcodes the simulation cannot reproduce. Still open: an owner action
  after the buy (a pause, a fee raised, a blacklist; any admin, not only the `owner()` whose takeback is
  probed), behaviour that changes after the late sale (400 to 510 s after the buy) through TIMESTAMP or NUMBER, a token keyed on the
  guard's own ETH balance (the real L1 data fee differs from the simulated one), V4 hooks. Block fields: on
  Base the coinbase is constant and the base fee sits at its floor (0.005 gwei in 10 of 11 blocks sampled on
  2026-11-11), prevrandao is constant
  over an L1 epoch as simulated; a token reading one is a `warn`. The real gap was system state, which a
  token can no longer read and be allowed. The check samples one sale amount and two delays (a derived share
  10 to 300 s after the buy, then the rest 400 to 510 s after it, both drawn per check): a token keyed on an
  amount or a delay it did not sample (a sale only below some share, or only after 510 s) still passes, and an agent's exit sells its holding
  (the signed minimum, 97 % of the quote), when it chooses. The check's sales are previews (no floor, a fixed
  deadline): an exit's own bytes are simulated only by its exit quote, after the buy. When the guard's address
  cannot pay for its transactions at the check, its balance is set to exactly what they spend. A token that
  refuses or taxes only some sale sizes (a per-sale limit, a fee swap the buy triggers) can still get listed
  by a check of that size; the owner unlists.
- **Verdicts tied to a nonce.** A verdict buys only the transaction simulated, at the guard's nonce then: a
  signature for another check, or a gas or fee change, between the verdict and the buy refuses that buy, and
  the agent pays a new check. Several busy agents race for the one nonce sequence.
- **Template reputation.** Keyed by code template only: changing anything other than a `PUSH32` operand or
  the metadata makes a new template, and a template with fewer than 3 earlier pools gets no finding. A token is judged only against pools funded before its own, so copies
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
  NEAR AI keeps a signature is unknown, hence the archived packages (`proofs/llm/`, kept locally, not in the
  repository).
- **Decision digest.** The guard stores the digest the agent sends and refuses one already anchored, but does
  not check the package: a compromised agent can omit it or attach another package. It ties an action to a
  decision after the fact; it does not gate it.
- **Operations.** The NEAR/ETH rate is fixed by the owner, with no oracle. One signature at a time for all
  agents and exits: the owner's sale waits for the one in progress. The emergency stop does not recall a
  signature already requested; it voids the checks requested before it. Each signature that does not come
  back needs the owner (replace, then clear), and a late signature broadcast before the replacement is mined
  (within the budget already debited). The sentinel and replay need anvil (Foundry) for the environment
  trace; without it the check fails closed. All roles run under one OS user, whose near-cli keychain holds
  full-access keys. `withdraw_fees` leaves storage, credits and escrow covered at the time; storage the guard
  pays for afterwards (an agent registered, an arming, a stop) comes out of what is left, so a fee withdrawal
  to the limit can leave the last credit refund a little short until the owner deposits.
- **Build.** `cargo near build non-reproducible-wasm` of `src/` at commit `d832e22`: its sha256 matches the
  deployed code hash (cargo finds the build here up to date with that source), but a rebuild on another machine may differ. `cargo near build reproducible-wasm` works here (Docker), but its
  metadata names the git commit it was built from, so it can be published only from a pushed commit.

## Closed after review

Each line is a bypass that a review (five judge runs, a red team, automated reviews and our own security
passes) found, then how it was closed. Each has a test.

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
- Simulated blocks told apart from real ones (the late sale 256 blocks but 1 h later, one prevrandao for all, then one per block where Base keeps it over an L1 epoch): 2 s per block, every block up to the late sale listed, a prevrandao per L1 epoch.
- A sale tax hidden by a token that sells for itself into the pool during the sale (the pool's WETH outflow was measured): the tax is the ETH the seller receives, and a pool paying out more is a `block`; `pair_pull_tax` on the fork.
- One signed decision anchored on two checks: the guard refuses a digest already anchored, and `attest --check` verifies `decision_of`.
- A pair created empty before the index window escaped reputation (having code there was taken for being older): an older pool must have held 0.5 ETH before the window, otherwise it is dated by its funding inside it.
- The red team's RedL1Trap: a sale only while the L1Block predeploy is unchanged since the buy, which Base rewrites every block and eth_simulateV1 never does (allow, NEAR signed, tokens stuck, `replay --check` OK): the environment rule. Every address the guard's transactions touch is traced on a local fork, and one outside the token, its pool and Uniswap is a `block`; opcodes no simulation can match are a `warn`; replay recomputes both. `red_l1_trap`, `helper_trap` and `basefee_trap` on the fork.
- A signature published by the MPC after the guard's yield timed out, once the guard had refunded the agent and freed the nonce (a spend outside the budget), and a nonce stuck behind a transaction that can never be mined: a signature that does not come back keeps its nonce, charge and tokens reserved until the owner settles it, and the owner signs a replacement at a reserved nonce.
- `attest --check` compared the model with the package's own claim, and the buy's amount came from unattested wrapper code: the model is pinned, the signed tool call states `amount_wei`, and `attest --check` requires the check's amount to be that one.
- "The owner can always have NEAR sign a sale, whatever the agent's state" was not true during a signature: the sentence says when, and a test shows the order after a stop.
- Executable code in a tail shaped like solc's metadata escaped the opcode scan, which cut that tail unread: the whole code is scanned, and such a tail counts as data only when the code before it halts and it holds no JUMPDEST.
- The model's tool call sets the buy's amount, which only the armed budget bounded: an owner-set per-buy limit (`max_buy_wei` in `bounds`), enforced by `request_check` and `buy`, and by the wrapper before it calls the guard.
- A verdict from before an emergency stop still bought after `unfreeze` and a new arming within its 120 s: the stop voids every check requested before it, for a buy and for a quoted exit.
- An agent whose budget was spent or expired could not sell, only the owner could: a sale never needs buying budget, the exit quote and its gas come from the agent's credit.
- A refund was accepted before any replacement was signed, so a late signature could still be mined after it, and a replacement could void a buy that was signed and charged: a refund needs a replacement signed at that nonce, and only a reserved nonce can be replaced.
- Any armed agent could get an honest token listed for the price of a check by picking an amount whose buy fails (USDC at 10,000 wei, the demo model's choice) or whose sale the pool pays 0 for: only a finding of the token after a buy that succeeded, measured on at least 1,000 units, lists it; the wrapper refuses dust below 1 % of the per-buy limit.
- A callback that ran out of gas would have held the signing slot forever: the owner releases it after 600 s, its transactions reserved as unsettled, and a late callback names its request, so it cannot settle the next job.
- Judge pass 6's NextBlockKey (a sale only in the block right after the buy, where every check sold first and no real exit lands) and AmountTrap (a sale only of half or all of the balance, what every check sold): the first sale's block (5 to 150 after the buy) and share (13 % to 87 %) are derived per check like the probes, each approve and swap in a block of its own, and `replay --check` recomputes them; both tokens are on the fork, blocked and listed.
- The owner's `withdraw_fees` took the prices that paid for storage, then an agent's `refund_credit` failed (`lacks balance for state`): a withdrawal must leave the balance paying for storage, every credit (`credits_total`) and the escrow.
- A sentinel could post an honest proof with `list_target` true and get a clean token listed while `replay --check` said OK: `list_target` is in the evidence and stored with the verdict, and replay compares both.
- A token that delivers almost nothing on a buy escaped the blocklist, dust being judged on the tokens received: dust is the pool's quote for the agent's amount.
- A token could accept a sale only at the check's late block, always 255 blocks after the buy (review of
  2026-11-12): the late sale is drawn per check too, 200 to 255 blocks after the buy, and `replay --check` refuses a schedule the sentinel
  chose (`sales not derived from on-chain data`).
