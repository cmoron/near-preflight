# goblin-near: a pre-buy guard for AI agents, purchases signed by NEAR

NEAR Hackathon, track **AI Security & Defense**.

An AI agent can buy a token on Base only through a NEAR contract, the guard. A spending cap stops an agent from spending too much; it does not stop it from spending a little on a trap. The guard adds four things a cap does not do: a **pre-buy simulation with a replayable proof** (a sentinel simulates buy, takeback and sales on Base, and anyone can re-derive the verdict NEAR stores); **template reputation** (a token whose code template already launched pools that their creators drained is blocked, even when its simulation is clean); a **Base purchase built by the contract and signed by NEAR Chain Signatures** (the agent holds no EVM key and picks neither token, route, recipient nor floor); and an **agent that is a NEAR AI enclave-attested model** (each decision is signed inside a TEE, and its sha256 is stored with the guard call it asked for).

Deployed on testnet: `guard.goblin-guard-21301.testnet` (`src/lib.rs`, near-sdk 5, wasm of 321,100 bytes, sha256 `3f7eb0cc…ad62`, the code hash on chain). Status page: [`docs/`](docs/index.html). Checks, rules, roles, keys and every limit: [`docs/DETAILS.md`](docs/DETAILS.md). Measured once on real Base (2026-11-11, 24 h, read-only): 29 Uniswap V2 WETH pools, all of one code template, 24 drained within a day of funding; the rule blocks that template's next copy. Command and block window: DETAILS, Real Base.

## Try it

Needs Rust with `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8 and `jq`.

1. `cargo test` -> `188 passed`. Then `bun install`.
2. Get a testnet account with at least 7 NEAR (setup moves 6.05 NEAR): the faucet gives 10.

   ```sh
   near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
   ```

   If it answers 429 (it rate-limits by IP), retry later or fund the account from any testnet account you hold. A failed faucet call can leave `~/.near-credentials/testnet/<you>.testnet.json` with a key that was never added: delete it first, the CLI will not overwrite it.

   ```sh
   near account create-account fund-myself <you>.testnet '7 NEAR' autogenerate-new-keypair save-to-keychain sign-as <funded>.testnet network-config testnet sign-with-keychain send
   ```

3. `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard and creates `agent.`, `agent2.`, `sentinel.` and `armer.`, each with a function-call key limited to the guard.
4. `evm/fork.sh` in another terminal starts an anvil fork of Base with the demo tokens. Then `bun test` -> `158 pass` and `bunx tsc --noEmit` -> exit 0.
5. `./demo.sh` -> exit 0 in about 65 s, four moments:
   1. A poisoned inbox message pushes the agent to a trap: the sentinel answers `BLOCK (sale refused in the next block ...)` and the contract refuses the buy (`verdict does not allow the purchase`).
   2. A farm token whose simulation is clean: `BLOCK (template 0x9c69..94c8: 5 of 5 earlier pools drained ...)`.
   3. USDC: `ALLOW`, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it: `receipt status 1`.
   4. The agent bypasses its wrapper: the protocol refuses a direct MPC call and a NEAR transfer, the contract a 1 ETH buy (`budget exceeded`) and ignores an injected target, recipient and `min_out`.
6. The demo ends by printing this run's `app/replay.ts ... --check` and `app/attest.ts ... --check` commands: each exits 0. If the roles log `429 Rate limits exceeded`, the NEAR RPC (fastnear) is limiting your IP after several runs in a row: wait a few minutes and run again.
7. Optional: with `NEAR_AI_API_KEY=...` in `.env.llm` ([cloud.near.ai](https://cloud.near.ai)), moment 1 runs the live attested model (96 s, 0.0003 USD); without it, one line says so and a recorded decision is verified instead. `./demo.sh --full` (233 s, 0.0010 USD with the key) adds the exit, a `warn` approved by the human, a trap aimed at the guard's own address, a second agent, the injection count, the emergency stop and the withdrawal.
8. `./check-mainnet.sh` -> exit 0: USDC simulated on Base mainnet (read-only) and replayed, verdict `warn` (no template index for mainnet: an unknown reputation is never a pass).

## What NEAR enforces

- The agent's key can call only the guard's `request_check`, `buy`, `refund_check`, `request_exit` and `sell_quoted`: no transfer, no MPC call. Its 0.5 NEAR allowance only caps gas; once spent, NEAR refuses the key's transactions and the human replaces the key.
- A buy needs an `allow`, or a `warn` the owner approved, less than 120 s old and simulated with the gas limit the guard signs with, on a token neither listed nor held for another agent, within the armed budget.
- The guard builds the transaction itself: chain 8453, router, path, recipient = its own address, floor = sentinel quote minus 3 %.
- The blocklist holds tokens, never a code template. A block lists its token only if the sentinel posts it with the token's code and flags it as found by its fresh probe; it never flags a failure seen only from the guard's own address.
- The owner can always have NEAR sign a sale of any token the guard's address holds, at any floor, whatever the agent's state (once no other signature is pending); if the sale needs more gas, the owner raises the gas limit (up to 2,000,000) and signs it again. Whether a sale then goes through is up to the token's code.

## Limits

- The sentinel is one key on one machine, no TEE: a lying `allow` can be bought within 120 s, and replay catches it only afterwards.
- Reputation is keyed by code template and dated by pool funding (net of removed liquidity): a token whose pool predates the index window is judged on the whole window, and an operator who funds its target with 0.5 ETH before running the farm escapes it.
- A credit whose buy reverted on Base keeps that token for its agent: no other agent can buy it until the owner clears or reassigns the holding (`set_holding`).
- The decision digest is stored, not checked: it ties an action to a decision after the fact.
- A transaction signed for chain 8453 is valid on Base mainnet: never fund the derived address. The relay broadcasts only to anvil. The build is not reproducible yet (DETAILS, Build).

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain; the traps and the template-reputation method come from those losses. No code, strategy, wallet, address list or account from that work is reused or published. Libraries: near-sdk, omni-transaction (Rust), near-api-js, viem, @phala/dcap-qvl-node (TypeScript), Foundry. Agent model: `z-ai/glm-5.3-flash` on NEAR AI Cloud. Code written with AI assistance (Claude Code). License: MIT.
