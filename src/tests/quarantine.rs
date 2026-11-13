//! Quarantine and caps: the shared blocklist, the quarantine of a blocked token, one check
//! per token at a time, and the rolling cap per token.

use super::*;

// 15. shared blocklist: reporters registered by the owner, evidence sha256 attached, storage paid
// by the reporter's credit; every block verdict lists its target; buy refuses a listed target
/// Agent funded and armed; `reporter.test` registered by the owner, `credit` deposited for it.
fn with_reporter(credit: u128) -> Guard {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_reporter(id("reporter.test"), true);
    ctx("owner.test", credit, 0);
    g.deposit_credit(Some(id("reporter.test")));
    g
}

fn report_as(g: &mut Guard, who: &str, token: &str) {
    ctx(who, 0, 50);
    g.report(token.into(), SHA.into(), "honeypot seen by agent B".into());
}

#[test]
fn a_registered_reporter_lists_a_token_with_its_evidence_and_pays_the_storage() {
    let mut g = with_reporter(ONE_NEAR);
    let credit = g.credit_of(&id("reporter.test")).0;
    let fees = g.fees().0;
    report_as(&mut g, "reporter.test", TARGET);
    let e = g.get_entry(TARGET.to_lowercase()).unwrap();
    assert_eq!(e.reporter, id("reporter.test"));
    assert_eq!(e.evidence_sha256, SHA);
    assert_eq!(e.at_ns, U64(50));
    assert_eq!(e.note, "honeypot seen by agent B");
    let cost = ENTRY_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear();
    assert_eq!(g.credit_of(&id("reporter.test")).0, credit - cost);
    assert_eq!(g.fees().0, fees + cost);
    let v = last_event();
    assert_eq!(v["event"], "listed");
    assert_eq!(v["data"][0]["token"], TARGET.to_lowercase());
    assert_eq!(v["data"][0]["reporter"], "reporter.test");
    assert_eq!(v["data"][0]["evidence_sha256"], SHA);
}

// A template is never listed: copies of an honest token's code launched later must not get it
// blocked (template reputation is the sentinel's, per target).
#[test]
#[should_panic(expected = "invalid token")]
fn a_code_hash_cannot_be_listed() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", &format!("0x{}", "ab".repeat(32)));
}

#[test]
#[should_panic(expected = "reporter only")]
fn an_unregistered_account_cannot_report() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "agent.test", TARGET);
}

#[test]
#[should_panic(expected = "reporter only")]
fn a_revoked_reporter_cannot_report() {
    let mut g = with_reporter(ONE_NEAR);
    ctx("owner.test", 0, 10);
    g.set_reporter(id("reporter.test"), false);
    report_as(&mut g, "reporter.test", TARGET);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_registers_reporters() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    g.set_reporter(id("agent.test"), true);
}

#[test]
#[should_panic(expected = "insufficient credit for the entry's storage")]
fn a_report_needs_credit_for_its_storage() {
    let mut g = with_reporter(2 * U); // about 1 U of credit left after the credit entry's own storage
    report_as(&mut g, "reporter.test", TARGET);
}

#[test]
#[should_panic(expected = "already listed")]
fn an_entry_is_never_overwritten() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", TARGET);
    report_as(&mut g, "reporter.test", &TARGET.to_lowercase());
}

#[test]
#[should_panic(expected = "invalid token")]
fn a_report_needs_a_token_address() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", "0xabc");
}

#[test]
#[should_panic(expected = "invalid evidence sha256")]
fn a_report_needs_an_evidence_sha256() {
    let mut g = with_reporter(ONE_NEAR);
    ctx("reporter.test", 0, 50);
    g.report(TARGET.into(), "abc".into(), String::new());
}

#[test]
fn the_owner_unlists_an_entry_with_an_event() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", TARGET);
    ctx("owner.test", 0, 60);
    g.unlist(TARGET.into());
    assert!(g.get_entry(TARGET.into()).is_none());
    let v = last_event();
    assert_eq!(v["event"], "unlisted");
    assert_eq!(v["data"][0]["token"], TARGET.to_lowercase());
    assert_eq!(v["data"][0]["by"], "owner.test");
}

#[test]
#[should_panic(expected = "owner only")]
fn a_reporter_cannot_unlist() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", TARGET);
    ctx("reporter.test", 0, 60);
    g.unlist(TARGET.into());
}

