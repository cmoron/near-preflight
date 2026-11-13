//! Buy and signing: the transaction the guard builds and has the MPC sign, the warn approval,
//! the quote and its floor, and the gas settings.

use super::*;

// 6. buy signed by NEAR: the guard builds the swap for the request's target and has it
// signed by the MPC; the agent chooses only the amount and the minimum tokens received.
// The sentinel simulates exactly what the guard signs: the agent states the amount at
// `request_check`, `preview_check` gives the bytes, and `buy` signs only those.
#[test]
fn the_check_stores_the_amount_the_agent_states() {
    let (g, check) = judged(Verdict::Allow);
    assert_eq!(g.get_check(check).unwrap().amount_wei, U128(VALUE));
}

#[test]
#[should_panic(expected = "amount is not the one checked")]
fn a_buy_of_another_amount_than_the_checked_one_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    let _ = g.buy(check, U128(VALUE + 1), None);
}

#[test]
fn the_preview_is_the_transaction_the_buy_signs() {
    let (mut g, check) = judged(Verdict::Allow);
    assert_eq!(previewed(&g, check, QUOTE), [HASH0]);
    assert_eq!(g.get_check(check).unwrap().tx_hashes, [HASH0]);
    buy(&mut g, check);
    assert_eq!(sign_args()["request"]["payload_v2"]["Ecdsa"], HASH0);
}

// another signature since the verdict moved the nonce: the bytes simulated are no longer the ones
// the guard would sign
#[test]
#[should_panic(expected = "transaction differs from the one simulated")]
fn a_buy_after_the_nonce_moved_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    g.evm_nonce = 1;
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "transaction differs from the one simulated")]
fn a_buy_on_a_verdict_posted_without_the_simulated_hashes_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    g.checks.get_mut(&check).unwrap().tx_hashes = vec![];
    buy(&mut g, check);
}

// the sentinel read a preview on a node behind the guard (another signature since): its allow is
// refused at once, it previews again, rather than an allow no buy can use
#[test]
#[should_panic(expected = "tx hashes are not what the guard would sign now")]
fn an_allow_with_stale_tx_hashes_is_refused() {
    let (mut g, check) = pending();
    let stale = previewed(&g, check, QUOTE);
    g.evm_nonce = 1;
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        stale,
    );
}

// a block is never signed: its hashes are not checked
#[test]
fn a_block_with_any_tx_hashes_is_accepted() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(0),
        code("aa"),
        false,
        vec!["ab".repeat(32)],
    );
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
}

#[test]
#[should_panic(expected = "invalid tx hashes")]
fn a_verdict_with_a_malformed_tx_hash_is_refused() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        vec!["0x12".into()],
    );
}

#[test]
fn the_buy_has_the_mpc_sign_the_viem_transaction_hash() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    let args = sign_args();
    assert_eq!(args["request"]["path"], DERIVATION_PATH);
    assert_eq!(args["request"]["payload_v2"]["Ecdsa"], HASH0);
    assert_eq!(args["request"]["domain_id"], 0);
}

#[test]
fn the_buy_debits_value_and_gas_at_the_fixed_rate() {
    let (mut g, check) = judged(Verdict::Allow);
    let credit = g.credit_of(&id("agent.test")).0;
    buy(&mut g, check);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - COST);
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - COST);
    assert_eq!(g.fees(), U128(PRICE)); // the cost stays in escrow until the signature
    let v = last_event();
    assert_eq!(v["event"], "sign_requested");
    assert_eq!(v["data"][0]["target"], TARGET);
    assert_eq!(v["data"][0]["nonce"], 0);
    assert_eq!(v["data"][0]["hash"], HASH0);
    assert_eq!(v["data"][0]["min_out"], MIN_OUT.to_string());
}

// the target, router, recipient and path come from the guard: the viem vector
// buys TARGET (the request's target) for ADDR via Base's Uniswap V2 router
#[test]
fn the_mpc_signature_gives_the_viem_transaction() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    let raw = signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    assert_eq!(raw.as_deref(), Some(RAW0));
    let c = g.get_check(check).unwrap();
    assert!(c.settled);
    assert_eq!(format!("0x{}", hex(&c.signed_tx.as_ref().unwrap().0)), RAW0);
    assert_eq!(g.fees(), U128(PRICE + COST));
    assert_eq!(g.evm_nonce, 1);
    let v = last_event();
    assert_eq!(v["event"], "signed");
    assert_eq!(v["data"][0]["tx"], RAW0);
}

