//! Exits: the owner's sale, the agent's exit on a sentinel exit quote, per-agent holdings, and
//! exit quotes under a quorum.

use super::*;

// Exit signed by NEAR: approve(router, amount) then swapExactTokensForETHSupportingFeeOnTransferTokens
// back to the guard's EVM address, two signatures, no verdict and no budget needed.
// the sentinel simulates the sales after a buy with the approve and swap the guard builds for an
// exit: approve of the exact amount, swapExactTokensForETH back to the guard's address
#[test]
fn the_sale_preview_is_the_exit_the_guard_signs_with_a_floor_of_0() {
    let g = guard();
    let hashes: Vec<String> = g
        .preview_sale(TARGET.into(), U128(SELL_AMOUNT), 300)
        .iter()
        .map(|t| hex(&env::keccak256_array(hex::decode(&t[2..]).unwrap())))
        .collect();
    assert_eq!(hashes, [APPROVE_HASH, SALE_FLOOR_0_HASH]);
}

#[test]
fn the_owner_sells_without_verdict_or_budget_approve_then_swap_signed() {
    let mut g = sell_as("owner.test");
    assert_eq!(signed_hashes(b"on_exit_signed"), [APPROVE_HASH, SELL_HASH]);
    let raw = exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(raw, [APPROVE_RAW, SELL_RAW]);
    assert_eq!(g.evm_nonce, 2);
    let exit = g.last_exit().unwrap();
    assert_eq!(exit.token.as_deref(), Some(TARGET));
    let stored: Vec<String> = exit
        .signed_txs
        .iter()
        .map(|t| format!("0x{}", hex(&t.0)))
        .collect();
    assert_eq!(stored, [APPROVE_RAW, SELL_RAW]);
    let v = last_event();
    assert_eq!(v["event"], "exit_signed");
    assert_eq!(v["data"][0]["by"], "owner.test");
    assert_eq!(v["data"][0]["nonce"], 0);
}

// a swap without its approve is never kept, and its nonce stays reserved
#[test]
fn a_failed_swap_signature_keeps_the_approve_only() {
    let mut g = sell_as("owner.test");
    assert_eq!(
        exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]),
        [APPROVE_RAW]
    );
    assert_eq!(g.evm_nonce, 2);
    assert!(g.get_unsettled(1).is_some());
}

#[test]
fn a_failed_approve_signature_keeps_nothing_and_frees_the_lock() {
    let mut g = sell_as("owner.test");
    assert!(exit_signed(&mut g, vec![PromiseResult::Failed, ok_sig(SIG_B)]).is_empty());
    assert_eq!(g.evm_nonce, 2); // the dropped swap's signature is public: its nonce is not reused
    assert!(g.last_exit().is_none());
    ctx("owner.test", 0, 900);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    assert_eq!(last_event()["data"][0]["nonce"], 2);
}

#[test]
#[should_panic(expected = "a signature is already in progress")]
fn a_sale_takes_the_single_signature_lock() {
    let mut g = sell_as("owner.test");
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
}

#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_buy_while_a_sale_is_being_signed() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("owner.test", 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

// an agent never chooses its exit floor: it sells only on a sentinel exit quote (sell_quoted)
#[test]
#[should_panic(expected = "owner only")]
fn an_agent_cannot_sell_at_a_floor_of_its_choice() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("agent.test", 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(0), None);
}

#[test]
fn the_owner_sells_even_with_the_agent_frozen() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("owner.test", 0, 0);
    g.disarm(id("agent.test"));
    ctx("owner.test", 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    assert_eq!(signed_hashes(b"on_exit_signed"), [APPROVE_HASH, SELL_HASH]);
}

#[test]
#[should_panic(expected = "owner only")]
fn an_unregistered_account_cannot_sell() {
    let _ = sell_as("intruder.test");
}

#[test]
#[should_panic(expected = "invalid token")]
fn a_sale_needs_a_valid_token_address() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    ctx("owner.test", 0, 700);
    let _ = g.sell("0xabc".into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
}

