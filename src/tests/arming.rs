//! Roles and arming: the owner's bounds, arming and its 7-day cap, the arming log, the
//! armer, the human's stop and freeze, and who may do what.

use super::*;

#[test]
#[should_panic(expected = "budget expired")]
fn spend_refused_after_the_deadline() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, SEC);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "budget exceeded")]
fn spend_refused_beyond_the_budget() {
    let mut g = funded(ONE_NEAR, 15 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "budget not armed")]
fn spend_refused_without_an_armed_budget() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U); // bounds set, nothing armed
    ctx("agent.test", 0, 0);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "armer only")]
fn the_agent_does_not_arm() {
    let mut g = guard();
    ctx("agent.test", 0, 0);
    g.arm(id("agent.test"), U128(100 * U), 1, U128(0));
}

// the human's bounds: zero at init, set by the owner alone
#[test]
fn bounds_are_zero_at_init_then_set_by_the_owner() {
    let mut g = guard();
    let b = g.bounds();
    assert_eq!(
        (b.max_budget, b.max_duration_s, b.max_7d, b.max_buy_wei),
        (U128(0), 0, U128(0), U128(0))
    );
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(50 * U), 60, U128(200 * U), U128(VALUE));
    let b = g.bounds();
    assert_eq!(
        (b.max_budget, b.max_duration_s, b.max_7d, b.max_buy_wei),
        (U128(50 * U), 60, U128(200 * U), U128(VALUE))
    );
}

// The model's tool call states the buy's amount: the owner caps each buy on chain, not only the
// armed budget.
fn limited_to(max_buy_wei: u128) -> Guard {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(100 * U), 1000, U128(1000 * U), U128(max_buy_wei));
    g
}

#[test]
fn a_check_at_the_per_buy_limit_is_accepted() {
    let mut g = limited_to(VALUE);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "amount above the owner's per-buy limit")]
fn a_check_above_the_per_buy_limit_is_refused() {
    let mut g = limited_to(VALUE);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE + 1), None);
}

#[test]
#[should_panic(expected = "amount above the owner's per-buy limit")]
fn a_buy_above_a_limit_lowered_after_its_check_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("owner.test", 0, 650);
    g.set_bounds(U128(100 * U), 1000, U128(1000 * U), U128(VALUE - 1));
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_armer_does_not_set_the_bounds() {
    let mut g = guard();
    ctx("armer.test", 0, 0);
    g.set_bounds(U128(ONE_NEAR), 1000, U128(ONE_NEAR), NO_BUY_LIMIT);
}

#[test]
#[should_panic(expected = "budget above the human's bound")]
fn no_arming_without_bounds() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.register_agent(id("agent.test"));
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("agent.test")));
    arm_at(&mut g, 1, 1, 0);
}

// otherwise budget 0 and duration 0 would pass the zero bounds of init
#[test]
#[should_panic(expected = "zero budget")]
fn zero_budget_refused() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.register_agent(id("agent.test"));
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("agent.test")));
    arm_at(&mut g, 0, 0, 0);
}

#[test]
fn budget_and_duration_accepted_at_the_bound() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
    arm_at(&mut g, 50 * U, 60, 0);
    assert_eq!(g.budget_left(&id("agent.test")).0, 50 * U);
}

#[test]
#[should_panic(expected = "budget above the human's bound")]
fn budget_above_the_bound_refused() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
    arm_at(&mut g, 50 * U + 1, 60, 0);
}

#[test]
#[should_panic(expected = "duration above the human's bound")]
fn duration_above_the_bound_refused() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
    arm_at(&mut g, 50 * U, 61, 0);
}

// integrity check: the armer arms on the state it read; credit spent or drained since is refused
#[test]
#[should_panic(expected = "integrity check failed: credit below what the armer read")]
fn arming_refused_if_the_credit_dropped() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
    ctx("armer.test", 0, 0);
    let credit = g.credit_of(&id("agent.test")).0;
    g.arm(id("agent.test"), U128(50 * U), 60, U128(credit + 1));
}

// judge's griefing: anyone may deposit for the agent (1 yocto every 2 s); a top-up between the
// armer's read and its arming must not refuse the arming
#[test]
fn a_third_party_deposit_does_not_prevent_arming() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
    ctx("armer.test", 0, 0);
    let read = g.credit_of(&id("agent.test"));
    ctx("griefer.test", 1, 0);
    g.deposit_credit(Some(id("agent.test")));
    ctx("armer.test", 0, 0);
    g.arm(id("agent.test"), U128(50 * U), 60, read);
    assert_eq!(g.budget_left(&id("agent.test")), U128(50 * U));
}

