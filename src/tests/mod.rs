//! Unit tests of the guard, one file per theme; the fixtures they share are here.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};

mod arming;
mod buy;
mod checks;
mod credit;
mod exits;
mod quarantine;
mod recovery;

/// Unit of test amounts: PRICE = 0.025 NEAR, enough for the storage of a request.
const U: u128 = 1_000_000_000_000_000_000_000;
const PRICE: u128 = 25 * U;
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
const TARGET: &str = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
/// Address of private key 0x00..01: stands in for the derived address in the viem vectors.
const ADDR: &str = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const RATE: u128 = 1_000_000_000; // yoctoNEAR per wei: 1 ETH = 1000 NEAR
/// Sentinel quote: tokens the guard's address received in the simulated buy of `VALUE` wei.
const QUOTE: u128 = 20_435;
/// The owner's EVM address for ETH withdrawals, fixed at init.
const WITHDRAW_TO: &str = "0x000000000000000000000000000000000000bEEF";
/// Gas limit of every signed transaction (`evm()`), and the one the sentinel simulates with.
const GAS: u64 = 250_000;
/// A per-buy bound that never binds, for tests about something else.
const NO_BUY_LIMIT: U128 = U128(u128::MAX);

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Code of the target as posted with a verdict: keccak256 `0x` + `b` x 32, no proxy.
#[allow(clippy::unnecessary_wraps)] // the verdict's `code` argument
fn code(b: &str) -> Option<Code> {
    Some(Code {
        code_hash: format!("0x{}", b.repeat(32)),
        implementation: None,
    })
}

/// Gas 250,000 at 0.05 gwei at most, tip 0.001 gwei.
fn evm() -> EvmConfig {
    EvmConfig {
        mpc: id("mpc.test"),
        address: ADDR.into(),
        gas_limit: GAS,
        max_fee_per_gas: U128(50_000_000),
        max_priority_fee_per_gas: U128(1_000_000),
        yocto_per_wei: U128(RATE),
        max_slippage_bps: 300,
        withdraw_to: WITHDRAW_TO.into(),
        chain_id: CHAIN_ID,
    }
}

fn ctx(who: &str, deposit: u128, now_ns: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("guard.test"))
        .predecessor_account_id(id(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ns)
        .build());
}

fn guard() -> Guard {
    guard_with(evm())
}

/// A guard initialised with `evm`; `guard()` is the Base mainnet one.
fn guard_with(evm: EvmConfig) -> Guard {
    // Empty storage: a test that builds several guards would otherwise share their maps' prefixes,
    // and one guard's credits would not add up to another's `credits_total`.
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    ctx("guard.test", 0, 0);
    let mut g = Guard::new(
        id("owner.test"),
        id("armer.test"),
        id("sentinel.test"),
        U128(PRICE),
        evm,
    );
    // A per-token cap that never binds, for tests about something else (zero at init:
    // `no_buy_before_the_owner_sets_the_token_cap`).
    g.limits.cap_wei = U128(u128::MAX);
    g
}

fn last_event() -> near_sdk::serde_json::Value {
    let log = get_logs().pop().unwrap();
    let json = log.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
    near_sdk::serde_json::from_str(json).unwrap()
}

/// All NEP-297 events of the current call, in order.
fn events() -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .map(|log| {
            let json = log.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
            near_sdk::serde_json::from_str(json).unwrap()
        })
        .collect()
}

/// The human sets the bounds, registers the agent then deposits `credit` for it; nothing is armed.
fn credited(credit: u128, max_budget: u128, max_duration_s: u64, max_7d: u128) -> Guard {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(max_budget), max_duration_s, U128(max_7d), NO_BUY_LIMIT);
    g.register_agent(id("agent.test"));
    ctx("owner.test", credit, 0);
    g.deposit_credit(Some(id("agent.test")));
    g
}

