//! Checks and verdicts: requests, the sentinel's verdict, the code reference, the decision
//! digest, and the sentinel quorum's votes.

use super::*;

// 1. log: structured JSON event, validated target
#[test]
fn structured_json_event() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    let log = get_logs().pop().unwrap();
    let json = log.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
    assert_eq!(v["event"], "check_requested");
    assert_eq!(v["data"][0]["target"], TARGET);
    assert_eq!(v["data"][0]["agent"], "agent.test");
    assert_eq!(v["data"][0]["id"], 1);
}

#[test]
fn invalid_target_refused_without_debit() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let before = g.credit_of(&id("agent.test")).0;
    let bad = [
        "0xabc",
        "dAC17F958D2ee523a2206206994597C13D831ec7ab",
        "0xdAC17F958D2ee523a2206206994597C13D831ecZ",
        "0xdAC17F958D2ee523a2206206994597C13D831ec7\" agent=evil",
        "0xdAC17F958D2ee523a2206206994597C13D831ec7\n",
        &format!("0x{}", "a".repeat(10_000)),
    ];
    for t in bad {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            g.request_check(t.to_string(), U128(VALUE), None)
        }));
        assert!(r.is_err(), "must refuse {t:?}");
    }
    assert_eq!(g.credit_of(&id("agent.test")).0, before);
}

// 5. verdict posted by the sentinel alone, once
#[test]
fn the_sentinel_posts_a_readable_verdict() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 600);
    g.post_verdict(
        check,
        Verdict::Block,
        "taken back by transferFrom".into(),
        "{\"block\":1}".into(),
        U128(QUOTE),
        code("aa"),
        true,
        vec![],
    );
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Block));
    assert_eq!(c.reasons, "taken back by transferFrom");
    let v = &events()[0]; // then `listed`: a block lists its target
    assert_eq!(v["event"], "verdict_posted");
    assert_eq!(v["data"][0]["id"], 1);
    assert_eq!(v["data"][0]["verdict"], "block");
    assert_eq!(v["data"][0]["evidence"], "{\"block\":1}");
}

#[test]
#[should_panic(expected = "sentinel only")]
fn only_the_sentinel_posts_a_verdict() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
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
#[should_panic(expected = "verdict already posted")]
fn a_verdict_is_not_rewritten() {
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
        true,
        vec![],
    );
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

// the posted proof is tied to the verdict: sha256 hash of the received string, in hex
#[test]
fn the_verdict_stores_the_proof_hash() {
    let (mut g, check) = pending();
    assert_eq!(g.get_check(check).unwrap().evidence_sha256, "");
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        "abc".into(),
        U128(QUOTE),
        code("aa"),
        true,
        vec![],
    );
    let v = near_sdk::serde_json::to_value(g.get_check(check).unwrap()).unwrap();
    assert_eq!(
        v["evidence_sha256"],
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

// 13. the sentinel knows how far to read, even if a refunded request was erased
#[test]
fn last_check_id_follows_the_requests() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    assert_eq!(g.last_check_id(), 0);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), None);
    g.request_check(OTHER.into(), U128(VALUE), None);
    assert_eq!(g.last_check_id(), 2);
}

// 14. an expired verdict no longer buys: the target may have changed since the check
fn judged_at_1s() -> (Guard, u64) {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    let check = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, SEC);
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
    (g, check)
}

#[test]
fn the_verdict_dates_its_judgment() {
    let (g, check) = judged_at_1s();
    assert_eq!(g.get_check(check).unwrap().judged_ns, U64(SEC));
}

#[test]
fn buy_signed_just_before_the_verdict_expires() {
    let (mut g, check) = judged_at_1s();
    ctx("agent.test", 0, SEC + VERDICT_TTL_NS - 1);
    buy(&mut g, check);
    assert_eq!(sign_args()["request"]["path"], DERIVATION_PATH);
}

#[test]
#[should_panic(expected = "verdict expired")]
fn buy_refused_on_an_expired_verdict() {
    let (mut g, check) = judged_at_1s();
    ctx("agent.test", 0, SEC + VERDICT_TTL_NS);
    buy(&mut g, check);
}

// 14. code changed since the last check: at most warn, the human decides
#[test]
fn the_code_seen_at_the_last_verdict_is_remembered_per_target() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    assert!(g.last_code(TARGET.into()).is_none());
    verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    let second = verdict_on(&mut g, Verdict::Allow, code("aa"), 20);
    let last = g.last_code(TARGET.to_lowercase()).unwrap();
    assert_eq!(last.id, second);
    assert_eq!(Some(last.code), code("aa"));
}

#[test]
#[should_panic(expected = "code changed since the last check")]
fn an_allow_on_changed_code_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    verdict_on(&mut g, Verdict::Allow, code("bb"), 20);
}

