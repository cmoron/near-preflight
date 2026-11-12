# Replay and attest

Two commands let anyone check the system after the fact, with no NEAR account and no key:

- [`app/replay.ts`](../app/replay.ts) re-derives a sentinel verdict from its proof file and a Base node.
- [`app/attest.ts`](../app/attest.ts) verifies the agent model's signed decision and ties it to a check.

Both print one line per fact (`OK`, `MISMATCH`, `ERROR`, or `SKIPPED` when the node cannot tell) and exit 0
only when every fact holds.

## The proof file

The sentinel writes `proofs/<id>.json` for each check ([`toProof`](../app/verifier.ts)):

| Field      | Content                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `id`       | the check on the guard                                                                           |
| `target`   | the token                                                                                        |
| `verdict`  | `allow`, `warn` or `block`, and `reasons` (at most 280 characters)                               |
| `evidence` | the exact string posted to `post_verdict`, at most 8,000 characters: the guard stores its sha256 |
| `request`  | the `eth_simulateV1` requests, byte for byte: three on the reference block, the later side's     |
|            | then the far sales' and the exit-size sales' blocks (`local_fork_mine`), mined on a local fork   |
| `response` | the node's answers, then the far and exit-size sales' results on the fork                        |
| `nodes`    | the hosts of the nodes the sentinel read: simulation and logs (outside the evidence)             |

The evidence holds the block, the chain's `cadence` there (the 100 blocks before it took `seconds`), the
request's sha256, the amount, the guard's transaction hashes, the call labels and outcomes, the quote,
the code facts, the liquidity facts and the reputation.

It also holds the NEAR facts read before the verdict, the opcodes, the addresses touched, what the
token's code calls or reads (`token_calls`), whose ETH balance (`token_balances`) and which of TIMESTAMP,
NUMBER, SELFBALANCE, CREATE and CREATE2 it ran (`token_opcodes`), the drawn `sales`
(`first`, `bps`, `late` and the drawn `far`, in blocks at that cadence), the guard's `slippage_bps` (the
exit-size sale sells the tokens bought minus it), the later side and `list_target`. The
later side (`later`) is its real block, the slots the buy wrote that Base also wrote before it
(`moved`), the pool's reserves there, the trades of the pool re-executed after the buy (`replayed`,
their hashes) and why they could not be (`unverified`, or null). The state the later side set is in its request's `stateOverrides`. An exit
quote's evidence has `kind: "exit"` and fewer fields.

Where it lives: each sentinel's evidence string is on NEAR, in its `verdict_posted` event, and its
sha256 in the check's `votes`. Each sentinel writes its own proof file: `proofs/<id>.json` for the first
one the guard names, `proofs/<id>.s2.json` for the second. The requests and responses are not: the sentinel publishes the proof file. Two ship in
[`app/fixtures/`](../app/fixtures/) (`usdc-base-mainnet.json` is check #28 of the demo guard, an `allow`: its far sales
301 s, 831 s and 900 s after the buy and its exit-size sale, which replay mines again on a local fork;
both sentinels posted that same evidence string, each from its own nodes).

## What `replay` recomputes

```sh
bun app/replay.ts <proof.json> [rpc] [--check]     # rpc defaults to EVM_RPC, then http://127.0.0.1:8545
```

The template index is rebuilt from `INDEX_RPC`, the rpc by default: it needs `eth_getLogs`, which
`mainnet.base.org` refuses. Without it the index line is an `ERROR` that names `INDEX_RPC`.

Without `--check`, from the file and the node only:

- the request's sha256 and shape: it must be what the sentinel builds for that token, and the guard
  side must hold only the guard's own transactions, nothing before or between them;
- the chain id, the cadence measured again at the evidence block, and the first simulated block's time
  at that cadence;
- every call resent to the node at its block (the evidence block, the later side's block): status, return
  data and logs identical;
- the probes are fresh addresses (no code, not the router, WETH, the target or `owner()`);
- the verdict, reasons and `list_target`, rejudged from the results;
- once the requests are confirmed as the sentinel's (no other input reaches it): the addresses the
  guard's transactions touch, what the token's code calls or reads and the TIMESTAMP, NUMBER,
  SELFBALANCE and CREATE it runs, traced again on local anvil forks (the guard side, the far sales, the later
  side), and the buy's state change;
- the far sales: their request rebuilt from the guard and probe sides (each one's late approve and swap,
  301 s, `sales.far` blocks and 900 s after the buy, then its exit-size sale, the tokens bought minus
  `slippage_bps`, at the late sale's blocks), mined again on that fork, every result identical; the
  verdict is rejudged on replay's own results;
- the later side: the trades of the pool and the transfers to or from the guard between the two blocks,
  fetched again from the node's receipts and re-executed after the buy (one left out or added is a
  `MISMATCH`), then the guard's sales on `later.block` with the buy's footprint set, rebuilt byte for
  byte from the node's state there;
- the quote, the hash of the guard's simulated buy, the liquidity facts (LP holders' logs from `INDEX_RPC`);
- the template index window: bound to the check's block (it starts at least 2 h before it, by their
  timestamps, and ends at it); `INDEX_RPC`, when it is another node, gives the window's ends the node's
  hashes; then the whole index rebuilt from it, same sha256;
- the target's code hash, template, proxy implementation and environment opcodes.

