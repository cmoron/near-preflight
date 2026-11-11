#!/usr/bin/env bash
# Controle reel sur Base mainnet : l'armeur arme, la sentinelle simule sur mainnet, l'agent demande
# un verdict sur USDC, puis replay --check de la preuve contre mainnet.base.org.
# Prerequis : bun app/setup.ts <parent>.testnet a ete lance. Pas besoin de evm/fork.sh.
# Code de sortie 0 si le replay concorde avec le verdict en chaine.
set -euo pipefail
cd "$(dirname "$0")"
TOKEN=${1:-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913} # USDC sur Base
RPC=https://mainnet.base.org

bun --env-file=.env --env-file=.env.armer app/arm.ts 0.03 600
EVM_RPC=$RPC bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINEL=$!
trap 'kill $SENTINEL 2>/dev/null || true' EXIT
out=$(bun --env-file=.env --env-file=.env.agent app/check.ts "$TOKEN")
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
proof=$(sed -n 's/.* proof=//p' <<<"$out")
bun --env-file=.env app/replay.ts "$proof" $RPC --check