/// Credit deposited by the owner for the agent, budget armed by the armer for `secs`
/// seconds, within wide bounds (100 U per arming, 1000 s, 1000 U over 7 days).
fn funded(credit: u128, budget: u128, secs: u64) -> Guard {
    let mut g = credited(credit, 100 * U, 1000, 1000 * U);
    arm_at(&mut g, budget, secs, 0);
    g
}

/// The armer arms `agent.test` at block time `now_ns`, expecting the credit it reads.
fn arm_at(g: &mut Guard, budget: u128, secs: u64, now_ns: u64) {
    ctx("armer.test", 0, now_ns);
    let credit = g.credit_of(&id("agent.test"));
    g.arm(id("agent.test"), U128(budget), secs, credit);
}

const VALUE: u128 = 10_000_000_000_000; // 0.00001 ETH
/// Computed by the guard: QUOTE minus 3 % slippage, rounded down.
const MIN_OUT: u128 = 19_821;
/// Value plus gas at the cap (250,000 x 0.05 gwei), at the fixed rate: 22.5 U.
const COST: u128 = (VALUE + 250_000 * 50_000_000) * RATE;
// viem 2.57 vectors (serializeTransaction, keccak256, signTransaction with key 0x00..01):
// swap of VALUE wei, minimum MIN_OUT, path [WETH, TARGET], recipient ADDR, deadline 300 s,
// gas 250,000, fees 0.05 / 0.001 gwei, chain id 8453, nonce 0.
const HASH0: &str = "314bf89cb90d7232250c56241836f4ab662a81de9030d250712eedbcdd5fd5e0";
const R0: &str = "edd513dba0e03506152548756199a93ca6e97d19067f21b928c1d3d093b85058";
const S0: &str = "554415cb6774e8a2fa43e6b66b4326492d07b9a4dba38722e3e973885f70733d"; // y = 1
const RAW0: &str = "0x02f9015782210580830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de950000000000000000000000000000000000000000000000000000000000004d6d00000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c001a0edd513dba0e03506152548756199a93ca6e97d19067f21b928c1d3d093b85058a0554415cb6774e8a2fa43e6b66b4326492d07b9a4dba38722e3e973885f70733d";
/// Same swap at nonce 7, fictitious signature r = 00aa..aa, s = 0000bb..bb, y = 1: viem removes
/// the leading zeros (canonical RLP integers).
const HASH7: &str = "09c441fe3699e56cd3c6d7646c8e3242427e00fd8816adc1b8c2b5771675fea0";
const RAW7: &str = "0x02f9015482210507830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de950000000000000000000000000000000000000000000000000000000000004d6d00000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c0019faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn judged(verdict: Verdict) -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
    g.post_verdict(
        check,
        verdict,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(&g, check, QUOTE),
    );
    ctx("agent.test", 0, 700);
    (g, check)
}

fn buy(g: &mut Guard, check: u64) {
    let _ = g.buy(check, U128(VALUE), None);
}

/// Signing hashes of what the guard would sign for `check` with `quote`: what the sentinel
/// simulates (`preview_check`) and posts with its verdict.
fn previewed(g: &Guard, check: u64, quote: u128) -> Vec<String> {
    g.preview_check(check, U128(quote))
        .iter()
        .map(|t| hex(&env::keccak256_array(hex::decode(&t[2..]).unwrap())))
        .collect()
}

/// `sign` response in the format of `v1.signer-prod.testnet`; `big_r` = prefix 02 + r.
fn mpc_response(r: &str, s: &str, recovery_id: u8) -> Vec<u8> {
    format!(
        r#"{{"big_r":{{"affine_point":"02{r}"}},"recovery_id":{recovery_id},"s":{{"scalar":"{s}"}},"scheme":"Secp256k1"}}"#
    )
    .into_bytes()
}

/// A callback's context: the guard calls itself with the `sign` results.
fn callback_env(results: Vec<PromiseResult>) {
    callback_at(800, results);
}

/// The same at block time `now_ns`.
fn callback_at(now_ns: u64, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guard.test"))
            .predecessor_account_id(id("guard.test"))
            .block_timestamp(now_ns)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        results,
    );
}

