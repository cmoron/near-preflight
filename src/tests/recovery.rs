//! Recovery and stop: a signature that does not come back, nonce reservation and replacement,
//! the release of the signing slot, and a stop during a check or a signature.

use super::*;

// 19. A signature that does not come back stays reserved (red team, after the fifth judge run): the
// MPC may still publish it after the yield timed out (its `respond` transaction is public), so its
// nonce, its charge and the tokens it sells stay reserved until the owner settles it.
/// viem 2.57: 0 wei to `WITHDRAW_TO` at nonce 0, unsigned: the owner's replacement of nonce 0.
const REPLACE0_HASH: &str = "5e976a8b891cb75214771ef2f4bfe5ffdae48108d6a5963befe2ddac772411d5";

/// A buy of `judged` whose signature failed: nonce 0 reserved.
fn failed_buy() -> (Guard, u64) {
    let (mut g, check) = judged(Verdict::Allow);
    let _ = g.buy(check, U128(VALUE), Some("1".repeat(64)));
    assert_eq!(signed(&mut g, PromiseResult::Failed), None);
    (g, check)
}

#[test]
fn a_failed_buy_signature_keeps_the_charge_and_reserves_its_nonce() {
    let (g, check) = failed_buy();
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - COST); // still debited
    assert_eq!(g.fees(), U128(PRICE)); // neither spent nor refunded
    assert_eq!(g.escrow, COST);
    assert_eq!(g.evm_nonce, 1); // the next transaction never reuses nonce 0
    let u = g.get_unsettled(0).unwrap();
    assert_eq!(
        (u.agent.as_ref(), u.check, u.cost),
        (Some(&id("agent.test")), Some(check), U128(COST))
    );
    assert_eq!(g.decision_of("1".repeat(64)), Some(U64(check))); // the decision stays anchored
    let v = last_event();
    assert_eq!(v["event"], "sign_unsettled");
    assert_eq!(v["data"][0]["nonce"], 0);
    assert_eq!(v["data"][0]["id"], check);
}

#[test]
#[should_panic(expected = "check already settled")]
fn after_a_failed_signature_the_agent_cannot_buy_again_at_the_same_nonce() {
    let (mut g, check) = failed_buy();
    ctx("agent.test", 0, 900);
    buy(&mut g, check);
}

#[test]
fn the_owner_refunds_an_unsettled_buy_once_its_nonce_is_replaced() {
    let (mut g, check) = failed_buy();
    let credit = g.credit_of(&id("agent.test")).0;
    replaced(&mut g, 0, 900);
    g.clear_unsettled(0, true);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit + COST);
    assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE);
    assert_eq!((g.escrow, g.fees()), (0, U128(PRICE)));
    assert!(g.get_unsettled(0).is_none());
    assert_eq!(g.decision_of("1".repeat(64)), None); // it backed nothing that happened
    assert!(g.get_check(check).unwrap().buy_decision_sha256.is_none());
    let v = last_event();
    assert_eq!(v["event"], "unsettled_cleared");
    assert_eq!(v["data"][0]["refund"], true);
}

#[test]
fn the_owner_counts_an_unsettled_buy_as_spent_when_its_late_signature_was_mined() {
    let (mut g, _) = failed_buy();
    let credit = g.credit_of(&id("agent.test")).0;
    ctx("owner.test", 0, 900);
    g.clear_unsettled(0, false);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit);
    assert_eq!((g.escrow, g.fees()), (0, U128(PRICE + COST)));
}

#[test]
fn a_refund_goes_to_the_debited_arming_only() {
    let (mut g, _) = failed_buy();
    arm_at(&mut g, 30 * U, 1000, 850);
    replaced(&mut g, 0, 900);
    g.clear_unsettled(0, true);
    assert_eq!(g.budget_left(&id("agent.test")).0, 30 * U); // the re-arming is not topped up
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_clears_an_unsettled_transaction() {
    let (mut g, _) = failed_buy();
    ctx("agent.test", 0, 900);
    g.clear_unsettled(0, true);
}

#[test]
#[should_panic(expected = "no unsettled transaction at this nonce")]
fn clearing_a_nonce_with_nothing_unsettled_is_refused() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    g.clear_unsettled(0, false);
    g.clear_unsettled(0, false);
}

