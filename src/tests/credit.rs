//! Credit, fees and refunds: deposits, the check price in escrow, fee withdrawal, refunds and
//! the storage the price covers.

use super::*;

#[test]
fn deposit_credit_credits_the_account() {
    let mut g = guard();
    ctx("agent.test", ONE_NEAR, 0);
    g.deposit_credit(None);
    let first = g.credit_of(&id("agent.test")).0;
    assert!(first > 0 && first < ONE_NEAR); // deposit minus the storage of the new account
    ctx("agent.test", 25, 0);
    g.deposit_credit(None);
    assert_eq!(g.credit_of(&id("agent.test")).0, first + 25);
    assert_eq!(g.credit_of(&id("other.test")).0, 0);
}

#[test]
fn request_check_debits_the_fixed_price() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    let before = g.credit_of(&id("agent.test")).0;
    ctx("agent.test", 0, 500);
    assert_eq!(g.request_check(TARGET.into(), U128(VALUE), None), 1);
    assert_eq!(g.credit_of(&id("agent.test")).0, before - PRICE);
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE);
}

#[test]
#[should_panic(expected = "insufficient credit")]
fn request_check_refused_without_enough_credit() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 0);
    let _ = g.refund_credit(); // credit at zero
    arm_at(&mut g, 100 * U, 1, 0);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

// 3. fees collected and credit recoverable
#[test]
fn fees_accounted_separately_and_withdrawable() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let a = g.request_check(TARGET.into(), U128(VALUE), None);
    let b = g.request_check(OTHER.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 500);
    g.post_verdict(
        a,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(&g, a, QUOTE),
    );
    g.post_verdict(
        b,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        vec![],
    );
    assert_eq!(g.fees(), U128(2 * PRICE));
    ctx("owner.test", 0, 500);
    let _ = g.withdraw_fees(U128(15 * U));
    assert_eq!(g.fees(), U128(2 * PRICE - 15 * U));
}

#[test]
#[should_panic(expected = "exceeds collected fees")]
fn withdrawal_capped_at_the_fees() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let a = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 500);
    g.post_verdict(
        a,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(&g, a, QUOTE),
    );
    ctx("owner.test", 0, 500);
    let _ = g.withdraw_fees(U128(PRICE + 1));
}

#[test]
#[should_panic(expected = "owner only")]
fn withdrawal_reserved_to_the_owner() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    let _ = g.withdraw_fees(U128(1));
}

#[test]
fn refund_of_unused_credit() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    let left = g.credit_of(&id("agent.test")).0;
    assert!(left > 0);
    let _ = g.refund_credit();
    assert_eq!(g.credit_of(&id("agent.test")).0, 0);
    assert_eq!(g.fees(), U128(0)); // the request's price stays in escrow
}

// 4. storage of a new account covered by its deposit
#[test]
#[should_panic(expected = "deposit does not cover storage")]
fn tiny_deposit_refused_for_a_new_account() {
    let mut g = guard();
    ctx("agent.test", 1, 0);
    g.deposit_credit(None);
}

// 7. credit deposited by the human for the agent (its function-call key cannot attach anything)
#[test]
fn the_owner_credits_the_agent() {
    let g = funded(ONE_NEAR, 100 * U, 1);
    let credit = g.credit_of(&id("agent.test")).0;
    assert!(credit > 0 && credit < ONE_NEAR);
    assert_eq!(g.credit_of(&id("owner.test")).0, 0);
}

// 10. price refund if the sentinel does not answer within the delay
#[test]
fn price_refunded_without_a_verdict_after_the_delay() {
    let (mut g, check) = pending();
    let credit = g.credit_of(&id("agent.test")).0;
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit + PRICE);
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE); // the budget does not come back
    assert_eq!(g.fees(), U128(0));
    assert!(g.get_check(check).is_none(), "stockage libere");
}

#[test]
#[should_panic(expected = "timeout not reached")]
fn no_refund_before_the_delay() {
    let (mut g, check) = pending();
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS - 1);
    g.refund_check(check);
}

#[test]
#[should_panic(expected = "verdict already posted")]
fn no_refund_after_a_verdict() {
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
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
}

#[test]
#[should_panic(expected = "unknown check")]
fn one_refund_only() {
    let (mut g, check) = pending();
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    g.refund_check(check);
}

#[test]
#[should_panic(expected = "unknown check")]
fn no_verdict_after_refund() {
    let (mut g, check) = pending();
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    ctx("sentinel.test", 0, VERDICT_TIMEOUT_NS);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        vec![],
    );
}

