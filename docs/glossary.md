# Glossary

One line per term, in alphabetical order. Links go to the page that explains it.

| Term                   | Meaning                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **agent**              | the AI model and its wrapper; it holds a NEAR key limited to five guard methods, and no Base key                           |
| **allow, warn, block** | the three verdicts: buy, buy once the owner approves, never buy                                                            |
| **allow-list**         | what the token's own code may do on the guard's transactions for an `allow`: call its implementation and the precompiles, run no TIMESTAMP, NUMBER or SELFBALANCE, create no contract ([sentinel](sentinel.md#environment-rule)) |
| **anvil**              | Foundry's local EVM node; here a copy (fork) of Base, never the real chain                                                 |
| **armed budget**       | what an agent may spend before a deadline, opened by the armer within the owner's bounds                                   |
| **armer**              | the role that arms an agent; a key apart from the agent's ([contract](contract.md#roles-and-keys))                         |
| **Chain Signatures**   | NEAR's threshold signing network (the MPC): it signs Base transactions for a NEAR account's derived address                |
| **cadence**            | Base's blocks per second, measured at a check's reference block from timestamps: turns the rules' seconds into blocks ([sentinel](sentinel.md#bases-cadence)) |
| **check**              | one request for a verdict on buying an amount of a token; it costs 0.025 NEAR on the demo guard                            |
| **credit**             | NEAR an account prepaid to the guard; checks and gas are paid from it                                                      |
| **decision package**   | one model completion, its signature and its TEE attestation ([attest](replay.md#the-attested-agent))                       |
| **derived address**    | the guard's Base address, derived by Chain Signatures from its NEAR account and the path `evm-1`                           |
| **drained**            | a pool whose liquidity was pulled: 90 % of the LP ever minted burned after funding                                         |
| **environment rule**   | a token whose transfers read what a simulation cannot reproduce is not allowed ([sentinel](sentinel.md#environment-rule))  |
| **escrow**             | NEAR the guard holds for nobody yet: checks awaiting a verdict, signatures in progress                                     |
| **evidence**           | the facts a verdict rests on, posted with it; the guard stores its sha256                                                  |
| **exit quote**         | the sentinel's simulation of an agent's sale; it sets the sale's floor                                                     |
| **far sale**           | the late sale again, 301 s and 900 s after the buy and at a delay drawn between, on a local fork whose clock moves ([sentinel](sentinel.md#the-far-sale)) |
| **farm**               | someone who launches copies of one code, funds each pool, then pulls the liquidity                                         |
| **first sale**         | the check's first simulated sale: 2 to 25 s after the buy, 13 % to 87 % of the tokens                                      |
| **footprint**          | the slots whose value the buy changed, carried through others' trades of the pool re-executed after it ([sentinel](sentinel.md#others-trades-during-the-wait)) |
| **floor**              | a swap's minimum output: the sentinel's quote minus 3 %, set by the guard, never by the agent                              |
| **fork**               | a local copy of Base at a fixed block (`evm/fork.sh`), with the trap tokens deployed on it                                 |
| **funded**             | a pool whose providers added at least 0.5 ETH of WETH, net of removals                                                     |
| **guard**              | the NEAR contract that holds the rules, the money and the verdicts, and builds every Base transaction                      |
| **holding**            | tokens at the guard's address that one agent may sell                                                                      |
| **index**              | the list of Uniswap V2 WETH pools by code template over a block window ([sentinel](sentinel.md#template-reputation))       |
| **horizon**            | how far past the buy a check sells: `eth_simulateV1` reaches 256 blocks (51 s on Base), the far sales 900 s |
| **index window**       | the blocks an index covers: from at least 2 h before the check's block to that block                                       |
| **late sale**          | the check's last `eth_simulateV1` sale, of the rest: 30 to 51 s after the buy                                              |
| **later side**         | the guard's sales again on a real block 16 to 24 s after the reference block, the buy's footprint set ([sentinel](sentinel.md#the-four-requests)) |
| **listed**             | on the guard's shared blocklist: refused to every agent until the owner unlists it                                         |
| **MPC**                | multi-party computation: Chain Signatures' nodes sign together, none holds the whole key                                   |
| **owner**              | the human named at init: bounds, roles, emergency stop, approvals, recovery                                                |
| **per-token cap**      | the most all agents together may buy of one token per rolling period, set by the owner ([contract](contract.md#token-limits)) |
| **probe**              | a fresh address derived per check, from which the sentinel repeats the buy and sales                                       |
| **proof file**         | `proofs/<id>.json`: the requests, the responses and the evidence of one check ([replay](replay.md#the-proof-file))         |
| **quarantine**         | after a `block`, the token can be neither checked nor bought for the owner's period (30 min by default) |
| **quorum**             | how many sentinels must post the same `allow` or `warn` for it to count; any one blocks ([contract](contract.md#sentinel-quorum)) |
| **reference block**    | the first Base block at least 4 s after a check's request on NEAR: the check simulates on it                               |
| **relay**              | a program with no key that broadcasts a transaction NEAR signed; here only to anvil                                        |
| **replay**             | `app/replay.ts`: re-derives a verdict from its proof file and a Base node                                                  |
| **sentinel**           | an off-chain program that simulates each check and posts its vote, with a key limited to that; the demo guard has two      |
| **takeback**           | a `transferFrom` of a buyer's tokens without approval, by `owner()` or a stranger                                          |
| **TEE**                | trusted execution environment: hardware that attests which code runs (Intel TDX here)                                      |
| **template**           | a token's code with metadata and `PUSH32` operands masked: copies share it                                                 |
| **verdict**            | the sentinels' answer to a check, set once their votes decide; it buys only within 120 s                                   |
| **vote**               | one sentinel's verdict on a check, stored with the sha256 of its evidence                                                  |