#[test]
fn r_and_s_are_encoded_without_leading_zeros() {
    let (mut g, check) = judged(Verdict::Allow);
    g.evm_nonce = 7; // as if simulated and judged at nonce 7
    g.checks.get_mut(&check).unwrap().tx_hashes = previewed(&g, check, QUOTE);
    buy(&mut g, check);
    assert_eq!(sign_args()["request"]["payload_v2"]["Ecdsa"], HASH7);
    let r = format!("00{}", "aa".repeat(31));
    let s = format!("0000{}", "bb".repeat(30));
    let raw = signed(&mut g, PromiseResult::Successful(mpc_response(&r, &s, 1)));
    assert_eq!(raw.as_deref(), Some(RAW7));
    assert_eq!(g.evm_nonce, 8);
}

// an unreadable response is no proof that nothing was signed: reserved like a failure
#[test]
fn an_unreadable_response_counts_as_a_failure() {
    let bad = [
        b"not json".to_vec(),
        b"{\"oops\":1}".to_vec(),
        mpc_response(R0, &S0[2..], 0), // s on 31 bytes
        mpc_response(&R0[2..], S0, 0), // big_r on 32 bytes
        mpc_response("zz", S0, 0),
        mpc_response(R0, S0, 2),
    ];
    for response in bad {
        let (mut g, check) = judged(Verdict::Allow);
        buy(&mut g, check);
        assert_eq!(signed(&mut g, PromiseResult::Successful(response)), None);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - COST);
        assert_eq!(g.evm_nonce, 1);
        assert!(g.get_unsettled(0).is_some());
    }
}

#[test]
fn a_refund_after_the_emergency_stop_does_not_return_the_budget() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    ctx("owner.test", 0, 750);
    g.disarm(id("agent.test"));
    signed(&mut g, PromiseResult::Failed);
    replaced(&mut g, 0, 900);
    g.clear_unsettled(0, true);
    assert_eq!(g.budget_left(&id("agent.test")).0, 0);
}

// reentrancy: a request being signed cannot be bought twice
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_second_buy_during_the_signature() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "check already settled")]
fn one_buy_per_verdict() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("agent.test", 0, 900);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "verdict does not allow the purchase")]
fn buy_refused_on_block() {
    let (mut g, check) = judged(Verdict::Block);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "warn verdict not approved by the owner")]
fn buy_refused_on_warn_without_the_human() {
    let (mut g, check) = judged(Verdict::Warn);
    buy(&mut g, check);
}

// warn: the human (owner) approves on chain, then the agent may buy, still within the
// verdict's 120 s: the approval does not extend the life of the simulation it approves.
#[test]
fn an_approved_warn_is_bought_and_the_approval_is_logged() {
    let (mut g, check) = judged(Verdict::Warn);
    approve(&mut g, check, 650);
    assert!(g.get_check(check).unwrap().approved);
    let v = last_event();
    assert_eq!(v["event"], "warn_approved");
    assert_eq!(v["data"][0]["id"], check);
    assert_eq!(v["data"][0]["agent"], "agent.test");
    assert_eq!(v["data"][0]["target"], TARGET);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
    assert_eq!(sign_args()["request"]["payload_v2"]["Ecdsa"], HASH0);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_approves_a_warn() {
    let (mut g, check) = judged(Verdict::Warn);
    ctx("armer.test", 0, 650);
    g.approve_warn(check);
}

#[test]
#[should_panic(expected = "not a warn verdict")]
fn a_block_cannot_be_approved() {
    let (mut g, check) = judged(Verdict::Block);
    approve(&mut g, check, 650);
}

#[test]
#[should_panic(expected = "verdict expired")]
fn an_expired_warn_cannot_be_approved() {
    let (mut g, check) = judged(Verdict::Warn);
    approve(&mut g, check, 600 + VERDICT_TTL_NS);
}

#[test]
#[should_panic(expected = "verdict expired")]
fn an_approved_warn_still_expires_120_s_after_the_verdict() {
    let (mut g, check) = judged(Verdict::Warn);
    approve(&mut g, check, 650);
    ctx("agent.test", 0, 600 + VERDICT_TTL_NS);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "no verdict yet")]