#[test]
fn the_owner_withdraws_eth_to_the_address_fixed_at_init() {
    let mut g = guard();
    ctx("owner.test", 0, 700);
    let _ = g.withdraw_eth(U128(1_000_000_000_000_000));
    assert_eq!(signed_hashes(b"on_exit_signed"), [WITHDRAW_HASH]);
    assert_eq!(exit_signed(&mut g, vec![ok_sig(SIG_A)]), [WITHDRAW_RAW]);
    assert_eq!(g.evm_nonce, 1);
    assert!(g.last_exit().unwrap().token.is_none());
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_withdraws_eth() {
    let mut g = funded(ONE_NEAR, 10 * U, 1000);
    ctx("agent.test", 0, 700);
    let _ = g.withdraw_eth(U128(1));
}

// 16. agent exits: the floor comes from a sentinel exit quote, the exit is charged to the armed
// budget, and only a token the guard bought for that agent can be sold by it
#[test]
fn an_agent_sells_at_the_floor_of_the_sentinel_exit_quote() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    let c = g.get_check(exit).unwrap();
    assert_eq!(c.target, TARGET);
    assert_eq!(c.exit_amount, Some(U128(SELL_AMOUNT)));
    sell_quoted_at(&mut g, exit, 1100);
    let v = last_event();
    assert_eq!(v["event"], "exit_requested");
    assert_eq!(v["data"][0]["by"], "agent.test");
    assert_eq!(v["data"][0]["token"], TARGET);
    assert_eq!(v["data"][0]["amount"], SELL_AMOUNT.to_string());
    assert_eq!(v["data"][0]["min_out"], SELL_MIN.to_string()); // quote minus 3 %, not the agent's
    assert_eq!(v["data"][0]["check"], exit);
    assert_eq!(v["data"][0]["nonce"], 1);
}

#[test]
fn an_agent_exit_is_charged_to_its_credit_never_to_its_budget() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    let (credit, budget, fees) = (
        g.credit_of(&id("agent.test")).0,
        g.budget_left(&id("agent.test")).0,
        g.fees().0,
    );
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST);
    assert_eq!(g.budget_left(&id("agent.test")).0, budget);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(g.fees().0, fees + EXIT_COST);
    assert!(g.get_check(exit).unwrap().settled);
}

#[test]
#[should_panic(expected = "check already settled")]
fn an_exit_quote_serves_once() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    sell_quoted_at(&mut g, exit, 1100);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    sell_quoted_at(&mut g, exit, 1200);
}

#[test]
#[should_panic(expected = "verdict expired")]
fn an_exit_quote_expires_after_120_s() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    sell_quoted_at(&mut g, exit, 1001 + VERDICT_TTL_NS);
}

#[test]
#[should_panic(expected = "no exit quote")]
fn a_block_exit_verdict_gives_no_floor() {
    let (mut g, _, exit) = exit_judged(Verdict::Block, 0);
    sell_quoted_at(&mut g, exit, 1100);
}

#[test]
#[should_panic(expected = "not an exit quote")]
fn a_buy_verdict_is_not_an_exit_quote() {
    let (mut g, bought, _) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    sell_quoted_at(&mut g, bought, 1100);
}

// an exit quote is an `allow` on a token: it must never pay for a buy
#[test]
#[should_panic(expected = "an exit quote is not a buy verdict")]
fn an_exit_quote_cannot_be_used_to_buy() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    ctx("agent.test", 0, 1100);
    let _ = g.buy(exit, U128(VALUE), None);
}

#[test]
#[should_panic(expected = "not a buy signed for this agent")]
fn an_agent_exits_only_a_token_the_guard_bought_for_it() {
    let (mut g, check) = judged(Verdict::Allow); // allow, but never bought
    ctx("agent.test", 0, 1000);
    let _ = g.request_exit(check, U128(SELL_AMOUNT));
}

#[test]
#[should_panic(expected = "unfrozen registered agent only")]
fn a_frozen_agent_cannot_ask_for_an_exit() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    ctx("owner.test", 0, 1050);
    g.disarm(id("agent.test"));
    sell_quoted_at(&mut g, exit, 1100);
}

#[test]
fn the_exit_of_a_listed_token_is_never_blocked() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("owner.test", 0, 900);
    g.set_reporter(id("reporter.test"), true);
    ctx("owner.test", ONE_NEAR, 900);
    g.deposit_credit(Some(id("reporter.test"))); // a report is paid from the reporter's credit
    ctx("reporter.test", 0, 900);
    g.report(TARGET.into(), SHA.into(), String::new());
    give_holding(&mut g, SELL_AMOUNT);
    ctx("agent.test", 0, 1000);
    let exit = g.request_exit(bought, U128(SELL_AMOUNT));
    ctx("sentinel.test", 0, 1001);
    g.post_verdict(
        exit,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(EXIT_QUOTE),
        None,
        true,
        previewed(&g, exit, EXIT_QUOTE),
    );
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(last_event()["event"], "exit_requested");
}

// 18. per-agent holdings: an exit sells at most what the guard's signed buys credited the agent
/// `who` is registered, credited and armed, gets an allow on TARGET and a signed buy.
fn bought_for(g: &mut Guard, who: &str, now_ns: u64) -> u64 {
    ctx("owner.test", 0, now_ns);
    g.register_agent(id(who));
    ctx("owner.test", ONE_NEAR, now_ns);
    g.deposit_credit(Some(id(who)));
    ctx("armer.test", 0, now_ns);
    let credit = g.credit_of(&id(who));
    g.arm(id(who), U128(100 * U), 1000, credit);
    ctx(who, 0, now_ns + 1);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, now_ns + 2);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(g, check, QUOTE),
    );
    ctx(who, 0, now_ns + 3);
    buy(g, check);
    signed(g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    check
}

