# near-preflight: a pre-buy guard for AI agents, purchases signed by NEAR

NEAR Hackathon, track **AI Security & Defense**. Repository: [github.com/cmoron/near-preflight](https://github.com/cmoron/near-preflight).

An AI agent can buy a token on Base only through a NEAR contract, the guard. A spending cap stops an agent from spending too much, not from spending a little on a trap. The guard adds what a cap cannot: it judges the token before NEAR signs anything. In the track's terms, the payee is a Base token, judged before NEAR signs the payment. Verdicts: `allow` (buyable), `warn` (buyable once the owner approves), `block`.

- **Pre-buy simulation with a replayable proof.** A sentinel simulates on Base the guard's buy and sales, the exact bytes NEAR would sign and nothing else before or between them; a probe's twins and the takebacks (tokens pulled back from the buyer without approval) run apart. A token whose transfers depend on what a simulation cannot reproduce is not allowed: the guard's transactions are replayed on a local fork, and an address they touch outside the token, its pool and Uniswap is a `block` (Base's L1Block, a fee vault, a helper); an opcode no simulation can match in its code is a `warn`. Anyone can re-derive the verdict NEAR stores.
- **Template reputation.** A token's template is its code with immutables and metadata masked, shared by its copies. Even with a clean simulation, a token is blocked when at least 3 pools of its template were funded (0.5 ETH of WETH net) before its own and at least 80 % of them were drained (90 % of their LP burned) within a day of funding.
- **A purchase built by the contract and signed by NEAR Chain Signatures.** The agent picks the token and the amount when it asks for a check. It cannot pick what gets signed after the verdict: route, recipient and floor come from the guard, which signs only the transaction the sentinel simulated.
- **An agent that is a NEAR AI enclave-attested model.** Each decision is signed inside a TEE; its signed request names the guard, the agent and a recent NEAR block, and its sha256 is stored with the one guard call it asked for (the guard refuses it a second time).

Deployed on testnet: `guard.goblin-guard-81427.testnet` (`src/lib.rs`, near-sdk 5, wasm of 361,064 bytes, sha256 `35bbcc91…f52d`, the code hash on chain). Status page: [`docs/`](docs/index.html). Checks, rules, roles, keys, every limit and what review found: [`docs/DETAILS.md`](docs/DETAILS.md). Measured once on real Base (2026-11-11, 24 h, read-only): 29 Uniswap V2 WETH pools, all of one code template, 24 drained within a day of funding; the rule blocks that template's next copy (DETAILS, Real Base).

## Try it

1. With Rust and `cargo-near` 0.23, `near` CLI 0.31, `bun` 1.4, Foundry 1.8 and `jq`: `cargo test` -> `247 passed`, then `bun install`.
2. Get a testnet account holding about 7 NEAR (setup moves 6.35 NEAR). The faucet gives 10:

   ```sh
   near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
   ```

   It rate-limits by IP (`429 Too Many Requests`). A failed call creates no account but leaves a key that was never added, in two places: the file `~/.near-credentials/testnet/<you>.testnet.json` and the folder `~/.near-credentials/testnet/<you>.testnet/`. Delete both (the CLI will not overwrite them), then retry later, or create the account from any testnet account holding 7.5 NEAR:

   ```sh
   near account create-account fund-myself <you>.testnet '7.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as <funded>.testnet network-config testnet sign-with-keychain send
   ```

3. `cargo near build non-reproducible-wasm && bun app/setup.ts <you>.testnet` deploys the guard and creates `agent.`, `agent2.`, `sentinel.` and `armer.` (the armer, a key apart from the agent's, opens the agent's armed budget: what it may spend before a deadline), each with a function-call key limited to the guard.
4. `evm/fork.sh` in another terminal starts an anvil fork of Base with the demo tokens (including the traps and USDC code copies from earlier reviews); the sentinel and replay also run throwaway anvil forks. Then `bun test` -> `248 pass` and `bunx tsc --noEmit` -> exit 0.
5. `./demo.sh` -> exit 0 in 75 to 115 s, four moments:
   1. A poisoned inbox message pushes the agent to a trap: the sentinel answers `BLOCK (sale refused N blocks after the buy ...)` and the contract refuses the buy (`verdict does not allow the purchase`).
   2. A farm token whose simulation is clean: `BLOCK (template 0x9c69..94c8: 5 of 5 earlier pools drained ...)`.
   3. USDC, whose code three drained copies share on the fork: `ALLOW (... template reputation not applied ...)`, the guard builds the swap, NEAR signs it, a relay with no key broadcasts it: `receipt status 1`.
   4. The agent bypasses its wrapper: the protocol refuses a direct MPC call and a NEAR transfer, the contract a 1 ETH check (`amount above the owner's per-buy limit`) and a buy of another amount than the one checked (`amount is not the one checked`), and ignores an injected target, recipient and `min_out`.