// otherwise the armer creates a budget and log for any account, at the contract's expense
#[test]
#[should_panic(expected = "integrity check failed: agent never credited")]
fn arming_refused_for_an_agent_never_credited() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(50 * U), 60, U128(1000 * U), NO_BUY_LIMIT);
    g.register_agent(id("agent.test"));
    arm_at(&mut g, 50 * U, 60, 0);
}

// 7-day rolling cap: the whole armed budget counts, even if unspent
#[test]
fn the_7_day_cap_admits_the_exact_total() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(0));
    arm_at(&mut g, 60 * U, 1000, 0);
    arm_at(&mut g, 40 * U, 1000, SEC);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(100 * U));
}

#[test]
#[should_panic(expected = "7-day cap exceeded")]
fn the_7_day_cap_accumulates_armed_budgets() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    arm_at(&mut g, 60 * U, 1000, 0);
    arm_at(&mut g, 41 * U, 1000, SEC);
}

#[test]
#[should_panic(expected = "7-day cap exceeded")]
fn an_arming_counts_up_to_7_days() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    arm_at(&mut g, 60 * U, 1000, SEC);
    arm_at(&mut g, 60 * U, 1000, SEC + WEEK_NS - 1);
}

#[test]
fn an_arming_leaves_the_window_after_7_days() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    arm_at(&mut g, 60 * U, 1000, SEC);
    ctx("agent.test", 0, SEC + WEEK_NS);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(0)); // the view follows block time
    arm_at(&mut g, 60 * U, 1000, SEC + WEEK_NS);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(60 * U));
}

// otherwise the armer would get around the cap by disarming then re-arming
#[test]
#[should_panic(expected = "7-day cap exceeded")]
fn disarming_does_not_reset_the_cap_to_zero() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    arm_at(&mut g, 60 * U, 1000, 0);
    g.disarm(id("agent.test"));
    arm_at(&mut g, 60 * U, 1000, SEC);
}

#[test]
fn rearming_replaces_the_current_budget() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    g.request_check(TARGET.into(), U128(VALUE), None);
    arm_at(&mut g, 30 * U, 1000, SEC);
    assert_eq!(g.budget_left(&id("agent.test")).0, 30 * U);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(130 * U));
}

#[test]
fn arming_is_logged() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    arm_at(&mut g, 60 * U, 1000, 0);
    arm_at(&mut g, 30 * U, 10, 5 * SEC);
    let v = last_event();
    assert_eq!(v["event"], "armed");
    let d = &v["data"][0];
    assert_eq!(d["agent"], "agent.test");
    assert_eq!(d["armer"], "armer.test");
    assert_eq!(d["budget"], (30 * U).to_string());
    assert_eq!(d["expires_ns"], (15 * SEC).to_string());
    assert_eq!(d["armed_7d"], (90 * U).to_string());
}

// storage paid by the contract: number of armings over 7 days bounded, refused beyond
#[test]
fn the_log_is_bounded_then_purged_after_7_days() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    for i in 0..MAX_ARMINGS_7D {
        arm_at(&mut g, 1, 1000, u64::try_from(i).unwrap() * SEC);
    }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arm_at(&mut g, 1, 1000, 100 * SEC);
    }));
    assert!(r.is_err(), "arming beyond the log refused");
    arm_at(&mut g, 1, 1000, 100 * SEC + WEEK_NS); // old entries are purged
    assert_eq!(g.armed_7d(&id("agent.test")), U128(1));
}

#[test]
#[should_panic(expected = "too many armings in 7 days")]
fn arming_refused_log_full() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    for _ in 0..=MAX_ARMINGS_7D {
        arm_at(&mut g, 1, 1000, 0);
    }
}

// a single human can hold both roles; the bounds still apply
#[test]
fn a_single_human_can_be_owner_and_armer() {
    ctx("guard.test", 0, 0);
    let mut g = Guard::new(
        id("owner.test"),
        id("owner.test"),
        id("sentinel.test"),
        U128(PRICE),
        evm(),
    );
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(50 * U), 60, U128(100 * U), NO_BUY_LIMIT);
    g.register_agent(id("agent.test"));
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("agent.test")));
    ctx("owner.test", 0, 0);
    let credit = g.credit_of(&id("agent.test"));
    g.arm(id("agent.test"), U128(50 * U), 60, credit);
    assert_eq!(g.budget_left(&id("agent.test")).0, 50 * U);
}

