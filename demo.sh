#!/usr/bin/env bash
# Demo de bout en bout, quatre roles dans quatre processus, chacun avec sa seule cle : l'armeur arme
# l'agent dans les bornes de l'humain, la sentinelle ecoute la garde, l'agent manipule tente un achat
# piege, l'achat sain est signe par NEAR et diffuse sur le fork par un relais sans cle, puis l'humain
# coupe tout (arret d'urgence) et l'armeur ne peut plus rearmer avant le degel.
# The sentinel consults a template index rebuilt here from the fork's logs; a second agent (.env.agent2)
# is refused a token the sentinel listed.
# Prerequis : evm/fork.sh tourne dans un autre terminal, bun app/setup.ts <parent>.testnet a ete lance.
# The agent's model runs on NEAR AI Cloud when .env.llm holds NEAR_AI_API_KEY (loaded by the agent's
# process only); without it the LLM step verifies a recorded decision package instead.
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
refused "budget above the human's bound" "${ARMER[@]}" 0.6 900
# LLM step: at most 3 checks of the trap + 1 check and 1 buy of USDC = 0.0825 NEAR; scripted agent:
# 7 verdicts at 0.015 NEAR (one an exit quote) + 3 buys at 0.0225 + 1 exit at 0.025 (gas of 2 tx at the
# cap) = 0.1975 NEAR; armed with some margin
"${ARMER[@]}" 0.4 900
# The second agent (step 7) asks for one check.
AGENT=$(sed -n 's/^AGENT=//p' .env.agent2) "${ARMER[@]}" 0.05 900
LLM=()
[[ -f .env.llm ]] && LLM=(--env-file=.env.llm)

# Template index the sentinel consults, rebuilt from the fork's own logs (same chain state, same sha256).
from=$(($(jq .fork_block evm/tokens.json) + 1))
bun app/index.ts http://127.0.0.1:8545 "$from" "$(cast block-number -r http://127.0.0.1:8545)" proofs/index-fork.json
INDEX=proofs/index-fork.json bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
status=0
# The agent's buy and sale wait for the MPC signature: allow 60 s per NEAR RPC call (20 s by default).
RPC_TIMEOUT_MS=60000 bun --env-file=.env --env-file=.env.agent "${LLM[@]}" app/demo.ts "$@" || status=$?
kill $SENTINEL
trap - EXIT # sinon le piege retue un processus deja recolte, et sous set -e son echec devient le code de sortie

echo
echo "8. Emergency stop by the human (own process, full-access key from the near-cli keychain):"
"${HUMAN[@]}" stop
refused "agent frozen by the owner" "${ARMER[@]}" 0.12 900
"${HUMAN[@]}" unfreeze

echo
echo "9. The human withdraws 0.00001 ETH from the guard's EVM address to the owner's address fixed at init:"
out=$("${HUMAN[@]}" withdraw 10000000000000)
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
bun --env-file=.env app/relay.ts exit "$(sed -n 's/.*relay.ts exit \([0-9]*\).*/\1/p' <<<"$out")" || status=1
exit $status
