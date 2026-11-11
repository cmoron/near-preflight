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
# The guard's derived EVM address is public: the guard-targeted trap freezes it. Derived from the
# guard account in ../.env (written by app/setup.ts), unless GUARD_EVM is given.
if [[ -z ${GUARD_EVM:-} ]]; then
  [[ -f ../.env ]] || { echo "../.env missing: run bun app/setup.ts <parent>.testnet first, or set GUARD_EVM" >&2; exit 1; }
  GUARD_EVM=$(cd .. && bun app/derive.ts "$(sed -n 's/^GUARD=//p' .env)" evm-1)
fi

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

deploy() { # name symbol trap [special address] -> token address, with 5 ETH of liquidity against 500,000 tokens
  local token pair
  token=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json \
    src/DemoToken.sol:DemoToken --constructor-args "$1" "$2" "$3" "${4:-0x0000000000000000000000000000000000000000}" | jq -r .deployedTo)
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
SIM=$(deploy "Demo Detecteur De Simulation" SIMU 7)
# Deployed after the others: the earlier addresses do not change.
FROZEN=$(deploy "Demo Frozen Guard" FROZEN 8 "$GUARD_EVM")
TAX20=$(deploy "Demo Tax 20" TAX20 9)

# Everything below is deployed after the tokens above, so their addresses do not change.
# A pair created with dust, whose deep liquidity comes 2000 blocks later: the pair contract is older
# than the liquidity window of app/verifier.ts (1800 blocks), its liquidity is not.
cast rpc -r $RPC anvil_setBalance $DEPLOYER 0x56BC75E2D63100000 >/dev/null # 100 ETH again
LATE=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json \
  src/DemoToken.sol:DemoToken --constructor-args "Demo Late Liquidity" LATE 0 0x0000000000000000000000000000000000000000 | jq -r .deployedTo)
cast send -r $RPC --unlocked --from $DEPLOYER "$LATE" 'approve(address,uint256)' $ROUTER 500000ether >/dev/null
cast send -r $RPC --unlocked --from $DEPLOYER --value 0.001ether $ROUTER \
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$LATE" 10ether 0 0 $DEPLOYER 9999999999 >/dev/null
cast send -r $RPC --unlocked --from $DEPLOYER "$LATE" 'setPair(address)' \
  "$(cast call $FACTORY 'getPair(address,address)(address)' "$LATE" "$WETH" -r $RPC)" >/dev/null
cast rpc -r $RPC anvil_mine 0x7d0 >/dev/null # 2000 empty blocks: every pool above is now older than the window
cast send -r $RPC --unlocked --from $DEPLOYER --value 20ether $ROUTER \
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$LATE" 499990ether 0 0 $DEPLOYER 9999999999 >/dev/null
# A young pool whose LP is burned (sent to 0xdead): nobody can pull it.
LP_BURNED=$(deploy "Demo LP Burned" LPBURNED 0)
pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$LP_BURNED" "$WETH" -r $RPC)
lp=$(cast call "$pair" 'balanceOf(address)(uint256)' $DEPLOYER -r $RPC | cut -d' ' -f1)
cast send -r $RPC --unlocked --from $DEPLOYER "$pair" 'transfer(address,uint256)' 0x000000000000000000000000000000000000dEaD "$lp" >/dev/null
# A young pool whose whole liquidity sits with one EOA, the deployer, who can remove it at any block.
LP_HELD=$(deploy "Demo LP Held" LPHELD 0)

# A farm (src/FarmToken.sol, no trap): five tokens of one template, each from a fresh creator who
# pulls all the liquidity 2 blocks after the pool is created; then a sixth, fresh, liquidity in place.
farm() { # creator name symbol drain|keep -> token address, 1 ETH of liquidity against 1,000,000 tokens
  local c=$1 token pair lp
  cast rpc -r $RPC anvil_setBalance "$c" 0x56BC75E2D63100000 >/dev/null
  cast rpc -r $RPC anvil_impersonateAccount "$c" >/dev/null
  token=$(forge create --rpc-url $RPC --unlocked --from "$c" --broadcast --json \
    src/FarmToken.sol:FarmToken --constructor-args "$2" "$3" | jq -r .deployedTo)
  cast send -r $RPC --unlocked --from "$c" "$token" 'approve(address,uint256)' $ROUTER 1000000ether >/dev/null
  cast send -r $RPC --unlocked --from "$c" --value 1ether $ROUTER \
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' \
    "$token" 1000000ether 0 0 "$c" 9999999999 >/dev/null
  if [[ $4 == drain ]]; then
    pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$token" "$WETH" -r $RPC)
    lp=$(cast call "$pair" 'balanceOf(address)(uint256)' "$c" -r $RPC | cut -d' ' -f1)
    cast send -r $RPC --unlocked --from "$c" "$pair" 'approve(address,uint256)' $ROUTER "$lp" >/dev/null
    cast send -r $RPC --unlocked --from "$c" $ROUTER \
      'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)' \
      "$token" "$lp" 0 0 "$c" 9999999999 >/dev/null
  fi
  echo "$token"
}
for i in 1 2 3 4 5; do farm 0xfa4300000000000000000000000000000000000$i "Farm $i" FARM$i drain >/dev/null; done
FARM_FRESH=$(farm 0xfa43000000000000000000000000000000000006 "Farm Fresh" FRESH keep)
# Deployed last, so every address above stays the same: a sale reverts with less than 500,000 gas
# left, while the guard signs with its gas limit (250,000 at setup).
GAS_HUNGRY=$(deploy "Demo Gas Hungry" GASHUNGRY 10)

jq -n --arg usdc $USDC --arg safe "$SAFE" --arg reclaim "$RECLAIM" --arg blocked "$BLOCKED" \
  --arg later "$LATER" --arg tax "$TAX" --arg taxlater "$TAX_LATER" --arg hold "$HOLD" --arg sim "$SIM" \
  --arg frozen "$FROZEN" --arg tax20 "$TAX20" --arg late "$LATE" --arg lpburned "$LP_BURNED" --arg lpheld "$LP_HELD" --arg fresh "$FARM_FRESH" --arg gashungry "$GAS_HUNGRY" --argjson block "$FORK_BLOCK" \
  '{fork_block: $block, usdc: $usdc, safe: $safe, owner_reclaim: $reclaim, sell_blocked: $blocked,
    sell_blocked_later: $later, sell_tax: $tax, sell_tax_later: $taxlater, hold_one_block: $hold, sim_detector: $sim,
    guard_frozen: $frozen, sell_tax_20: $tax20, late_liquidity: $late, lp_burned: $lpburned, lp_held: $lpheld,
    farm_fresh: $fresh, gas_hungry: $gashungry}' > tokens.json
echo "guard_frozen freezes $GUARD_EVM"
echo "fork de Base au bloc $FORK_BLOCK pret sur $RPC ; jetons dans evm/tokens.json :"
cat tokens.json
wait $ANVIL