/// The guard's callback receives `result`, the result of `sign`.
fn signed(g: &mut Guard, result: PromiseResult) -> Option<String> {
    callback_env(vec![result]);
    let since = g.signing_since_ns;
    g.on_signed(since)
}

/// Arguments of the `sign` call created by `buy` (1 yoctoNEAR to the MPC), followed by the callback.
fn sign_args() -> near_sdk::serde_json::Value {
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, id("mpc.test"));
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        ..
    } = &receipts[0].actions[0]
    else {
        panic!("sign call expected")
    };
    assert_eq!(method_name, b"sign");
    assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
    assert_eq!(receipts[1].receiver_id, id("guard.test"));
    let MockAction::FunctionCallWeight { method_name, .. } = &receipts[1].actions[0] else {
        panic!("callback expected")
    };
    assert_eq!(method_name, b"on_signed");
    near_sdk::serde_json::from_slice(args).unwrap()
}

fn approve(g: &mut Guard, check: u64, now_ns: u64) {
    ctx("owner.test", 0, now_ns);
    g.approve_warn(check);
}

fn pending() -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    (g, check)
}

// Vectors from viem 2.57 (scratch script): token TARGET, 1,000,000 tokens, floor 0.000005 ETH,
// deadline 300 s, nonces 0 and 1; fictitious signatures (aa, bb, y = 1) and (cc, dd, y = 0).
const SELL_AMOUNT: u128 = 1_000_000;
const SELL_MIN: u128 = 5_000_000_000_000;
const APPROVE_HASH: &str = "655e06dcbeba90aa01c2e4fb6f9b6bf827516faf20694d21488d2d9e168bb101";
const APPROVE_RAW: &str = "0x02f8b182210580830f42408402faf0808303d09094dac17f958d2ee523a2206206994597c13d831ec780b844095ea7b30000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad2400000000000000000000000000000000000000000000000000000000000f4240c001a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SELL_HASH: &str = "c50b231ab621fdadff0584450841972221d538d10d72c244c302ca1563203b5f";
const SELL_RAW: &str = "0x02f9017282210501830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad2480b90104791ac94700000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000048c2739500000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec70000000000000000000000004200000000000000000000000000000000000006c080a0cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccca0dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
/// 0.001 ETH to `WITHDRAW_TO`, nonce 0, signature (aa, bb, y = 1).
const WITHDRAW_HASH: &str = "80db6f822c86663530bbe853e49c3f8196c7959b9c771afa84440fcd2ef4e099";
const WITHDRAW_RAW: &str = "0x02f87382210580830f42408402faf0808303d09094000000000000000000000000000000000000beef87038d7ea4c6800080c001a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIG_A: (&str, &str, u8) = (
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    1,
);
const SIG_B: (&str, &str, u8) = (
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    0,
);

/// viem 2.57: the swap of `SELL_RAW` with a floor of 0, unsigned (what `preview_sale` builds).
const SALE_FLOOR_0_HASH: &str = "4e63831862f4e2d50eab33966eee2e53843bd3f8cea8c0d01f4ece43e71cf1d1";

fn ok_sig((r, s, v): (&str, &str, u8)) -> PromiseResult {
    PromiseResult::Successful(mpc_response(r, s, v))
}