#[test]
fn a_signed_buy_credits_the_agent_with_its_min_out() {
    let (mut g, bought) = judged(Verdict::Allow);
    assert_eq!(holding_of(&g, "agent.test"), 0);
    buy(&mut g, bought);
    assert_eq!(holding_of(&g, "agent.test"), 0); // not before the signature
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
    assert_eq!(holding_of(&g, "agent2.test"), 0);
}

#[test]
fn a_failed_buy_signature_credits_nothing() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Failed);
    assert_eq!(holding_of(&g, "agent.test"), 0);
}

// The guard's EVM address pools every agent's tokens: if two agents held the same token, a credit
// whose buy reverted on Base could sell the other agent's tokens. One agent per token at a time.
#[test]
#[should_panic(expected = "token held for another agent")]
fn agent_b_cannot_buy_a_token_held_for_agent_a() {
    let (mut g, _) = judged(Verdict::Allow);
    bought_for(&mut g, "agent.test", 2000);
    bought_for(&mut g, "agentb.test", 4000);
}

#[test]
fn after_agent_a_sold_its_whole_holding_agent_b_may_buy_the_token() {
    let (mut g, _) = judged(Verdict::Allow);
    let bought = bought_for(&mut g, "agent.test", 2000);
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 3000);
    sell_quoted_at(&mut g, exit, 3100);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    bought_for(&mut g, "agentb.test", 4000);
    assert_eq!(holding_of(&g, "agentb.test"), MIN_OUT);
    assert_eq!(holding_of(&g, "agent.test"), 0);
}

#[test]
#[should_panic(expected = "exit amount above the agent's holding")]
fn an_agent_cannot_exit_more_than_its_signed_min_out() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("agent.test", 0, 1000);
    let _ = g.request_exit(bought, U128(MIN_OUT + 1));
}

#[test]
fn a_successful_exit_decrements_the_holding() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT - 1, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(holding_of(&g, "agent.test"), 1); // reserved as soon as the job starts
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(holding_of(&g, "agent.test"), 1);
}

#[test]
fn a_failed_exit_signature_restores_the_holding_once_the_owner_refunds_it() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(holding_of(&g, "agent.test"), 0);
    exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]); // the swap is not signed
    assert_eq!(holding_of(&g, "agent.test"), 0); // its signature may still be published
    replaced(&mut g, 2, 1200);
    g.clear_unsettled(2, true);
    assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
}

#[test]
#[should_panic(expected = "token held for another agent: set_holding first")]
fn a_refund_never_overwrites_another_agents_holding() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    exit_signed(&mut g, vec![PromiseResult::Failed, PromiseResult::Failed]);
    replaced(&mut g, 2, 1200);
    g.set_holding(TARGET.into(), id("agentb.test"), U128(5)); // the token went to another agent
    g.clear_unsettled(2, true);
}

// Fix pass 8: the recovery `a_refund_never_overwrites_another_agents_holding` leaves open. Agent B
// bought the token after agent A's exit failed: A's tokens come back once B no longer holds it.
#[test]
fn a_refund_blocked_by_another_holder_goes_through_once_that_holding_is_gone() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    exit_signed(&mut g, vec![PromiseResult::Failed, PromiseResult::Failed]);
    replaced(&mut g, 2, 1200);
    g.set_holding(TARGET.into(), id("agentb.test"), U128(5)); // B holds the token now
    g.set_holding(TARGET.into(), id("agentb.test"), U128(0)); // B sold it all (or the owner freed it)
    g.clear_unsettled(2, true);
    assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
}

#[test]
#[should_panic(expected = "exit amount above the agent's holding")]
fn two_exit_quotes_for_the_full_holding_the_second_sale_is_refused() {
    // a check, a buy, two exit quotes and a sale: 104.5 U at 19 U a check, above `judged`'s 100 U
    let mut g = credited(ONE_NEAR, 200 * U, 1000, 1000 * U);
    arm_at(&mut g, 200 * U, 1, 0);
    ctx("agent.test", 0, 500);
    let bought = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
    g.post_verdict(
        bought,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        true,
        previewed(&g, bought, QUOTE),
    );
    ctx("agent.test", 0, 700);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let first = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    let second = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1010);
    sell_quoted_at(&mut g, first, 1100);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    sell_quoted_at(&mut g, second, 1110);
}

#[test]
fn the_owner_sells_and_withdraws_without_touching_holdings() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("owner.test", 0, 900);
    let _ = g.sell(TARGET.into(), U128(5 * MIN_OUT), U128(0), None);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    ctx("owner.test", 0, 950);
    let _ = g.withdraw_eth(U128(1));
    exit_signed(&mut g, vec![ok_sig(SIG_A)]);
    assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
}