#[test]
#[should_panic(expected = "code changed since the last check")]
fn a_new_proxy_implementation_is_a_code_change() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, proxy("11"), 10);
    verdict_on(&mut g, Verdict::Allow, proxy("22"), 20);
}

#[test]
fn a_warn_on_changed_code_stands_and_the_human_can_approve_it() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    let check = verdict_on(&mut g, Verdict::Warn, code("bb"), 20);
    ctx("owner.test", 0, 30);
    g.approve_warn(check);
    assert!(g.get_check(check).unwrap().approved);
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, check); // the new code is the reference now
}

#[test]
#[should_panic(expected = "allow or warn without the target's code")]
fn an_allow_without_the_code_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, None, 10);
}

#[test]
#[should_panic(expected = "invalid code hash")]
fn a_malformed_code_hash_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    let bad = Code {
        code_hash: "0x12".into(),
        implementation: None,
    };
    verdict_on(&mut g, Verdict::Allow, Some(bad), 10);
}

// 17. decision digest: an attested LLM decision anchored on chain with the check and the buy
const DIGEST: &str = "AB12ab12AB12ab12AB12ab12AB12ab12AB12ab12AB12ab12AB12ab12AB12ab12";

#[test]
fn a_decision_digest_is_stored_lowercase_and_logged_with_the_check_and_the_buy() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), Some(DIGEST.into()));
    let lower = DIGEST.to_lowercase();
    assert_eq!(last_event()["data"][0]["decision_sha256"], lower);
    let v = near_sdk::serde_json::to_value(g.get_check(check).unwrap()).unwrap();
    assert_eq!(v["decision_sha256"], lower);
    assert!(v["buy_decision_sha256"].is_null());
    ctx("sentinel.test", 0, 600);
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
    ctx("agent.test", 0, 700);
    let other = "0".repeat(64);
    let _ = g.buy(check, U128(VALUE), Some(other.clone()));
    assert_eq!(last_event()["event"], "sign_requested");
    assert_eq!(last_event()["data"][0]["decision_sha256"], other);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.buy_decision_sha256.as_deref(), Some(other.as_str()));
    assert_eq!(c.decision_sha256.as_deref(), Some(lower.as_str()));
}

#[test]
fn without_a_digest_the_fields_and_events_carry_null() {
    let (mut g, check) = judged(Verdict::Allow);
    let c = g.get_check(check).unwrap();
    assert!(c.decision_sha256.is_none() && c.buy_decision_sha256.is_none());
    buy(&mut g, check);
    assert!(last_event()["data"][0]["decision_sha256"].is_null());
}

#[test]
#[should_panic(expected = "invalid decision sha256: 64 hex digits")]
fn a_digest_with_a_0x_prefix_is_refused_before_any_debit() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(
        TARGET.into(),
        U128(VALUE),
        Some(format!("0x{}", "a".repeat(62))),
    );
}

#[test]
#[should_panic(expected = "invalid decision sha256: 64 hex digits")]
fn a_buy_digest_of_the_wrong_length_is_refused() {
    let (mut g, check) = judged(Verdict::Allow);
    let _ = g.buy(check, U128(VALUE), Some("ab".into()));
}

#[test]
#[should_panic(expected = "invalid decision sha256: 64 hex digits")]
fn a_non_hex_digest_is_refused() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), Some("g".repeat(64)));
}

// 17b. one signed decision backs one guard call (judge pass 5: one package anchored on two checks)
#[test]
#[should_panic(expected = "decision already anchored on check #1")]
fn a_decision_digest_backs_one_check_only() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    g.request_check(TARGET.into(), U128(VALUE), Some(DIGEST.into()));
    g.request_check(OTHER.into(), U128(VALUE), Some(DIGEST.to_lowercase()));
    // same digest, other case
}

#[test]
#[should_panic(expected = "decision already anchored on check #1")]
fn the_check_s_digest_cannot_also_back_its_buy() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let check = g.request_check(TARGET.into(), U128(VALUE), Some(DIGEST.into()));
    ctx("sentinel.test", 0, 600);
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
    ctx("agent.test", 0, 700);
    let _ = g.buy(check, U128(VALUE), Some(DIGEST.into()));
}

#[test]
fn decision_of_names_the_check_a_digest_backs() {
    let (mut g, check) = judged(Verdict::Allow);
    assert_eq!(g.decision_of(DIGEST.into()), None);
    let _ = g.buy(check, U128(VALUE), Some(DIGEST.into()));
    assert_eq!(g.decision_of(DIGEST.into()), Some(U64(check)));
    assert_eq!(g.decision_of(DIGEST.to_lowercase()), Some(U64(check)));
}

#[test]
fn a_refunded_check_frees_its_digest() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    ctx("agent.test", 0, 0);
    let check = g.request_check(TARGET.into(), U128(VALUE), Some(DIGEST.into()));
    ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    assert_eq!(g.decision_of(DIGEST.into()), None); // it backs nothing any more
    let again = g.request_check(TARGET.into(), U128(VALUE), Some(DIGEST.into()));
    assert_eq!(g.decision_of(DIGEST.into()), Some(U64(again)));
}