fn buy_refused_without_a_verdict() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    buy(&mut g, check);
}

// the amount is stated at the check: one the armed budget cannot pay is refused before any
// simulation
#[test]
#[should_panic(expected = "budget exceeded")]
fn a_check_beyond_the_armed_budget_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(10 * VALUE), None);
}

#[test]
#[should_panic(expected = "budget expired")]
fn buy_refused_after_the_deadline() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("agent.test", 0, SEC);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "check belongs to another agent")]
fn buy_refused_to_another_agent() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("intruder.test", 0, 700);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "zero amount")]
fn a_check_of_zero_wei_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(0), None);
}

#[test]
#[should_panic(expected = "amount too large")]
fn amount_that_overflows_at_the_rate_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(u128::MAX), None);
}

// quote: posted by the sentinel with its verdict, basis of the minimum tokens computed by the guard
#[test]
fn the_quote_is_stored_and_logged_with_the_verdict() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(&g, check, QUOTE),
    );
    assert_eq!(g.get_check(check).unwrap().quote, U128(QUOTE));
    let v = last_event();
    assert_eq!(v["event"], "verdict_posted");
    assert_eq!(v["data"][0]["quote"], QUOTE.to_string());
}

#[test]
#[should_panic(expected = "allow without a quote")]
fn an_allow_without_a_quote_is_refused() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(0),
        code("aa"),
        true,
        vec![],
    );
}

#[test]
fn a_block_without_a_quote_is_accepted() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(0),
        code("aa"),
        true,
        vec![],
    );
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
}

#[test]
fn the_minimum_received_is_the_quote_minus_the_slippage_without_overflow() {
    assert_eq!(floor(QUOTE, 300), MIN_OUT);
    assert_eq!(floor(QUOTE, 0), QUOTE);
    assert_eq!(floor(10u128.pow(30), 300), 97 * 10u128.pow(28));
    assert_eq!(
        floor(u128::MAX, 300),
        u128::MAX / 10_000 * 9_700 + u128::MAX % 10_000 * 9_700 / 10_000
    );
}

#[test]
#[should_panic(expected = "minimum output rounds to zero")]
fn a_buy_whose_minimum_is_zero_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
    let hashes = previewed(&g, check, 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(1),
        code("aa"),
        true,
        hashes,
    );
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn an_invalid_evm_configuration_is_refused() {
    let bad = [
        EvmConfig {
            address: "0x1234".into(),
            ..evm()
        },
        EvmConfig {
            max_priority_fee_per_gas: U128(50_000_001),
            ..evm()
        },
        EvmConfig {
            yocto_per_wei: U128(0),
            ..evm()
        },
        EvmConfig {
            gas_limit: 0,
            ..evm()
        },
        EvmConfig {
            max_slippage_bps: 10_000,
            ..evm()
        },
        EvmConfig {
            withdraw_to: "0xbeef".into(),
            ..evm()
        },
    ];
    for config in bad {
        ctx("guard.test", 0, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Guard::new(
                id("owner.test"),
                id("armer.test"),
                id("sentinel.test"),
                U128(PRICE),
                config,
            )
        }));
        assert!(r.is_err(), "configuration acceptee a tort");
    }
}

// The chain a guard signs for is fixed at init: Base mainnet (the default) or Base Sepolia, each
// with the Uniswap V2 router the guard itself knows for it.
// viem 2.57 vectors (serializeTransaction, keccak256): the fields of `HASH0`, `APPROVE_HASH` and
// `SALE_FLOOR_0_HASH` with chain id 84532 and Base Sepolia's router; the same script gives those three.
const SEPOLIA_BUY: &str = "0x02f9011583014a3480830f42408402faf0808303d090941689e7b1f10000ae47ebfe339a4f69decd19f6028609184e72a000b8e4b6f9de950000000000000000000000000000000000000000000000000000000000004d6d00000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c0";
const SEPOLIA_APPROVE_HASH: &str =
    "8751f0d92d727c4aa91f19b94aa01ca5f8e4fc7154f8fe186657854e41aa3464";