#[test]
#[should_panic(expected = "check belongs to another agent")]
fn only_the_agent_gets_refunded() {
    let (mut g, check) = pending();
    ctx("intruder.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
}

// 11. a request's price stays in escrow until the verdict
#[test]
#[should_panic(expected = "exceeds collected fees")]
fn the_pending_price_is_not_withdrawable() {
    let (mut g, _check) = pending();
    ctx("owner.test", 0, 0);
    let _ = g.withdraw_fees(U128(PRICE));
}

// agent of 64 characters, reasons and proof at the maximum: the price always covers the request
/// Storage bytes of one worst-case check, on the block path (`allow == false`: code, `seen`, a
/// listing and the token's quarantine) or the buy path (`allow == true`: code, `seen`, signed tx,
/// both decision hashes, the agent's holdings entry and the token's first entry in its log of buys).
fn worst_case_bytes(allow: bool) -> u128 {
    let big = id(&"a".repeat(64));
    ctx("guard.test", 0, 0);
    // the agent is also the sentinel: request and verdict in the same measurement context
    let mut g = Guard::new(
        id("owner.test"),
        id("armer.test"),
        big.clone(),
        U128(PRICE),
        evm(),
    );
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(100 * U), 1000, U128(1000 * U), NO_BUY_LIMIT);
    g.set_token_cap(U128(u128::MAX), MAX_CAP_PERIOD_S);
    g.register_agent(big.clone());
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(big.clone()));
    ctx("armer.test", 0, 0);
    let credit = g.credit_of(&big);
    g.arm(big.clone(), U128(100 * U), 1000, credit);
    ctx(big.as_str(), 0, 1);
    g.credits.flush();
    g.budgets.flush();
    g.armings.flush();
    let before = env::storage_usage();
    let check = g.request_check(TARGET.into(), U128(VALUE), Some("f".repeat(64)));
    g.post_verdict(
        check,
        if allow {
            Verdict::Allow
        } else {
            Verdict::Block
        },
        "r".repeat(MAX_REASONS),
        "e".repeat(MAX_EVIDENCE),
        U128(QUOTE),
        proxy("11"), // code with a proxy implementation; either verdict also writes `seen`
        true,
        if allow {
            previewed(&g, check, QUOTE)
        } else {
            vec![]
        },
    );
    let c = g.checks.get_mut(&check).unwrap();
    c.exit_amount = Some(U128(u128::MAX));
    c.amount_wei = U128(u128::MAX);
    c.tx_hashes = vec!["f".repeat(64); MAX_TX_HASHES]; // an exit's approve and swap
                                                       // every sentinel voted, each under a 64-character account
    c.votes = vec![c.votes[0].clone(); MAX_SENTINELS];
    if allow {
        // Longest signed transaction: type 1, list header 3, chain id 3, nonce 9,
        // fees 17 + 17, gas 9, router 21, value 17, data 3 + 228, access 1, v 1, r 33, s 33.
        c.signed_tx = Some(vec![0xff; 396].into());
        c.settled = true;
        c.buy_decision_sha256 = Some("e".repeat(64));
        g.decisions.insert("e".repeat(64), u64::MAX);
        g.holdings
            .insert(TARGET.to_ascii_lowercase(), (big.clone(), u128::MAX));
        g.token_buys
            .insert(TARGET.to_ascii_lowercase(), vec![(u64::MAX, u128::MAX)]);
    }
    g.quarantine.flush();
    g.pending.flush();
    g.token_buys.flush();
    g.checks.flush();
    g.credits.flush();
    g.budgets.flush();
    g.seen.flush();
    g.blocklist.flush();
    g.holdings.flush();
    g.decisions.flush();
    u128::from(env::storage_usage() - before)
}

// A block check is never bought and only a block lists, so the two worst cases are exclusive
// (each in its own test: the mock storage outlives a guard).
#[test]
fn the_upper_bound_covers_a_request_at_worst_case() {
    let used = worst_case_bytes(true);
    assert!(
        used > 0 && used <= CHECK_STORAGE_BYTES,
        "{used} bytes for a request"
    );
}

#[test]
fn the_upper_bound_covers_a_block_at_worst_case() {
    let used = worst_case_bytes(false);
    assert!(
        used > 0 && used <= CHECK_STORAGE_BYTES,
        "{used} bytes for a block"
    );
}

#[test]
fn the_verdict_makes_the_price_withdrawable() {
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
    assert_eq!(g.fees(), U128(PRICE));
}

