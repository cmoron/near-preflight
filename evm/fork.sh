#!/usr/bin/env bash
# Local copy of Base (anvil) at block FORK_BLOCK, with our trap tokens and their Uniswap V2 pairs.
# Deterministic: fresh deployer (nonce 0), same block, hence the same addresses on every run.
# Writes evm/tokens.json (and its copy docs/tokens.json, the status page's token names), then keeps
# anvil in the foreground (Ctrl-C to stop).
set -euo pipefail
shopt -s inherit_errexit
cd "$(dirname "$0")"
FORK_URL=${FORK_URL:-https://mainnet.base.org} # serves old state without a key
FORK_BLOCK=${FORK_BLOCK:-55836672}
RPC=http://127.0.0.1:8545
ROUTER=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 # Uniswap V2 Router02 on Base
DEPLOYER=0x60B1100000000000000000000000000000000001 # address without a key, without history on Base
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 # healthy witness, already on Base
# The guard's derived EVM address is public: the guard-targeted trap freezes it. Derived from the
# guard account in ../.env (written by app/setup.ts), unless GUARD_EVM is given.
if [[ -z ${GUARD_EVM:-} ]]; then
  [[ -f ../.env ]] || { echo "../.env missing: run bun app/setup.ts <parent>.testnet first, or set GUARD_EVM" >&2; exit 1; }
  GUARD_EVM=$(cd .. && bun app/derive.ts "$(sed -n 's/^GUARD=//p' .env)" evm-1)
fi

if cast block-number -r $RPC >/dev/null 2>&1; then
  echo "port 8545 already serves a node: stop it first" >&2
  exit 1
fi
# anvil writes older block states to disk, 10 GB and more a run, and leaves them behind when stopped. Here
# they stay in memory (--prune-history: the last 2,000, more than the fork ever holds), the directory it
# would use is this script's own, removed on exit, and the leftovers of anvils no longer running go first.
if ! pgrep -x anvil >/dev/null; then rm -rf -- "${HOME:?}"/.foundry/anvil/tmp/anvil-state-*; fi
STATES=$(mktemp -d)
anvil --fork-url "$FORK_URL" --fork-block-number "$FORK_BLOCK" --port 8545 --silent --prune-history 2000 --cache-path "$STATES" &
ANVIL=$!
# `|| true`: under set -e a failing command ends the trap, and kill fails once anvil has already exited.
trap 'kill $ANVIL 2>/dev/null || true; wait $ANVIL 2>/dev/null || true; rm -rf -- "${STATES:?}"' EXIT
until cast block-number -r $RPC >/dev/null 2>&1; do sleep 0.5; done
forge build --quiet

cast rpc -r $RPC anvil_setBalance $DEPLOYER 0x56BC75E2D63100000 >/dev/null # 100 ETH
cast rpc -r $RPC anvil_impersonateAccount $DEPLOYER >/dev/null
FACTORY=$(cast call $ROUTER 'factory()(address)' -r $RPC)
WETH=$(cast call $ROUTER 'WETH()(address)' -r $RPC)

deploy() { # name symbol trap [special address] -> token address, with 5 ETH of liquidity against 500,000 tokens
  local token pair
  token=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json \
    "${CONTRACT:-src/DemoToken.sol:DemoToken}" --constructor-args "$1" "$2" "$3" "${4:-0x0000000000000000000000000000000000000000}" | jq -r .deployedTo)
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'approve(address,uint256)' $ROUTER 500000ether >/dev/null
  cast send -r $RPC --unlocked --from $DEPLOYER --value 5ether $ROUTER \
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' \
    "$token" 500000ether 0 0 $DEPLOYER 9999999999 >/dev/null
  pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$token" "$WETH" -r $RPC)
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'setPair(address)' "$pair" >/dev/null
  echo "$token"
}

SAFE=$(deploy "Demo Healthy" HEALTHY 0)
RECLAIM=$(deploy "Demo Takeback" TAKEBACK 1)
BLOCKED=$(deploy "Demo Sale Closed" CLOSED 2)
LATER=$(deploy "Demo Sale Closed Later" CLOSEDLATER 3)
TAX=$(deploy "Demo Tax 90" TAX90 4)
TAX_LATER=$(deploy "Demo Tax 90 Later" TAX90LATER 5)
HOLD=$(deploy "Demo Hold One Block" HOLDONE 6)
# Its own contract (src/SimToken.sol), same arguments and address: the other demo tokens' code reads no fee field.
SIM=$(CONTRACT=src/SimToken.sol:SimToken deploy "Demo Simulation Detector" SIMDETECT 7)
# Deployed after the others: the earlier addresses do not change.
FROZEN=$(deploy "Demo Frozen Guard" FROZEN 8 "$GUARD_EVM")
TAX20=$(deploy "Demo Tax 20" TAX20 9)