const SEPOLIA_SALE_FLOOR_0_HASH: &str =
    "4a75566f6bbbeab5716d657c2c981cb10b954693b4c81542a22cf81f79d9820d";

fn sepolia_guard() -> Guard {
    guard_with(EvmConfig {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        ..evm()
    })
}

// a script that does not name the chain (app/setup.ts and app/deploy.ts before it was a parameter)
// gets a Base mainnet guard, whose transactions are the Base vectors of these tests (`HASH0`...)
#[test]
fn an_init_without_a_chain_id_is_a_base_mainnet_guard() {
    let mut json = near_sdk::serde_json::to_value(evm()).unwrap();
    json.as_object_mut().unwrap().remove("chain_id");
    let config: EvmConfig = near_sdk::serde_json::from_value(json).unwrap();
    assert_eq!(config.chain_id, 8453);
    assert_eq!(guard_with(config).evm_config().chain_id, 8453);
}

// chain id 84532 and Base Sepolia's router, in the buy and in the exit's approve and swap; no other
// byte differs from the Base transactions
#[test]
fn a_base_sepolia_guard_signs_for_chain_84532_on_its_own_router() {
    let mut g = sepolia_guard();
    assert_eq!(g.evm_config().chain_id, 84_532);
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(100 * U), 1000, U128(1000 * U), NO_BUY_LIMIT);
    g.register_agent(id("agent.test"));
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("agent.test")));
    arm_at(&mut g, 100 * U, 1, 0);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    assert_eq!(g.preview_check(check, U128(QUOTE)), [SEPOLIA_BUY]);
    let sale: Vec<String> = g
        .preview_sale(TARGET.into(), U128(SELL_AMOUNT), 300)
        .iter()
        .map(|t| hex(&env::keccak256_array(hex::decode(&t[2..]).unwrap())))
        .collect();
    assert_eq!(sale, [SEPOLIA_APPROVE_HASH, SEPOLIA_SALE_FLOOR_0_HASH]);
}

// the guard holds one router per chain it knows: any other chain is refused at init, so no guard
// of this code signs for Ethereum mainnet or another chain where its address may hold funds
#[test]
fn a_chain_the_guard_has_no_router_for_is_refused_at_init() {
    for chain_id in [0, 1, 8_452, 84_531, 11_155_111, u64::MAX] {
        ctx("guard.test", 0, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Guard::new(
                id("owner.test"),
                id("armer.test"),
                id("sentinel.test"),
                U128(PRICE),
                EvmConfig { chain_id, ..evm() },
            )
        }));
        assert!(r.is_err(), "chain id {chain_id} accepted");
    }
}

// the owner's gas settings are the only EVM parameters that move after init
#[test]
fn the_chain_stays_the_one_of_the_init_when_the_owner_sets_the_gas() {
    let mut g = sepolia_guard();
    ctx("owner.test", 0, 0);
    g.set_evm_gas(300_000, U128(60_000_000), U128(1_000_000));
    assert_eq!(g.evm_config().chain_id, 84_532);
}

// 22. gas: the owner may change the gas limit and fees within bounds (a sale that needs more gas
// can be retried); a verdict simulated with another gas limit neither buys nor exits
/// The owner sets the gas limit to `gas` (fees unchanged) at 650 ns.
fn set_gas(g: &mut Guard, gas: u64) {
    ctx("owner.test", 0, 650);
    g.set_evm_gas(gas, U128(50_000_000), U128(1_000_000));
}