#[test]
fn a_block_verdict_lists_its_target_automatically() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    let check = verdict_on(&mut g, Verdict::Block, code("aa"), 10);
    let e = g.get_entry(TARGET.into()).unwrap();
    assert_eq!(e.reporter, id("sentinel.test"));
    assert_eq!(e.evidence_sha256, SHA_EMPTY);
    assert_eq!(e.note, format!("verdict #{check}"));
    assert_eq!(last_event()["event"], "listed");
}

#[test]
fn a_block_on_a_listed_target_keeps_the_first_entry() {
    // the request is refused once listed: judge one made before the listing
    let mut g = with_reporter(ONE_NEAR);
    ctx("agent.test", 0, 10);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    report_as(&mut g, "reporter.test", TARGET);
    ctx("sentinel.test", 0, 60);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        "second".into(),
        U128(0),
        code("aa"),
        true,
        vec![],
    );
    let e = g.get_entry(TARGET.into()).unwrap();
    assert_eq!(e.reporter, id("reporter.test"));
    assert_eq!(e.note, "honeypot seen by agent B");
}

#[test]
#[should_panic(expected = "target is on the shared blocklist")]
fn a_listed_target_cannot_be_checked_for_a_buy() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", TARGET);
    ctx("agent.test", 0, 60);
    let _ = g.request_check(TARGET.to_lowercase(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "target is on the shared blocklist")]
fn buy_refuses_a_listed_target_even_with_an_allow() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("owner.test", 0, 0);
    g.set_reporter(id("reporter.test"), true);
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("reporter.test")));
    report_as(&mut g, "reporter.test", TARGET);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn the_owner_still_sells_a_listed_token() {
    let mut g = with_reporter(ONE_NEAR);
    report_as(&mut g, "reporter.test", TARGET);
    ctx("owner.test", 0, 700);
    let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN), None);
    assert_eq!(signed_hashes(b"on_exit_signed"), [APPROVE_HASH, SELL_HASH]);
}

// reporter of 64 characters, code key, note at the maximum: ENTRY_STORAGE_BYTES covers it
#[test]
fn the_entry_bound_covers_the_worst_case() {
    let big = id(&"r".repeat(64));
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_reporter(big.clone(), true);
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(big.clone()));
    g.credits.flush();
    ctx(big.as_str(), 0, 50);
    let before = env::storage_usage();
    g.report(TARGET.into(), SHA.into(), "n".repeat(MAX_NOTE));
    g.blocklist.flush();
    g.credits.flush();
    let used = u128::from(env::storage_usage() - before);
    assert!(
        used > 0 && used <= ENTRY_STORAGE_BYTES,
        "{used} bytes for an entry"
    );
}

// 20. only a block substantiated by the target's code, and asked to list, lists the token
fn block_with(code: Option<Code>, list_target: bool) -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 10);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 11);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(QUOTE),
        code,
        list_target,
        vec![],
    );
    ctx("agent.test", 0, 12);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = g.buy(check, U128(VALUE), None);
    }));
    assert!(refused.is_err(), "a blocked check must refuse buy");
    (g, check)
}

fn listed(g: &Guard) -> bool {
    g.get_entry(TARGET.to_lowercase()).is_some()
}

#[test]
fn a_block_with_code_and_list_target_lists_the_token() {
    let (g, _) = block_with(code("aa"), true);
    assert!(listed(&g));
}

#[test]
fn a_block_without_code_never_lists_even_when_asked() {
    let (g, _) = block_with(None, true);
    assert!(!listed(&g));
}

#[test]
fn a_block_with_code_but_no_list_target_does_not_list() {
    let (g, _) = block_with(code("aa"), false);
    assert!(!listed(&g));
}

// 21. paginated view of the blocklist
#[test]
fn list_entries_pages_through_the_blocklist_and_follows_unlist() {
    let mut g = with_reporter(ONE_NEAR);
    for n in ["1", "2", "3"] {
        report_as(&mut g, "reporter.test", &format!("0x{}", n.repeat(40)));
    }
    report_as(&mut g, "reporter.test", TARGET);
    let page = g.list_entries(0, 3);
    assert_eq!(page.len(), 3);
    let rest = g.list_entries(3, 50);
    assert_eq!(rest.len(), 1);
    let mut keys: Vec<String> = page
        .iter()
        .chain(rest.iter())
        .map(|(k, _)| k.clone())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            format!("0x{}", "1".repeat(40)),
            format!("0x{}", "2".repeat(40)),
            format!("0x{}", "3".repeat(40)),
            TARGET.to_lowercase(),
        ]
    );
    assert!(g.list_entries(4, 10).is_empty());
    assert_eq!(page[0].1.reporter, id("reporter.test"));
    ctx("owner.test", 0, 60);
    g.unlist(TARGET.into());
    assert_eq!(g.list_entries(0, 50).len(), 3);
}

