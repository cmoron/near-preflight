# goblin-near: a spending guard and a pre-buy sentinel for AI agents on NEAR

NEAR Hackathon, track **AI Security & Defense** (`security`), also `open`.

An AI agent that can pay can be talked into paying for a trap. This project puts two independent
barriers between the agent and the money:

1. **A spending guard on NEAR.** The agent signs only with a function-call key limited to one contract.
   That contract holds the agent's prepaid credit, the budget a human armed for it, its expiry, and the
   recipients the human allowed. It pays nothing without a sentinel verdict `allow` recorded on chain.
2. **A pre-buy sentinel.** Before paying for an EVM token, the agent asks for a verdict. The sentinel
   simulates the purchase read-only (`eth_simulateV1`) and answers `allow`, `warn` or `block` with the
   reasons and a proof summary (chain, block, request hash, result of every simulated call), posted to
   the NEAR contract by the sentinel's own account.

The demo: an agent manipulated by prompt injection tries to buy a trap token. The sentinel blocks it;
the agent then bypasses its own wrapper and signs directly, and the contract and the protocol refuse.

State: day 1 of the build (2026-11-11). Everything below runs today; what does not is listed under
[Limits](#limits-what-does-not-work-yet).

## What NEAR carries

Deployed on testnet: `guard.goblin-guard-00044.testnet` (source `src/lib.rs`, near-sdk 5).

| Rule                                                                                                      | Where it is enforced                                     |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| The agent cannot transfer NEAR or call anything but `request_check`, `spend`, `refund_check` on the guard | NEAR protocol: function-call access key                  |
| A purchase is paid only on a verdict `allow` for that request, once                                       | contract `spend`                                         |
| Only the sentinel account posts a verdict, once per request                                               | contract `post_verdict`                                  |
| Payment only to a recipient the human allowed                                                             | contract `allow_recipient` / `spend`                     |
| Total spending (verdict fees + purchases) within the budget the human armed, before its expiry            | contract `arm(agent, budget, duration_s)`                |
| Emergency stop                                                                                            | contract `disarm` (owner only)                           |
| A verdict fee comes back to the agent if no verdict arrives in 5 minutes                                  | contract `refund_check`                                  |
| Prepaid credit, because a function-call key cannot attach a deposit                                       | contract `deposit_credit(account_id)`, paid by the human |

Function-call key limits (from the [access keys docs](https://docs.near.org/protocol/accounts-contracts/access-keys)):
it can only call the listed methods of one contract, cannot attach a deposit, cannot transfer, add keys
or deploy. Its gas is paid from the account balance and capped by the key's allowance (0.25 NEAR here);
when the allowance is spent, the key stops working. The agent account also has a full-access key, which stays in the human's near-cli keychain
and is never given to the agent process.

## The three checks of the sentinel

`app/verifier.ts`, route Uniswap V2 WETH -> token on Base (chain 8453). Two `eth_simulateV1` calls at the
same block, nothing signed, from buyer and stranger addresses drawn at random for every check:

| Check                                                                   | How                                                                                           | Verdict                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Can someone take the tokens back with `transferFrom`, without approval? | after a simulated buy, `transferFrom(buyer, x, 1)` sent by `owner()` and by a random stranger | `block` if it moves tokens                               |
| Does the sale go through right after the buy?                           | sell half the tokens in the same simulated block                                              | `block` if it reverts                                    |
| Does it still go through later?                                         | sell the rest in a second simulated block, one hour later                                     | `block` if it reverts                                    |
| Tax                                                                     | balance deltas against the pool quote (`getAmountsOut`), on the buy and on both sales         | `warn` from 10 %, `block` from 50 % or if not measurable |

## Try it

Requirements: Rust with `cargo-near` (0.23), `near` CLI (near-cli-rs 0.31), `bun` (1.4), Foundry
(`anvil`, `forge`, `cast`, 1.8). No API key: Base public RPCs serve `eth_simulateV1` and past state.

1. **Contract tests.** `cargo test` -> `43 passed`. Lint: `cargo clippy --all-targets -- -D warnings` -> no warning.
2. **Build the contract.** `cargo near build non-reproducible-wasm` -> `target/near/goblin_near.wasm`.
3. **Get a testnet account** (free, faucet):
   `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
4. **Deploy.** `bun install && bun app/setup.ts <name>.testnet` -> creates `guard.`, `agent.`, `sentinel.`,
   `shop.<name>.testnet`, deploys and initializes the guard in one transaction, adds the two function-call
   keys, allows `shop.` as recipient, deposits 1 NEAR of credit for the agent. Writes `.env` (no key),
   `.env.agent` (agent key only) and `.env.sentinel` (sentinel key only).
5. **Start a copy of Base**, in a separate terminal: `evm/fork.sh` -> `fork de Base au bloc 55836672 pret`
   and `evm/tokens.json`: USDC (healthy, already on Base), one healthy demo token and five trap tokens
   (`evm/src/DemoToken.sol`) with their Uniswap V2 pairs. Same addresses on every run.
6. **Sentinel tests.** `bun test app/verifier.test.ts` -> `7 pass`: USDC and the healthy token `allow`,
   the five traps `block`, each for its own reason.
7. **Run the attack demo.** `./demo.sh` (optional argument: a trap name from `evm/tokens.json`, default
   `sell_blocked_later`). The human arms the agent, the sentinel starts, the agent runs. You see (real
   output, simulated-call lines trimmed):

   ```text
   1. L'agent passe par son enveloppe : la sentinelle simule l'achat sur Base avant tout paiement.
     [enveloppe] demande #3 : verdict sur 0xaabfF6E27fdc021573753978741a5F88e01000C8, 0,01 NEAR debite du credit  https://testnet.nearblocks.io/txns/AzpB25WrFKGrdBsQF1qHkFZsp5YGS6eozDN7DityZS5C
       [sentinelle] #3 : BLOCK (vente 1 h apres l'achat refusee (TransferHelper: TRANSFER_FROM_FAILED)), bloc 55836696, preuve proofs/3.json  https://testnet.nearblocks.io/txns/CcW4MkwyHzX6rSPsT5ccaMwXQicMQLbYRUigJA7MwJsu
     [enveloppe] #3 : BLOCK, JE REFUSE DE SIGNER l'achat (vente 1 h apres l'achat refusee (TransferHelper: TRANSFER_FROM_FAILED))

   2. L'agent manipule contourne son enveloppe et signe lui-meme, avec sa cle function-call :
     [contrat] spend(#3) de 0,5 NEAR vers attacker.goblin-guard-00044.testnet : REFUSE (Contract panicked: verdict refuse l'achat)
     [contrat] spend(#3) de 0,02 NEAR vers la boutique permise : REFUSE (Contract panicked: verdict refuse l'achat)
     [protocole] virement direct de 0,01 NEAR vers attacker.goblin-guard-00044.testnet : REFUSE (Access key requires full access)

   3. Temoin : USDC, jeton sain deja sur Base. Meme chemin, verdict allow, l'achat est paye.
     [enveloppe] #4 : ALLOW, achat signe, 0.02 NEAR payes a shop.goblin-guard-00044.testnet  https://testnet.nearblocks.io/txns/EtmtAvwyiSAsij6R4qbJGPXTtpgSbDjUtALFTyWBkcWF

   4. L'agent manipule obtient un verdict allow, puis tente d'en tirer plus que son budget arme :
     [contrat] spend(#5) de 1 NEAR vers la boutique permise : REFUSE (Contract panicked: budget depasse)
   ```

   The script exits with code 1 if any trapped attempt goes through.

8. **Read the verdict on chain.**
   `near contract call-function as-read-only guard.<name>.testnet get_check json-args '{"id":3}' network-config testnet now`
   -> `"verdict": "block"` with its reasons. The full proof summary is in the `verdict_posted` event
   (`EVENT_JSON:` log, NEP-297) of the sentinel's transaction; the full simulation request and response
   are in `proofs/<id>.json`.
9. **Check the agent's keys.** `near account list-keys agent.<name>.testnet network-config testnet now`
   -> one full-access key (human's keychain) and one key that can `only do ["request_check", "spend",
"refund_check"] function calls on guard.<name>.testnet`.

The same verifier also runs against Base mainnet without a fork, for example on USDC:
`bun -e 'import { checkToken } from "./app/verifier"; console.log((await checkToken("https://mainnet.base.org", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).verdict)'` -> `allow`.

## Design choices

- The verdict is bound to the token (the request's `target`), not to the recipient or the amount, on
  purpose: the recipient has its own barrier (the human's allowlist) and the amount has its own (the armed
  budget). The `spent` event carries the target, so the paid venue knows which token it was paid to buy.
- A verdict fee stays in escrow until the verdict; the owner can only withdraw fees of delivered verdicts.
  A refund returns the credit but never the budget, so a re-armed budget cannot be exceeded.
- The contract refuses a price that does not cover the storage of a request.
- Each role runs in its own process with its own key file. The agent process never reads the sentinel key.

## Limits: what does not work yet

- The agent is scripted: it obeys the injected message the way a manipulated LLM would. No LLM yet.
- On testnet the purchase is a NEAR payment to an allowlisted account; the EVM purchase itself is not executed.
- `warn` stops the purchase like `block`; asking a human to approve a `warn` is not built.
- Uniswap V4 hook permissions (read from the low bits of the hook address) are not checked yet; the route is V2 only.
- The "creator" of a token is not probed, only `owner()` and a random stranger.
- No script yet to replay a proof from `proofs/<id>.json`; replay means re-sending that request to a node at the same block.
- The sentinel is a single trusted key on a regular machine; running the checks in an enclave (TEE) is planned, not built.
- In the demo all roles run under the same OS user; real separation needs separate users or machines.
- The guard account keeps a full-access key so that it can be redeployed during the hackathon.
- The 7-day spending cap and a dedicated "armer" role distinct from the human owner are not built.

## Disclosure

Written from 2026-11-11 for this hackathon, in a new repository. Our team has run trading agents with real
money on an EVM chain for two months; the method shown here comes from losses on these exact traps. No code
from that work is reused, and nothing about its strategies, wallets or accounts is published.
Libraries: near-sdk (Rust), near-api-js, viem, Foundry. Code written with AI assistance (Claude Code).

License: MIT.