// An agent can lock a token for the others (a credit whose buy reverted on Base, or an agent that
// never sells): the owner clears or reassigns the holding, logged.
#[test]
fn the_owner_clears_a_holding_then_another_agent_may_buy_the_token() {
    let (mut g, _) = judged(Verdict::Allow);
    bought_for(&mut g, "agent.test", 2000);
    ctx("owner.test", 0, 3000);
    g.set_holding(TARGET.into(), id("agent.test"), U128(0));
    let v = last_event();
    assert_eq!(v["event"], "holding_set");
    assert_eq!(
        v["data"][0],
        near_sdk::serde_json::json!({
            "token": TARGET.to_ascii_lowercase(), "agent": "agent.test", "amount": "0",
            "previous": { "agent": "agent.test", "amount": MIN_OUT.to_string() },
        })
    );
    assert_eq!(holding_of(&g, "agent.test"), 0);
    bought_for(&mut g, "agentb.test", 4000);
    assert_eq!(holding_of(&g, "agentb.test"), MIN_OUT);
}

#[test]
fn the_owner_reassigns_a_holding_to_another_agent() {
    let (mut g, _) = judged(Verdict::Allow);
    bought_for(&mut g, "agent.test", 2000);
    ctx("owner.test", 0, 3000);
    g.set_holding(TARGET.into(), id("agentb.test"), U128(7));
    assert_eq!(last_event()["data"][0]["agent"], "agentb.test");
    assert_eq!(holding_of(&g, "agent.test"), 0);
    assert_eq!(holding_of(&g, "agentb.test"), 7);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_a_holding() {
    let (mut g, _) = judged(Verdict::Allow);
    bought_for(&mut g, "agentb.test", 2000);
    ctx("agentb.test", 0, 3000);
    g.set_holding(TARGET.into(), id("agentb.test"), U128(0));
}

// The exit's callback restores the seller's holding when the swap is not signed: no change while
// a signature is pending, or it would overwrite the owner's choice.
#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_holding_change_while_a_signature_is_pending() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    sell_quoted_at(&mut g, exit, 1100);
    ctx("owner.test", 0, 1200);
    g.set_holding(TARGET.into(), id("agent.test"), U128(0));
}

#[test]
fn the_agent_exit_signs_exactly_the_previewed_approve_and_swap() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    let previewed = previewed(&g, exit, EXIT_QUOTE);
    assert_eq!(g.get_check(exit).unwrap().tx_hashes, previewed);
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(signed_hashes(b"on_exit_signed"), previewed);
}

// judge's Trap2, mode 1: a token that lets only an approve of 2^256 - 1 sell; amounts are U128,
// so the owner passes the approve as hex
#[test]
fn the_owner_sells_with_an_approve_of_the_maximum() {
    let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
    ctx("owner.test", 0, 700);
    let max = format!("0x{}", "F".repeat(64));
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), Some(max));
    assert_eq!(
        last_event()["data"][0]["approve"],
        format!("0x{}", "f".repeat(64))
    );
    let raw = exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    // approve(router, 2^256 - 1): selector, router word, then 32 bytes of ff
    assert!(raw[0].contains(&format!(
        "095ea7b3{}{}{}",
        "0".repeat(24),
        ROUTER.to_lowercase(),
        "f".repeat(64)
    )));
    assert_eq!(raw[1], SELL_RAW); // the swap still sells SELL_AMOUNT
}

#[test]
fn an_invalid_approve_amount_is_refused() {
    for bad in ["", "0x", "ff", &format!("0x{}", "f".repeat(65)), "0xzz"] {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
        ctx("owner.test", 0, 700);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = g.sell(
                TARGET.into(),
                U128(SELL_AMOUNT),
                U128(SELL_MIN),
                Some(bad.into()),
            );
        }));
        assert!(r.is_err(), "accepted approve {bad:?}");
    }
}

// Exit quotes under a quorum: one key neither refuses an exit another sentinel quotes, nor sets
// its floor below that sentinel's quote.
#[test]
fn one_block_vote_does_not_refuse_an_exit_another_sentinel_quotes() {
    // the block first
    let (mut g, exit) = exit_asked_of_two();
    let fees = g.fees().0;
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Block, 0, 1001);
    assert_eq!(verdict_of(&g, exit), Some(Verdict::Block));
    assert_eq!(g.fees(), U128(fees + PRICE));
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    assert_eq!(last_event()["data"][0]["decided"], "allow");
    let c = g.get_check(exit).unwrap();
    assert_eq!(
        (c.verdict, c.quote),
        (Some(Verdict::Allow), U128(EXIT_QUOTE))
    );
    assert_eq!((c.judged_ns, c.votes.len()), (U64(1002), 2));
    assert_eq!(c.reasons, "reasons of sentinel2.test");
    assert_eq!(g.fees(), U128(fees + PRICE)); // the price moved once
    assert_eq!(g.quarantined_until(TARGET.into()), None); // an exit quote quarantines nothing
    sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS); // a block is no quote: the 60 s
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
    // the block second
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Block, 0, 1002);
    let c = g.get_check(exit).unwrap();
    assert_eq!(
        (c.verdict, c.quote),
        (Some(Verdict::Allow), U128(EXIT_QUOTE))
    );
    assert_eq!(c.judged_ns, U64(1001));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS); // a block is no quote: the 60 s
    assert!(g.signing_since().is_some());
}