#[test]
fn list_entries_caps_the_page_size() {
    let mut g = with_reporter(ONE_NEAR);
    for n in 0..=MAX_PAGE {
        report_as(&mut g, "reporter.test", &format!("0x{n:040x}"));
    }
    assert_eq!(g.list_entries(0, u32::MAX).len(), MAX_PAGE as usize);
}

// 21. Design review: sampling sales at drawn delays does not converge, so the contract bounds what
// any wrong `allow` costs. A block is remembered (quarantine), one check per token awaits its
// verdict (N parallel checks are not N draws), a rolling cap per token for all agents together, and a
// buy only within 180 s of the check's request.
/// The sentinel posts `verdict` on buy check `check` at `now_ns`, asking to list nothing.
fn verdict_at(g: &mut Guard, check: u64, verdict: Verdict, now_ns: u64) {
    ctx("sentinel.test", 0, now_ns);
    let hashes = if verdict == Verdict::Block {
        vec![]
    } else {
        previewed(g, check, QUOTE)
    };
    g.post_verdict(
        check,
        verdict,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("aa"),
        false,
        hashes,
    );
}

/// `who` (armed) asks a check of TARGET at `now_ns`, gets an allow, buys, and NEAR signs.
fn buy_signed(g: &mut Guard, who: &str, now_ns: u64) -> u64 {
    ctx(who, 0, now_ns);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(g, check, Verdict::Allow, now_ns + 1);
    ctx(who, 0, now_ns + 2);
    buy(g, check);
    signed(g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    check
}

/// A guard whose owner caps each token at `cap_wei` an hour, `agent.test` armed for 1,000 s.
fn capped(cap_wei: u128) -> Guard {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_token_cap(U128(cap_wei), MIN_CAP_PERIOD_S);
    g
}

#[test]
fn the_token_limits_at_init_close_every_buy_until_the_owner_sets_a_cap() {
    ctx("guard.test", 0, 0);
    let g = Guard::new(
        id("owner.test"),
        id("armer.test"),
        id("sentinel.test"),
        U128(PRICE),
        evm(),
    );
    let l = g.token_limits();
    assert_eq!(
        (l.quarantine_s, l.cap_wei, l.cap_period_s),
        (1800, U128(0), 86_400)
    );
}

#[test]
#[should_panic(expected = "amount above what the owner's per-token cap leaves")]
fn no_check_while_the_token_cap_is_zero() {
    let mut g = capped(0);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "target is quarantined after a block verdict")]
fn a_blocked_token_is_not_checked_again_at_once() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    assert!(g.get_entry(TARGET.into()).is_none()); // a block that lists nothing
    ctx("agent.test", 0, 700);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "target is quarantined after a block verdict")]
fn another_agent_does_not_check_a_blocked_token_either() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    enroll(&mut g, "agent2.test", 700);
    ctx("agent2.test", 0, 800);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
fn the_quarantine_ends_after_the_owners_period() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    let other = g.request_check(OTHER.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    let until = 600 + DEFAULT_QUARANTINE_S * SEC;
    let q = &events()[1]; // after `verdict_posted`
    assert_eq!(q["event"], "quarantined");
    assert_eq!(q["data"][0]["token"], TARGET.to_ascii_lowercase());
    assert_eq!(q["data"][0]["id"], check);
    assert_eq!(q["data"][0]["until_ns"], until.to_string());
    // an allow quarantines nothing
    verdict_at(&mut g, other, Verdict::Allow, 700);
    assert_eq!(events().len(), 1);
    assert_eq!(g.quarantined_until(OTHER.into()), None);
    ctx("agent.test", 0, until - 1);
    assert_eq!(g.quarantined_until(TARGET.into()), Some(U64(until)));
    arm_at(&mut g, 100 * U, 1000, until);
    ctx("agent.test", 0, until);
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "target is quarantined after a block verdict")]
fn an_allow_no_longer_buys_once_a_later_check_blocked_its_token() {
    let (mut g, allowed) = judged(Verdict::Allow);
    let again = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, again, Verdict::Block, 800);
    ctx("agent.test", 0, 900);
    buy(&mut g, allowed);
}