// the agent that pays is never the one that arms
#[test]
#[should_panic(expected = "the armer cannot arm itself")]
fn the_armer_does_not_arm_itself() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 100 * U);
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("armer.test")));
    ctx("armer.test", 0, 0);
    let credit = g.credit_of(&id("armer.test"));
    g.arm(id("armer.test"), U128(50 * U), 60, credit);
}

#[test]
#[should_panic(expected = "armer only")]
fn the_owner_no_longer_arms() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.arm(id("agent.test"), U128(100 * U), 1, U128(0));
}

// 2. initializer reserved to the contract account
#[test]
#[should_panic(expected = "init reserved to the contract account")]
fn new_refuses_a_third_party() {
    ctx("intruder.test", 0, 0);
    let _ = Guard::new(
        id("intruder.test"),
        id("intruder.test"),
        id("intruder.test"),
        U128(PRICE),
        evm(),
    );
}

// 8. arming for a duration, from block time
#[test]
fn arming_runs_from_the_block() {
    let mut g = funded(ONE_NEAR, 100 * U, 0);
    arm_at(&mut g, 100 * U, 60, 10 * SEC);
    ctx("agent.test", 0, 69 * SEC);
    g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("agent.test", 0, 70 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        g.request_check(TARGET.into(), U128(VALUE), None)
    }));
    assert!(r.is_err(), "expired at 10 s + 60 s");
}

// 9. emergency stop by the human
#[test]
#[should_panic(expected = "budget not armed")]
fn disarming_cuts_all_spending() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "owner or armer only")]
fn the_agent_does_not_disarm() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 0);
    g.disarm(id("agent.test"));
}

// abnormal stop: the armer also disarms
#[test]
#[should_panic(expected = "budget not armed")]
fn the_armer_disarms_too() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("armer.test", 0, 0);
    g.disarm(id("agent.test"));
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
fn disarming_is_logged() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    let v = &events()[0];
    assert_eq!(v["event"], "disarmed");
    assert_eq!(v["data"][0]["agent"], "agent.test");
    assert_eq!(v["data"][0]["by"], "owner.test");
}

// human's emergency stop: the agent is frozen, the armer cannot re-arm it right away
#[test]
#[should_panic(expected = "agent frozen by the owner")]
fn the_armer_does_not_rearm_after_the_human_stop() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    arm_at(&mut g, 10 * U, 1000, SEC);
}

#[test]
fn the_freeze_is_logged() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    let v = last_event();
    assert_eq!(v["event"], "frozen");
    assert_eq!(v["data"][0]["agent"], "agent.test");
}

// abnormal stop noticed by the armer: no freeze, it can re-arm
#[test]
fn disarming_by_the_armer_does_not_freeze() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("armer.test", 0, 0);
    g.disarm(id("agent.test"));
    assert!(events().iter().all(|v| v["event"] != "frozen"));
    arm_at(&mut g, 10 * U, 1000, SEC);
    assert_eq!(g.budget_left(&id("agent.test")).0, 10 * U);
}

#[test]
fn only_the_human_unfreezes_then_the_armer_rearms() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    g.unfreeze(id("agent.test"));
    let v = last_event();
    assert_eq!(v["event"], "unfrozen");
    assert_eq!(v["data"][0]["agent"], "agent.test");
    arm_at(&mut g, 10 * U, 1000, SEC);
    assert_eq!(g.budget_left(&id("agent.test")).0, 10 * U);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_armer_does_not_unfreeze() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    ctx("armer.test", 0, 0);
    g.unfreeze(id("agent.test"));
}

// revocation of a compromised armer by the human
#[test]
#[should_panic(expected = "armer only")]
fn a_revoked_armer_no_longer_arms() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 100 * U);
    ctx("owner.test", 0, 0);
    g.set_armer(id("armer2.test"));
    arm_at(&mut g, 10 * U, 60, 0);
}