#[test]
fn a_failed_exit_keeps_every_nonce_its_charge_and_its_tokens_reserved() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    let credit = g.credit_of(&id("agent.test")).0;
    let held = holding_of(&g, "agent.test");
    sell_quoted_at(&mut g, exit, 1100); // approve at nonce 1, swap at nonce 2
    exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]);
    assert_eq!(g.evm_nonce, 3);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST); // the swap's half stays charged
    assert_eq!(holding_of(&g, "agent.test"), held - SELL_AMOUNT); // its tokens stay reserved
    let u = g.get_unsettled(2).unwrap();
    assert_eq!(
        (u.cost, u.restore.clone()),
        (
            U128(EXIT_COST / 2),
            Some((TARGET.to_owned(), U128(SELL_AMOUNT)))
        )
    );
    assert!(g.get_check(exit).unwrap().settled);
    let budget = g.budget_left(&id("agent.test")).0;
    replaced(&mut g, 2, 1200);
    g.clear_unsettled(2, true);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST / 2);
    assert_eq!(g.budget_left(&id("agent.test")).0, budget); // a sale never touched it
    assert_eq!(holding_of(&g, "agent.test"), held);
}

#[test]
fn an_exit_with_no_signature_reserves_both_nonces() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    sell_quoted_at(&mut g, exit, 1100);
    assert!(exit_signed(&mut g, vec![PromiseResult::Failed, PromiseResult::Failed]).is_empty());
    assert_eq!(g.evm_nonce, 3);
    assert!(g.get_unsettled(1).unwrap().restore.is_none()); // the approve
    assert!(g.get_unsettled(2).unwrap().restore.is_some()); // the swap carries the tokens
}

#[test]
fn the_owners_failed_sale_reserves_its_nonces_with_nothing_charged() {
    let mut g = sell_as("owner.test");
    exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]);
    assert_eq!(g.evm_nonce, 2);
    let u = g.get_unsettled(1).unwrap();
    assert_eq!((u.agent.clone(), u.cost), (None, U128(0)));
}

#[test]
fn the_owner_signs_a_replacement_at_a_reserved_nonce() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(0);
    assert_eq!(signed_hashes(b"on_exit_signed"), [REPLACE0_HASH]); // 0 wei to the owner's address, nonce 0
    assert_eq!(exit_signed(&mut g, vec![ok_sig(SIG_A)]).len(), 1);
    assert_eq!(g.evm_nonce, 1); // nothing new reserved
    assert_eq!(g.last_exit().unwrap().nonce, 0);
    assert!(g.get_unsettled(0).unwrap().replaced); // settling stays the owner's call, once it is mined
}

#[test]
fn a_failed_replacement_reserves_nothing() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(0);
    assert!(exit_signed(&mut g, vec![PromiseResult::Failed]).is_empty());
    assert_eq!(g.evm_nonce, 1);
    assert!(!g.get_unsettled(0).unwrap().replaced); // the buy's entry, still the only one
}

#[test]
#[should_panic(expected = "no unsettled transaction at this nonce")]
fn a_replacement_is_for_a_reserved_nonce_only() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(1);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_signs_a_replacement() {
    let (mut g, _) = failed_buy();
    ctx("agent.test", 0, 900);
    let _ = g.sign_replacement(0);
}