// A sentinel whose node fails posts a block without the token's code: nothing was judged.
#[test]
fn the_fail_closed_fallback_block_quarantines_nothing() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
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
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    ctx("agent.test", 0, 700);
    g.request_check(TARGET.into(), U128(VALUE), None); // the next check is possible at once
}

#[test]
fn the_owner_lifts_a_quarantine() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    ctx("owner.test", 0, 700);
    g.lift_quarantine(TARGET.into());
    let v = last_event();
    assert_eq!(v["event"], "quarantine_lifted");
    assert_eq!(v["data"][0]["token"], TARGET.to_ascii_lowercase());
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    ctx("agent.test", 0, 800);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_agent_does_not_lift_a_quarantine() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    ctx("agent.test", 0, 700);
    g.lift_quarantine(TARGET.into());
}

#[test]
#[should_panic(expected = "token not quarantined")]
fn lifting_needs_a_quarantine() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.lift_quarantine(TARGET.into());
}

#[test]
fn the_owner_sets_the_quarantine_for_the_next_blocks() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("owner.test", 0, 0);
    g.set_quarantine(MIN_QUARANTINE_S);
    assert_eq!(last_event()["event"], "quarantine_set");
    g.set_quarantine(MAX_QUARANTINE_S);
    assert_eq!(g.token_limits().quarantine_s, 86_400);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Block, 600);
    ctx("owner.test", 0, 700);
    g.set_quarantine(MIN_QUARANTINE_S); // a quarantine already running keeps its end
    assert_eq!(
        g.quarantined_until(TARGET.into()),
        Some(U64(600 + 86_400 * SEC))
    );
}

#[test]
#[should_panic(expected = "quarantine out of bounds")]
fn a_quarantine_shorter_than_10_minutes_is_refused() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_quarantine(MIN_QUARANTINE_S - 1);
}

#[test]
#[should_panic(expected = "quarantine out of bounds")]
fn a_quarantine_longer_than_a_day_is_refused() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_quarantine(MAX_QUARANTINE_S + 1);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_sentinel_does_not_set_the_quarantine() {
    let mut g = guard();
    ctx("sentinel.test", 0, 0);
    g.set_quarantine(MIN_QUARANTINE_S);
}

// An exit is never blocked: a quarantined token is still quoted and sold, and an exit quote
// without a sale quarantines nothing.
#[test]
fn a_quarantined_token_is_still_sold() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("agent.test", 0, 800);
    let again = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, again, Verdict::Block, 900);
    assert!(g.quarantined_until(TARGET.into()).is_some());
    let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
    ctx("agent.test", 0, 1100);
    let _ = g.sell_quoted(exit);
    assert!(g.signing_since().is_some());
}

#[test]
fn an_exit_quote_without_a_sale_quarantines_nothing() {
    let (mut g, bought) = judged(Verdict::Allow);
    buy(&mut g, bought);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    ctx("agent.test", 0, 800);
    let exit = g.request_exit(bought, U128(MIN_OUT));
    ctx("sentinel.test", 0, 900);
    g.post_verdict(
        exit,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(0),
        None,
        false,
        vec![],
    );
    assert_eq!(g.quarantined_until(TARGET.into()), None);
}

#[test]
#[should_panic(expected = "a check of this target is already awaiting its verdict")]
fn a_second_check_of_a_token_waits_for_the_first_verdict() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    g.request_check(TARGET.to_ascii_lowercase(), U128(VALUE), None); // the same token, another case
}

#[test]
#[should_panic(expected = "a check of this target is already awaiting its verdict")]
fn another_agent_waits_for_it_too() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    enroll(&mut g, "agent2.test", 600);
    ctx("agent2.test", 0, 700);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