6. The demo ends by printing this run's `app/replay.ts ... --check` and `app/attest.ts ... --check` commands: each exits 0. If the roles log `429 Rate limits exceeded`, the NEAR RPC (fastnear) is limiting your IP: wait a few minutes and run again.
7. Optional: with `NEAR_AI_API_KEY=...` in `.env.llm` ([cloud.near.ai](https://cloud.near.ai)), moment 1 runs the live attested model (about 0.0004 USD); without it, one line says so and a recorded decision is verified instead. `./demo.sh --full` (about 3.5 min) adds the exit, a `warn` approved by the human, a trap aimed at the guard's own address, a second agent, the injection count, the emergency stop and the withdrawal.
8. `./check-mainnet.sh` -> exit 0: USDC simulated on Base mainnet (read-only), its transactions traced on a fork of it (they touch USDC, its implementation, its pool and WETH only) and replayed, verdict `warn` (no template index for mainnet: an unknown reputation is never a pass).

## What NEAR enforces

- The agent's key can call only the guard's `request_check`, `buy`, `refund_check`, `request_exit` and `sell_quoted`: no transfer, no MPC call. Its 0.5 NEAR allowance only caps gas.
- A buy needs an `allow`, or a `warn` the owner approved, less than 120 s old, on a check requested after the owner's last stop, for the amount stated at the check (at most the owner's per-buy limit), on a token neither listed nor held for another agent, within the armed budget. A sale never needs buying budget: an exit's quote and gas come from the agent's credit.
- For an agent's buy or exit, the guard signs only the transactions whose hashes the verdict carries, built by the guard itself (chain 8453, router, path, recipient = its own address, floor = sentinel quote minus 3 %, nonce, gas, fees) and simulated as is by the sentinel. If anything moved since, it signs nothing and the agent asks a new check. The owner's `sell`, `withdraw_eth` and `sign_replacement` sign without a verdict. The blocklist holds tokens, never a code template.
- The owner can have NEAR sign a sale of any token the guard's address holds, at any floor and with any approve, the maximum included, whatever the agent's state, once a signature in progress returns (about 6 s); after a stop, that sale is mined after the buy in flight.
- A signature that does not come back may still be published by the MPC: its nonce, charge and tokens stay reserved; the owner signs a replacement at that nonce (only a reserved nonce can be replaced), and only then can refund it. A signing slot whose callback never ran is released by the owner after 600 s, reserved the same way (DETAILS).

## Limits

- The sentinel is one key on one machine, no TEE: a lying `allow` can be bought within 120 s, and replay catches it only afterwards. The owner replaces a compromised key (`set_sentinel`).
- A simulation cannot prove that a token will be sellable later. Closed: tokens keyed on the guard's gas, fees, amount, approve or calldata, on extra calls of the simulation, on state or opcodes the simulation cannot reproduce (L1Block, fee vaults, the base fee...), and on where or what the check sells: its first sale lands 5 to 150 blocks after the buy and sells 13 % to 87 % of it, both derived per check from the EVM block hash. Open: a token keyed on a sale amount or delay the check did not sample (an exit sells the agent's holding, when it chooses), an owner action after the buy, behaviour that changes beyond the 512 s horizon (TIMESTAMP, NUMBER), an admin other than `owner()`.
- The signing request and the signed transaction are public on NEAR before broadcast: a token owner can react before the swap's 300 s deadline.
- Reputation judges a token only against pools funded before its own: a token whose pool held 0.5 ETH before the index window is not judged by it (its reasons say so).
- A transaction signed for chain 8453 is valid on Base mainnet: never fund the derived address. The relay broadcasts only to anvil. The build is not reproducible yet (DETAILS, Build).

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real money on an EVM chain; the traps and the template-reputation method come from those losses. No code, strategy, wallet, address list or account from that work is reused or published. Libraries: near-sdk, omni-transaction (Rust), near-api-js, viem, @phala/dcap-qvl-node (TypeScript), Foundry. Agent model: `z-ai/glm-5.3-flash` on NEAR AI Cloud. Code written with AI assistance (Claude Code). License: MIT.