// A check's price covers its worst case with a signed transaction (396 bytes) and the holdings
// entry a signed buy adds (the_upper_bound_covers_a_request_at_worst_case). A signature that does not
// come back writes neither, and reserves at most two transactions per check (an exit's approve and
// swap): two worst-case reservations must fit in what they leave unwritten.
#[test]
fn two_reservations_take_no_more_storage_than_a_signed_buy_leaves_unwritten() {
    let mut g = guard();
    let big = id(&"a".repeat(64));
    let measure = |g: &mut Guard, write: &dyn Fn(&mut Guard)| {
        g.unsettled.flush();
        g.holdings.flush();
        let before = env::storage_usage();
        write(g);
        g.unsettled.flush();
        g.holdings.flush();
        env::storage_usage() - before
    };
    let reserved = measure(&mut g, &|g| {
        for nonce in [u64::MAX - 1, u64::MAX] {
            g.unsettled.insert(
                nonce,
                Unsettled {
                    agent: Some(big.clone()),
                    check: Some(u64::MAX),
                    cost: U128(u128::MAX),
                    armed_until_ns: U64(u64::MAX),
                    restore: Some((TARGET.into(), U128(u128::MAX))),
                    replaced: true,
                },
            );
        }
    });
    let holding = measure(&mut g, &|g| {
        g.holdings
            .insert(TARGET.to_ascii_lowercase(), (big.clone(), u128::MAX));
    });
    assert!(
        reserved <= 396 + holding,
        "{reserved} bytes reserved, {} left unwritten",
        396 + holding
    );
}

// 3.1 of the red team's report: the owner's sale is not concurrent with a signature in progress
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn the_owners_sale_waits_for_a_pending_buy_signature() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    ctx("owner.test", 0, 750);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
}

#[test]
fn after_a_stop_the_owners_sale_takes_the_nonces_after_the_buy_in_flight() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check); // nonce 0
    ctx("owner.test", 0, 750);
    g.disarm(id("agent.test"));
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1))); // the stop does not recall it
    ctx("owner.test", 0, 900);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    assert_eq!(last_event()["data"][0]["nonce"], 1); // approve at 1, swap at 2: mined after the buy
}

// 20. State-machine scenarios: owner functions, concurrent requests, a stop during a check or a signature.
fn allow_at(g: &mut Guard, check: u64, now_ns: u64) {
    ctx("sentinel.test", 0, now_ns);
    let hashes = previewed(g, check, QUOTE);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        hashes,
    );
}

// two checks both fit the budget at request time; only one buy does
#[test]
#[should_panic(expected = "budget exceeded")]
fn two_checks_fit_the_budget_at_request_time_only_one_buy_does() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    arm_at(&mut g, 2 * PRICE + COST + COST / 2, 1000, 0);
    ctx("agent.test", 0, 500);
    let a = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, a, 600);
    ctx("agent.test", 0, 700);
    let b = g.request_check(TARGET.into(), U128(VALUE), None); // one check per token at a time
    buy(&mut g, a);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    allow_at(&mut g, b, 801); // previewed at nonce 1
    ctx("agent.test", 0, 802);
    buy(&mut g, b);
}

// owner stop while a check waits for its verdict
#[test]
#[should_panic(expected = "check requested before the owner's stop")]
fn a_stop_while_a_check_waits_for_its_verdict_refuses_its_buy() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let c = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("owner.test", 0, 550);
    g.disarm(id("agent.test"));
    allow_at(&mut g, c, 600);
    ctx("agent.test", 0, 700);
    buy(&mut g, c);
}

// stop, unfreeze and re-arm within the verdict's 120 s: a verdict on a check requested before the
// stop is void, a check requested after it buys
fn stopped_and_rearmed() -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let c = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, c, 600);
    ctx("owner.test", 0, 610);
    g.disarm(id("agent.test"));
    ctx("owner.test", 0, 620);
    g.unfreeze(id("agent.test"));
    arm_at(&mut g, 50 * U, 1, 630);
    (g, c)
}

#[test]
#[should_panic(expected = "check requested before the owner's stop")]
fn a_verdict_from_before_a_stop_never_buys_after_unfreeze_and_rearm() {
    let (mut g, c) = stopped_and_rearmed();
    ctx("agent.test", 0, 700);
    buy(&mut g, c);
}

#[test]
fn a_check_requested_after_the_stop_buys() {
    let (mut g, _) = stopped_and_rearmed();
    ctx("agent.test", 0, 640);
    let c = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, c, 650);
    ctx("agent.test", 0, 700);
    buy(&mut g, c);
    assert!(g.signing.is_some());
}