fn a_token_is_checked_again_after_its_verdict_or_the_timeout() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 500);
    let first = g.request_check(TARGET.into(), U128(VALUE), None);
    let other = g.request_check(OTHER.into(), U128(VALUE), None); // another token, another draw
    assert_eq!(g.pending_check(TARGET.into()), Some(first));
    assert_eq!(g.pending_check(OTHER.into()), Some(other));
    verdict_at(&mut g, first, Verdict::Allow, 600);
    ctx("agent.test", 0, 700);
    assert_eq!(g.pending_check(TARGET.into()), None);
    let second = g.request_check(TARGET.into(), U128(VALUE), None);
    // Never judged, never refunded: it stops counting at the timeout, or an agent that never asks
    // its refund would close the token to every agent.
    ctx("agent.test", 0, 700 + VERDICT_TIMEOUT_NS - 1);
    assert_eq!(g.pending_check(TARGET.into()), Some(second));
    arm_at(&mut g, 100 * U, 1000, 700 + VERDICT_TIMEOUT_NS);
    ctx("agent.test", 0, 700 + VERDICT_TIMEOUT_NS);
    assert_eq!(g.pending_check(TARGET.into()), None);
    let third = g.request_check(TARGET.into(), U128(VALUE), None);
    // The second check's verdict, late, is refused: it neither frees nor takes the third's slot.
    let late = panic_of(|| verdict_at(&mut g, second, Verdict::Allow, 800 + VERDICT_TIMEOUT_NS));
    assert!(late.contains("verdict already posted"), "{late}");
    ctx("agent.test", 0, 900 + VERDICT_TIMEOUT_NS);
    assert_eq!(g.pending_check(TARGET.into()), Some(third));
}

#[test]
fn a_refund_frees_the_tokens_slot() {
    let (mut g, check) = pending();
    let key = g.get_check(check).unwrap().target.to_ascii_lowercase();
    assert_eq!(g.pending.get(&key), Some(&check));
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    assert_eq!(g.pending.get(&key), None);
}

#[test]
fn the_token_cap_counts_every_agents_buys() {
    let mut g = capped(2 * VALUE);
    buy_signed(&mut g, "agent.test", 10);
    assert_eq!(g.token_bought(TARGET.into()), U128(VALUE));
    ctx("owner.test", 0, 20);
    g.set_holding(TARGET.into(), id("agent.test"), U128(0)); // free for another agent
    enroll(&mut g, "agent2.test", 30);
    buy_signed(&mut g, "agent2.test", 40);
    assert_eq!(g.token_bought(TARGET.into()), U128(2 * VALUE));
    assert_eq!(g.token_bought(OTHER.into()), U128(0)); // per token
    ctx("agent2.test", 0, 50);
    g.request_check(OTHER.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "amount above what the owner's per-token cap leaves")]
fn a_check_beyond_the_token_cap_is_refused_for_any_agent() {
    let mut g = capped(2 * VALUE - 1);
    buy_signed(&mut g, "agent.test", 10);
    ctx("owner.test", 0, 20);
    g.set_holding(TARGET.into(), id("agent.test"), U128(0));
    enroll(&mut g, "agent2.test", 30);
    ctx("agent2.test", 0, 40);
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
#[should_panic(expected = "amount above what the owner's per-token cap leaves")]
fn a_buy_beyond_a_token_cap_lowered_after_its_check_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    ctx("owner.test", 0, 650);
    g.set_token_cap(U128(VALUE - 1), MIN_CAP_PERIOD_S);
    assert_eq!(last_event()["event"], "token_cap_set");
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn a_buy_leaves_the_token_cap_after_its_period() {
    let mut g = capped(VALUE);
    buy_signed(&mut g, "agent.test", 10);
    let end = 12 + MIN_CAP_PERIOD_S * SEC; // the buy was sent to signing at 12
    ctx("agent.test", 0, end - 1);
    assert_eq!(g.token_bought(TARGET.into()), U128(VALUE));
    arm_at(&mut g, 100 * U, 1000, end);
    ctx("agent.test", 0, end);
    assert_eq!(g.token_bought(TARGET.into()), U128(0));
    g.request_check(TARGET.into(), U128(VALUE), None);
}

#[test]
fn a_buy_whose_signature_does_not_come_back_stays_counted() {
    let (mut g, check) = judged(Verdict::Allow);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Failed);
    assert_eq!(g.token_bought(TARGET.into()), U128(VALUE)); // the MPC may still publish it
}

