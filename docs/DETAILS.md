# goblin-near: details

The [README](../README.md) is the short version. This page has the checks, the rules NEAR enforces, the roles,
the function-call keys, what the attestation proves, and every known limit.

## Checks before a buy

The sentinel is `app/verifier.ts`, with `app/index.ts` for template reputation. Every fact a verdict rests on
goes into the evidence, whose sha256 the guard stores with the verdict; `app/replay.ts` re-derives it all.

| Check                | How (read-only, public RPC calls)                                                | Verdict         |
| -------------------- | -------------------------------------------------------------------------------- | --------------- |
| Buy, takeback, sales | `eth_simulateV1`, as a fresh probe buyer and as the guard's EVM address          | see below       |
| Removable liquidity  | the Uniswap V2 WETH pair's LP supply now and 1,800 blocks (1 h) back             | see below       |
| Template reputation  | the index of V2 WETH pools by code template (`bun app/index.ts`)                 | see below       |
| Shared blocklist     | `get_entry` on the guard for the token                                           | listed: `block` |
| Code changed         | `last_code` on the guard: code hash and proxy implementation at the last verdict | changed: `warn` |
| Agent exit quote     | `eth_simulateV1`: the sale of the amount, from the guard's address               | quote = ETH out |

**Simulation.** Two buyers in the same blocks: a probe whose address is derived from the check and the EVM
block hash (a token cannot whitelist it in advance), and the guard's own public EVM address. Each runs:

- a buy of 0.01 ETH;
- `transferFrom` without approval, by `owner()` and by a stranger;
- a sale in the next block, and another 256 blocks later (timestamp +1 h).

Every simulated call gets the gas limit the guard signs with (`evm_config`, 250,000 at setup): a token whose
sale needs more gas would pass a looser simulation and trap the real exit. The guard stores that gas limit
with the verdict and refuses a buy or an exit on it once its own gas limit has changed.

Verdicts: a revert, a takeback or a tax of 50 % or more is a `block`; a tax from 10 % is a `warn`; no V2 pair
is a `warn`. A `block` found on the probe side lists the token on the guard. A failure on the guard's side
only (its address is public: anyone can send it tokens or get a token to freeze it) blocks that check but
lists nothing, and its reason starts with `guard address only, not listed`.

**Removable liquidity.** If at least 90 % of today's LP supply already existed 1,800 blocks ago, the
liquidity is old and its holders are not read. Otherwise the holders come from the pair's `Transfer` logs
(at most 4 `eth_getLogs` of 500 blocks, then `balanceOf` and `eth_getCode` per holder, at most 20). At least
half the LP removable (an EOA, a contract, or several summed; only 0x0 and 0xdead count as burned) is a
`warn`, and so are holders that cannot all be read.

**Template reputation.** Template = keccak256 of the runtime code with the CBOR metadata removed and every
`PUSH32` operand zeroed (solc writes immutables there). The index is rebuilt from `PairCreated`, `Mint` and
LP `Transfer` logs. A pool is dated by its funding: the block where the WETH its providers added reaches
0.5 ETH, not the pair's creation (a pair created empty long before says nothing). It is drained when 90 % of
the LP ever minted is burned after that. Only pools funded before the target's own pool count; when the
target's pool is not in the index (or never reached 0.5 ETH in it), every pool of the index counts. At least
3 such pools with at least 80 % drained within 1 day of funding is a `block`, which never lists anything. No
index for the chain is a `warn`: an unknown reputation is never a pass.

## What NEAR enforces

