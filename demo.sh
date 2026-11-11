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
refused "budget above the human's bound" "${ARMER[@]}" 0.2 900
"${ARMER[@]}" 0.08 900 # 3 verdicts a 0,01 NEAR + 2 achats a 0,0225 NEAR (valeur et gaz au plafond)

bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
status=0
bun --env-file=.env --env-file=.env.agent app/demo.ts "$@" || status=$?
kill $SENTINEL
trap - EXIT # sinon le piege retue un processus deja recolte, et sous set -e son echec devient le code de sortie

echo
echo "6. Emergency stop by the human (own process, full-access key from the near-cli keychain):"
"${HUMAN[@]}" stop
refused "agent frozen by the owner" "${ARMER[@]}" 0.08 900
"${HUMAN[@]}" unfreeze
exit $status