#[test]
#[should_panic(expected = "check requested before the owner's stop")]
fn an_exit_quote_from_before_a_stop_never_sells_after_unfreeze() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    ctx("owner.test", 0, 1050);
    g.disarm(id("agent.test"));
    ctx("owner.test", 0, 1060);
    g.unfreeze(id("agent.test"));
    sell_quoted_at(&mut g, exit, 1100);
}

// stop while an agent's exit is being signed: the exit completes
#[test]
fn a_stop_during_an_exit_signature_does_not_recall_it() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    sell_quoted_at(&mut g, exit, 1100);
    ctx("owner.test", 0, 1150);
    g.disarm(id("agent.test"));
    assert_eq!(
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_A)]).len(),
        2
    );
    assert_eq!(holding_of(&g, "agent.test"), 0);
    assert_eq!(g.evm_nonce, 3);
}

// a buy that was signed is charged and credited: voiding it would leave the agent paying for nothing
#[test]
#[should_panic(expected = "no unsettled transaction at this nonce")]
fn a_signed_buys_nonce_cannot_be_replaced() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(0);
}

// a refund before any replacement is signed would let the late signature be mined after it
#[test]
#[should_panic(expected = "no replacement signed at this nonce")]
fn no_refund_before_a_replacement_is_signed() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    g.clear_unsettled(0, true);
}

// no settlement while the replacement is being signed
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_clear_while_the_replacement_is_being_signed() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(0);
    g.clear_unsettled(0, true);
}

// no replacement while a buy is being signed
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_replacement_while_a_buy_is_being_signed() {
    let (mut g, _) = failed_buy();
    ctx("agent.test", 0, 900);
    let c = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, c, 901);
    ctx("agent.test", 0, 902);
    buy(&mut g, c);
    ctx("owner.test", 0, 903);
    let _ = g.sign_replacement(0);
}

// a failed replacement, then a second one at the same nonce
#[test]
fn a_failed_replacement_can_be_retried_and_reserves_nothing() {
    let (mut g, _) = failed_buy();
    ctx("owner.test", 0, 900);
    let _ = g.sign_replacement(0);
    assert!(exit_signed(&mut g, vec![PromiseResult::Failed]).is_empty());
    ctx("owner.test", 0, 950);
    let _ = g.sign_replacement(0);
    assert_eq!(exit_signed(&mut g, vec![ok_sig(SIG_A)]).len(), 1);
    assert_eq!(g.evm_nonce, 1);
    assert!(g.get_unsettled(0).unwrap().replaced && g.get_unsettled(1).is_none());
}

// a sale never needs buying budget: an agent whose budget is spent, expired or removed by the
// armer still exits, paying the quote and the gas from its credit
#[test]
fn an_agent_that_spent_its_budget_still_exits() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    arm_at(&mut g, PRICE + COST, 1000, 0);
    ctx("agent.test", 0, 500);
    let c = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, c, 600);
    ctx("agent.test", 0, 700);
    buy(&mut g, c);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    assert_eq!(g.budget_left(&id("agent.test")).0, 0);
    let credit = g.credit_of(&id("agent.test")).0;
    let exit = exit_quote(&mut g, "agent.test", c, MIN_OUT, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]).len(),
        2
    );
    assert_eq!(holding_of(&g, "agent.test"), 0);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - PRICE - EXIT_COST);
    assert_eq!(g.budget_left(&id("agent.test")).0, 0);
}

#[test]
fn an_agent_whose_budget_expired_or_was_disarmed_still_exits() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("armer.test", 0, 1000);
    g.disarm(id("agent.test")); // the armer's stop: no freeze
    let exit = exit_quote(&mut g, "agent.test", check, MIN_OUT, 2 * SEC);
    sell_quoted_at(&mut g, exit, 2 * SEC + 100);
    assert_eq!(
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]).len(),
        2
    );
    assert_eq!(holding_of(&g, "agent.test"), 0);
}

// a failed buy's check keeps its allow; after the refund the agent cannot reuse it
#[test]
#[should_panic(expected = "check already settled")]
fn a_refunded_unsettled_buy_cannot_be_bought_again() {
    let (mut g, check) = failed_buy();
    replaced(&mut g, 0, 900);
    g.clear_unsettled(0, true);
    ctx("agent.test", 0, 950);
    buy(&mut g, check);
}