// 19. the reference code moves only to the same code, or when the owner approves a warn
#[test]
#[should_panic(expected = "code changed since the last check: at most warn")]
fn a_warn_on_changed_code_does_not_let_the_next_check_allow() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    verdict_on(&mut g, Verdict::Warn, code("bb"), 20);
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, 1); // the reference did not move
    verdict_on(&mut g, Verdict::Allow, code("bb"), 30);
}

#[test]
fn approving_the_warn_moves_the_reference_to_the_changed_code() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    let warn = verdict_on(&mut g, Verdict::Warn, code("bb"), 20);
    approve(&mut g, warn, 30);
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, warn);
    let next = verdict_on(&mut g, Verdict::Allow, code("bb"), 40);
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, next);
}

#[test]
fn a_block_on_changed_code_never_moves_the_reference_and_the_old_code_still_does() {
    let mut g = funded(ONE_NEAR, 100 * U, 1000);
    let first = verdict_on(&mut g, Verdict::Allow, code("aa"), 10);
    ctx("agent.test", 0, 20);
    let block = g.request_check(TARGET.into(), U128(VALUE), None);
    ctx("sentinel.test", 0, 21);
    g.post_verdict(
        block,
        Verdict::Block,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("bb"),
        false, // not listed
        vec![],
    );
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, first);
    ctx("owner.test", 0, 25);
    g.lift_quarantine(TARGET.into()); // the next check is possible again
    let back = verdict_on(&mut g, Verdict::Warn, code("aa"), 30); // same code, any verdict
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, back);
}

// Judge pass 6: `list_target` was stored nowhere, so replay could not tell a listing the sentinel
// asked for from the one its evidence supports.
#[test]
fn the_check_keeps_the_list_target_the_sentinel_posted() {
    let mut g = funded(ONE_NEAR, 100 * U, 1);
    ctx("agent.test", 0, 500);
    let asked = g.request_check(TARGET.into(), U128(VALUE), None);
    let not_asked = g.request_check(WITHDRAW_TO.into(), U128(VALUE), None);
    for (check, list_target) in [(asked, true), (not_asked, false)] {
        ctx("sentinel.test", 0, 600);
        g.post_verdict(
            check,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            list_target,
            vec![],
        );
        assert_eq!(g.get_check(check).unwrap().list_target, list_target);
        assert_eq!(events()[0]["data"][0]["list_target"], list_target);
    }
}

// 22. Sentinel quorum: an allow or a warn takes `quorum` identical votes, any one sentinel blocks,
// a disagreement blocks, listing takes the quorum (exit quotes: section 23).
#[test]
fn one_allow_vote_of_two_is_no_verdict() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    let v = last_event();
    assert_eq!(v["event"], "verdict_posted");
    assert_eq!(v["data"][0]["sentinel"], "sentinel.test");
    assert_eq!(v["data"][0]["votes"], 1);
    assert_eq!(v["data"][0]["quorum"], 2);
    assert!(v["data"][0]["decided"].is_null());
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, None);
    assert_eq!(c.votes.len(), 1);
    assert_eq!(g.fees(), U128(0)); // the price stays in escrow
    assert_eq!(g.pending_check(TARGET.into()), Some(check));
    assert!(g.last_code(TARGET.into()).is_none()); // one vote moves no reference
}

#[test]
#[should_panic(expected = "no verdict yet")]
fn one_allow_vote_of_two_does_not_buy() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn two_identical_allow_votes_make_the_verdict() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    assert_eq!(last_event()["data"][0]["decided"], "allow");
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Allow));
    assert_eq!(c.judged_ns, U64(700)); // the confirming vote
    assert_eq!(c.reasons, "reasons of sentinel.test");
    let sha = |who: &str| hex(&env::sha256(format!("evidence of {who}").as_bytes()));
    assert_eq!(
        c.votes,
        [
            Vote {
                sentinel: id("sentinel.test"),
                verdict: Verdict::Allow,
                evidence_sha256: sha("sentinel.test"),
                quote: None,
            },
            Vote {
                sentinel: id("sentinel2.test"),
                verdict: Verdict::Allow,
                evidence_sha256: sha("sentinel2.test"),
                quote: None,
            },
        ]
    );
    assert_eq!(c.evidence_sha256, sha("sentinel.test"));
    assert_eq!(g.fees(), U128(PRICE)); // once
    assert_eq!(g.pending_check(TARGET.into()), None);
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, check);
    // the 120 s run from the confirming vote
    ctx("agent.test", 0, 700 + VERDICT_TTL_NS - 1);
    buy(&mut g, check);
    assert!(g.signing_since().is_some());
}

