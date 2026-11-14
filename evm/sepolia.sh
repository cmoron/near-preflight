#!/usr/bin/env bash
# Base Sepolia, a public testnet: deploys demo tokens of evm/src as they are (DemoToken: `honest`, the
# healthy one, and `sell_blocked`, the one whose sales revert), gives each a Uniswap V2 WETH pool whose
# LP is burned, and sends the guard's derived address the test ETH its signed transactions spend.
# Writes evm/base-sepolia.json: addresses and transaction hashes. A token already there is not deployed again.
# It signs with the test key in ~/.near-credentials/base-sepolia/deployer.key, never printed. Test ETH is
# scarce: every transaction is estimated first and sent only if the deployer can pay it.
# FORK=1: the same on a throwaway anvil fork of Base Sepolia, on port 8546, kept in the foreground
# (Ctrl-C to stop): no key is read (the deployer is impersonated, with the balance it has on Base Sepolia:
# a rehearsal of the budget), nothing is spent, and the addresses are the real run's (same deployer, same
# nonces). It writes proofs/base-sepolia.fork.json.
# Prerequisite: EVM_CHAIN_ID=84532 ENV_FILE=.env.sepolia bun app/setup.ts <parent>.testnet
# Usage: [FORK=1] [ENV_FILE=.env.sepolia] evm/sepolia.sh [honest] [sell_blocked]   (both when none is named)
set -euo pipefail
shopt -s inherit_errexit
cd "$(dirname "$0")"
ENV_FILE=${ENV_FILE:-.env.sepolia}
FORK=${FORK:-}
PUBLIC=${EVM_RPC:-https://sepolia.base.org}
ROUTER=0x1689E7B1F10000AE47eBfE339a4f69dECd19F602 # Uniswap V2 Router02 on Base Sepolia (SEPOLIA_ROUTER in src/lib.rs)
WETH=0x4200000000000000000000000000000000000006
DEPLOYER=0xb4dF3199B9b39Aa9Be1A26cAbacbE24d03FdEfD3 # the test key's address
KEY=$HOME/.near-credentials/base-sepolia/deployer.key
DEAD=0x000000000000000000000000000000000000dEaD
POOL_ETH=0.00001  # liquidity of each pool, against 500,000 tokens
# For the guard's address: each transaction NEAR signs must be covered at its gas cap (250,000 gas at
# 0.05 gwei: 0.0000125 ETH), an exit's two at once, though it then pays Base Sepolia's fee, ten times less.
GUARD_ETH=0.00004
GUARD_MIN=0.00003
# Fees of what this script sends: Base Sepolia's base fee is 0.005 gwei and its usual tip 0.001.
MAX_FEE=12000000
TIP=1000000
(($#)) || set -- honest sell_blocked

[[ -f ../$ENV_FILE ]] || { echo "../$ENV_FILE missing: run EVM_CHAIN_ID=84532 ENV_FILE=$ENV_FILE bun app/setup.ts <parent>.testnet first" >&2; exit 1; }
GUARD_EVM=$(cd .. && bun app/derive.ts "$(sed -n 's/^GUARD=//p' "$ENV_FILE")" evm-1)

if [[ -n $FORK ]]; then
  RPC=http://127.0.0.1:8546
  OUT=../proofs/base-sepolia.fork.json
  mkdir -p ../proofs
  if (: </dev/tcp/127.0.0.1/8546) 2>/dev/null; then echo "port 8546 already in use: stop what listens there first" >&2; exit 1; fi
  # As evm/fork.sh: block states stay in memory, the directory anvil would use is ours, removed on exit;
  # nothing of the upstream node is cached on disk. A block every 2 s, as Base Sepolia.
  STATES=$(mktemp -d)
  anvil --fork-url "$PUBLIC" --port 8546 --block-time 2 --silent --prune-history 2000 --no-storage-caching --cache-path "$STATES" &
  ANVIL=$!
  trap 'kill $ANVIL 2>/dev/null || true; wait $ANVIL 2>/dev/null || true; rm -rf -- "${STATES:?}"' EXIT
  until cast block-number -r $RPC >/dev/null 2>&1; do sleep 0.5; done
  cast rpc -r $RPC anvil_impersonateAccount $DEPLOYER >/dev/null
  SIGNER=(--unlocked --from $DEPLOYER)
  rm -f "$OUT" # a new fork holds none of the last one's tokens
else
  RPC=$PUBLIC
  OUT=base-sepolia.json
  [[ $(cast wallet address --private-key "$(cat "$KEY")") == "$DEPLOYER" ]] || { echo "$KEY is not the key of $DEPLOYER" >&2; exit 1; }
  SIGNER=(--private-key "$(cat "$KEY")")
fi
# Base Sepolia or its fork, nothing else: this script sends transactions.
[[ $(cast chain-id -r $RPC) == 84532 ]] || { echo "$RPC is not Base Sepolia (chain id 84532): nothing sent" >&2; exit 1; }
[[ $(cast call $ROUTER 'WETH()(address)' -r $RPC) == "$WETH" ]] || { echo "router $ROUTER: unexpected WETH()" >&2; exit 1; }
FACTORY=$(cast call $ROUTER 'factory()(address)' -r $RPC)
[[ -f $OUT ]] || jq -n --arg deployer $DEPLOYER --arg router $ROUTER --arg factory "$FACTORY" '{chain_id: 84532, deployer: $deployer, router: $router, factory: $factory}' >"$OUT"
forge build --quiet

afford() { # what gas [wei]: stops unless the deployer holds the gas at MAX_FEE and the value, twice the gas for margin
  local held need
  held=$(cast balance $DEPLOYER -r $RPC)
  need=$(jq -n --arg g "$2" --arg f $MAX_FEE --arg v "${3:-0}" '($g | tonumber) * ($f | tonumber) * 2 + ($v | tonumber)')
  echo "  $1: estimated $2 gas, $(cast from-wei "$(jq -n --arg g "$2" '($g | tonumber) * 6000000')") ETH at 0.006 gwei, plus $(cast from-wei "${3:-0}") ETH sent; the deployer holds $(cast from-wei "$held")" >&2
  [[ $(jq -n --arg h "$held" --arg n "$need" '($h | tonumber) >= ($n | tonumber)') == true ]] || { echo "the deployer cannot pay $1 with a margin: send $DEPLOYER test ETH on Base Sepolia, then run this again" >&2; exit 1; }
}

sent() { # label [--value wei] to [sig args...] -> transaction hash; estimated first, stops on a revert (cast send exits 0 on one)
  local label=$1 value=() wei=0 r
  shift
  if [[ $1 == --value ]]; then value=(--value "$2") wei=$2 && shift 2; fi
  afford "$label" "$(cast estimate -r $RPC --from $DEPLOYER "${value[@]}" "$@")" "$wei"
  r=$(cast send -r $RPC "${SIGNER[@]}" --gas-price $MAX_FEE --priority-gas-price $TIP --json "${value[@]}" "$@")
  [[ $(jq -r .status <<<"$r") == 0x1 ]] || { echo "reverted: $label ($(jq -r .transactionHash <<<"$r"))" >&2; exit 1; }
  jq -r .transactionHash <<<"$r"
}

deploy() { # name symbol trap -> JSON {token, pair, txs}: the token, POOL_ETH of liquidity against 500,000 tokens, LP burned
  local code made token pair lp txs
  code=$(jq -r .bytecode.object out/DemoToken.sol/DemoToken.json)$(cast abi-encode 'c(string,string,uint8,address)' "$1" "$2" "$3" 0x0000000000000000000000000000000000000000 | cut -c3-)
  afford "deploy $2" "$(cast estimate -r $RPC --from $DEPLOYER --create "$code")"
  made=$(forge create --rpc-url $RPC "${SIGNER[@]}" --gas-price $MAX_FEE --priority-gas-price $TIP --broadcast --json src/DemoToken.sol:DemoToken \
    --constructor-args "$1" "$2" "$3" 0x0000000000000000000000000000000000000000)
  token=$(jq -r .deployedTo <<<"$made")
  txs=$(jq -r .transactionHash <<<"$made")
  txs+=" $(sent "approve the router" "$token" 'approve(address,uint256)' $ROUTER 500000ether)"
  txs+=" $(sent "create and fund the pool" --value "$(cast to-wei $POOL_ETH)" $ROUTER 'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$token" 500000ether 0 0 $DEPLOYER 9999999999)"
  pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$token" $WETH -r $RPC)
  txs+=" $(sent "name the pool to the token" "$token" 'setPair(address)' "$pair")"
  # Nobody can pull the liquidity: the deployer's LP goes to 0xdead (as lp_burned in evm/fork.sh).
  lp=$(cast call "$pair" 'balanceOf(address)(uint256)' $DEPLOYER -r $RPC | cut -d' ' -f1)
  txs+=" $(sent "burn the LP" "$pair" 'transfer(address,uint256)' $DEAD "$lp")"
  jq -n --arg token "$token" --arg pair "$pair" --arg txs "$txs" '{token: $token, pair: $pair, txs: ($txs | split(" "))}'
}

for name in "$@"; do
  case $name in
    honest) args=("Demo Healthy" HEALTHY 0) ;;
    sell_blocked) args=("Demo Sale Closed" CLOSED 2) ;;
    *) echo "unknown token $name: honest or sell_blocked" >&2; exit 1 ;;
  esac
  if [[ $(jq -r --arg n "$name" '.[$n].token // empty' "$OUT") ]]; then echo "$name already in ${OUT#../}: not deployed again"; continue; fi
  made=$(deploy "${args[@]}")
  jq --arg n "$name" --argjson made "$made" '.[$n] = $made' "$OUT" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  echo "$name: $(jq -r .token <<<"$made"), pool $(jq -r .pair <<<"$made")"