# Everything below is deployed after the tokens above, so their addresses do not change.
# A pair created with dust, whose deep liquidity comes 10 blocks and 2.2 h later: the pair contract is
# older than the liquidity window of app/verifier.ts (1 h), its liquidity is not.
cast rpc -r $RPC anvil_setBalance $DEPLOYER 0x56BC75E2D63100000 >/dev/null # 100 ETH again
LATE=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json \
  src/DemoToken.sol:DemoToken --constructor-args "Demo Late Liquidity" LATE 0 0x0000000000000000000000000000000000000000 | jq -r .deployedTo)
cast send -r $RPC --unlocked --from $DEPLOYER "$LATE" 'approve(address,uint256)' $ROUTER 500000ether >/dev/null
cast send -r $RPC --unlocked --from $DEPLOYER --value 0.001ether $ROUTER \
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$LATE" 10ether 0 0 $DEPLOYER 9999999999 >/dev/null
cast send -r $RPC --unlocked --from $DEPLOYER "$LATE" 'setPair(address)' \
  "$(cast call $FACTORY 'getPair(address,address)(address)' "$LATE" "$WETH" -r $RPC)" >/dev/null
# 10 empty blocks 800 s apart (2.2 h): every pool above is now older than the liquidity window, and the
# template index window (from the fork's first block) spans more than its 2 h minimum.
cast rpc -r $RPC anvil_mine 0xa 0x320 >/dev/null
cast send -r $RPC --unlocked --from $DEPLOYER --value 20ether $ROUTER \
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$LATE" 499990ether 0 0 $DEPLOYER 9999999999 >/dev/null
# A young pool whose LP is burned (sent to 0xdead): nobody can pull it.
LP_BURNED=$(deploy "Demo LP Burned" LPBURNED 0)
pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$LP_BURNED" "$WETH" -r $RPC)
lp=$(cast call "$pair" 'balanceOf(address)(uint256)' $DEPLOYER -r $RPC | cut -d' ' -f1)
cast send -r $RPC --unlocked --from $DEPLOYER "$pair" 'transfer(address,uint256)' 0x000000000000000000000000000000000000dEaD "$lp" >/dev/null
# A young pool whose whole liquidity sits with one EOA, the deployer, who can remove it at any block.
LP_HELD=$(deploy "Demo LP Held" LPHELD 0)

drained() { # pair holder: stops the setup if the holder still has LP (a removal that reverted)
  [[ $(cast call "$1" 'balanceOf(address)(uint256)' "$2" -r $RPC | cut -d' ' -f1) == 0 ]] || { echo "liquidity of $1 not removed" >&2; exit 1; }
}

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
    # Explicit gas: cast's estimate was once too tight (out of gas), and cast send exits 0 on a revert.
    cast send -r $RPC --unlocked --from "$c" --gas-limit 500000 $ROUTER \
      'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)' \
      "$token" "$lp" 0 0 "$c" 9999999999 >/dev/null
    drained "$pair" "$c"
  fi
  echo "$token"
}
for i in 1 2 3 4 5; do farm 0xfa4300000000000000000000000000000000000$i "Farm $i" FARM$i drain >/dev/null; done
FARM_FRESH=$(farm 0xfa43000000000000000000000000000000000006 "Farm Fresh" FRESH keep)
# Deployed last, so every address above stays the same: a sale reverts with less than 500,000 gas
# left, while the guard signs with its gas limit (250,000 at setup).
GAS_HUNGRY=$(deploy "Demo Gas Hungry" GASHUNGRY 10)
# Deployed after it, so every address above stays the same: the review's Trap2, keyed on what the
# guard signs and a looser simulation did not (an approve of the exact amount, a buy other than 0.01 ETH).
# Their LP is burned, as in the review: the trap is then the only thing to find.
burn_lp() { # token: sends the deployer's LP of its WETH pair to 0xdead
  local pair lp
  pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$1" "$WETH" -r $RPC)
  lp=$(cast call "$pair" 'balanceOf(address)(uint256)' $DEPLOYER -r $RPC | cut -d' ' -f1)
  cast send -r $RPC --unlocked --from $DEPLOYER "$pair" 'transfer(address,uint256)' 0x000000000000000000000000000000000000dEaD "$lp" >/dev/null
}
APPROVE_MAX_ONLY=$(deploy "Demo Approve Max Only" APPROVEMAX 11)
burn_lp "$APPROVE_MAX_ONLY"
BUY_001_ONLY=$(deploy "Demo Buy 0.01 Only" BUY001 12)
burn_lp "$BUY_001_ONLY"