// A full log never closes the token: the 33rd buy merges the two oldest entries, counted until the
// newer of the two leaves the period (never less than what was bought).
#[test]
fn a_33rd_buy_of_a_token_merges_the_two_oldest_and_never_wedges_it() {
    let (mut g, check) = judged(Verdict::Allow);
    let key = TARGET.to_ascii_lowercase();
    g.token_buys
        .insert(key.clone(), (0..32).map(|i| (600 + i, 1)).collect());
    buy(&mut g, check);
    let log = g.token_buys.get(&key).unwrap();
    assert_eq!(log.len(), MAX_TOKEN_BUYS);
    assert_eq!(log[0], (601, 2));
    assert_eq!(log[MAX_TOKEN_BUYS - 1], (700, VALUE));
    assert_eq!(g.token_bought(TARGET.into()), U128(32 + VALUE));
}

#[test]
#[should_panic(expected = "cap period out of bounds")]
fn a_cap_period_shorter_than_an_hour_is_refused() {
    let mut g = guard();
    ctx("owner.test", 0, 0);
    g.set_token_cap(U128(VALUE), MIN_CAP_PERIOD_S - 1);
}

#[test]
#[should_panic(expected = "owner only")]
fn the_armer_does_not_set_the_token_cap() {
    let mut g = guard();
    ctx("armer.test", 0, 0);
    g.set_token_cap(U128(VALUE), MIN_CAP_PERIOD_S);
}

// The 120 s of a verdict count from the verdict; the state it judged is the reference block's, 4 s
// after the request. A verdict posted late (a flooded queue) buys only within 180 s of the request.
#[test]
fn a_buy_just_within_180_s_of_its_request_is_signed() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Allow, 100 * SEC);
    ctx("agent.test", 0, VERDICT_FRESH_NS - 1);
    buy(&mut g, check);
    assert!(g.signing_since().is_some());
}

#[test]
#[should_panic(expected = "check requested more than 180 s ago: request a new check")]
fn a_buy_180_s_after_its_request_is_refused_within_the_verdicts_120_s() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    verdict_at(&mut g, check, Verdict::Allow, 100 * SEC); // a slow verdict
    ctx("agent.test", 0, VERDICT_FRESH_NS); // 80 s after it
    buy(&mut g, check);
}

// A block vote that names the token's code quarantines it in every order.
#[test]
fn a_block_naming_the_code_quarantines_after_a_fallback_block_decided() {
    let (mut g, check) = asked_of_two();
    fallback(&mut g, "sentinel.test", check, 600);
    assert_eq!(verdict_of(&g, check), Some(Verdict::Block));
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 700);
    assert_eq!(last_event()["event"], "quarantined");
    assert_eq!(
        g.quarantined_until(TARGET.into()),
        Some(U64(700 + DEFAULT_QUARANTINE_S * SEC))
    );
    assert_eq!(g.fees(), U128(PRICE)); // the price moved once, at the decision
}

#[test]
fn a_block_naming_the_code_quarantines_after_one_vote_was_the_quorum() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    name(&mut g, &["sentinel.test", "sentinel2.test"], 1, 0);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    fallback(&mut g, "sentinel.test", check, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 700);
    assert!(g.quarantined_until(TARGET.into()).is_some());
}

#[test]
fn a_block_naming_the_code_quarantines_after_a_disagreement() {
    let (mut g, check) = asked_of_three(3);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, false, 700);
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    vote(&mut g, "sentinel3.test", check, Verdict::Block, false, 800);
    assert!(g.quarantined_until(TARGET.into()).is_some());
    assert_eq!(g.get_check(check).unwrap().reasons, DISAGREE); // decided by the disagreement
}

#[test]
fn a_later_block_never_shortens_a_quarantine() {
    let (mut g, check) = asked_of_two();
    ctx("owner.test", 0, 550);
    g.set_quarantine(MAX_QUARANTINE_S);
    vote(&mut g, "sentinel.test", check, Verdict::Block, false, 600);
    ctx("owner.test", 0, 650);
    g.set_quarantine(MIN_QUARANTINE_S);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 700);
    assert_eq!(
        g.quarantined_until(TARGET.into()),
        Some(U64(600 + MAX_QUARANTINE_S * SEC))
    );
}

#[test]
fn a_refund_leaves_the_slot_a_later_check_of_the_token_holds() {
    let (mut g, first) = pending(); // requested at 0, never judged
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    let second = g.request_check(TARGET.into(), U128(VALUE), None);
    g.refund_check(first);
    assert_eq!(g.pending_check(TARGET.into()), Some(second));
    assert!(g.get_check(first).is_none());
}
