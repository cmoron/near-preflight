#!/usr/bin/env bash
# Keyless check of what the README claims about the three deployed guards, read from public NEAR RPC.
# Needs curl, jq, base64 and sha256sum (or shasum). No account, no key, nothing to install or build.
# One PASS or FAIL line per claim, INFO for what is disclosed, not claimed. Exit 0 if no FAIL.
# Other nodes: NEAR_TESTNET_RPC, NEAR_MAINNET_RPC, BASE_RPC, BASE_SEPOLIA_RPC. A 429 or a network error is
# retried once.
set -uo pipefail

TESTNET_RPC=${NEAR_TESTNET_RPC:-https://test.rpc.fastnear.com}
MAINNET_RPC=${NEAR_MAINNET_RPC:-https://free.rpc.fastnear.com}
BASE_RPC=${BASE_RPC:-https://mainnet.base.org}
BASE_SEPOLIA_RPC=${BASE_SEPOLIA_RPC:-https://sepolia.base.org}
DEMO=guard.goblin-guard-17826.testnet # the demo guard (docs/reproduce.md#deployment)
INERT=guard.near-preflight.near       # the inert mainnet guard (docs/mainnet.md)
PARENT=${INERT#guard.}
SEPOLIA=guard.preflight-sepolia-96623.testnet # the keyless Base Sepolia guard (docs/base-sepolia.md)
SHA=3c5b992fea5d6e13cbf6c75760d138fa434a1efd67d5a1ff385f9bacb566372f # cargo near build reproducible-wasm
REV=22e5c32ad5387189eee7575ce00c6938ff253dc2                         # the commit that wasm names
# The Base Sepolia guard runs a later commit (tag base-sepolia-guard), which adds the chain id fixed at init.
SEPOLIA_SHA=f2136c17d830afc5123e9ee80b5b6bc2aa857d6d571c6e1bb7e6c80faef301a9
SEPOLIA_REV=c3c361fdba68d7ce03b4c94ded5aca71cb761755
# What it had NEAR sign and Base Sepolia mined (docs/base-sepolia.md): the buy, the sale (approve, then swap),
# the owner's withdrawal.
SEPOLIA_TXS="buy:0x2d5d377655b8f8faf7921b40e2a25cfe95190c1b8a17e6d0733f4b1070e46863
sale-approve:0xd7de762732c130366e39ca543ebfeb8ad0fb9708d8cec0604e24f9403d14c4c4
sale-swap:0x7f65205ca9c33b80a9228b0ed2c0647c75548fb6aa2e780020355cc4778a21c9
withdrawal:0x30d09618730ad7d4500318ed82ab55dfc99dc42d7ac5ef8509adf0d859a80943"
AGENT_METHODS='["buy","refund_check","request_check","request_exit","sell_quoted"]' # docs/contract.md, sorted

fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }
info() { echo "INFO  $*"; }
# check <condition's exit status> <line>
check() { if [ "$1" = 0 ]; then pass "$2"; else fail "$2"; fi; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -c1-64; }

# rpc <url> <method> <params json>: prints .result, fails on an RPC error.
rpc() {
  local body out try
  body=$(jq -cn --arg m "$2" --argjson p "$3" '{jsonrpc: "2.0", id: 1, method: $m, params: $p}')
  for try in 1 2; do
    if out=$(curl -sS --fail --connect-timeout 10 --max-time 30 -H 'content-type: application/json' -d "$body" "$1" 2>/dev/null) &&
      jq -e 'has("result")' <<<"$out" >/dev/null 2>&1; then
      jq -c .result <<<"$out"
      return 0
    fi
    [ "$try" = 1 ] && sleep 5
  done
  return 1
}
# query <url> <params json without finality>
query() { rpc "$1" query "$(jq -c '. + {finality: "final"}' <<<"$2")"; }
# view <url> <account> <method> [args json]: the view's JSON result
view() {
  query "$1" "$(jq -cn --arg a "$2" --arg m "$3" --arg args "${4:-{\}}" \
    '{request_type: "call_function", account_id: $a, method_name: $m, args_base64: ($args | @base64)}')" |
    jq -c '.result | implode | fromjson'
}
keys() { query "$1" "$(jq -cn --arg a "$2" '{request_type: "view_access_key_list", account_id: $a}')" | jq -c '[.keys[].access_key.permission]'; }
# is <json> <jq filter> [jq options]: exit 0 when the filter is true
is() { local json=$1 filter=$2; shift 2; jq -e "$@" "$filter" <<<"$json" >/dev/null 2>&1; }

# The code on chain is the reproducible build, and names its commit (NEP-330).
code() { # <url> <guard> [sha256] [commit]
  local got meta sha=${3:-$SHA} rev=${4:-$REV}
  got=$(query "$1" "$(jq -cn --arg a "$2" '{request_type: "view_code", account_id: $a}')" | jq -r .code_base64 | base64 --decode | sha256)
  [ "$got" = "$sha" ]
  check $? "$2: code sha256 ${got:-unread}, the reproducible build's"
  meta=$(view "$1" "$2" contract_source_metadata | jq -r '.build_info.source_code_snapshot // empty')
  [ "${meta##*rev=}" = "$rev" ]
  check $? "$2: source metadata (NEP-330) names commit ${meta##*rev=}"
}

count() { jq -r "[.[] | select($1)] | length" <<<"$checks"; }
# Every check the guard stores, with its votes. Needs $s, the guard's sentinels.
votes() { # <guard>
  n=$(view "$TESTNET_RPC" "$1" last_check_id)
  checks='[]'
  for id in $(seq 1 "${n:-0}"); do
    c=$(view "$TESTNET_RPC" "$1" get_check "{\"id\":$id}") || c=null
    checks=$(jq -c --argjson c "${c:-null}" --argjson id "$id" '. + [$c + {id: $id}]' <<<"$checks")
  done
  is "$checks" 'length > 0 and all(.[]; .agent != null)'
  check $? "checks stored: ${n:-unread}, verdicts allow $(count '.verdict == "allow"'), warn $(count '.verdict == "warn"'), block $(count '.verdict == "block"'), none yet $(count '.verdict == null')"

  # A buy NEAR signed keeps its signed_tx. Each must rest on an allow two sentinels of the guard voted, or
  # on a warn they voted and the owner approved.
  is "$checks" '
    [.[] | select(.signed_tx != null and .exit_amount == null)] as $buys
    | ($buys | length) > 0
    and all($buys[]; . as $c
      | ([$c.votes[] | select(.verdict == $c.verdict and (.sentinel | IN($s.sentinels[]))) | .sentinel] | unique | length) >= $s.quorum
      and ($c.verdict == "allow" or ($c.verdict == "warn" and $c.approved)))' --argjson s "${s:-null}"
  check $? "buys NEAR signed: $(count '.signed_tx != null and .exit_amount == null'), each on $(jq -r .quorum <<<"$s" 2>/dev/null) matching sentinel votes: allow $(count '.signed_tx != null and .exit_amount == null and .verdict == "allow"'), warn approved by the owner $(count '.signed_tx != null and .exit_amount == null and .verdict == "warn" and .approved')"
  is "$checks" 'all(.[] | select(.exit_amount == null and (.verdict == "block" or (.verdict == "warn" and (.approved | not)))); .signed_tx == null)'
  check $? "no buy signed on a block ($(count '.exit_amount == null and .verdict == "block"') checks) or on a warn not approved ($(count '.exit_amount == null and .verdict == "warn" and (.approved | not)'))"
}

echo "NEAR testnet, the demo guard ($TESTNET_RPC)"
code "$TESTNET_RPC" "$DEMO"

s=$(view "$TESTNET_RPC" "$DEMO" sentinels)
is "$s" '(.sentinels | unique | length) == 3 and .quorum == 2'
check $? "sentinels: $(jq -r '.sentinels | map(split(".")[0]) | join(", ")' <<<"$s" 2>/dev/null), quorum $(jq -r .quorum <<<"$s" 2>/dev/null)"

evm=$(view "$TESTNET_RPC" "$DEMO" evm_config)
is "$evm" '.mpc == "v1.signer-prod.testnet"'
check $? "signer: $(jq -r .mpc <<<"$evm" 2>/dev/null) (NEAR Chain Signatures on testnet), for the Base address $(jq -r .address <<<"$evm" 2>/dev/null)"

votes "$DEMO"

agent=agent.${DEMO#guard.}
k=$(keys "$TESTNET_RPC" "$agent")
is "$k" '
  [.[] | objects | .FunctionCall] as $fc
  | ($fc | length) > 0 and all($fc[]; .receiver_id == $g and (.method_names | sort) == $m)' --arg g "$DEMO" --argjson m "$AGENT_METHODS"
check $? "$agent: $(jq -r '[.[] | objects] | length' <<<"$k" 2>/dev/null) function-call key, limited to the guard and to $(jq -r 'join(", ")' <<<"$AGENT_METHODS")"
info "$agent also has $(jq -r '[.[] | strings] | length' <<<"$k" 2>/dev/null) full-access key: setup keeps it in the owner's keychain, the agent process gets the function-call key. Not provable on chain."
k=$(keys "$TESTNET_RPC" "$DEMO")
info "$DEMO holds $(jq -r '[.[] | strings] | length' <<<"$k" 2>/dev/null) full-access key: its holder can redeploy it (README, How NEAR is used)."

echo
echo "NEAR testnet, the keyless Base Sepolia guard ($TESTNET_RPC)"
code "$TESTNET_RPC" "$SEPOLIA" "$SEPOLIA_SHA" "$SEPOLIA_REV"

k=$(keys "$TESTNET_RPC" "$SEPOLIA")
[ "$k" = '[]' ]
check $? "$SEPOLIA: access keys ${k:-unread}: no key can redeploy it, move its NEAR or call the signer as the guard"

s=$(view "$TESTNET_RPC" "$SEPOLIA" sentinels)
is "$s" '(.sentinels | unique | length) == 3 and .quorum == 2'
check $? "sentinels: $(jq -r '.sentinels | map(split(".")[0]) | join(", ")' <<<"$s" 2>/dev/null), quorum $(jq -r .quorum <<<"$s" 2>/dev/null)"

evm=$(view "$TESTNET_RPC" "$SEPOLIA" evm_config)
addr=$(jq -r .address <<<"$evm" 2>/dev/null)
is "$evm" '.chain_id == 84532 and .mpc == "v1.signer-prod.testnet"'
check $? "chain id fixed at init: $(jq -r .chain_id <<<"$evm" 2>/dev/null) (Base Sepolia); signer $(jq -r .mpc <<<"$evm" 2>/dev/null), for the address $addr"

votes "$SEPOLIA"

# The transactions the docs cite were mined, and sent by the address NEAR signs for as this guard.
while IFS=: read -r what hash; do
  r=$(rpc "$BASE_SEPOLIA_RPC" eth_getTransactionReceipt "[\"$hash\"]")
  is "$r" '.status == "0x1" and (.from | ascii_downcase) == ($a | ascii_downcase)' --arg a "$addr"
  check $? "Base Sepolia, $what $hash: status $(jq -r .status <<<"$r" 2>/dev/null), sent by the guard's address"
done <<<"$SEPOLIA_TXS"
info "Both tokens on Base Sepolia are test tokens we deployed; the three sentinels ran on one machine (docs/base-sepolia.md#limits)."

echo
echo "NEAR mainnet, the inert guard ($MAINNET_RPC)"
code "$MAINNET_RPC" "$INERT"

s=$(view "$MAINNET_RPC" "$INERT" sentinels)
is "$s" '.sentinels == [$p] and .quorum == 1' --arg p "$PARENT"
check $? "only sentinel: $(jq -r '.sentinels | join(", ")' <<<"$s" 2>/dev/null), the guard's parent account, quorum $(jq -r .quorum <<<"$s" 2>/dev/null)"

b=$(view "$MAINNET_RPC" "$INERT" bounds)
cap=$(view "$MAINNET_RPC" "$INERT" token_limits | jq -r .cap_wei)
is "$b" '.max_budget == "0" and .max_7d == "0" and .max_buy_wei == "0" and .max_duration_s == 0' && [ "$cap" = 0 ]
check $? "bounds and per-token cap zero (max_buy_wei $(jq -r .max_buy_wei <<<"$b" 2>/dev/null), cap_wei ${cap:-unread}): every check is refused"

agents=$(query "$MAINNET_RPC" "$(jq -cn --arg a "$INERT" '{request_type: "view_state", account_id: $a, prefix_base64: ("g" | @base64)}')" | jq -r '.values | length')
[ "$agents" = 0 ]
check $? "agents registered: ${agents:-unread}"

last=$(view "$MAINNET_RPC" "$INERT" last_check_id)
exit_=$(view "$MAINNET_RPC" "$INERT" last_exit)
[ "$last" = 0 ] && [ "$exit_" = null ]
check $? "checks requested: ${last:-unread}; exits or withdrawals signed: $([ "$exit_" = null ] && echo none || echo "${exit_:-unread}")"

evm=$(view "$MAINNET_RPC" "$INERT" evm_config)
addr=$(jq -r .address <<<"$evm" 2>/dev/null)
is "$evm" '.mpc == "v1.signer"'
check $? "signer: $(jq -r .mpc <<<"$evm" 2>/dev/null) (NEAR Chain Signatures on mainnet)"
wei=$(rpc "$BASE_RPC" eth_getBalance "[\"$addr\",\"latest\"]" | jq -r .)
[ "$wei" = 0x0 ]
check $? "its Base address $addr holds ${wei:-unread} wei on Base mainnet ($BASE_RPC)"

k=$(keys "$MAINNET_RPC" "$INERT")
is "$k" 'length > 0 and all(.[]; type == "string")'
check $? "$INERT: $(jq -r '[.[] | objects] | length' <<<"$k" 2>/dev/null) function-call key: no agent, armer or sentinel key can act on it"
info "$INERT holds $(jq -r '[.[] | strings] | length' <<<"$k" 2>/dev/null) full-access key, the owner's: inert until the owner changes it, not immutable (docs/mainnet.md)."

echo
if [ "$fails" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; exit 1; fi
