#!/usr/bin/env bash
# Real check on Base mainnet: the armer arms, the three sentinels simulate on mainnet, each on its own nodes,
# and build the template index over the 2 h before the check's block, the agent asks for a verdict on
# USDC, the armer disarms, then replay --check of the first vote's proof against mainnet.base.org.
# Read only on Base: nothing calls buy, and the agent is disarmed once the verdict is in, so the guard
# can sign no swap for it (buy needs an armed budget).
# Prerequisite: bun app/setup.ts <parent>.testnet has been run. No need for evm/fork.sh.
# Exit code 0 if the replay matches the on-chain verdict.
set -euo pipefail
cd "$(dirname "$0")"
TOKEN=${1:-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913} # USDC on Base
# Each sentinel reads its own Base nodes, of providers no other sentinel reads: one for the simulation
# (EVM_RPC), one for the logs (INDEX_RPC: the index, its own pool, LP holders), which mainnet.base.org
# refuses. A node that lies or lags is then one sentinel's, and an allow takes two. Each logs node is tied
# to its sentinel's simulation node by block hash at every check (app/verifier.ts sameChain). The second
# and the third read one provider for both: base.drpc.org, blockpi and thirdweb answered the trace's
# anvil with 429. Four providers in all.
RPC=https://mainnet.base.org
export INDEX_RPC=${INDEX_RPC:-https://base.public.blockpi.network/v1/rpc/public}
RPC_2=${EVM_RPC_2:-https://base-rpc.publicnode.com}
INDEX_RPC_2=${INDEX_RPC_2:-$RPC_2}
RPC_3=${EVM_RPC_3:-https://base.rpc.blxrbdn.com}
INDEX_RPC_3=${INDEX_RPC_3:-$RPC_3}
unset INDEX_FROM # the window is the 2 h before each check's block, the same for every sentinel

# The check states a buy of 0.00001 ETH: its price plus that buy at the gas cap must fit in the budget.
bun --env-file=.env --env-file=.env.armer app/arm.ts 0.05 600
# The guard's sentinels, each on its own nodes.
EVM_RPC=$RPC bun --env-file=.env --env-file=.env.sentinel app/sentinel.ts &
SENTINELS=($!)
if [[ -f .env.sentinel2 ]]; then
  EVM_RPC=$RPC_2 INDEX_RPC=$INDEX_RPC_2 bun --env-file=.env --env-file=.env.sentinel2 app/sentinel.ts &
  SENTINELS+=($!)
fi
if [[ -f .env.sentinel3 ]]; then
  EVM_RPC=$RPC_3 INDEX_RPC=$INDEX_RPC_3 bun --env-file=.env --env-file=.env.sentinel3 app/sentinel.ts &
  SENTINELS+=($!)
fi
trap 'kill "${SENTINELS[@]}" 2>/dev/null || true' EXIT
status=0
out=$(bun --env-file=.env --env-file=.env.agent app/check.ts "$TOKEN") || status=$?
echo "$out" # not tee /dev/stderr: reopening it truncates a log file the output is redirected to
bun --env-file=.env --env-file=.env.armer app/arm.ts disarm
[[ $status == 0 ]] || exit 1
# The proofs of the votes the guard took, in the order posted: two for an allow or a warn (the third
# sentinel's same vote is not needed, and not taken), up to three for a block.
read -ra proofs <<<"$(sed -n 's/.* proof=//p' <<<"$out")"
# Each sentinel's proof names the nodes it read; the same evidence sha256 is the same vote, byte for byte.
for f in "${proofs[@]}"; do
  echo "$f: simulated on $(jq -r .nodes.simulation "$f"), logs from $(jq -r .nodes.logs "$f"), evidence sha256 $(jq -j .evidence "$f" | sha256sum | cut -c1-64)"
done
# Replayed on the first sentinel's nodes, whichever sentinel's vote the file is: a proof holds on any honest node.
bun --env-file=.env app/replay.ts "${proofs[0]}" $RPC --check