#[test]
#[should_panic(expected = "verdict expired")]
fn the_verdict_expires_120_s_after_the_confirming_vote() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    ctx("agent.test", 0, 700 + VERDICT_TTL_NS);
    buy(&mut g, check);
}

#[test]
fn a_single_block_vote_blocks_at_once_and_listing_takes_the_quorum() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel2.test", check, Verdict::Block, true, 600);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Block));
    assert_eq!(c.judged_ns, U64(600));
    assert_eq!(g.fees(), U128(PRICE));
    assert!(g.quarantined_until(TARGET.into()).is_some());
    assert!(g.get_entry(TARGET.into()).is_none()); // one key lists nothing
    vote(&mut g, "sentinel.test", check, Verdict::Block, true, 700);
    let e = g.get_entry(TARGET.into()).unwrap();
    assert_eq!(e.reporter, id("sentinel.test"));
    assert_eq!(e.note, format!("verdict #{check}"));
    assert_eq!(last_event()["event"], "listed");
    assert_eq!(g.fees(), U128(PRICE)); // the price moved once
    assert_eq!(g.get_check(check).unwrap().judged_ns, U64(600));
}

#[test]
fn two_block_votes_that_do_not_both_ask_to_list_list_nothing() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Block, true, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 700);
    assert!(g.get_entry(TARGET.into()).is_none());
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
}

#[test]
fn a_block_vote_after_an_allow_vote_vetoes_it() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, true, 700);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Block));
    assert_eq!(c.reasons, "reasons of sentinel2.test");
    assert_eq!(
        c.evidence_sha256,
        hex(&env::sha256(b"evidence of sentinel2.test"))
    );
    assert!(g.quarantined_until(TARGET.into()).is_some());
    assert!(g.get_entry(TARGET.into()).is_none());
    assert!(g.last_code(TARGET.into()).is_none());
}

#[test]
fn votes_that_disagree_block_and_quarantine_nothing() {
    // another verdict
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, false, 700);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Block));
    assert_eq!(c.reasons, DISAGREE);
    assert_eq!(last_event()["data"][0]["decided"], "block");
    assert_eq!(g.quarantined_until(TARGET.into()), None); // no sentinel found a refusal
    assert_eq!(g.pending_check(TARGET.into()), None);
    // the same verdict, another listing
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, true, 700);
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
    // the same verdict, another code
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    ctx("sentinel2.test", 0, 700);
    let hashes = previewed(&g, check, QUOTE);
    g.post_verdict(
        check,
        Verdict::Warn,
        String::new(),
        String::new(),
        U128(QUOTE),
        code("bb"),
        false,
        hashes,
    );
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
}

#[test]
#[should_panic(expected = "verdict does not allow the purchase")]
fn a_disagreement_does_not_buy() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, false, 700);
    ctx("agent.test", 0, 800);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "sentinel already voted")]
fn a_sentinel_votes_once() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 700);
}

#[test]
#[should_panic(expected = "verdict already posted")]
fn a_third_sentinels_allow_is_not_taken_once_two_of_three_decided() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Allow));
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 800);
}

#[test]
fn a_warn_is_approved_only_once_the_quorum_voted_it() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    ctx("owner.test", 0, 650);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        g.approve_warn(check);
    }));
    assert!(early.is_err(), "a warn approved on one vote of two");
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, false, 700);
    ctx("owner.test", 0, 750);
    g.approve_warn(check);
    ctx("agent.test", 0, 800);
    buy(&mut g, check);
    assert!(g.signing_since().is_some());
}

#[test]
#[should_panic(expected = "verdict below the sentinels' quorum")]
fn a_verdict_decided_under_a_lower_quorum_no_longer_buys() {
    let (mut g, check) = judged(Verdict::Allow); // one sentinel, quorum 1
    ctx("owner.test", 0, 650);
    g.set_sentinels(vec![id("sentinel.test"), id("sentinel2.test")], 2);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn a_check_one_sentinel_never_voted_on_is_refunded() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    let credit = g.credit_of(&id("agent.test")).0;
    ctx("agent.test", 0, 500 + VERDICT_TIMEOUT_NS);
    g.refund_check(check);
    assert_eq!(g.credit_of(&id("agent.test")).0, credit + PRICE);
    assert_eq!(g.escrow(), U128(0));
}

#[test]
fn the_owner_names_the_sentinels_and_the_quorum() {
    let mut g = guard();
    let s = g.sentinels();
    assert_eq!((s.sentinels, s.quorum), (vec![id("sentinel.test")], 1));
    ctx("owner.test", 0, 0);
    let three = ["a.test", "b.test", "c.test"].map(id).to_vec();
    g.set_sentinels(three.clone(), 2);
    let s = g.sentinels();
    assert_eq!((s.sentinels, s.quorum), (three, 2));
    for (sentinels, quorum) in [
        (vec![], 1),
        (vec![id("a.test"), id("a.test")], 1),
        (["a.test", "b.test", "c.test", "d.test"].map(id).to_vec(), 2),
        (vec![id("a.test")], 0),
        (vec![id("a.test")], 2),
    ] {
        let bad = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            g.set_sentinels(sentinels.clone(), quorum);
        }));
        assert!(bad.is_err(), "{sentinels:?} with quorum {quorum} accepted");
    }
}

