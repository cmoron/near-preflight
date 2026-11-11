#!/usr/bin/env bash
# Demo de bout en bout, trois roles dans trois processus, chacun avec sa seule cle :
# l'humain arme l'agent, la sentinelle ecoute la garde, l'agent manipule tente un achat piege.
# Prerequis : evm/fork.sh tourne dans un autre terminal, bun app/setup.ts <parent>.testnet a ete lance.
set -euo pipefail
cd "$(dirname "$0")"
bun --env-file=.env app/arm.ts 0.06 900
bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
bun --env-file=.env --env-file=.env.agent app/demo.ts "$@"
