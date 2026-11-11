#!/usr/bin/env bash
# End-to-end demo, each role in its own process with its own key: the armer arms the agent within the
# human's bounds, the sentinel listens to the guard, the agent (app/demo.ts) goes through four moments:
# a poisoned message and its trap, a farm token, a healthy buy signed by NEAR, the agent's bypasses.
# --full adds the armer's bounds, the agent's exit, a warn approved by the human, a trap aimed at the
# guard's address, a second agent, the live injection count (with the key), the emergency stop and the
# owner's withdrawal. The commands that verify the run are printed last.
# Prerequisites: bun app/setup.ts <parent>.testnet, then evm/fork.sh running in another terminal.
# The agent's model runs on NEAR AI Cloud when .env.llm holds NEAR_AI_API_KEY (loaded by the agent's
# process only); without it, moment 1 verifies a recorded decision package instead.
# Exit code 1 if a trapped attempt goes through, a refusal has another reason, or a healthy purchase is
# not executed on the fork.
set -euo pipefail
cd "$(dirname "$0")"
FULL=
[[ ${1:-} == --full ]] && FULL=--full
ARMER=(bun --env-file=.env --env-file=.env.armer app/arm.ts)
HUMAN=(bun --env-file=.env app/human.ts)

# Attempt that must be refused by the contract for the given reason; otherwise the demo fails.
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
[[ $FULL ]] && refused "budget above the human's bound" "${ARMER[@]}" 0.6 900
# Default run: 4 checks and 2 buys (0.105 NEAR), with the model up to 2 more checks; --full: about
# 0.3 NEAR (exit, warn, second trap, the model's runs and buy). Armed with some margin.
"${ARMER[@]}" 0.4 900
# The second agent (--full) asks for one check.
[[ $FULL ]] && AGENT=$(sed -n 's/^AGENT=//p' .env.agent2) "${ARMER[@]}" 0.05 900
LLM=()
[[ -f .env.llm ]] && LLM=(--env-file=.env.llm)

# Template index the sentinel consults, rebuilt from the fork's own logs (same chain state, same sha256).
from=$(($(jq .fork_block evm/tokens.json) + 1))
bun app/index.ts http://127.0.0.1:8545 "$from" "$(cast block-number -r http://127.0.0.1:8545)" proofs/index-fork.json
INDEX=proofs/index-fork.json bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL' EXIT
status=0
rm -f proofs/verify.txt
# The agent's buy and sale wait for the MPC signature: allow 60 s per NEAR RPC call (20 s by default).
RPC_TIMEOUT_MS=60000 bun --env-file=.env --env-file=.env.agent "${LLM[@]}" app/demo.ts $FULL || status=$?
kill $SENTINEL
trap - EXIT # otherwise the trap kills an already reaped process, and under set -e its failure becomes the exit code

if [[ $FULL ]]; then
  echo
  echo "11. Emergency stop by the human (own process, full-access key from the near-cli keychain):"
  "${HUMAN[@]}" stop
  refused "agent frozen by the owner" "${ARMER[@]}" 0.12 900
  "${HUMAN[@]}" unfreeze

  echo
  echo "12. The human withdraws 0.00001 ETH from the guard's EVM address to the owner's address fixed at init:"
  out=$("${HUMAN[@]}" withdraw 10000000000000)
  echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
  bun --env-file=.env app/relay.ts exit "$(sed -n 's/.*relay.ts exit \([0-9]*\).*/\1/p' <<<"$out")" || status=1
fi
echo
cat proofs/verify.txt 2>/dev/null || status=1
exit $status
