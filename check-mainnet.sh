#!/usr/bin/env bash
# Real check on Base mainnet: the armer arms, both sentinels simulate on mainnet and build the template
# index over the 2 h before the check's block, the agent asks for a verdict on USDC, the armer disarms,
# then replay --check of the proof against mainnet.base.org.
# Read only on Base: nothing calls buy, and the agent is disarmed once the verdict is in, so the guard
# can sign no swap for it (buy needs an armed budget).
# Prerequisite: bun app/setup.ts <parent>.testnet has been run. No need for evm/fork.sh.
# Exit code 0 if the replay matches the on-chain verdict.
set -euo pipefail
cd "$(dirname "$0")"
TOKEN=${1:-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913} # USDC on Base
RPC=https://mainnet.base.org
# The index needs eth_getLogs, which mainnet.base.org refuses: it reads a node that serves them.
export INDEX_RPC=${INDEX_RPC:-https://base-rpc.publicnode.com}
unset INDEX_FROM # the window is the 2 h before each check's block, the same for both sentinels

# The check states a buy of 0.00001 ETH: its price plus that buy at the gas cap must fit in the budget.
bun --env-file=.env --env-file=.env.armer app/arm.ts 0.05 600
# Both sentinels (the guard's quorum); the second reads EVM_RPC_2 when it names another Base node.
EVM_RPC=$RPC bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINELS=($!)
if [[ -f .env.sentinel2 ]]; then
  EVM_RPC=${EVM_RPC_2:-$RPC} bun --env-file=.env --env-file=.env.sentinel2 app/sentinel.ts &
  SENTINELS+=($!)
fi
trap 'kill "${SENTINELS[@]}" 2>/dev/null || true' EXIT
status=0
out=$(bun --env-file=.env --env-file=.env.agent app/check.ts "$TOKEN") || status=$?
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
bun --env-file=.env --env-file=.env.armer app/arm.ts disarm
[[ $status == 0 ]] || exit 1
proof=$(sed -n 's/.* proof=//p' <<<"$out")
bun --env-file=.env app/replay.ts "$proof" $RPC --check