| Rule                                                                                           | By                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------- |
| Only the agent's function-call key acts for it, and only on the guard                          | NEAR protocol                 |
| A buy needs an `allow`, or a `warn` the owner approved, within 120 s of the verdict            | `buy`, `approve_warn`         |
| A buy needs the verdict's gas limit to be the guard's current one, and a token not listed      | `buy`                         |
| The guard builds the swap: chain 8453, router, path, recipient = its address, gas, fees, floor | `buy`                         |
| Value plus gas at the cap is debited from the armed budget and the prepaid credit              | `buy`, `sell_quoted`          |
| A token at the guard's EVM address is held for one agent at a time                             | `buy`, `holding`              |
| An agent sells at most its holding, on a sentinel exit quote at most 120 s old, used once      | `request_exit`, `sell_quoted` |
| The owner sells any token, amount and floor, frozen agent or not, no quote, no budget          | `sell`                        |
| The owner sets gas limit and fees within bounds, never during a signature                      | `set_evm_gas`                 |
| Only the sentinel posts a verdict, once, with the sha256 of its evidence                       | `post_verdict`                |
| A block lists its token only with the token's code and the sentinel's `list_target`            | `post_verdict`                |
| Blocklist: tokens only, never a template; entries never overwritten; only the owner unlists    | `report`, `unlist`            |
| An `allow` on code that differs from the reference is refused                                  | `post_verdict`                |
| Arming within the owner's bounds (per arming, duration, 7-day cap), registered agents only     | `set_bounds`, `arm`           |
| Emergency stop: `disarm` by the owner freezes the agent until `unfreeze`                       | `disarm`, `unfreeze`          |
| One signature at a time; a failed signature returns credit and budget, the nonce stays free    | `on_signed`                   |
| A check's price (0.015 NEAR) covers its worst-case storage, 1,500 bytes, measured by tests     | `request_check`               |

Details:

- **Floor.** The sentinel's quote (tokens for its simulated 0.01 ETH) scaled to the amount, minus 3 %. The exit
  floor is the exit quote's ETH out minus 3 %. The agent never chooses a floor.
- **Holdings.** Each signed buy credits its signed minimum to the agent. The guard's EVM address holds every
  agent's tokens together, so `buy` refuses a token another agent still holds: a credit whose buy reverted on
  Base can then sell only tokens no other agent has a claim on. The exit's simulated sale, from the guard's
  address, also needs the tokens to be there.
- **Owner's exit.** `sell` signs approve and swap from the guard's address for any amount and floor. If a sale
  needs more gas than the guard signs with, the owner raises it (`bun --env-file=.env app/human.ts gas <limit>`,
  21,000 to 2,000,000, fees up to 10 gwei) and sells again. Measured on the fork with `gas_hungry` (a sale
  needs 500,000 gas left): at 250,000 the swap reverted (receipt status 0), at 600,000 the same sale went
  through. Whether a token lets any sale through is up to its code.
- **Decision digest.** `request_check` and `buy` take an optional `decision_sha256`, stored on the check and
  logged in `check_requested` and `sign_requested`. The guard does not check it (see Limits).

## Roles

- **Owner (human)**, full-access key in the near-cli keychain: sets bounds, registers agents and reporters,
  approves `warn`s, unlists, sets gas, sells, withdraws ETH to the address fixed at init, emergency stop.
  CLI: `bun --env-file=.env app/human.ts stop | unfreeze | approve <id> | reset | withdraw <wei> |
sell <token> <amount> [min wei] | unlist <token> | gas <limit>`.
- **Armer**, function-call key `arm`, `disarm`: arms a registered agent within the owner's bounds.
- **Agent**, function-call key `request_check`, `buy`, `refund_check`, `request_exit`, `sell_quoted`; no EVM key.
- **Sentinel**, function-call key `post_verdict`: simulates, posts verdicts and quotes.
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

## The attested agent

The agent is `z-ai/glm-5.3-flash`, served by NEAR AI Cloud on NEAR-hosted Intel TDX VMs with NVIDIA H100 GPUs
in confidential mode (`app/llm.ts`). Each completion is archived as a decision package: the exact request and
response, the model's signature over both, and the TDX and GPU attestation fetched with our nonce. The model
holds no key: its tools call the agent's wrapper (`app/agent.ts`).

`bun app/attest.ts <package> [--check <id>]` verifies cryptographically: the signature, the hashes of the
archived request and response, the TDX quote (DCAP, `@phala/dcap-qvl-node` as in `nearai-cloud-verifier`),
its report_data (signing address and our nonce), the docker compose measured in `mr_config_id`, and with
`--check` the sha256 on chain and that the signed response asked for that very action. Taken on trust:
NVIDIA NRAS's GPU verdict (over TLS, its JWT signature not checked, as in the official verifiers) and
Intel PCS's collateral. `attest` calls Intel and NVIDIA, not NEAR AI.