#[test]
#[should_panic(expected = "reporter only")]
fn a_sentinel_alone_does_not_report_a_token() {
    let mut g = guard();
    ctx("owner.test", ONE_NEAR, 0);
    g.deposit_credit(Some(id("sentinel.test")));
    ctx("sentinel.test", 0, 1);
    g.report(TARGET.into(), "a".repeat(64), String::new());
}

// 23. Review of the quorum and the token limits. A vote counts while its sentinel is one of the
// guard's; a quorum changed while votes wait is the one they are weighed with; a block vote that
// names the token's code quarantines in every order and stops a buy not yet sent to signing; an
// exit quote is no longer one key's to give or to refuse.
// A sentinel removed because its key was stolen no longer counts, on checks it already voted on too.
#[test]
#[should_panic(expected = "verdict below the sentinels' quorum")]
fn an_allow_resting_on_a_removed_sentinels_vote_no_longer_buys() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    name(&mut g, &["sentinel2.test", "sentinel3.test"], 2, 750);
    ctx("agent.test", 0, 800);
    buy(&mut g, check);
}

#[test]
#[should_panic(expected = "verdict below the sentinels' quorum")]
fn a_warn_resting_on_a_removed_sentinels_vote_is_not_approved() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Warn, false, 700);
    name(&mut g, &["sentinel2.test", "sentinel3.test"], 2, 750);
    ctx("owner.test", 0, 800);
    g.approve_warn(check);
}

#[test]
fn a_removed_sentinels_vote_does_not_complete_the_quorum() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    name(&mut g, &["sentinel2.test", "sentinel3.test"], 2, 650);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, None, "a removed sentinel's vote made the quorum");
    // its vote is dropped (its `verdict_posted` event stays), the check rests on the others'
    assert_eq!(c.votes.len(), 1);
    assert_eq!(c.votes[0].sentinel, id("sentinel2.test"));
    assert_eq!(c.reasons, "reasons of sentinel2.test");
    assert_eq!(last_event()["data"][0]["votes"], 1);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 800);
    assert_eq!(verdict_of(&g, check), Some(Verdict::Allow));
    ctx("agent.test", 0, 900);
    buy(&mut g, check);
    assert!(g.signing_since().is_some());
}

// The stolen key voted first, with a quote of its own: once removed, the honest votes are not
// compared with it (they would disagree and block).
#[test]
fn what_a_removed_sentinel_posted_is_not_what_the_others_are_compared_with() {
    let (mut g, check) = asked_of_two();
    ctx("sentinel.test", 0, 600);
    let hashes = previewed(&g, check, QUOTE + 1);
    g.post_verdict(
        check,
        Verdict::Allow,
        String::new(),
        String::new(),
        U128(QUOTE + 1),
        code("aa"),
        true,
        hashes,
    );
    name(&mut g, &["sentinel2.test", "sentinel3.test"], 2, 650);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 800);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Allow));
    assert_eq!((c.quote, c.list_target), (U128(QUOTE), false));
}

// A whole new set: the old votes make no quorum, and the first new vote drops them.
#[test]
fn the_votes_of_a_replaced_set_never_make_its_quorum_and_are_dropped() {
    let (mut g, check) = asked_of_three(3);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 610);
    name(&mut g, &["a.test", "b.test", "c.test"], 3, 650);
    vote(&mut g, "a.test", check, Verdict::Allow, false, 700);
    assert_eq!(
        verdict_of(&g, check),
        None,
        "two removed sentinels made a quorum of three"
    );
    vote(&mut g, "b.test", check, Verdict::Allow, false, 710);
    vote(&mut g, "c.test", check, Verdict::Allow, false, 720);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Allow));
    assert_eq!(c.votes.len(), MAX_SENTINELS);
}

// The owner lowers the quorum while a check waits: the next vote decides it...
#[test]
fn the_next_vote_decides_under_a_lowered_quorum() {
    let (mut g, check) = asked_of_three(3);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 610);
    name(&mut g, &THREE, 2, 650);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    assert_eq!(verdict_of(&g, check), Some(Verdict::Allow));
    assert_eq!(g.get_check(check).unwrap().judged_ns, U64(700));
}

