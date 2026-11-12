# near-preflight documentation

This is the top level of near-preflight's documentation. The [README](../README.md) is the two-minute
version; each page below covers one part and stays short. Read them in this order if you are new.

## Understand it

- [Architecture](architecture.md): read this if you want to know which component talks to which, what
  each key can do, where state lives, and which file implements what.
- [Glossary](glossary.md): read this if a word (floor, probe, late sale, template, listed) is unclear.

## Judge its security

- [Threat model](threat-model.md): read this if you want every attack, the guard's exact answer and the
  test that shows it, what it does not stop, and what each review found.

## Component manuals

- [Contract](contract.md): read this if you call the guard or audit it: methods, roles and keys, rules,
  accounting, signing, recovery.
- [Sentinel](sentinel.md): read this if you want to know what a check simulates and why a token gets its
  verdict.
- [Replay and attest](replay.md): read this if you want to check a verdict or a model decision yourself.

## Run it

- [Reproduce](reproduce.md): read this if you want to run the demo, fix a setup error, or check the
  deployed code.
- [Status page](https://cmoron.github.io/near-preflight/): the live journal of the demo guard (its source
  is [`index.html`](index.html) and [`app.js`](app.js) in this folder).

The former single page, [DETAILS.md](DETAILS.md), now points to these.