// 12. security review: storage covered by the price, budget never topped up again
#[test]
#[should_panic(expected = "price below the storage cost of a check")]
fn the_price_covers_the_storage_of_a_request() {
    ctx("guard.test", 0, 0);
    let _ = Guard::new(
        id("owner.test"),
        id("armer.test"),
        id("sentinel.test"),
        U128(U),
        evm(),
    );
}

#[test]
fn a_refund_does_not_exceed_the_new_arming() {
    let (mut g, check) = pending();
    arm_at(&mut g, 100 * U, 1000, 0);
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U);
}

// Judge pass 6: the owner withdrew every fee, then an agent's `refund_credit` failed for lack of
// balance for the state. A price collected paid for storage; credits and escrow are owed.
/// The runtime's view of the guard at a call: its balance and its storage usage.
fn ctx_holding(who: &str, balance: u128, storage: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("guard.test"))
        .predecessor_account_id(id(who))
        .account_balance(NearToken::from_yoctonear(balance))
        .storage_usage(storage)
        .build());
}

/// A blocked check (its price in the fees), the guard's storage usage, and a balance that pays
/// for that storage and the agent's credit, nothing more: the price collected paid for storage.
fn fees_spent_on_storage() -> (Guard, u64, u128) {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        false,
        vec![],
    );
    let storage = env::storage_usage();
    let held = u128::from(storage) * env::storage_byte_cost().as_yoctonear()
        + g.credit_of(&id("agent.test")).0;
    (g, storage, held)
}

#[test]
#[should_panic(expected = "less than storage, credits and escrow need")]
fn a_fee_withdrawal_never_takes_what_storage_and_credits_need() {
    let (mut g, storage, held) = fees_spent_on_storage();
    ctx_holding("owner.test", held, storage);
    let _ = g.withdraw_fees(g.fees());
}

#[test]
fn withdraw_fees_then_refund_credit_succeeds() {
    let (mut g, storage, held) = fees_spent_on_storage();
    ctx_holding("owner.test", held + PRICE / 2, storage); // half a price above what is owed
    let _ = g.withdraw_fees(U128(PRICE / 2));
    ctx_holding("agent.test", env::account_balance().as_yoctonear(), storage);
    let _ = g.refund_credit();
    assert_eq!(g.credit_of(&id("agent.test")), U128(0));
    // what the runtime requires after the call: the balance left still pays for the state
    assert!(
        env::account_balance().as_yoctonear()
            >= u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
    );
}

// Fix pass 8: a check's price moves to the fees at its verdict, yet the storage it pays for is written
// later, by the buy and its callback. A withdrawal in between takes that price; a buy whose signature
// then does not come back reserves its nonce out of what the credits and the escrow are owed.
#[test]
fn fees_withdrawn_before_a_buy_leave_its_reservation_unpaid() {
    let (mut g, check) = judged(Verdict::Allow);
    let flush = |g: &mut Guard| {
        g.checks.flush();
        g.credits.flush();
        g.budgets.flush();
        g.holdings.flush();
        g.decisions.flush();
        g.unsettled.flush();
    };
    let owed = |g: &Guard| {
        u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
            + g.credits_total().0
            + g.escrow().0
    };
    flush(&mut g);
    let storage = env::storage_usage();
    ctx_holding("owner.test", owed(&g) + g.fees().0, storage);
    let _ = g.withdraw_fees(g.fees()); // every fee, the check's price included: accepted
    let balance = env::account_balance().as_yoctonear();
    assert_eq!(balance, owed(&g));
    ctx_holding("agent.test", balance, storage);
    buy(&mut g, check);
    flush(&mut g);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guard.test"))
            .predecessor_account_id(id("guard.test"))
            .account_balance(NearToken::from_yoctonear(balance))
            .storage_usage(env::storage_usage())
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Failed],
    );
    let since = g.signing_since_ns;
    assert_eq!(g.on_signed(since), None);
    flush(&mut g);
    assert!(g.get_unsettled(0).is_some());
    assert!(env::storage_usage() > storage);
    assert!(balance < owed(&g)); // short by the reservation's storage until the owner deposits
}

// Unreachable through the contract's own calls (a settled check has a verdict, refused first):
// the state is forced here, to pin the refusal should the order above it ever change.
#[test]
#[should_panic(expected = "check already settled")]
fn a_settled_check_is_never_refunded() {
    let (mut g, check) = pending();
    g.checks.get_mut(&check).unwrap().settled = true;
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
}
