#!/usr/bin/env bash
# Copie locale de Base (anvil) au bloc FORK_BLOCK, avec nos jetons pieges et leurs paires Uniswap V2.
# Deterministe : deployeur neuf (nonce 0), meme bloc, donc memes adresses a chaque lancement.
# Ecrit evm/tokens.json, puis garde anvil au premier plan (Ctrl-C pour arreter).
set -euo pipefail
shopt -s inherit_errexit
cd "$(dirname "$0")"
FORK_URL=${FORK_URL:-https://mainnet.base.org} # sert l'etat ancien sans cle
FORK_BLOCK=${FORK_BLOCK:-55836672}
RPC=http://127.0.0.1:8545
ROUTER=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 # Uniswap V2 Router02 sur Base
DEPLOYER=0x60B1100000000000000000000000000000000001 # adresse sans cle, sans historique sur Base
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 # temoin sain, deja sur Base

if cast block-number -r $RPC >/dev/null 2>&1; then
  echo "le port 8545 sert deja un noeud : arrete-le d'abord" >&2
  exit 1
fi
anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK" --port 8545 --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT
until cast block-number -r $RPC >/dev/null 2>&1; do sleep 0.5; done
forge build --quiet

cast rpc -r $RPC anvil_setBalance $DEPLOYER 0x56BC75E2D63100000 >/dev/null # 100 ETH
cast rpc -r $RPC anvil_impersonateAccount $DEPLOYER >/dev/null
FACTORY=$(cast call $ROUTER 'factory()(address)' -r $RPC)
WETH=$(cast call $ROUTER 'WETH()(address)' -r $RPC)

deploy() { # nom symbole piege -> adresse du jeton, avec 5 ETH de liquidite face a 500 000 jetons
  local token pair
  token=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json \
    src/DemoToken.sol:DemoToken --constructor-args "$1" "$2" "$3" | jq -r .deployedTo)
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'approve(address,uint256)' $ROUTER 500000ether >/dev/null
  cast send -r $RPC --unlocked --from $DEPLOYER --value 5ether $ROUTER \
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' \
    "$token" 500000ether 0 0 $DEPLOYER 9999999999 >/dev/null
  pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$token" "$WETH" -r $RPC)
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'setPair(address)' "$pair" >/dev/null
  echo "$token"
}

SAFE=$(deploy "Demo Sain" SAIN 0)
RECLAIM=$(deploy "Demo Reprise" REPRISE 1)
BLOCKED=$(deploy "Demo Vente Fermee" FERME 2)
LATER=$(deploy "Demo Vente Fermee Plus Tard" PLUSTARD 3)
TAX=$(deploy "Demo Taxe 90" TAXE 4)
TAX_LATER=$(deploy "Demo Taxe 90 Plus Tard" TAXETARD 5)
HOLD=$(deploy "Demo Detention Un Bloc" DETENTION 6)
SIM=$(deploy "Demo Detecteur De Simulation" SIMU 7) # en dernier : les adresses precedentes ne changent pas

jq -n --arg usdc $USDC --arg safe "$SAFE" --arg reclaim "$RECLAIM" --arg blocked "$BLOCKED" \
  --arg later "$LATER" --arg tax "$TAX" --arg taxlater "$TAX_LATER" --arg hold "$HOLD" --arg sim "$SIM" --argjson block "$FORK_BLOCK" \
  '{fork_block: $block, usdc: $usdc, safe: $safe, owner_reclaim: $reclaim, sell_blocked: $blocked,
    sell_blocked_later: $later, sell_tax: $tax, sell_tax_later: $taxlater, hold_one_block: $hold, sim_detector: $sim}' > tokens.json
echo "fork de Base au bloc $FORK_BLOCK pret sur $RPC ; jetons dans evm/tokens.json :"
cat tokens.json
wait $ANVIL