// ...and when no sentinel is left to vote, the buy itself: the votes in already make the quorum.
#[test]
fn votes_that_make_a_lowered_quorum_decide_at_the_buy() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    name(&mut g, &["sentinel.test"], 1, 650);
    ctx("agent.test", 0, 700);
    assert_eq!(g.pending_check(TARGET.into()), None); // the token is no longer held
    buy(&mut g, check);
    let v = &events()[0];
    assert_eq!(v["event"], "verdict_decided");
    assert_eq!(v["data"][0]["id"], check);
    assert_eq!(v["data"][0]["verdict"], "allow");
    assert_eq!(v["data"][0]["votes"], 1);
    assert_eq!(v["data"][0]["quorum"], 1);
    let c = g.get_check(check).unwrap();
    assert_eq!((c.verdict, c.judged_ns), (Some(Verdict::Allow), U64(700)));
    assert_eq!(g.fees(), U128(PRICE)); // the price left the escrow, once
    assert_eq!(g.escrow(), U128(COST));
    assert_eq!(g.last_code(TARGET.into()).unwrap().id, check);
    assert!(g.signing_since().is_some());
}

#[test]
fn a_warn_whose_votes_make_a_lowered_quorum_is_approved() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    name(&mut g, &["sentinel.test", "sentinel2.test"], 1, 650);
    ctx("owner.test", 0, 700);
    g.approve_warn(check);
    let c = g.get_check(check).unwrap();
    assert_eq!((c.verdict, c.approved), (Some(Verdict::Warn), true));
    assert_eq!(g.fees(), U128(PRICE));
}

#[test]
#[should_panic(expected = "no verdict yet")]
fn votes_below_the_quorum_decide_nothing_at_the_buy() {
    let (mut g, check) = asked_of_three(3);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    name(&mut g, &THREE, 2, 650);
    ctx("agent.test", 0, 700);
    buy(&mut g, check);
}

#[test]
fn a_raised_quorum_takes_one_more_vote() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    name(&mut g, &THREE, 3, 650);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    assert_eq!(verdict_of(&g, check), None);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 800);
    assert_eq!(verdict_of(&g, check), Some(Verdict::Allow));
}

// Two of three decided an allow; the third finds a refusal before the agent buys.
#[test]
fn a_block_vote_after_the_quorums_allow_stops_the_buy() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    assert_eq!(g.fees(), U128(PRICE));
    vote(&mut g, "sentinel2.test", check, Verdict::Block, true, 800);
    let posted = &events()[0];
    assert_eq!(posted["data"][0]["decided"], "block");
    assert_eq!(posted["data"][0]["votes"], 3);
    let c = g.get_check(check).unwrap();
    assert_eq!(c.verdict, Some(Verdict::Block));
    assert_eq!(c.judged_ns, U64(800));
    assert_eq!(c.reasons, "reasons of sentinel2.test");
    assert_eq!(g.fees(), U128(PRICE)); // once
    assert!(g.quarantined_until(TARGET.into()).is_some());
    assert!(g.get_entry(TARGET.into()).is_none()); // one key lists nothing
    ctx("agent.test", 0, 900);
    let bought = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        buy(&mut g, check);
    }));
    assert!(
        bought.is_err(),
        "bought on an allow a sentinel blocked since"
    );
}

#[test]
#[should_panic(expected = "verdict does not allow the purchase")]
fn the_buy_after_a_late_block_vote_is_refused_as_a_block() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    fallback(&mut g, "sentinel2.test", check, 800); // even without the code: no quarantine, no buy
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    ctx("agent.test", 0, 900);
    buy(&mut g, check);
}

// A signature already requested is not recalled (as with the owner's stop): the vote is refused,
// so no check ever shows a block and a signed buy.
#[test]
#[should_panic(expected = "verdict already posted")]
fn a_block_vote_does_not_recall_a_buy_being_signed() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    ctx("agent.test", 0, 750);
    buy(&mut g, check);
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 800);
}

#[test]
#[should_panic(expected = "verdict already posted")]
fn a_block_vote_after_the_buy_was_signed_is_refused() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    ctx("agent.test", 0, 750);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
    vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 900);
}

#[test]
#[should_panic(expected = "sentinel already voted")]
fn a_sentinel_does_not_change_its_allow_into_a_block() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    vote(&mut g, "sentinel.test", check, Verdict::Block, false, 800);
}

