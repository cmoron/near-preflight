#!/usr/bin/env bash
# Demo de bout en bout, quatre roles dans quatre processus, chacun avec sa seule cle : l'armeur arme
# l'agent dans les bornes de l'humain, la sentinelle ecoute la garde, l'agent manipule tente un achat
# piege, puis l'humain coupe tout (arret d'urgence) et l'armeur ne peut plus rearmer avant le degel.
# Prerequis : evm/fork.sh tourne dans un autre terminal, bun app/setup.ts <parent>.testnet a ete lance.
# Code de sortie 1 si une tentative piegee passe ou si un refus attendu n'a pas la bonne raison.
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
refused "budget above the human's bound" "${ARMER[@]}" 0.2 900
"${ARMER[@]}" 0.06 900

bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
status=0
bun --env-file=.env --env-file=.env.agent app/demo.ts "$@" || status=$?
kill $SENTINEL
trap - EXIT # sinon le piege retue un processus deja recolte, et sous set -e son echec devient le code de sortie

echo
echo "5. Emergency stop by the human (own process, full-access key from the near-cli keychain):"
"${HUMAN[@]}" stop
refused "agent frozen by the owner" "${ARMER[@]}" 0.06 900
"${HUMAN[@]}" unfreeze
exit $status
