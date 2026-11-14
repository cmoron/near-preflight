#!/usr/bin/env bash
# One purchase that lands on a public chain, and one refusal, through a guard that signs for Base Sepolia:
#   1. the agent asks to buy the healthy token: the three sentinels simulate the buy and the resale on Base
#      Sepolia and vote, the guard builds the swap, NEAR signs it, the relay broadcasts it to Base Sepolia
#      (receipt status 1); then the agent's exit: exit quote, approve and swap signed, both broadcast;
#   2. the agent asks to buy the token whose sales revert: block, the guard signs nothing.
# Prerequisites: EVM_CHAIN_ID=84532 ENV_FILE=.env.sepolia bun app/setup.ts <parent>.testnet, then evm/sepolia.sh.
# FORK=1: the same against the throwaway fork FORK=1 evm/sepolia.sh keeps running (a dry run: NEAR signs
# for chain 84532, nothing reaches Base Sepolia).
# Usage: [FORK=1] [ENV_FILE=.env.sepolia] ./sepolia.sh [buy] [blocked]   (both when none is named)
# Exit code 0 only if the buy and the sale landed with status 1 and the trap was blocked and never signed.
set -euo pipefail
cd "$(dirname "$0")"
(($#)) || set -- buy blocked
E=${ENV_FILE:-.env.sepolia}
BUY_ETH=0.0000002 # 2 % of the pool's 0.00001 ETH: test ETH is scarce
LOGS=$(mktemp -d)
if [[ -n ${FORK:-} ]]; then
  TOKENS=proofs/base-sepolia.fork.json
  # One node holds the fork: every sentinel and the relay read it.
  RPC=http://127.0.0.1:8546 RPC_2=$RPC RPC_3=$RPC LOGS_RPC=$RPC
  # A check spaces its simulated blocks at the cadence of the last 100 (app/verifier.ts cadenceAt), and
  # anvil's eth_simulateV1 refuses two blocks with one timestamp, which Base Sepolia's five blocks a second
  # give: wait until the fork's own blocks, 2 s apart, fill most of them.
  echo "waiting for 100 blocks of the fork to span 100 s (about 3 min after it started)"
  until (($(cast block latest -r $RPC -f timestamp) - $(cast block $(($(cast block-number -r $RPC) - 100)) -r $RPC -f timestamp) >= 100)); do sleep 5; done
else
  TOKENS=evm/base-sepolia.json
  # Each sentinel simulates on its own provider. Only one public node serves the logs the template index
  # and the liquidity rule read (5,000 blocks a request): each sentinel ties it to its own node by block hash.
  RPC=https://sepolia.base.org
  RPC_2=${EVM_RPC_2:-https://base-sepolia-rpc.publicnode.com}
  RPC_3=${EVM_RPC_3:-https://rpc.sentio.xyz/base-sepolia}
  LOGS_RPC=${INDEX_RPC:-https://base-sepolia-rpc.publicnode.com}
fi
[[ -f $E && -f $TOKENS ]] || { echo "$E or $TOKENS missing: see the prerequisites at the top of this script" >&2; exit 1; }
HONEST=$(jq -r '.honest.token // empty' "$TOKENS")
TRAP=$(jq -r '.sell_blocked.token // empty' "$TOKENS")
for step in "$@"; do
  case $step in
    buy) [[ $HONEST ]] || { echo "no healthy token in $TOKENS: evm/sepolia.sh honest" >&2; exit 1; } ;;
    blocked) [[ $TRAP ]] || { echo "no sale-closed token in $TOKENS: evm/sepolia.sh sell_blocked" >&2; exit 1; } ;;
    *) echo "unknown step $step: buy or blocked" >&2; exit 1 ;;
  esac
done
export INDEX_RPC=$LOGS_RPC RPC_TIMEOUT_MS=60000
unset INDEX_FROM # the index window is the 2 h before each check's block
AGENT=(bun --env-file="$E" --env-file="$E.agent")
ARMER=(bun --env-file="$E" --env-file="$E.armer" app/arm.ts)
relay() { EVM_RPC=$RPC bun --env-file="$E" app/relay.ts "$@"; }

# Two checks, a buy and an exit quote: 0.1 NEAR of budget is enough (a check 0.025, the buy 0.0225).
"${ARMER[@]}" 0.3 900
SENTINELS=()
n=0
for rpc in "$RPC" "$RPC_2" "$RPC_3"; do
  n=$((n + 1))
  keys=$E.sentinel$([[ $n == 1 ]] || echo $n)
  EVM_RPC=$rpc bun --env-file="$E" --env-file="$keys" app/sentinel.ts >"$LOGS/sentinel$n.log" 2>&1 &
  SENTINELS+=($!)
done
# On every exit: each sentinel stops, by PID, with the throwaway anvil it may be tracing on (a sentinel
# stopped in the middle of a check would leave it running), and the agent is disarmed, so the guard signs
# no more buys.
stop() {
  for pid in "${SENTINELS[@]}"; do
    pkill -x anvil -P "$pid" || true
    kill "$pid" 2>/dev/null || true
  done
  "${ARMER[@]}" disarm || true
  echo "sentinel logs: $LOGS"
}
trap stop EXIT
for i in 1 2 3; do until grep -q "listening to" "$LOGS/sentinel$i.log"; do kill -0 "${SENTINELS[$((i - 1))]}" || { cat "$LOGS/sentinel$i.log"; exit 1; }; sleep 0.5; done; done

for step in "$@"; do
  echo
  if [[ $step == buy ]]; then
    echo "The agent buys $BUY_ETH ETH of the healthy token $HONEST: checked on Base Sepolia, signed by NEAR, broadcast."
    out=$(EVM_RPC=$RPC "${AGENT[@]}" app/buy.ts "$HONEST" $BUY_ETH) || { echo "$out"; exit 1; }
    echo "$out"
    id=$(sed -n 's/^#\([0-9]*\) signed by NEAR.*/\1/p' <<<"$out")
    relay "$id"
    out=$(EVM_RPC=$RPC "${AGENT[@]}" app/sell.ts "$id") || { echo "$out"; exit 1; }
    echo "$out"
    relay exit "$(sed -n 's/.*relay.ts exit \([0-9]*\).*/\1/p' <<<"$out")"
  else
    echo "The agent asks to buy $BUY_ETH ETH of $TRAP, whose sales revert: block, nothing signed."
    if out=$(EVM_RPC=$RPC "${AGENT[@]}" app/buy.ts "$TRAP" $BUY_ETH); then echo "$out"; echo "  !!! SIGNED, the guard failed"; exit 1; fi
    echo "$out"
    # Run again, the guard refuses the request itself: the block quarantined the token, then listed it.
    if grep -qE "target is (quarantined after a block verdict|on the shared blocklist)" <<<"$out"; then continue; fi
    grep -q "verdict=block" <<<"$out" || { echo "  !!! not bought, but not on a block verdict"; exit 1; }
    id=$(sed -n 's/^#\([0-9]*\) verdict=block.*/\1/p' <<<"$out")
    # One block vote refuses; listing the token for every agent takes two identical ones: wait for the
    # second, 90 s at most.
    for _ in $(seq 45); do
      (($(cat "$LOGS"/sentinel*.log | grep -c "#$id : BLOCK") >= 2)) && break
      sleep 2
    done
    signed=$(bun --env-file="$E" -e 'const { view } = await import("./app/near"); const c = await view("get_check", { id: Number(process.argv[1]) }); console.log(c.signed_tx === null && !c.settled ? "none" : "SIGNED")' "$id")
    echo "  [guard] check #$id: signed transaction $signed"
    [[ $signed == none ]]
  fi
  echo "Proofs of the votes on check #$id: proofs/$id.json (and .s2, .s3); replay one with"
  echo "  EVM_CHAIN_ID=84532 INDEX_RPC=$LOGS_RPC bun --env-file=$E app/replay.ts proofs/$id.json $RPC --check"
done
