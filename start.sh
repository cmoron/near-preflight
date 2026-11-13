#!/usr/bin/env bash
# Starts what an agent's buys through the guard need on this machine, as demo.sh does: the local Base fork
# (evm/fork.sh), its block miner and the sentinels. Prints one ready line, with the log files, once each
# sentinel listens, then stays in the foreground; Ctrl-C or TERM stops every process it started, by its PID,
# and deletes the logs. A process that stops on its own stops the others and leaves the logs, as evidence.
# Prerequisites: bun app/setup.ts <parent>.testnet. demo.sh starts its own miner and sentinels on a fork
# alone: stop this first, then run evm/fork.sh.
set -euo pipefail
cd "$(dirname "$0")"
# fork.sh refuses a port serving a node; this refuses any listener, before anything starts.
if (: </dev/tcp/127.0.0.1/8545) 2>/dev/null; then
  echo "port 8545 already in use: stop what listens there first" >&2
  exit 1
fi
LOGS=$(mktemp -d)
PIDS=()
STOPPED= # set by Ctrl-C or TERM
# On every exit: stops each process started here and waits for it (fork.sh stops its anvil on the way out),
# then deletes the logs on a stop asked for.
trap 'kill "${PIDS[@]}" 2>/dev/null || true; wait "${PIDS[@]}" 2>/dev/null || true; if [[ -n $STOPPED ]]; then rm -rf -- "$LOGS"; fi' EXIT
trap 'STOPPED=1; exit 130' INT
trap 'STOPPED=1; exit 143' TERM

logged() { # log text: waits until the log holds the text; stops everything if a process started here exits first
  echo "waiting for \"$2\" in $1"
  until grep -qF "$2" "$1"; do
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null || { echo "a process stopped before \"$2\" in $1 (logs kept in $LOGS); its last lines:" >&2; tail -n 20 "$1" >&2; exit 1; }
    done
    sleep 0.5
  done
}

evm/fork.sh >"$LOGS/fork.log" 2>&1 &
PIDS+=($!)
logged "$LOGS/fork.log" "ready on http://127.0.0.1:8545"

# As demo.sh: 60 s per RPC call, a block a second, the template index from the fork's first block.
export RPC_TIMEOUT_MS=60000
bun app/testkit.ts live >"$LOGS/miner.log" 2>&1 &
PIDS+=($!)
export INDEX_FROM=$(($(jq .fork_block evm/tokens.json) + 1))
unset INDEX_RPC
SENTINELS=()
for keys in .env.sentinel .env.sentinel2 .env.sentinel3; do
  [[ -f $keys ]] || continue
  log=$LOGS/${keys#.env.}.log
  bun --env-file=.env --env-file=$keys app/sentinel.ts >"$log" 2>&1 &
  PIDS+=($!)
  SENTINELS+=("$log")
done
for log in "${SENTINELS[@]}"; do logged "$log" "listening to"; done

echo "ready: fork on http://127.0.0.1:8545, a block a second, ${#SENTINELS[@]} sentinels listening; logs: $LOGS/fork.log $LOGS/miner.log ${SENTINELS[*]}; Ctrl-C stops them all and deletes the logs"
wait -n || true
echo "a process started here stopped on its own: stopping the others; logs kept in $LOGS" >&2
exit 1