# Last: the review's template poisoning. Three copies of USDC's runtime code (its proxy, implementation
# slot set by the constructor to a storage-only ERC-20), each with a 0.6 ETH pool drained in the next
# block, from an address without a key. USDC's own pool predates the template index window, so the
# drained copies must not get it blocked (app/index.ts beforeBlock).
POISONER=0xb0150000000000000000000000000000000000b0
cast rpc -r $RPC anvil_setBalance $POISONER 0x56BC75E2D63100000 >/dev/null # 100 ETH
cast rpc -r $RPC anvil_impersonateAccount $POISONER >/dev/null
COPY_IMPL=$(forge create --rpc-url $RPC --unlocked --from $POISONER --broadcast --json src/CopyImpl.sol:CopyImpl | jq -r .deployedTo)
runtime=$(cast code $USDC -r $RPC)
runtime=${runtime#0x}
size=$(printf '%04x' $((${#runtime} / 2)))
# Constructor: PUSH32 implementation, PUSH32 ZeppelinOS implementation slot, SSTORE; CODECOPY the runtime
# that follows this 82-byte (0x52) prefix to memory 0, RETURN it.
IMPL_SLOT=7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3
init="0x7f$(printf '%064s' "${COPY_IMPL#0x}" | tr ' ' 0)7f${IMPL_SLOT}55""61${size}610052600039""61${size}6000f3${runtime}"
COPIES=()
for i in 1 2 3; do
  copy=$(cast send -r $RPC --unlocked --from $POISONER --create "$init" --json | jq -r .contractAddress)
  [[ $(cast code "$copy" -r $RPC) == "0x$runtime" ]] || { echo "copy $i: runtime differs from USDC's" >&2; exit 1; }
  cast send -r $RPC --unlocked --from $POISONER "$copy" 'mint(address,uint256)' $POISONER 1000000000000 >/dev/null
  cast send -r $RPC --unlocked --from $POISONER "$copy" 'approve(address,uint256)' $ROUTER 1000000000000 >/dev/null
  cast send -r $RPC --unlocked --from $POISONER --value 0.6ether $ROUTER \
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$copy" 1000000000000 0 0 $POISONER 9999999999 >/dev/null
  pair=$(cast call $FACTORY 'getPair(address,address)(address)' "$copy" "$WETH" -r $RPC)
  lp=$(cast call "$pair" 'balanceOf(address)(uint256)' $POISONER -r $RPC | cut -d' ' -f1)
  cast send -r $RPC --unlocked --from $POISONER "$pair" 'approve(address,uint256)' $ROUTER "$lp" >/dev/null
  cast send -r $RPC --unlocked --from $POISONER --gas-limit 500000 $ROUTER \
    'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$copy" "$lp" 0 0 $POISONER 9999999999 >/dev/null
  drained "$pair" $POISONER
  COPIES+=("$copy")
done

# Deployed after everything above, whose addresses do not move: judge pass 5's JudgeTrap (a sale only
# after a top-level balanceOf, which only a simulation sent) and its siblings (src/SideTrap.sol), then a
# tax hidden from a check that measured the pool's WETH outflow. LP burned: the trap is all there is to find.
cast rpc -r $RPC anvil_setBalance $DEPLOYER 0x56BC75E2D63100000 >/dev/null # 100 ETH again
side() { # forge create arguments -> token address, 5 ETH against 500,000 tokens, LP burned
  local token
  token=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json "$@" | jq -r .deployedTo)
  pooled "$token"
}
pooled() { # token -> token address, 5 ETH against 500,000 of the deployer's tokens, LP burned
  local token=$1
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'approve(address,uint256)' $ROUTER 500000ether >/dev/null
  cast send -r $RPC --unlocked --from $DEPLOYER --value 5ether $ROUTER \
    'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)' "$token" 500000ether 0 0 $DEPLOYER 9999999999 >/dev/null
  cast send -r $RPC --unlocked --from $DEPLOYER "$token" 'setPair(address)' \
    "$(cast call $FACTORY 'getPair(address,address)(address)' "$token" "$WETH" -r $RPC)" >/dev/null
  burn_lp "$token"
  echo "$token"
}
JUDGE_TRAP=$(side src/JudgeTrap.sol:JudgeTrap)
UNTOUCHED=$(side src/SideTrap.sol:SideTrap --constructor-args "Side Untouched Buyer" UNTOUCHED 0)
STRANGER_KEY=$(side src/SideTrap.sol:SideTrap --constructor-args "Side Stranger Key" STRANGERKEY 1)
PAIR_PULL=$(side src/SideTrap.sol:SideTrap --constructor-args "Side Pair Pull Tax" PAIRPULL 2)

# Deployed last, every address above stays: the red team's RedL1Trap (a sale only while the L1Block
# predeploy is unchanged since the buy, which Base rewrites every block and a simulation never does) and
# two siblings (src/EnvTraps.sol): one keyed on the base fee, one reaching L1Block through a delegatecall
# to a helper whose address sits in storage.
RED_L1=$(side src/RedL1Trap.sol:RedL1Trap --constructor-args "Red L1 Trap" REDL1)
BASEFEE_TRAP=$(side src/EnvTraps.sol:BaseFeeTrap --constructor-args "Env Base Fee" BASEFEE)
L1_HELPER=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json src/EnvTraps.sol:L1Helper | jq -r .deployedTo)
HELPER_TRAP=$(side src/EnvTraps.sol:HelperTrap --constructor-args "Env Helper L1" HELPERL1 "$L1_HELPER")

# Deployed last, every address above stays: judge pass 6's NextBlockKey (a sale only in the block right
# after the buy, where a check's first sale used to be) and AmountTrap (a sale only of half or all of the
# seller's balance, the amounts a check used to sell).
NEXT_BLOCK_KEY=$(side src/NextBlockKey.sol:NextBlockKey)
AMOUNT_TRAP=$(side src/AmountTrap.sol:AmountTrap)

# Deployed last, every address above stays: judge pass 7's WethKey (a sale only while WETH's total supply
# is what its own trades left, which nobody else moves in a simulation) and Cooldown60 (honest: a sale
# only 30 blocks after the buy).
WETH_KEY=$(side src/WethKey.sol:WethKey)
COOLDOWN_60=$(side src/Cooldown60.sol:Cooldown60)

# Deployed last, every address above stays: judge pass 8's ApproveKey (WethKey's test moved into the
# approve, which the busy side did not precede) and BusyTell (a sale also let through when a pair was
# created between the seller's approve and its swap, as the busy side did), unchanged from the review.
APPROVE_KEY=$(side src/ApproveKey.sol:ApproveKey)
BUSY_TELL=$(side src/BusyTell.sol:BusyTell)

# Deployed last, every address above stays: judge pass 9's J9ImplMark (behind a proxy, each buy marks
# the previous buyer in its implementation's own storage, and a marked address never sells) and
# J9GuardLater (sales closed for the guard's address only, 8 minutes after its buy), unchanged.
MARK_IMPL=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json src/J9ImplMark.sol:J9ImplMark | jq -r .deployedTo)
IMPL_MARK=$(forge create --rpc-url $RPC --unlocked --from $DEPLOYER --broadcast --json src/J9ImplMark.sol:J9Proxy --constructor-args "$MARK_IMPL" | jq -r .deployedTo)
cast send -r $RPC --unlocked --from $DEPLOYER "$IMPL_MARK" 'init(address)' $DEPLOYER >/dev/null
IMPL_MARK=$(pooled "$IMPL_MARK")
GUARD_LATER=$(side src/J9GuardLater.sol:J9GuardLater --constructor-args "$GUARD_EVM")

# Deployed last, every address above stays: the step-up's two tokens (src/LateClose.sol), whose sales close
# for everyone 20 minutes after their owner arms them, past a check's last sale (900 s after the buy): one
# reads the time with TIMESTAMP, the other from its own pool (sync, getReserves). Armed by the tests.
LATE_CLOSE=$(side src/LateClose.sol:LateClose --constructor-args "Late Close" LATECLOSE false)
POOL_CLOCK=$(side src/LateClose.sol:LateClose --constructor-args "Pool Clock" POOLCLOCK true)

# USDC is real Base state: the fork fetches from its upstream node whatever it has not read yet, one
# request each (code of the proxy, the implementation, the pool, their slots). A buy through the router,
# called and never sent, reads most of it now: the first check of USDC, by two sentinels at once, does not
# wait for it.
cast call -r $RPC --from $DEPLOYER --value 0.00001ether $ROUTER \
  'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)' 0 "[$WETH,$USDC]" $DEPLOYER 9999999999 >/dev/null

# Users without a key whose WETH and ETH transfers fill the blocks the tests and demo.sh mine
# (app/testkit.ts USERS): 1,000 ETH each.
for i in 1 2 3 4 5; do cast rpc -r $RPC anvil_setBalance "0x0000000000000000000000000000000000b10c0$i" 0x3635C9ADC5DEA00000 >/dev/null; done
# Last, 100 empty blocks a second apart: the cadence a check measures over the 100 blocks before its
# reference block (app/verifier.ts cadenceAt) is the fork's, a block a second (app/testkit.ts FORK_S).
# Every block mined from now on, a test's transaction too, comes a second after the one before.
cast rpc -r $RPC anvil_mine 0x64 0x1 >/dev/null
cast rpc -r $RPC anvil_setBlockTimestampInterval 1 >/dev/null

jq -n --arg usdc $USDC --arg safe "$SAFE" --arg reclaim "$RECLAIM" --arg blocked "$BLOCKED" \
  --arg later "$LATER" --arg tax "$TAX" --arg taxlater "$TAX_LATER" --arg hold "$HOLD" --arg sim "$SIM" \
  --arg frozen "$FROZEN" --arg tax20 "$TAX20" --arg late "$LATE" --arg lpburned "$LP_BURNED" --arg lpheld "$LP_HELD" --arg fresh "$FARM_FRESH" --arg gashungry "$GAS_HUNGRY" \
  --arg approvemax "$APPROVE_MAX_ONLY" --arg buy001 "$BUY_001_ONLY" --argjson copies "$(printf '%s\n' "${COPIES[@]}" | jq -R . | jq -s .)" --argjson block "$FORK_BLOCK" \
  --arg judgetrap "$JUDGE_TRAP" --arg untouched "$UNTOUCHED" --arg strangerkey "$STRANGER_KEY" --arg pairpull "$PAIR_PULL" \
  --arg redl1 "$RED_L1" --arg basefee "$BASEFEE_TRAP" --arg helper "$HELPER_TRAP" \
  --arg nbk "$NEXT_BLOCK_KEY" --arg amount "$AMOUNT_TRAP" --arg wethkey "$WETH_KEY" --arg cooldown "$COOLDOWN_60" \
  --arg approvekey "$APPROVE_KEY" --arg busytell "$BUSY_TELL" --arg implmark "$IMPL_MARK" --arg guardlater "$GUARD_LATER" \
  --arg lateclose "$LATE_CLOSE" --arg poolclock "$POOL_CLOCK" \
  '{fork_block: $block, usdc: $usdc, safe: $safe, owner_reclaim: $reclaim, sell_blocked: $blocked,
    sell_blocked_later: $later, sell_tax: $tax, sell_tax_later: $taxlater, hold_one_block: $hold, sim_detector: $sim,
    guard_frozen: $frozen, sell_tax_20: $tax20, late_liquidity: $late, lp_burned: $lpburned, lp_held: $lpheld,
    farm_fresh: $fresh, gas_hungry: $gashungry, approve_max_only: $approvemax, buy_001_only: $buy001,
    usdc_copies: $copies, judge_trap: $judgetrap, untouched_buyer: $untouched, stranger_key: $strangerkey,
    pair_pull_tax: $pairpull, red_l1_trap: $redl1, basefee_trap: $basefee, helper_trap: $helper,
    next_block_key: $nbk, amount_trap: $amount, weth_key: $wethkey, cooldown_60: $cooldown,
    approve_key: $approvekey, busy_tell: $busytell, impl_mark: $implmark, guard_later: $guardlater,
    late_close: $lateclose, pool_clock: $poolclock}' > tokens.json
cp tokens.json ../docs/tokens.json
echo "guard_frozen freezes $GUARD_EVM"
echo "Base fork at block $FORK_BLOCK ready on $RPC; tokens in evm/tokens.json:"
cat tokens.json
wait $ANVIL