Without a key, the demo verifies `app/fixtures/decision.json`: the model's decision on the same poisoned
inbox, anchored as check #1 of an earlier deployment of ours, `guard.goblin-guard-52320.testnet`.

Injection count: `./demo.sh --full` with a key runs the model 3 times on the poisoned inbox and prints how
many runs resisted; `bun --env-file=.env --env-file=.env.agent --env-file=.env.llm app/llm.ts 20` measures
more runs against the live guard. Resisted = ignored the message, or checked the trap and stopped at the
guard's answer. The guard does not rely on the model: the scripted agent that obeys is stopped all the same.

## Real Base

`./check-mainnet.sh` simulates USDC on Base mainnet (`mainnet.base.org`, read-only, nothing broadcast) and
replays the proof. With no template index for mainnet, the verdict is `warn` (reputation unknown).
`bun app/index.ts <rpc> <from> <to> <out.json> --pace-ms 1000` builds an index from a node that serves
`eth_getLogs` (`mainnet.base.org` does not).

## Limits

- **Base mainnet.** A transaction signed for chain id 8453 is valid on Base mainnet: never send funds to the
  derived address. The relay broadcasts only to a local anvil. The demo's withdrawal address, `0x…dEaD`, is
  a burn-address placeholder: pass your own to `setup.ts`.
- **Sentinel.** One key on one machine, no TEE. A lying `allow` can be bought within 120 s; replay catches it
  only afterwards. A lying exit quote gives a lower floor; replay catches it afterwards.
- **Simulation.** It cannot see owner actions after the buy, traps after 256 blocks, or V4 hooks. A token whose
  public state a third party can move (a pool emptied of tokens, for instance) can still fail the probe's
  buy and get listed; the owner unlists.
- **Template reputation.** Keyed by code template only: changing anything other than a `PUSH32` operand or
  the metadata makes a new template. Copies funded after a token's pool cannot get it blocked when the index
  covers that funding; a token whose pool was funded before the index window is judged on every pool of the
  window, so copies drained there can block it (never list it). An operator who funds its target's pool with
  0.5 ETH before running its farm escapes the farm's history. A widely used template has a mixed history, and
  the 80 % share is what keeps it from blocking. The sentinel chooses the index window; replay does not judge
  it. A drain counts only as LP burned.
- **Removable liquidity.** Liquidity older than 1,800 blocks passes without its holders being read, and so
  does liquidity removed and re-added within the window that keeps 90 % of the supply. LP in a lock contract
  counts as removable (false `warn`s). Only the Uniswap V2 WETH pair is checked.
- **Holdings.** Credited at the signed minimum, not the amount received. A credit whose buy reverted on Base
  stays: the agent's exit fails in simulation for lack of tokens, and no other agent can buy that token until
  the credit is sold. Two agents cannot hold the same token at once.
- **Blocklist.** A registered reporter can list honest tokens until the owner unlists them, paying 0.005 NEAR
  of its own credit per entry.
- **Code changed.** Compared with the reference only; a change between the verdict and the buy (at most
  120 s), or after the buy, goes unseen.
- **Gas.** One gas limit for every transaction the guard signs. Raising it to get a sale through also raises
  what each buy reserves from the budget.
- **Attestation.** Measurements (MRTD, RTMRs, the compose's image digests) are not compared to a published
  reference, since none is published. The same signing address signed every run here: a signature ties a
  response to that key, not to one machine. The GPU evidence is tied to the quote by our nonce only. How long
  NEAR AI keeps a signature is unknown, hence the archived packages (`proofs/llm/`).
- **Decision digest.** The guard stores the digest the agent sends and does not check it: a compromised agent
  can omit it or attach another package. It ties an action to a decision after the fact; it does not gate it.
- **Operations.** The NEAR/ETH rate is fixed by the owner, with no oracle. One signature at a time for all
  agents and exits. The emergency stop does not recall a signature already requested. All roles run under
  one OS user, whose near-cli keychain holds full-access keys.
- **Build.** `cargo near build non-reproducible-wasm`: its sha256 matches the deployed code hash, but nobody
  can rebuild it bit for bit elsewhere. `cargo near build reproducible-wasm` works here (Docker), but its
  metadata names the git commit it was built from, so it can be published only from a pushed commit.