#[test]
fn the_owner_sets_the_gas_limit_and_fees_within_bounds_with_an_event() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_evm_gas(600_000, U128(10_000_000_000), U128(2_000_000));
    let e = g.evm_config();
    assert_eq!(
        (e.gas_limit, e.max_fee_per_gas, e.max_priority_fee_per_gas),
        (600_000, U128(10_000_000_000), U128(2_000_000))
    );
    let v = last_event();
    assert_eq!(v["event"], "evm_gas_set");
    assert_eq!(v["data"][0]["gas_limit"], 600_000);
    assert_eq!(v["data"][0]["max_fee_per_gas"], "10000000000");
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_the_gas() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("agent.test", 0, 0);
    g.set_evm_gas(600_000, U128(50_000_000), U128(1_000_000));
}

#[test]
fn gas_settings_out_of_bounds_are_refused() {
    let bad: [(u64, u128, u128); 4] = [
        (20_999, 50_000_000, 1_000_000),
        (2_000_001, 50_000_000, 1_000_000),
        (250_000, 10_000_000_001, 1_000_000),
        (250_000, 50_000_000, 50_000_001),
    ];
    for (gas, fee, tip) in bad {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            g.set_evm_gas(gas, U128(fee), U128(tip));
        }));
        assert!(r.is_err(), "accepted gas {gas}, fee {fee}, tip {tip}");
    }
}

// its callback rebuilds the transaction from the config: changing it mid-signature would
// attach the signature to another transaction
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_gas_change_while_a_signature_is_in_progress() {
    let mut g = sell_as("owner.test");
    set_gas(&mut g, 600_000);
}

#[test]
fn after_raising_the_gas_the_owner_retries_a_sale_signed_with_it() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    set_gas(&mut g, 600_000);
    ctx("owner.test", 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    let raw = exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(raw.len(), 2);
    // RLP of the gas limit: 0x83 then 600,000 = 0x0927c0 (250,000 would be 0x8303d090)
    assert!(raw
        .iter()
        .all(|t| t.contains("830927c0") && !t.contains("8303d090")));
}

#[test]
#[should_panic(expected = "transaction differs from the one simulated")]
fn a_buy_on_a_verdict_simulated_with_another_gas_limit_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    set_gas(&mut g, 600_000);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

// same gas limit, another fee: tx.gasprice differs from the simulated one
#[test]
#[should_panic(expected = "transaction differs from the one simulated")]
fn a_buy_after_a_fee_change_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("owner.test", 0, 650);
    g.set_evm_gas(GAS, U128(50_000_000), U128(2_000_000));
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "transaction differs from the one simulated")]
fn an_exit_quote_simulated_with_another_gas_limit_is_refused() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    set_gas(&mut g, 600_000);
    sell_quoted_at(&mut g, exit, 1100);
}

// The freshness bound is the buy's, not the callback's: a signature is public once the MPC
// answers, so the callback settles it whenever it comes and never panics with the slot taken.
#[test]
fn a_signature_that_returns_after_the_swap_deadline_still_settles() {
    let (mut g, check) = judged(Verdict::Allow); // requested at 500, bought at 700
    buy(&mut g, check);
    callback_at(
        500 + (SWAP_DEADLINE_S + 60) * SEC,
        vec![PromiseResult::Successful(mpc_response(R0, S0, 1))],
    );
    let since = g.signing_since_ns;
    assert!(g.on_signed(since).is_some());
    let c = g.get_check(check).unwrap();
    assert!(c.settled && c.signed_tx.is_some());
    assert_eq!(g.signing_since(), None); // the slot is free
    assert_eq!(g.escrow(), U128(0));
}

#[test]
#[should_panic(expected = "check already settled")]
fn a_warn_already_bought_is_not_approved_again() {
    let (mut g, check) = judged(Verdict::Warn);
    approve(&mut g, check, 650);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    approve(&mut g, check, 900);
}

// Each callback settles its own kind of job only (the whole message, quoted: the one of a callback
// that names no job in progress starts the same).
#[test]
fn the_buy_callback_does_not_settle_an_exit_nor_the_exit_callback_a_buy() {
    let mut g = sell_as("owner.test");
    let said = panic_of(|| {
        signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    });
    assert!(said.contains(r#""no signature in progress""#), "{said}");
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    let said = panic_of(|| {
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    });
    assert!(
        said.contains(r#""no exit signature in progress""#),
        "{said}"
    );
}
