#!/usr/bin/env bash
# Real check on Base mainnet: the armer arms, the sentinel simulates on mainnet, the agent asks
# for a verdict on USDC, then replay --check of the proof against mainnet.base.org.
# Prerequisite: bun app/setup.ts <parent>.testnet has been run. No need for evm/fork.sh.
# Exit code 0 if the replay matches the on-chain verdict.
set -euo pipefail
cd "$(dirname "$0")"
TOKEN=${1:-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913} # USDC on Base
RPC=https://mainnet.base.org

# The check states a buy of 0.00001 ETH: price 0.017 NEAR plus that buy at the gas cap must fit in the budget.
bun --env-file=.env --env-file=.env.armer app/arm.ts 0.05 600
EVM_RPC=$RPC bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL 2>/dev/null || true' EXIT
out=$(bun --env-file=.env --env-file=.env.agent app/check.ts "$TOKEN") || { echo "$out"; exit 1; }
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
proof=$(sed -n 's/.* proof=//p' <<<"$out")
bun --env-file=.env app/replay.ts "$proof" $RPC --check