// One call tells a sentinel whether its vote on a check can still count.
#[test]
fn vote_due_tells_a_sentinel_whether_its_vote_still_counts() {
    let due = |g: &Guard, who: &str, check: u64| g.vote_due(check, id(who));
    let (mut g, check) = asked_of_three(2);
    assert!(due(&g, "sentinel.test", check));
    assert!(!due(&g, "agent.test", check)); // not a sentinel
    assert!(!due(&g, "sentinel.test", check + 1)); // unknown
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    assert!(!due(&g, "sentinel.test", check)); // voted
    assert!(due(&g, "sentinel2.test", check));
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    // decided: the third may still block it while it can buy, 180 s from the request
    ctx("sentinel2.test", 0, 500 + VERDICT_FRESH_NS - 1);
    assert!(due(&g, "sentinel2.test", check));
    ctx("sentinel2.test", 0, 500 + VERDICT_FRESH_NS);
    assert!(!due(&g, "sentinel2.test", check));
    // a block takes votes up to the quorum (listing needs them)
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Block, true, 600);
    assert!(due(&g, "sentinel2.test", check));
    vote(&mut g, "sentinel2.test", check, Verdict::Block, true, 700);
    assert!(!due(&g, "sentinel3.test", check));
    // a check left waiting is no longer judged 300 s after its request: a restarted sentinel
    // skips every old one
    let (g, check) = asked_of_three(2);
    ctx("sentinel.test", 0, 500 + VERDICT_TIMEOUT_NS - 1);
    assert!(due(&g, "sentinel.test", check));
    ctx("sentinel.test", 0, 500 + VERDICT_TIMEOUT_NS);
    assert!(!due(&g, "sentinel.test", check));
    // an exit quote: every sentinel, until it is sold
    let (mut g, exit) = exit_asked_of_two();
    assert!(due(&g, "sentinel2.test", exit));
    exit_vote(
        &mut g,
        "sentinel.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1001,
    );
    assert!(due(&g, "sentinel2.test", exit));
    exit_vote(
        &mut g,
        "sentinel2.test",
        exit,
        Verdict::Allow,
        EXIT_QUOTE,
        1002,
    );
    assert!(!due(&g, "sentinel2.test", exit));
}

// 24. Refusals a coverage measurement found without a test.
// The owner cannot approve a warn the quorum does not back: here, decided by one sentinel before
// the owner asked for two.
#[test]
#[should_panic(expected = "verdict below the sentinels' quorum")]
fn a_warn_decided_under_a_lower_quorum_is_not_approved() {
    let (mut g, check) = judged(Verdict::Warn); // one sentinel, quorum 1
    name(&mut g, &["sentinel.test", "sentinel2.test"], 2, 650);
    approve(&mut g, check, 660);
}

#[test]
#[should_panic(expected = "reasons too long")]
fn reasons_above_280_bytes_are_refused() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Block,
        "r".repeat(MAX_REASONS + 1),
        String::new(),
        U128(0),
        None,
        false,
        vec![],
    );
}

#[test]
#[should_panic(expected = "evidence too long")]
fn evidence_above_8000_bytes_is_refused() {
    let (mut g, check) = pending();
    ctx("sentinel.test", 0, 1);
    g.post_verdict(
        check,
        Verdict::Block,
        String::new(),
        "e".repeat(MAX_EVIDENCE + 1),
        U128(0),
        None,
        false,
        vec![],
    );
}

// 25. Independent review of the branch. Votes have a time limit; a buy sent to signing is never
// overturned, signed or not; a buy needs its check's code to still be the reference; an exit's
// floor is the median of three quotes, and only quotes make it ready.
// A stolen key, or an honest sentinel restarted, held a stock of old checks it never voted on: a
// block on one quarantined the token again after each lift.
#[test]
fn a_vote_on_a_check_older_than_300_s_is_refused() {
    let (mut g, check) = asked_of_two();
    fallback(&mut g, "sentinel2.test", check, 600);
    assert_eq!(g.quarantined_until(TARGET.into()), None);
    let late = 500 + VERDICT_TIMEOUT_NS;
    ctx("sentinel.test", 0, late);
    assert!(!g.vote_due(check, id("sentinel.test")));
    let said = panic_of(|| vote(&mut g, "sentinel.test", check, Verdict::Block, false, late));
    assert!(said.contains("verdict already posted"), "{said}");
    assert_eq!(
        g.quarantined_until(TARGET.into()),
        None,
        "quarantined through an old check"
    );
    // one nanosecond earlier it still counts
    vote(
        &mut g,
        "sentinel.test",
        check,
        Verdict::Block,
        false,
        late - 1,
    );
    assert!(g.quarantined_until(TARGET.into()).is_some());
}

// A block overturns an allow only while that allow can still buy: 180 s from the request.
#[test]
fn a_block_on_an_allow_too_old_to_buy_is_refused() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    let late = 500 + VERDICT_FRESH_NS;
    let said = panic_of(|| vote(&mut g, "sentinel2.test", check, Verdict::Block, false, late));
    assert!(said.contains("verdict already posted"), "{said}");
    assert_eq!(verdict_of(&g, check), Some(Verdict::Allow));
    assert_eq!(g.quarantined_until(TARGET.into()), None);
}

// The MPC may still publish the signature of a buy that did not come back: no vote overturns it.
#[test]
fn a_late_block_does_not_overturn_a_buy_whose_signature_did_not_come_back() {
    let (mut g, check) = asked_of_three(2);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    ctx("agent.test", 0, 750);
    buy(&mut g, check);
    signed(&mut g, PromiseResult::Failed);
    assert!(g.get_unsettled(0).is_some_and(|u| u.check == Some(check)));
    assert!(g.get_check(check).unwrap().settled); // sent to signing: used
    ctx("sentinel2.test", 0, 800);
    assert!(!g.vote_due(check, id("sentinel2.test")));
    let said = panic_of(|| vote(&mut g, "sentinel2.test", check, Verdict::Block, false, 800));
    assert!(said.contains("verdict already posted"), "{said}");
    assert_eq!(verdict_of(&g, check), Some(Verdict::Allow));
}

