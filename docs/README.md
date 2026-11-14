# near-preflight documentation

A map of the documentation. The [README](../README.md) is the two-minute version, and the
[site](https://cmoron.github.io/near-preflight/#demo) plays the demo video. You do not need to read
everything: start with the three pages below.

## Start here, 5 minutes

1. [Base Sepolia](base-sepolia.md): what can I check on a public chain? Swaps the guard had NEAR sign,
   mined on Base Sepolia, and a guard whose account holds no key: accounts, transactions, how to replay
   them.
2. [Architecture](architecture.md): how does it work? Which component talks to which, what each key can
   do, where state lives, and which file implements what.
3. [Threat model](threat-model.md): what does it stop, and what not? Every attack, the guard's exact
   answer and the test that shows it, what it does not stop, and what each review found.

## Reference

Open these when you need them. Each covers one part.

- [Glossary](glossary.md): a word (floor, probe, late sale, template, listed) is unclear.
- [Latency and fit](latency.md): how long a check takes, why, and whom it suits today (an agent that can
  wait tens of seconds before a buy, not a same-second sniper).
- [Launch corpus](corpus.md): the check's verdicts on 96 real Base launches against what happened to
  each pool in the next 24 h, and what that does and does not show.
- [Contract](contract.md): for calling the guard or auditing it: methods, roles and keys, rules,
  accounting, signing, recovery.
- [Sentinel](sentinel.md): what a check simulates and why a token gets its verdict.
- [Replay and attest](replay.md): check a verdict or a model decision yourself.
- [Agent guide](agent-guide.md): give this to your AI coding agent if you want your own guard on NEAR
  testnet and an agent that buys through it: setup, the contract calls in order, what it must never do.
- [Reproduce](reproduce.md): run the demo, fix a setup error, or check the deployed code.
- [Mainnet](mainnet.md): deploy the guard on NEAR mainnet as an inert, readable guard: dry run, deploy,
  verify, undo.
- [Site](https://cmoron.github.io/near-preflight/): the landing page ([`index.html`](index.html),
  [`landing.js`](landing.js)) and the [journal](https://cmoron.github.io/near-preflight/journal.html) of the
  demo guard's checks ([`journal.html`](journal.html), [`app.js`](app.js)), in this folder.
