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
| `request`  | the four `eth_simulateV1` requests, byte for byte                                                |
| `response` | the node's answers                                                                               |

The evidence holds the block, the request's sha256, the amount, the guard's transaction hashes, the
call labels and outcomes, the quote, the code facts, the liquidity facts and the reputation.

It also holds the NEAR facts read before the verdict, the opcodes, the addresses touched, the drawn
`sales` and `list_target`. An exit quote's evidence has `kind: "exit"` and fewer fields.

Where it lives: the evidence string is on NEAR, in the `verdict_posted` event, and its sha256 in the
check. The requests and responses are not: the sentinel publishes the proof file. Two ship in
[`app/fixtures/`](../app/fixtures/) (`usdc-base-mainnet.json` is check #5 of the demo guard).

## What `replay` recomputes

```sh
bun app/replay.ts <proof.json> [rpc] [--check]     # rpc defaults to EVM_RPC, then http://127.0.0.1:8545
```

Without `--check`, from the file and the node only:

- the request's sha256 and shape: it must be what the sentinel builds for that token, and the guard
  side must hold only the guard's own transactions, nothing before or between them;
- the chain id and the first simulated block's time (the evidence block + 2 s);
- every call resent to the node at the evidence block: status, return data and logs identical;
- the probes are fresh addresses (no code, not the router, WETH, the target or `owner()`);
- the verdict, reasons and `list_target`, rejudged from the results;
- the addresses the guard's transactions touch, traced again on a local anvil fork;
- the quote, the hash of the guard's simulated buy, the liquidity facts;
- the template index window: bound to the check's block (it starts at least 2,000 blocks before it and
  ends at most 300 before it), then the whole index rebuilt from the node, same sha256;
- the target's code hash, template, proxy implementation and environment opcodes.

With `--check`, against the guard on NEAR (`GUARD` names it):

- the on-chain `evidence_sha256` is the sha256 of the evidence replayed;
- the on-chain quote, amount, `list_target`, transaction hashes, target, verdict and reasons match;
- the buy NEAR signed for the check, if any, is the transaction simulated;
- the sales, the probes and the busy side's sender are those derived from the guard, the check id, its
  request time and the Base block hash: a sentinel cannot choose them;
- the guard side was simulated from the guard's derived Base address;
- the blocklist entries and the code at the last check, as the evidence cites them, are on the guard;
- the Base block's time lies between the NEAR request and the verdict (within 60 s); skipped on a node
  whose clock is not real time, such as a local fork.

Example, from a fresh clone ([reproduce](reproduce.md#without-an-account)): check #5 replays with 30 `OK`
lines and `REPLAY OK: verdict warn confirmed, same as on chain`.

## What replay cannot do

- **It comes afterwards.** A lying `allow` can be bought within 120 s; replay shows a forged simulation,
  forged facts or an unbound index window only after that.
- **It needs the proof file.** The requests and responses are off-chain; without the file there is
  nothing to resend. The evidence on NEAR still shows what the sentinel claimed.
- **It needs the state.** A node that serves the evidence block's state and logs (an archive node for
  old checks), and anvil (Foundry) for the trace.

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

Its signed request names `guard.goblin-guard-13713.testnet`, `agent.goblin-guard-13713.testnet` and a
NEAR block 21 s before the check; its `request_check` tool call states the 10000000000000 wei the check stores.

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
