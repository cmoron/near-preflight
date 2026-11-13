# near-preflight documentation

This is the top level of near-preflight's documentation. The [README](../README.md) is the two-minute
version; each page below covers one part. Read them in this order if you are new.

## Understand it

- [Architecture](architecture.md): read this if you want to know which component talks to which, what
  each key can do, where state lives, and which file implements what.
- [Glossary](glossary.md): read this if a word (floor, probe, late sale, template, listed) is unclear.
- [Latency and fit](latency.md): read this if you ask how long a check takes, why, and whom it suits
  today (an agent that can wait tens of seconds before a buy, not a same-second sniper).

## Judge its security

- [Threat model](threat-model.md): read this if you want every attack, the guard's exact answer and the
  test that shows it, what it does not stop, and what each review found.

- [Launch corpus](corpus.md): read this if you want the check's verdicts on 96 real Base launches
  against what happened to each pool in the next 24 h, and what that does and does not show.

## Component manuals

- [Contract](contract.md): read this if you call the guard or audit it: methods, roles and keys, rules,
  accounting, signing, recovery.
- [Sentinel](sentinel.md): read this if you want to know what a check simulates and why a token gets its
  verdict.
- [Replay and attest](replay.md): read this if you want to check a verdict or a model decision yourself.

## Run it

- [Agent guide](agent-guide.md): give this to your AI coding agent if you want your own guard on NEAR
  testnet and an agent that buys through it: setup, the contract calls in order, what it must never do.
- [Reproduce](reproduce.md): read this if you want to run the demo, fix a setup error, or check the
  deployed code.
- [Mainnet](mainnet.md): read this if you deploy the guard on NEAR mainnet as an inert, readable guard:
  dry run, deploy, verify, undo.
- [Site](https://cmoron.github.io/near-preflight/): the landing page ([`index.html`](index.html),
  [`landing.js`](landing.js)) and the [journal](https://cmoron.github.io/near-preflight/journal.html) of the
  demo guard's checks ([`journal.html`](journal.html), [`app.js`](app.js)), in this folder.