done
# The guard's address pays the value and the gas of what NEAR signs for it: topped up to GUARD_ETH once
# it holds less than GUARD_MIN, never a second GUARD_ETH on top of what it has left.
held=$(cast balance "$GUARD_EVM" -r $RPC)
if [[ $(jq -n --arg h "$held" --arg n "$(cast to-wei $GUARD_MIN)" '($h | tonumber) < ($n | tonumber)') == true ]]; then
  tx=$(sent "fund the guard's address" --value "$(jq -n --arg h "$held" --arg n "$(cast to-wei $GUARD_ETH)" '($n | tonumber) - ($h | tonumber)')" "$GUARD_EVM")
  jq --arg guard "$GUARD_EVM" --arg tx "$tx" '.guard.address = $guard | .guard.funded_by += [$tx]' "$OUT" >"$OUT.tmp" && mv "$OUT.tmp" "$OUT"
fi
echo "Base Sepolia$([[ -n $FORK ]] && echo " fork on $RPC") ready: tokens $(jq -c '{honest: .honest.token, sell_blocked: .sell_blocked.token}' "$OUT"); the guard's address $GUARD_EVM holds $(cast from-wei "$(cast balance "$GUARD_EVM" -r $RPC)") ETH, the deployer $(cast from-wei "$(cast balance $DEPLOYER -r $RPC)"); written to ${OUT#../}"
if [[ -n $FORK ]]; then wait $ANVIL; fi