/// `who` sells `SELL_AMOUNT` of `TARGET` at 700 ns; the agent is registered, credited, never armed.
fn sell_as(who: &str) -> Guard {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    ctx(who, 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    g
}

/// Payload hashes of the `sign` calls created by the last call, which must end with `callback`.
fn signed_hashes(callback: &[u8]) -> Vec<String> {
    let receipts = get_created_receipts();
    let (last, signs) = receipts.split_last().unwrap();
    let MockAction::FunctionCallWeight { method_name, .. } = &last.actions[0] else {
        panic!("callback expected")
    };
    assert_eq!(method_name, callback);
    signs
        .iter()
        .map(|r| {
            assert_eq!(r.receiver_id, id("mpc.test"));
            let MockAction::FunctionCallWeight { args, .. } = &r.actions[0] else {
                panic!("sign call expected")
            };
            let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
            v["request"]["payload_v2"]["Ecdsa"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn exit_signed(g: &mut Guard, results: Vec<PromiseResult>) -> Vec<String> {
    callback_env(results);
    let since = g.signing_since_ns;
    g.on_exit_signed(since)
}

/// A check of `TARGET` requested at `now_ns`, judged by the sentinel 1 ns later with `code`.
fn verdict_on(g: &mut Guard, verdict: Verdict, code: Option<Code>, now_ns: u64) -> u64 {
    ctx("agent.test", 0, now_ns);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, now_ns + 1);
    g.post_verdict(
        check,
        verdict,
        String::new(),
        String::new(),
        U128(QUOTE),
        code,
        true,
        previewed(g, check, QUOTE),
    );
    check
}

#[allow(clippy::unnecessary_wraps)] // the verdict's `code` argument
fn proxy(implementation: &str) -> Option<Code> {
    Some(Code {
        code_hash: format!("0x{}", "aa".repeat(32)),
        implementation: Some(format!("0x{}", implementation.repeat(20))),
    })
}

const SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
/// sha256 of the empty string: the evidence posted by `verdict_on`.
const SHA_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Quote whose 3 % slippage floor is exactly `SELL_MIN`.
const EXIT_QUOTE: u128 = 5_154_639_175_258;
/// An exit by an agent: two transactions at the gas cap, at the fixed rate (25 U).
const EXIT_COST: u128 = 2 * 250_000 * 50_000_000 * RATE;

/// Sets the holding of `agent.test` in TARGET (the real path is the signed buy's `min_out`).
fn give_holding(g: &mut Guard, amount: u128) {
    g.set_held(&id("agent.test"), TARGET, amount);
}

/// The agent's buy of TARGET is signed (nonce 0); it then asks an exit quote of `SELL_AMOUNT` at
/// 1000 ns, which the sentinel judges `verdict` with `quote` at 1001 ns.
fn exit_judged(verdict: Verdict, quote: u128) -> (Guard, u64, u64) {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    give_holding(&mut g, SELL_AMOUNT);
    ctx("agent.test", 0, 1000);
    let exit = g.request_exit(bought, U128(SELL_AMOUNT));
    ctx("sentinel.test", 0, 1001);
    g.post_verdict(
        exit,
        verdict,
        String::new(),
        String::new(),
        U128(quote),
        None,
        true,
        previewed(&g, exit, quote),
    );
    (g, bought, exit)
}

fn sell_quoted_at(g: &mut Guard, check: u64, now_ns: u64) {
    ctx("agent.test", 0, now_ns);
    let _ = g.sell_quoted(check);
}

/// A bought for TARGET (holding `MIN_OUT`), then asks and gets an `allow` exit quote of `amount`.
fn exit_quote(g: &mut Guard, who: &str, bought: u64, amount: u128, now_ns: u64) -> u64 {
    ctx(who, 0, now_ns);
    let exit = g.request_exit(bought, U128(amount));
    ctx("sentinel.test", 0, now_ns + 1);
    g.post_verdict(
        exit,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(EXIT_QUOTE),
        None,
        true,
        previewed(g, exit, EXIT_QUOTE),
    );
    exit
}

fn holding_of(g: &Guard, who: &str) -> u128 {
    g.holding(id(who), TARGET.into()).0
}

/// The owner signs a replacement at the reserved `nonce` at `now_ns`, and its signature comes back.
fn replaced(g: &mut Guard, nonce: u64, now_ns: u64) {
    ctx("owner.test", 0, now_ns);
    let _ = g.sign_replacement(nonce);
    assert_eq!(exit_signed(g, vec![ok_sig(SIG_A)]).len(), 1);
    ctx("owner.test", 0, now_ns);
}

const OTHER: &str = "0x000000000000000000000000000000000000c0de";

/// The owner registers and credits `who`, the armer arms it, at `now_ns`.
fn enroll(g: &mut Guard, who: &str, now_ns: u64) {
    ctx("owner.test", 0, now_ns);
    g.register_agent(id(who));
    ctx("owner.test", ONE_NEAR, now_ns);
    g.deposit_credit(Some(id(who)));
    ctx("armer.test", 0, now_ns);
    let credit = g.credit_of(&id(who));
    g.arm(id(who), U128(100 * U), 1000, credit);
}

/// A guard whose owner named two sentinels, both needed; `agent.test` armed for 1,000 s.
fn two_sentinels() -> Guard {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_sentinels(vec![id("sentinel.test"), id("sentinel2.test")], 2);
    g
}

/// `who` votes `verdict` on buy check `check` at `now_ns`: quote `QUOTE`, code `aa`, its own
/// reasons and evidence.
fn vote(g: &mut Guard, who: &str, check: u64, verdict: Verdict, list: bool, now_ns: u64) {
    ctx(who, 0, now_ns);
    let hashes = if verdict == Verdict::Block {
        vec![]
    } else {
        previewed(g, check, QUOTE)
    };
    g.post_verdict(
        check,
        verdict,
        format!("reasons of {who}"),
        format!("evidence of {who}"),
        U128(QUOTE),
        code("aa"),
        list,
        hashes,
    );
}

/// A buy check of TARGET requested at 500 on a guard with two sentinels.
fn asked_of_two() -> (Guard, u64) {
    let mut g = two_sentinels();
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    (g, check)
}

const THREE: [&str; 3] = ["sentinel.test", "sentinel2.test", "sentinel3.test"];

/// The owner names `sentinels` and `quorum` at `now_ns`.
fn name(g: &mut Guard, sentinels: &[&str], quorum: u8, now_ns: u64) {
    ctx("owner.test", 0, now_ns);
    g.set_sentinels(sentinels.iter().map(|s| id(s)).collect(), quorum);
}

/// A buy check of TARGET requested at 500 on a guard with three sentinels, `quorum` needed.
fn asked_of_three(quorum: u8) -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    name(&mut g, &THREE, quorum, 0);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    (g, check)
}

/// `who` posts the fail-closed fallback on `check`: a block without the token's code.
fn fallback(g: &mut Guard, who: &str, check: u64, now_ns: u64) {
    ctx(who, 0, now_ns);
    g.post_verdict(
        check,
        Verdict::Block,
        "simulation impossible after 3 tries".into(),
        String::new(),
        U128(0),
        None,
        false,
        vec![],
    );
}

fn verdict_of(g: &Guard, check: u64) -> Option<Verdict> {
    g.get_check(check).unwrap().verdict
}

/// `who` posts `verdict` with `quote` on exit quote `exit` at `now_ns`.
fn exit_vote(g: &mut Guard, who: &str, exit: u64, verdict: Verdict, quote: u128, now_ns: u64) {
    ctx(who, 0, now_ns);
    let hashes = if verdict == Verdict::Block {
        vec![]
    } else {
        previewed(g, exit, quote)
    };
    g.post_verdict(
        exit,
        verdict,
        format!("reasons of {who}"),
        format!("evidence of {who}"),
        U128(quote),
        code("aa"),
        true,
        hashes,
    );
}

/// `agent.test` holds `SELL_AMOUNT` of TARGET; the owner names two sentinels, both needed; the
/// agent asks an exit quote at 1000 ns.
fn exit_asked_of_two() -> (Guard, u64) {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    give_holding(&mut g, SELL_AMOUNT);
    name(&mut g, &["sentinel.test", "sentinel2.test"], 2, 900);
    ctx("agent.test", 0, 1000);
    let exit = g.request_exit(bought, U128(SELL_AMOUNT));
    (g, exit)
}

/// The message of the panic `f` ends in.
fn panic_of(f: impl FnOnce()) -> String {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("no panic");
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_default()
}