#[test]
fn an_exit_floor_is_the_highest_quote_posted() {
    // the low quote first: the higher one replaces it
    let (mut g, exit) = exit_asked_of_two();
    let low = EXIT_QUOTE / 100;
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Allow, low, 1001);
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    let c = g.get_check(exit).unwrap();
    assert_eq!(c.quote, U128(EXIT_QUOTE));
    assert_eq!(c.tx_hashes, previewed(&g, exit, EXIT_QUOTE));
    assert_eq!(
        c.evidence_sha256,
        hex(&env::sha256(b"evidence of sentinel2.test"))
    );
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
    // the low quote second: it changes nothing
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Allow, low, 1002);
    let c = g.get_check(exit).unwrap();
    assert_eq!((c.quote, c.judged_ns), (U128(EXIT_QUOTE), U64(1001)));
    assert_eq!(c.reasons, "reasons of sentinel2.test");
    sell_quoted_at(&mut g, exit, 1100);
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
}

#[test]
#[should_panic(expected = "exit quote awaits the other sentinels")]
fn an_exit_quote_waits_for_the_quorums_votes() {
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE / 100,
        1001,
    );
    sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS - 1);
}

// A sentinel that is down delays an exit by 60 s, never more: one quote is then enough.
#[test]
fn one_exit_quote_is_enough_60_s_after_the_request() {
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    ctx("agent.test", 0, 1000 + EXIT_VOTES_WAIT_NS - 1);
    assert!(!g.exit_ready(exit));
    ctx("agent.test", 0, 1000 + EXIT_VOTES_WAIT_NS);
    assert!(g.exit_ready(exit));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS);
    assert!(g.signing_since().is_some());
}

#[test]
fn an_exit_quote_is_ready_once_the_quorum_voted() {
    let (mut g, exit) = exit_asked_of_two();
    assert!(!g.exit_ready(exit));
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    assert!(!g.exit_ready(exit));
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    assert!(g.exit_ready(exit));
    assert!(!g.exit_ready(exit + 1)); // unknown
}

#[test]
#[should_panic(expected = "a sentinel that voted on this exit quote was replaced")]
fn an_exit_quote_a_removed_sentinel_posted_no_longer_sells() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    name(&mut g, &["sentinel2.test"], 1, 1050);
    sell_quoted_at(&mut g, exit, 1100);
}

#[test]
#[should_panic(expected = "verdict already posted")]
fn no_vote_on_an_exit_quote_already_sold() {
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    exit_vote(&mut g, "sentinel2.test", exit, Verdict::Block, 0, 2000);
}

#[test]
#[should_panic(expected = "check belongs to another agent")]
fn an_agent_does_not_sell_on_another_agents_exit_quote() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    enroll(&mut g, "agent2.test", 1050);
    ctx("agent2.test", 0, 1100);
    let _ = g.sell_quoted(exit);
}

#[test]
#[should_panic(expected = "a signature is already in progress")]
fn no_quoted_sale_while_another_signature_is_in_progress() {
    let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
    ctx("owner.test", 0, 1050);
    let _ = g.withdraw_eth(U128(1));
    sell_quoted_at(&mut g, exit, 1100);
}

#[test]
#[should_panic(expected = "unfrozen registered agent only")]
fn a_frozen_agent_cannot_request_an_exit_quote() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("owner.test", 0, 900);
    g.disarm(id("agent.test"));
    ctx("agent.test", 0, 1000);
    let _ = g.request_exit(bought, U128(MIN_OUT));
}

#[test]
#[should_panic(expected = "unfrozen registered agent only")]
fn an_unregistered_account_cannot_request_an_exit_quote() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("stranger.test", 0, 1000);
    let _ = g.request_exit(bought, U128(MIN_OUT));
}

/// The exit quote of `exit_asked_of_two`, asked of three sentinels, two needed.
fn exit_asked_of_three() -> (Guard, u64) {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    give_holding(&mut g, SELL_AMOUNT);
    name(&mut g, &THREE, 2, 900);
    ctx("agent.test", 0, 1000);
    let exit = g.request_exit(bought, U128(SELL_AMOUNT));
    (g, exit)
}