#[test]
fn the_new_armer_arms_and_the_change_is_logged() {
    let mut g = credited(ONE_NEAR, 50 * U, 60, 100 * U);
    ctx("owner.test", 0, 0);
    g.set_armer(id("armer2.test"));
    let v = last_event();
    assert_eq!(v["event"], "armer_changed");
    assert_eq!(v["data"][0]["previous"], "armer.test");
    assert_eq!(v["data"][0]["armer"], "armer2.test");
    ctx("armer2.test", 0, 0);
    let credit = g.credit_of(&id("agent.test"));
    g.arm(id("agent.test"), U128(10 * U), 60, credit);
    assert_eq!(g.budget_left(&id("agent.test")).0, 10 * U);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_armer_does_not_replace_itself() {
    let mut g = guard();
    ctx("armer.test", 0, 0);
    g.set_armer(id("armer2.test"));
}

// a compromised sentinel key is replaced by the owner: the old key no longer posts verdicts
#[test]
fn the_owner_replaces_the_sentinel_and_the_change_is_logged() {
    let (mut g, check) = pending();
    ctx("owner.test", 0, 1);
    g.set_sentinels(vec![id("sentinel2.test")], 1);
    let v = last_event();
    assert_eq!(v["event"], "sentinels_changed");
    assert_eq!(v["data"][0]["previous"][0], "sentinel.test");
    assert_eq!(v["data"][0]["sentinels"][0], "sentinel2.test");
    assert_eq!(v["data"][0]["quorum"], 1);
    ctx("sentinel.test", 0, 2);
    let old = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        g.post_verdict(
            check,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(0),
            None,
            false,
            vec![],
        );
    }));
    assert!(old.is_err(), "the replaced sentinel still posts");
    ctx("sentinel2.test", 0, 3);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(0),
        None,
        false,
        vec![],
    );
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_replaces_the_sentinel() {
    let mut g = guard();
    ctx("sentinel.test", 0, 0);
    g.set_sentinels(vec![id("sentinel2.test")], 1);
}

// log storage paid by the contract: only agents registered by the human are armed
#[test]
#[should_panic(expected = "agent not registered by the owner")]
fn the_armer_does_not_arm_an_unregistered_account() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_bounds(U128(50 * U), 60, U128(100 * U), NO_BUY_LIMIT);
    ctx("intruder.test", ONE_NEAR, 0); // credit deposited by the account itself
    g.deposit_credit(None);
    ctx("armer.test", 0, 0);
    let credit = g.credit_of(&id("intruder.test"));
    g.arm(id("intruder.test"), U128(10 * U), 60, credit);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_human_registers_an_agent() {
    let mut g = guard();
    ctx("armer.test", 0, 0);
    g.register_agent(id("intruder.test"));
}

#[test]
fn the_log_purges_armings_that_left_the_window() {
    const DAY: u64 = 24 * 3600 * SEC;
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    arm_at(&mut g, 10 * U, 1000, 0);
    arm_at(&mut g, 10 * U, 1000, 5 * DAY);
    arm_at(&mut g, 10 * U, 1000, 8 * DAY);
    assert_eq!(g.armings.get(&id("agent.test")).unwrap().len(), 2);
}

// A compromised armer can lock an agent out for 7 days (full log or exhausted cap): the owner
// replaces it and resets the agent's arming log, then the new armer arms again.
#[test]
fn the_owner_resets_a_full_arming_log_after_replacing_the_armer() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    for _ in 0..MAX_ARMINGS_7D {
        arm_at(&mut g, 1, 1000, 0);
    }
    ctx("owner.test", 0, SEC);
    g.set_armer(id("armer2.test"));
    g.reset_armings(id("agent.test"));
    let v = last_event();
    assert_eq!(v["event"], "armings_reset");
    assert_eq!(v["data"][0]["agent"], "agent.test");
    assert_eq!(v["data"][0]["cleared"], MAX_ARMINGS_7D);
    assert_eq!(v["data"][0]["armed_7d"], MAX_ARMINGS_7D.to_string());
    assert_eq!(g.armed_7d(&id("agent.test")), U128(0));
    ctx("armer2.test", 0, 2 * SEC);
    let credit = g.credit_of(&id("agent.test"));
    g.arm(id("agent.test"), U128(10 * U), 60, credit);
    assert_eq!(g.budget_left(&id("agent.test")).0, 10 * U);
}

#[test]
fn the_owner_resets_an_exhausted_7_day_cap() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
    arm_at(&mut g, 100 * U, 1000, 0);
    ctx("owner.test", 0, SEC);
    g.reset_armings(id("agent.test"));
    arm_at(&mut g, 100 * U, 1000, 2 * SEC);
    assert_eq!(g.armed_7d(&id("agent.test")), U128(100 * U));
}

#[test]
#[should_panic(expected = "owner only")]
fn the_armer_cannot_reset_the_arming_log() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("armer.test", 0, SEC);
    g.reset_armings(id("agent.test"));
}

#[test]
fn the_empty_log_is_deleted_at_disarm() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("armer.test", 0, WEEK_NS);
    g.disarm(id("agent.test"));
    assert!(g.armings.get(&id("agent.test")).is_none());
}