// 21. A callback that never ran (out of gas, say) would keep the signing slot forever: the owner
// releases it once RELEASE_DELAY_NS, longer than the MPC's own timeout, has passed; what it was
// signing is reserved as unsettled, as if no signature came back.
#[test]
fn the_owner_releases_a_buy_whose_callback_never_ran() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check); // at 700 ns; its callback never runs
    ctx("owner.test", 0, 700 + RELEASE_DELAY_NS);
    g.release_signing();
    assert!(g.signing.is_none());
    assert_eq!(g.evm_nonce, 1);
    let u = g.get_unsettled(0).unwrap();
    assert_eq!(
        (u.check, u.cost, u.replaced),
        (Some(check), U128(COST), false)
    );
    let v = last_event();
    assert_eq!(v["event"], "signing_released");
    assert_eq!(v["data"][0]["since_ns"], "700");
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None); // the slot is free
}

#[test]
fn a_released_exit_reserves_its_nonces_and_its_tokens() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    let held = holding_of(&g, "agent.test");
    sell_quoted_at(&mut g, exit, 1100);
    ctx("owner.test", 0, 1100 + RELEASE_DELAY_NS);
    g.release_signing();
    assert_eq!(g.evm_nonce, 3);
    assert!(g.get_unsettled(1).is_some());
    assert_eq!(
        g.get_unsettled(2).unwrap().restore,
        Some((TARGET.to_owned(), U128(SELL_AMOUNT)))
    );
    assert_eq!(holding_of(&g, "agent.test"), held - SELL_AMOUNT);
}

#[test]
#[should_panic(expected = "signature requested less than 600 s ago")]
fn no_release_before_the_delay() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    ctx("owner.test", 0, 700 + RELEASE_DELAY_NS - 1);
    g.release_signing();
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_releases_the_slot() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    ctx("agent.test", 0, 700 + RELEASE_DELAY_NS);
    g.release_signing();
}

#[test]
#[should_panic(expected = "no signature in progress")]
fn no_release_without_a_signature_in_progress() {
    let mut g = guard();
    ctx("owner.test", 0, RELEASE_DELAY_NS);
    g.release_signing();
}

// the released buy's callback, arriving after another buy took the slot, must not settle that one
#[test]
#[should_panic(expected = "no signature in progress for this callback")]
fn a_late_callback_after_a_release_cannot_settle_the_next_job() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    let since = g.signing_since_ns;
    let now = 700 + RELEASE_DELAY_NS;
    ctx("owner.test", 0, now);
    g.release_signing();
    arm_at(&mut g, 50 * U, 1000, now);
    ctx("agent.test", 0, now + 1);
    let next = g.request_check(TARGET.into(), U128(VALUE), None);
    allow_at(&mut g, next, now + 2);
    ctx("agent.test", 0, now + 3);
    buy(&mut g, next);
    callback_env(vec![PromiseResult::Successful(mpc_response(R0, S0, 1))]);
    g.on_signed(since);
}

// Judge pass 6: an agent's stop, a signature in progress and the escrow were not readable.
#[test]
fn views_show_a_stop_a_signature_in_progress_and_the_escrow() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    let agent = id("agent.test");
    assert!(!g.is_frozen(&agent));
    assert_eq!(g.stopped_at(&agent), None);
    assert_eq!(g.signing_since(), None);
    assert_eq!(g.credits_total(), g.credit_of(&agent));
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    assert_eq!(g.escrow(), U128(PRICE));
    allow_at(&mut g, check, 600);
    assert_eq!(g.escrow(), U128(0));
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
    assert_eq!(g.signing_since(), Some(U64(700)));
    assert_eq!(g.escrow(), U128(COST));
    ctx("owner.test", 0, 800);
    g.disarm(agent.clone());
    assert!(g.is_frozen(&agent));
    assert_eq!(g.stopped_at(&agent), Some(U64(800)));
    assert_eq!(g.credits_total(), g.credit_of(&agent));
}