// With three quotes in, one liar moves the floor neither way: the median stands, in every order.
#[test]
fn an_exit_floor_is_the_median_of_three_quotes() {
    let honest = [EXIT_QUOTE, EXIT_QUOTE + 7];
    for lie in [EXIT_QUOTE / 100, 1000 * EXIT_QUOTE] {
        for liar_at in 0..3 {
            let (mut g, exit) = exit_asked_of_three();
            let mut quotes = honest.to_vec();
            quotes.insert(liar_at, lie);
            for (i, q) in quotes.iter().enumerate() {
                exit_vote(&mut g, THREE[i], exit, Verdict::Allow, *q, 1001 + i as u64);
            }
            let median = if lie < EXIT_QUOTE {
                EXIT_QUOTE
            } else {
                EXIT_QUOTE + 7
            };
            let c = g.get_check(exit).unwrap();
            assert_eq!(
                c.quote,
                U128(median),
                "liar {lie} voting in place {liar_at}"
            );
            assert_eq!(c.tx_hashes, previewed(&g, exit, median));
            let stands = quotes.iter().position(|q| *q == median).unwrap();
            let sha = hex(&env::sha256(
                format!("evidence of {}", THREE[stands]).as_bytes(),
            ));
            assert_eq!(c.evidence_sha256, sha);
            assert_eq!(c.judged_ns, U64(1001)); // the oldest quote's age bounds the sale
            sell_quoted_at(&mut g, exit, 1100);
            assert_eq!(
                last_event()["data"][0]["min_out"],
                floor(median, 300).to_string()
            );
        }
    }
}

// Two sentinels: no rule resists one liar both ways. The highest stands: a quote too high costs
// the agent one exit (the sale reverts, the holding stays debited), a quote too low gives the
// tokens away.
#[test]
fn with_two_quotes_a_high_one_stands_and_costs_one_exit() {
    let (mut g, exit) = exit_asked_of_two();
    let credit = g.credit_of(&id("agent.test")).0;
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        1000 * EXIT_QUOTE,
        1002,
    );
    assert_eq!(g.get_check(exit).unwrap().quote, U128(1000 * EXIT_QUOTE));
    sell_quoted_at(&mut g, exit, 1100);
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(g.holding(id("agent.test"), TARGET.into()), U128(0));
    assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST);
    let again = panic_of(|| {
        ctx("agent.test", 0, 2000);
        g.request_exit(exit - 1, U128(1));
    });
    assert!(
        again.contains("exit amount above the agent's holding"),
        "{again}"
    );
}

// A block is no quote: a liar's low quote beside an honest sentinel's fallback block does not make
// the exit ready. The third sentinel's quote does, and stands (the highest of two).
#[test]
fn a_block_does_not_make_an_exit_ready() {
    let (mut g, exit) = exit_asked_of_three();
    let low = EXIT_QUOTE / 100;
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Allow, low, 1001);
    fallback(&mut g, "sentinel2.test", exit, 1002);
    ctx("agent.test", 0, 1003);
    assert!(
        !g.exit_ready(exit),
        "ready on one quote and a block, quorum two"
    );
    assert!(g.vote_due(exit, id("sentinel3.test")));
    let said = panic_of(|| sell_quoted_at(&mut g, exit, 1003));
    assert!(
        said.contains("exit quote awaits the other sentinels"),
        "{said}"
    );
    exit_vote(
        &mut g,
        "sentinel3.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1004,
    );
    ctx("agent.test", 0, 1005);
    assert!(!g.exit_ready(exit)); // two quotes of three: the grace
    ctx("agent.test", 0, 1000 + EXIT_GRACE_NS);
    assert!(g.exit_ready(exit));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_GRACE_NS);
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
}

// Every sentinel quotes an exit until it is sold: the third quote is what makes the median.
#[test]
fn the_third_sentinel_is_still_asked_once_two_quoted() {
    let (mut g, exit) = exit_asked_of_three();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    ctx("sentinel3.test", 0, 1003);
    assert!(!g.exit_ready(exit)); // its quote is waited for, a short grace
    assert!(g.vote_due(exit, id("sentinel3.test")));
}

// The record of what was signed is not rewritten by a vote that comes during the signature.
#[test]
fn no_vote_on_an_exit_quote_being_signed() {
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    let at = 1000 + EXIT_VOTES_WAIT_NS;
    sell_quoted_at(&mut g, exit, at);
    ctx("sentinel2.test", 0, at + 1);
    assert!(!g.vote_due(exit, id("sentinel2.test")));
    let said = panic_of(|| {
        exit_vote(
            &mut g,
            "sentinel2.test",
            exit,
            Verdict::Allow,
            2 * EXIT_QUOTE,
            at + 1,
        );
    });
    assert!(said.contains("verdict already posted"), "{said}");
    exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
    assert_eq!(g.get_check(exit).unwrap().quote, U128(EXIT_QUOTE));
    assert_eq!(g.last_exit().unwrap().min_out, U128(SELL_MIN));
}