// `buy` compared nothing with the reference code: an allow on code `aa` still bought after a later
// check's approved warn moved the reference to `bb`.
#[test]
fn an_allow_no_longer_buys_once_the_reference_code_moved() {
    let warn_bb = |g: &mut Guard, who: &str, check: u64, now: u64| {
        ctx(who, 0, now);
        let hashes = previewed(g, check, QUOTE);
        g.post_verdict(
            check,
            Verdict::Warn,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("bb"),
            false,
            hashes,
        );
    };
    let (mut g, first) = judged(Verdict::Allow); // code aa at 600
    ctx("agent.test", 0, 610);
    let second = g.request_check(TARGET.into(), U128(VALUE), None);
    warn_bb(&mut g, "sentinel.test", second, 620);
    approve(&mut g, second, 630);
    assert_eq!(
        g.last_code(TARGET.into()).unwrap().code,
        code("bb").unwrap()
    );
    ctx("agent.test", 0, 700);
    let said = panic_of(|| buy(&mut g, first));
    assert!(said.contains("code changed since the verdict"), "{said}");
    buy(&mut g, second); // the approved warn on the new code buys
    assert!(g.signing_since().is_some());
    // the same when the first check is decided at the buy, after the owner lowered the quorum
    let (mut g, first) = asked_of_two();
    vote(&mut g, "sentinel.test", first, Verdict::Allow, false, 600); // code aa
    name(&mut g, &["sentinel.test", "sentinel2.test"], 1, 650);
    ctx("agent.test", 0, 660);
    let second = g.request_check(TARGET.into(), U128(VALUE), None);
    warn_bb(&mut g, "sentinel2.test", second, 670);
    approve(&mut g, second, 680);
    ctx("agent.test", 0, 700);
    let said = panic_of(|| buy(&mut g, first));
    assert!(said.contains("code changed since the verdict"), "{said}");
}

// Votes that make a lowered quorum decide only a check that can still buy.
#[test]
#[should_panic(expected = "not a warn verdict")]
fn votes_already_in_do_not_decide_a_check_too_old_to_buy() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    name(
        &mut g,
        &["sentinel.test", "sentinel2.test"],
        1,
        500 + VERDICT_FRESH_NS,
    );
    approve(&mut g, check, 500 + VERDICT_FRESH_NS);
}

#[test]
fn the_approval_that_decides_a_warn_says_so() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Warn, false, 600);
    name(&mut g, &["sentinel.test", "sentinel2.test"], 1, 650);
    approve(&mut g, check, 700);
    let e = events();
    assert_eq!(e[0]["event"], "verdict_decided");
    assert_eq!(e[0]["data"][0]["id"], check);
    assert_eq!(e[0]["data"][0]["verdict"], "warn");
    assert_eq!(e[1]["event"], "warn_approved");
    assert_eq!(g.get_check(check).unwrap().judged_ns, U64(700));
}

// Known and documented: the guard keeps no record of a removal, so an account named again counts
// again on the checks it voted on, unless a vote since dropped its own. After a theft the owner
// names another account.
#[test]
fn a_sentinel_removed_then_named_again_counts_again() {
    let (mut g, check) = asked_of_two();
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 700);
    name(&mut g, &["sentinel2.test", "sentinel3.test"], 2, 710);
    name(&mut g, &["sentinel.test", "sentinel2.test"], 2, 720);
    ctx("agent.test", 0, 800);
    buy(&mut g, check);
    assert!(g.signing_since().is_some());
}

// After the owner shrinks the set, a check keeps its old votes until its next vote: they are
// stored, not counted.
#[test]
fn old_votes_stay_on_a_check_until_its_next_vote_and_count_for_nothing() {
    let (mut g, check) = asked_of_three(3);
    vote(&mut g, "sentinel.test", check, Verdict::Allow, false, 600);
    vote(&mut g, "sentinel2.test", check, Verdict::Allow, false, 610);
    name(&mut g, &["sentinel3.test"], 1, 650);
    assert_eq!(g.get_check(check).unwrap().votes.len(), 2); // two votes, one sentinel
    ctx("agent.test", 0, 660);
    let said = panic_of(|| buy(&mut g, check));
    assert!(said.contains("no verdict yet"), "{said}");
    vote(&mut g, "sentinel3.test", check, Verdict::Allow, false, 700);
    let c = g.get_check(check).unwrap();
    assert_eq!((c.verdict, c.votes.len()), (Some(Verdict::Allow), 1));
}