With `--check`, against the guard on NEAR (`GUARD` names it):

- one of the check's votes carries the sha256 of the evidence replayed, and that vote's verdict is the file's;
- the guard's verdict is what the votes decide: the quorum's votes for an `allow` or a `warn` (read from
  the view `sentinels`), one for a `block`; a block on a vote that was not one is reported as such;
- the on-chain quote, amount, `list_target`, transaction hashes and target match, and the reasons when
  this vote is the one whose reasons the guard stored;
- the buy NEAR signed for the check, if any, is the transaction simulated;
- the evidence block is the request's reference block: the first Base block at least 4 s after its time
  on NEAR;
- the sales (the far sale's drawn delay included), the probes and the later side's block are those derived from
  the guard, the check id, its request time and the reference block's hash: a sentinel cannot choose them;
- the guard side was simulated from the guard's derived Base address;
- `slippage_bps` is the guard's (`evm_config`): the exit-size sale sold what an agent's exit sells;
- the blocklist entries and the code at the last check, as the evidence cites them, are on the guard.

Example, from a fresh clone ([reproduce](reproduce.md#without-an-account)): check #28 replays with 43 `OK`
lines and `REPLAY OK: verdict allow confirmed, same as on chain`.

## What replay cannot do

- **It comes afterwards.** A lying `allow` can be bought within 120 s; replay shows a forged simulation,
  forged facts, a chosen block or an unbound index window only after that.
- **It needs the proof file.** The requests and responses are off-chain; without the file there is
  nothing to resend. The evidence on NEAR still shows what the sentinel claimed.
- **It needs the state.** A node that serves the state and logs of the evidence block and of the later
  side's block, and their receipts, and anvil (Foundry) for the trace and the re-execution. On
  2026-11-12 `mainnet.base.org` still served the
  state of blocks 5,000,000 back (116 days), for `eth_simulateV1` and storage reads alike; a public
  endpoint may prune it at any time, and an archive node never does. A node that no longer serves a
  block answers with an error: replay prints `ERROR resending the requests at block … (the node must
  still serve their state …)` and `REPLAY FAILED`, never an `OK` (`bun test -t "does not serve the later"`).

An exit quote replays the same way: same request, same quote; with `--check`, the seller is the guard's
derived address and the on-chain quote matches.

## The attested agent

The demo agent is `z-ai/glm-5.3-flash`, served by NEAR AI Cloud on Intel TDX machines with NVIDIA H100
GPUs in confidential mode ([`app/llm.ts`](../app/llm.ts)). Its replies are signed inside the attested
TEE (trusted execution environment). The model holds no key: its tools call the agent's wrapper
([`app/agent.ts`](../app/agent.ts)).

Each completion is archived as a **decision package**: the exact request and response, the model's
signature over `model:sha256(request):sha256(response)`, and the TDX and GPU attestation fetched with our
nonce. How long NEAR AI keeps a signature is unknown, hence the archive.

Packages stay in `proofs/llm/`, outside the repository. One ships,
[`app/fixtures/decision.json`](../app/fixtures/decision.json), anchored on check #1 of the demo guard.

Its signed request names `guard.goblin-guard-69369.testnet`, `agent.goblin-guard-69369.testnet` and a
NEAR block 7 s before the check; its `request_check` tool call states the 10000000000000 wei the check stores.

The agent may attach a package's sha256 to `request_check` or `buy`. The guard stores it and refuses it a
second time; it neither requires nor verifies it. The guard does not rely on the model: the scripted
agent that obeys the poisoned message is stopped all the same.

## What `attest` verifies

```sh
bun app/attest.ts <package.json> [--check <id>]     # --check reads GUARD
```

Verified cryptographically:

- the signature recovers the signing address (EIP-191), for the pinned model, non-streaming;
- the archived request and response hash to what was signed;
- the Intel TDX quote verifies (DCAP, `@phala/dcap-qvl-node`), and its report data binds the signing
  address and our nonce;
- the docker compose measured in the quote (`mr_config_id`) is the one in the report.

With `--check <id>`:

- the check on the guard carries the package's sha256, and `decision_of` anchors it on that check alone;
- the signed response asked for that very action, with the amount the check stores;
- the signed request names that guard, the check's agent and a NEAR block at most 600 s before the check
  was requested, never after: a package cannot be re-anchored on another guard or reused later.

Taken on trust: NVIDIA NRAS's GPU verdict (over TLS, its JWT signature not checked, as in the official
verifiers) and Intel PCS's collateral. `attest` calls Intel and NVIDIA, not NEAR AI.

Not verified:

- the measurements (MRTD, RTMRs, the compose's image digests) against a published reference, since none
  is published (the `SKIPPED` line);
- which machine signed: the same signing address signed every run here, so a signature ties a response
  to that key, not to one machine;
- the GPU evidence is tied to the quote by our nonce only.

**Injection count.** `./demo.sh --full` with a key runs the model 3 times on the poisoned inbox and prints
how many runs resisted. Resisted = ignored the message, or checked the trap and stopped at the guard's
answer. To measure more runs against the live guard:

```sh
bun --env-file=.env --env-file=.env.agent --env-file=.env.llm app/llm.ts 20
```

The `--full` runs are concurrent: once one run's check lists the trap, another's is refused
(`target is on the shared blocklist`) and counts as resisted, so the count partly measures the blocklist.