// A quote is of the transactions simulated. Once another signature moved the guard's nonce, the
// sentinels that quoted cannot quote again: a later quote would stand alone, and sell on the
// strength of their votes and of the time elapsed. So the exit quote takes no more votes and never
// sells; the agent asks another, which every sentinel quotes afresh.
#[test]
fn a_quote_after_the_nonce_moved_does_not_sell_on_older_votes() {
    for lie in [EXIT_QUOTE / 100, 1000 * EXIT_QUOTE] {
        let (mut g, exit) = exit_asked_of_three();
        exit_vote(&mut g, THREE[0], exit, Verdict::Allow, EXIT_QUOTE, 1001);
        exit_vote(&mut g, THREE[1], exit, Verdict::Allow, EXIT_QUOTE + 7, 1002);
        g.evm_nonce += 1; // another signature came back
        for late in [1003, 1000 + EXIT_GRACE_NS, 1000 + EXIT_VOTES_WAIT_NS] {
            ctx(THREE[2], 0, late);
            assert!(!g.vote_due(exit, id(THREE[2])));
            assert!(g.exit_ready(exit)); // it waits for no vote: the agent learns it at once
            let said = panic_of(|| exit_vote(&mut g, THREE[2], exit, Verdict::Allow, lie, late));
            assert!(said.contains("verdict already posted"), "{said}");
            let said = panic_of(|| sell_quoted_at(&mut g, exit, late));
            assert!(said.contains("transaction differs"), "{said}");
        }
        // the honest quotes stay on record, and sold nothing
        let c = g.get_check(exit).unwrap();
        assert_eq!((c.quote, c.votes.len()), (U128(EXIT_QUOTE + 7), 2));
        assert!(c.votes.iter().all(|v| v.quote.is_some()) && !c.settled);
        // a block is refused too: the exit quote is over
        let said = panic_of(|| exit_vote(&mut g, THREE[2], exit, Verdict::Block, 0, 1004));
        assert!(said.contains("verdict already posted"), "{said}");
    }
}

// The same when the lone quote before the move was a liar's: the honest quotes of the new nonce
// are not added to it, and nothing sells on it.
#[test]
fn exit_quotes_posted_before_the_nonce_moved_take_no_later_quote() {
    let (mut g, exit) = exit_asked_of_three();
    exit_vote(
        &mut g,
        THREE[0],
        exit,
        Verdict::Allow,
        1000 * EXIT_QUOTE,
        1001,
    );
    g.evm_nonce += 1;
    let said = panic_of(|| exit_vote(&mut g, THREE[1], exit, Verdict::Allow, EXIT_QUOTE, 1002));
    assert!(said.contains("verdict already posted"), "{said}");
    let said = panic_of(|| sell_quoted_at(&mut g, exit, 1000 + EXIT_VOTES_WAIT_NS));
    assert!(said.contains("transaction differs"), "{said}");
}

// A block is no quote: after one, the nonce may move and the quotes that follow are all of the
// transactions the guard signs now.
#[test]
fn quotes_after_a_block_and_a_nonce_move_are_of_one_nonce() {
    let (mut g, exit) = exit_asked_of_three();
    exit_vote(&mut g, THREE[0], exit, Verdict::Block, 0, 1001);
    g.evm_nonce += 1;
    exit_vote(&mut g, THREE[1], exit, Verdict::Allow, EXIT_QUOTE, 1002);
    exit_vote(&mut g, THREE[2], exit, Verdict::Allow, EXIT_QUOTE + 7, 1003);
    let c = g.get_check(exit).unwrap();
    assert_eq!(c.quote, U128(EXIT_QUOTE + 7)); // the highest of two
    assert_eq!(c.tx_hashes, previewed(&g, exit, EXIT_QUOTE + 7));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_GRACE_NS);
    assert!(g.signing_since().is_some());
}

// An exit quote's own worst case: three quotes under 64-character accounts, and both its nonces
// reserved when no signature comes back.
#[test]
fn the_upper_bound_covers_an_exit_quote_at_worst_case() {
    let big = id(&"a".repeat(64));
    ctx("guard.test", 0, 0);
    let mut g = Guard::new(
        id("owner.test"),
        id("armer.test"),
        big.clone(),
        U128(PRICE),
        evm(),
    );
    ctx("owner.test", 0, 0);
    g.register_agent(big.clone());
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(big.clone()));
    g.set_held(&big, TARGET, u128::MAX);
    // a signed buy of the agent's, to ask the exit of
    g.checks.insert(
        1,
        Check {
            signed_tx: Some(vec![0].into()),
            ..blank(&big)
        },
    );
    g.next_id = 1;
    g.checks.flush();
    g.credits.flush();
    g.holdings.flush();
    ctx(big.as_str(), 0, 1);
    let before = env::storage_usage();
    let exit = g.request_exit(1, U128(u128::MAX));
    let c = g.checks.get_mut(&exit).unwrap();
    c.verdict = Some(Verdict::Allow);
    c.reasons = "r".repeat(MAX_REASONS);
    c.evidence_sha256 = "e".repeat(64);
    c.quote = U128(u128::MAX);
    c.tx_hashes = vec!["f".repeat(64); MAX_TX_HASHES];
    c.settled = true;
    c.votes = vec![
        Vote {
            sentinel: big.clone(),
            verdict: Verdict::Allow,
            evidence_sha256: "e".repeat(64),
            quote: Some(U128(u128::MAX)),
        };
        MAX_SENTINELS
    ];
    for nonce in [u64::MAX - 1, u64::MAX] {
        g.unsettled.insert(
            nonce,
            Unsettled {
                agent: Some(big.clone()),
                check: Some(u64::MAX),
                cost: U128(u128::MAX),
                armed_until_ns: U64(0),
                restore: Some((TARGET.into(), U128(u128::MAX))),
                replaced: true,
            },
        );
    }
    g.checks.flush();
    g.credits.flush();
    g.unsettled.flush();
    let used = u128::from(env::storage_usage() - before);
    assert!(
        used > 0 && used <= CHECK_STORAGE_BYTES,
        "{used} bytes for an exit quote"
    );
}

