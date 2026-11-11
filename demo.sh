#!/usr/bin/env bash
# Demo de bout en bout, quatre roles dans quatre processus, chacun avec sa seule cle : l'armeur arme
# l'agent dans les bornes de l'humain, la sentinelle ecoute la garde, l'agent manipule tente un achat
# piege, l'achat sain est signe par NEAR et diffuse sur le fork par un relais sans cle, puis l'humain
# coupe tout (arret d'urgence) et l'armeur ne peut plus rearmer avant le degel.
# Prerequis : evm/fork.sh tourne dans un autre terminal, bun app/setup.ts <parent>.testnet a ete lance.
# Code de sortie 1 si une tentative piegee passe, si un refus attendu n'a pas la bonne raison ou si un
# achat sain n'est pas execute sur le fork.
set -euo pipefail
cd "$(dirname "$0")"
ARMER=(bun --env-file=.env --env-file=.env.armer app/arm.ts)
HUMAN=(bun --env-file=.env app/human.ts)

# Tentative qui doit etre refusee par le contrat pour la raison donnee ; sinon la demo echoue.
refused() {
  local want=$1 out
  shift
  if out=$("$@" 2>&1); then
    echo "$out"
    echo "  !!! ACCEPTED, the guard failed"
    exit 1
  fi
  echo "$out"
  grep -qF "$want" <<<"$out" || {
    echo "  !!! refused, but not because: $want"
    exit 1
  }
}

echo "0. The armer (own process, function-call key limited to arm/disarm) arms the agent within the human's bounds."
refused "budget above the human's bound" "${ARMER[@]}" 0.3 900
"${ARMER[@]}" 0.12 900 # 5 verdicts at 0.01 NEAR + 3 buys at 0.0225 NEAR (value and gas at the cap); the exit needs no budget

bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
status=0
bun --env-file=.env --env-file=.env.agent app/demo.ts "$@" || status=$?
kill $SENTINEL
trap - EXIT # sinon le piege retue un processus deja recolte, et sous set -e son echec devient le code de sortie

echo
echo "7. Emergency stop by the human (own process, full-access key from the near-cli keychain):"
"${HUMAN[@]}" stop
refused "agent frozen by the owner" "${ARMER[@]}" 0.12 900
"${HUMAN[@]}" unfreeze

echo
echo "8. The human withdraws 0.00001 ETH from the guard's EVM address to the owner's address fixed at init:"
out=$("${HUMAN[@]}" withdraw 10000000000000)
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
bun --env-file=.env app/relay.ts exit "$(sed -n 's/.*relay.ts exit \([0-9]*\).*/\1/p' <<<"$out")" || status=1
exit $status