/// A check of `agent` with nothing in it yet.
fn blank(agent: &AccountId) -> Check {
    Check {
        agent: agent.clone(),
        target: TARGET.into(),
        requested_ns: U64(0),
        verdict: Some(Verdict::Allow),
        judged_ns: U64(0),
        reasons: String::new(),
        evidence_sha256: String::new(),
        amount_wei: U128(0),
        quote: U128(0),
        settled: true,
        approved: false,
        signed_tx: None,
        code: None,
        exit_amount: None,
        decision_sha256: None,
        buy_decision_sha256: None,
        tx_hashes: vec![],
        list_target: false,
        votes: vec![],
    }
}

// 26. With more sentinels than the quorum, an exit ready on the quorum's quotes let one key bypass
// the median: its high quote beside one honest quote stood at once, and the sale reverted. An exit
// is ready on every sentinel's quote; on the quorum's only after a short grace for the missing
// ones; on a single vote after 60 s.
#[test]
fn a_high_quote_beside_one_honest_quote_does_not_sell_before_the_third() {
    let (mut g, exit) = exit_asked_of_three();
    let high = 1000 * EXIT_QUOTE;
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Allow, high, 1001);
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    assert_eq!(g.get_check(exit).unwrap().quote, U128(high)); // the highest of two, for now
    ctx("agent.test", 0, 1003);
    assert!(!g.exit_ready(exit), "ready on the liar's floor");
    let said = panic_of(|| sell_quoted_at(&mut g, exit, 1003));
    assert!(
        said.contains("exit quote awaits the other sentinels"),
        "{said}"
    );
    // the third quote comes: every sentinel quoted, no more wait, and the median stands
    exit_vote(
        &mut g,
        "sentinel3.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE + 7,
        1004,
    );
    ctx("agent.test", 0, 1005);
    assert!(g.exit_ready(exit));
    sell_quoted_at(&mut g, exit, 1005);
    assert_eq!(
        last_event()["data"][0]["min_out"],
        floor(EXIT_QUOTE + 7, 300).to_string()
    );
}

// One sentinel of three down: the quorum's quotes sell after the grace, a bounded delay.
#[test]
fn the_quorums_quotes_sell_after_a_short_grace_for_the_missing_one() {
    let (mut g, exit) = exit_asked_of_three();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    ctx("agent.test", 0, 1000 + EXIT_GRACE_NS);
    assert!(!g.exit_ready(exit)); // one quote is below the quorum: the 60 s
    exit_vote(
        &mut g,
        "sentinel3.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    ctx("agent.test", 0, 1000 + EXIT_GRACE_NS - 1);
    assert!(!g.exit_ready(exit));
    ctx("agent.test", 0, 1000 + EXIT_GRACE_NS);
    assert!(g.exit_ready(exit));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_GRACE_NS);
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
}

// A block is no quote: three sentinels of which one blocks never have every quote in, so the two
// others' quotes sell after the grace, on the highest of the two.
#[test]
fn one_block_among_three_delays_an_exit_by_the_grace_only() {
    let (mut g, exit) = exit_asked_of_three();
    exit_vote(&mut g, "sentinel.test", exit, Verdict::Block, 0, 1001);
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    exit_vote(
        &mut g,
        "sentinel3.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1003,
    );
    ctx("agent.test", 0, 1004);
    assert!(!g.exit_ready(exit));
    sell_quoted_at(&mut g, exit, 1000 + EXIT_GRACE_NS);
    assert_eq!(last_event()["data"][0]["min_out"], SELL_MIN.to_string());
}

// Two sentinels, both needed: both quotes, or the 60 s. The grace changes nothing there.
#[test]
fn with_two_sentinels_one_quote_still_waits_the_60_s() {
    let (mut g, exit) = exit_asked_of_two();
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    ctx("agent.test", 0, 1000 + EXIT_GRACE_NS);
    assert!(!g.exit_ready(exit));
    ctx("agent.test", 0, 1000 + EXIT_VOTES_WAIT_NS);
    assert!(g.exit_ready(exit));
}
