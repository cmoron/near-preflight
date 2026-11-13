//! Spend guard: the agent signs with a function-call key limited to this
//! contract; the contract holds its prepaid credit and its armed budget.
//! Three roles: the human (owner) sets the bounds, registers agents and keeps the emergency
//! stop, the armer arms a registered agent within those bounds, the agent buys. Every
//! arming, disarming, freeze and armer change is logged.
//! The buy on Base is signed by NEAR (Chain Signatures): the guard itself builds the swap
//! transaction for the target judged `allow` and has the MPC contract sign it.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::utils::parse_eth_address;
use omni_transaction::evm::EVMTransaction;

/// Buy on Base: fixed chain id, Uniswap V2 router and WETH. A transaction signed for 8453
/// is valid on real Base.
pub const CHAIN_ID: u64 = 8453;
const ROUTER: &str = "4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const WETH: &str = "4200000000000000000000000000000000000006";
/// `swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)`
const SWAP_SELECTOR: [u8; 4] = [0xb6, 0xf9, 0xde, 0x95];
/// `approve(address,uint256)`
const APPROVE_SELECTOR: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)`
const SELL_SELECTOR: [u8; 4] = [0x79, 0x1a, 0xc9, 0x47];
/// Chain Signatures derivation path, fixed: the EVM address depends only on the guard's account.
pub const DERIVATION_PATH: &str = "evm-1";
/// Swap deadline: 300 s after the check's request for a buy or an agent's exit (fixed by the check,
/// so the sentinel simulates the very bytes the guard signs), after the call for the owner's exits.
const SWAP_DEADLINE_S: u64 = 300;
/// An agent's exit is signed only if this long remains before its swap deadline, to broadcast. A buy
/// always has more: it is signed within `VERDICT_FRESH_NS` of its request, 120 s before its deadline.
const MIN_BROADCAST_S: u64 = 60;
/// Most transactions a check is simulated with: a buy, or an exit's approve and swap.
const MAX_TX_HASHES: usize = 2;
/// Gas reserved for `sign` (the MPC requires 15 `TGas`) and for the callback; the rest of the gas attached by
/// the agent is split between them.
const SIGN_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// At most this much of the `sign` response is read (about 200 bytes expected).
const MAX_SIGN_RESPONSE: usize = 1024;
/// The owner may release a signature slot whose callback never ran this long after the request:
/// longer than the MPC's own timeout (its yield expires after 200 blocks).
const RELEASE_DELAY_NS: u64 = 600 * 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct Budget {
    remaining: u128,
    expires_ns: u64,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

/// Bounds set by the human for every arming. Zero at init: no arming is possible
/// until the human has set them.
#[near(serializers = [borsh, json])]
#[derive(Default)]
pub struct Bounds {
    pub max_budget: U128,
    pub max_duration_s: u64,
    /// Sum of the budgets armed for an agent over a rolling 7 days.
    pub max_7d: U128,
    /// Largest buy, in wei, an agent may state at `request_check` and buy: the model's tool call states
    /// the amount, so the armed budget alone would bound it only in total.
    pub max_buy_wei: U128,
}

/// What one token can cost through this guard, set by the owner: a wrong `allow` (a trap the checks
/// missed, a lying sentinel) is bounded by them, whatever the agents' armed budgets add up to.
#[near(serializers = [borsh, json])]
pub struct TokenLimits {
    /// How long a token that got a `block` can be neither checked nor bought, in seconds
    /// (`MIN_QUARANTINE_S`..=`MAX_QUARANTINE_S`; `DEFAULT_QUARANTINE_S` at init).
    pub quarantine_s: u64,
    /// Most wei all agents together may buy of one token over `cap_period_s`, counted when a buy is
    /// sent to signing. Zero at init: no buy until the owner has set it, like the bounds.
    pub cap_wei: U128,
    /// The rolling period of `cap_wei`, in seconds (`MIN_CAP_PERIOD_S`..=`MAX_CAP_PERIOD_S`).
    pub cap_period_s: u64,
}

/// A verdict request: the EVM target, the sentinel's verdict and its reasons.
#[near(serializers = [borsh, json])]
pub struct Check {
    pub agent: AccountId,
    pub target: String,
    pub requested_ns: U64,
    pub verdict: Option<Verdict>,
    /// Block time at which the verdict was set (0 while there is none): the vote that completed the
    /// quorum or blocked, the call that decided votes already in, or, on an exit quote, the oldest
    /// quote that counts (so the sale is never on a quote more than 120 s old).
    pub judged_ns: U64,
    pub reasons: String,
    /// sha256 (lowercase hex) of the `evidence` string received with the verdict, computed by
    /// the contract: ties the logged proof to the stored verdict. Empty while there is no verdict.
    pub evidence_sha256: String,
    /// Buy amount the agent stated at `request_check`, in wei: the sentinel simulates that amount and
    /// `buy` accepts no other (0 for an exit quote).
    pub amount_wei: U128,
    /// Sentinel quote: tokens the guard's address received in its simulated buy of `amount_wei` (0
    /// without a quote), tied to the proof. The swap's minimum is this quote minus the slippage bound.
    pub quote: U128,
    /// True once the check's transactions were sent to signing and came back signed or were reserved
    /// (the MPC may still publish them): a verdict is used only once, and takes no more votes.
    pub settled: bool,
    /// True once the owner approved this `warn` verdict (`approve_warn`): only then can it buy.
    pub approved: bool,
    /// EIP-1559 transaction signed by the MPC for this buy (base64 in JSON), to broadcast on Base.
    pub signed_tx: Option<Base64VecU8>,
    /// The target's code posted with the verdict (none for an exit quote or a fallback block).
    pub code: Option<Code>,
    /// An exit quote: tokens to sell (`request_exit`); the quote is then the ETH out, in wei.
    pub exit_amount: Option<U128>,
    /// sha256 (64 lowercase hex) of the attested LLM decision the agent anchored at `request_check`.
    pub decision_sha256: Option<String>,
    /// Same, as given to the `buy` that last asked for the signature (a retry overwrites it).
    pub buy_decision_sha256: Option<String>,
    /// Signing hashes (64 lowercase hex: the MPC payloads) of the transactions the sentinel simulated
    /// from the guard's address, as `preview_check` built them: `buy` and `sell_quoted` sign only
    /// these exact transactions (same nonce, calldata, value, gas and fees), or refuse.
    pub tx_hashes: Vec<String>,
    /// The sentinel's `list_target` with the verdict, as posted: replay compares it with the one its
    /// evidence carries.
    pub list_target: bool,
    /// The sentinels' votes, in the order posted, one per sentinel. `verdict` is set once they decide:
    /// `quorum` identical votes for an `allow` or a `warn`, a single `block` vote or a disagreement
    /// for a `block`. `reasons` and `evidence_sha256` above are those of the vote that decided (the
    /// first vote's while they agree). Only the votes of the current sentinels count: on a buy check
    /// the next vote drops those of sentinels removed since (their `verdict_posted` events stay), so a
    /// check holds at most three votes, and keeps old ones until that next vote. On an exit quote,
    /// `quote`, `tx_hashes` and `evidence_sha256` are those of the quote that stands: the median of
    /// three `allow` quotes, the highest of fewer; `reasons` are those of the last vote whose own quote
    /// stood when posted (honest sentinels word an exit quote alike).
    pub votes: Vec<Vote>,
}

/// One sentinel's vote on a check: its verdict and the sha256 of the evidence it posted with it.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Vote {
    pub sentinel: AccountId,
    pub verdict: Verdict,
    /// sha256 (lowercase hex) of that sentinel's `evidence` string, computed by the contract.
    pub evidence_sha256: String,
    /// On an exit quote, the ETH out an `allow` vote quoted: it counts toward the floor. None on a
    /// `block`, and on a buy check, whose votes share the check's `quote`.
    pub quote: Option<U128>,
}

/// The sentinels and how many of them must agree for an `allow` or a `warn` (view `sentinels`).
#[near(serializers = [json])]
pub struct Sentinels {
    pub sentinels: Vec<AccountId>,
    pub quorum: u8,
}

/// The target's code as the sentinel read it at the verdict's block: keccak256 of its runtime code
/// and, behind a proxy, the implementation address (both `0x` + lowercase hex).
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Code {
    pub code_hash: String,
    pub implementation: Option<String>,
}

/// A shared blocklist entry: who listed it, when, and the sha256 of the evidence it rests on.
#[near(serializers = [borsh, json])]
pub struct Entry {
    pub reporter: AccountId,
    pub at_ns: U64,
    /// sha256 (64 lowercase hex) of the evidence, kept by the reporter (a proof file for the sentinel).
    pub evidence_sha256: String,
    pub note: String,
}

/// The code a target had at its last verdict, and that verdict's check id.
#[near(serializers = [json])]
pub struct LastCode {
    pub id: u64,
    pub code: Code,
}

/// Parameters of the EVM buy fixed by the owner at init; the agent chooses none of them.
#[near(serializers = [borsh, json])]
pub struct EvmConfig {
    /// Chain Signatures contract that signs for the guard (testnet: v1.signer-prod.testnet).
    pub mpc: AccountId,
    /// Address derived from the guard and `DERIVATION_PATH`, computed off chain: signer of
    /// the transaction and recipient of the bought tokens.
    pub address: String,
    pub gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    /// Fixed rate, no oracle: yoctoNEAR debited from the budget per signed wei (value and gas at the cap).
    pub yocto_per_wei: U128,
    /// Slippage tolerated below the sentinel's quote, in basis points (300 = 3 %).
    pub max_slippage_bps: u16,
    /// The owner's EVM address: the only destination of `withdraw_eth`.
    pub withdraw_to: String,
}

/// Buy waiting for the MPC signature.
#[near(serializers = [borsh])]
struct Pending {
    id: u64,
    agent: AccountId,
    target: String,
    value: u128,
    min_out: u128,
    deadline_s: u64,
    /// yoctoNEAR debited from the credit and the budget, held in escrow until the callback.
    cost: u128,
    /// Deadline of the debited arming: a failure refunds the budget only to that same arming.
    armed_until_ns: u64,
}

/// Exit from the guard's EVM address, signed by NEAR: a sale of `token` for ETH (approve, then
/// swap back to the guard's address) or, with no token, an ETH withdrawal to `evm.withdraw_to`.
#[near(serializers = [borsh, json])]
pub struct Exit {
    pub by: AccountId,
    /// Token sold, `None` for an ETH withdrawal.
    pub token: Option<String>,
    /// Tokens sold, or wei withdrawn.
    pub amount: U128,
    /// Minimum ETH out of the sale, chosen by the caller (0 for a withdrawal).
    pub min_out: U128,
    pub deadline_s: u64,
    /// Nonce of the first transaction, the next ones follow.
    pub nonce: u64,
    /// The owner's approve amount (`0x` + 64 lowercase hex, up to 2^256 - 1) when not `amount`.
    pub approve: Option<String>,
    /// Signed transactions in nonce order (base64 in JSON); empty while signing.
    pub signed_txs: Vec<Base64VecU8>,
}

/// An agent's exit, charged to its credit alone (a sale never needs buying budget): `per_tx`
/// yoctoNEAR per transaction (gas at the cap, at the fixed rate) in escrow until the callback, which
/// keeps what was signed and reserves the rest.
#[near(serializers = [borsh])]
struct Charge {
    agent: AccountId,
    /// The exit quote used, settled once a transaction is signed.
    check: u64,
    per_tx: u128,
}

/// A transaction whose signature did not come back. The MPC may still publish it (its `respond` after
/// the yield timed out is a public transaction), so its nonce is never reused, its charge stays debited
/// and the tokens it sells stay reserved until the owner settles it (`clear_unsettled`).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Unsettled {
    /// The agent charged; none for the owner's own exits.
    pub agent: Option<AccountId>,
    /// The check it was asked for (a buy or an exit quote); none for the owner's own exits.
    pub check: Option<u64>,
    /// yoctoNEAR debited from the agent and held in escrow (0 for the owner's exits).
    pub cost: U128,
    /// Deadline of the debited arming: a refund tops up only that arming (0 for a sale, which debits
    /// no budget).
    pub armed_until_ns: U64,
    /// An agent exit's swap: the tokens it would sell, back to the agent's holding on a refund.
    pub restore: Option<(String, U128)>,
    /// True once the owner's replacement at this nonce was signed (`sign_replacement`): only then can
    /// the charge be refunded, since the replacement is what keeps a late signature from being mined.
    pub replaced: bool,
}

/// What the single signature slot is waiting for.
#[near(serializers = [borsh])]
enum Job {
    Buy(Pending),
    /// An exit, and its charge when an agent asked for it (the owner's exits are not charged).
    Exit(Exit, Option<Charge>),
}

/// `sign` response of the MPC contract (secp256k1 domain).
#[near(serializers = [json])]
struct SignResponse {
    big_r: AffinePoint,
    s: Scalar,
    recovery_id: u8,
}

#[near(serializers = [json])]
struct AffinePoint {
    affine_point: String,
}

#[near(serializers = [json])]
struct Scalar {
    scalar: String,
}

/// Size caps: stored reasons, proof only logged (NEAR log <= 16 KiB).
const MAX_REASONS: usize = 280;
const MAX_EVIDENCE: usize = 8_000;
/// Delay after which the agent recovers the price of a request left without a verdict.
/// Upper bound of a request's storage (key 9 bytes, agent <= 64 bytes, target 42 bytes, reasons <= 280 bytes,
/// hash 64 bytes, two tx hashes, amount, signed transaction <= 396 bytes, length prefixes, 40 bytes of overhead per
/// entry), measured at worst case by a test. The price must cover it, otherwise each request eats into
/// the contract's balance. It also covers the code posted with the verdict, the target's `seen` record
/// and, on a `block`, the blocklist entry the verdict adds. Two exclusive worst cases (a block is
/// never bought): the block path, and the buy path with the signed tx, both decision hashes, their
/// anchors (`decisions`) and the agent's holdings entry.
/// Since the token limits, the block path also counts the token's quarantine, and the buy path the
/// token's first entry in its rolling log of buys; since the quorum, both count a vote per sentinel
/// (`MAX_SENTINELS` of them: 2,415 bytes measured on the buy path, 1,882 before either). An exit
/// quote's own worst case, three quotes and both its nonces reserved, measures 1,625 bytes.
const CHECK_STORAGE_BYTES: u128 = 2450;
/// Validity duration of a verdict: the target can change (owner, proxy, liquidity),
/// so an old `allow` no longer pays; the agent asks for a new check.
pub const VERDICT_TTL_NS: u64 = 120 * 1_000_000_000;
pub const VERDICT_TIMEOUT_NS: u64 = 300 * 1_000_000_000;
/// A buy is signed only within this long of its check's request. The sentinel judges the state of the
/// reference block, 4 s after the request, however late its verdict comes (a flooded queue): the 120 s
/// of `VERDICT_TTL_NS` count from the verdict, this bound from the state judged.
pub const VERDICT_FRESH_NS: u64 = 180 * 1_000_000_000;
/// How long an agent's exit waits for the quorum's quotes: after it, one sentinel's vote is enough,
/// so a sentinel that is down delays an exit by this much and never refuses it. Until then another
/// sentinel's quote can still replace a low one.
pub const EXIT_VOTES_WAIT_NS: u64 = 60 * 1_000_000_000;
/// How long an exit that holds the quorum's quotes, but not every sentinel's, waits for the missing
/// ones. Without it, with three sentinels and a quorum of two, a liar's high quote beside one honest
/// quote sold at once on the highest: the median never applied. 15 s: measured on 2026-11-12, an exit
/// quote simulates in 0.5 to 2 s on three public Base nodes, to which a sentinel adds its 2.5 s poll
/// and about 2 s for the vote's inclusion on NEAR; an honest third quote is in within 8 s, and a
/// sentinel that is down costs an exit these 15 s, no more.
pub const EXIT_GRACE_NS: u64 = 15 * 1_000_000_000;
/// Bounds and default of the quarantine a `block` puts its token in: 10 min to 24 h, 30 min at init.
/// Never zero: a token blocked on one draw could be asked again at once until a draw misses the trap.
const MIN_QUARANTINE_S: u64 = 600;
const MAX_QUARANTINE_S: u64 = 86_400;
const DEFAULT_QUARANTINE_S: u64 = 1_800;
/// Bounds of the per-token cap's rolling period: 1 h to 7 days (24 h at init, with a cap of zero).
const MIN_CAP_PERIOD_S: u64 = 3_600;
const MAX_CAP_PERIOD_S: u64 = 7 * 24 * 3_600;
const DEFAULT_CAP_PERIOD_S: u64 = 86_400;
/// Size of a token's rolling log of buys (as an agent's log of armings): 24 bytes an entry, each paid by
/// its check's price. A buy into a full log merges the two oldest entries into one, counted until the
/// newer of them leaves the period: the total is never undercounted, and 32 small buys never close a
/// token to every agent for the period.
const MAX_TOKEN_BUYS: usize = 32;
/// Most sentinels the owner names: each vote is stored with its check (at most 137 bytes), within
/// the check's price. A check never holds more than three: a vote on a buy check drops those of
/// sentinels removed since, an exit quote takes no more votes than there are sentinels.
const MAX_SENTINELS: usize = 3;
/// Reasons of a check its sentinels disagreed on.
const DISAGREE: &str =
    "sentinels disagree on the verdict, the quote, the transactions, the code or the listing";
/// Window of the rolling cap: an arming counts while it is less than 7 days old.
const WEEK_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;
/// Size of an agent's rolling log. An entry (block time u64, budget u128) takes
/// 24 bytes paid by the contract, not by the armer: 32 entries = 768 bytes (~0.008 NEAR) per agent at
/// most, and a scan of 32 elements per arming. Beyond that, arming is refused: forgetting an
/// entry still in the window would undercount the total, and leaving it unbounded would let the armer
/// grow the contract's storage without end (a budget of 1 yocto is enough to add an entry).
const MAX_ARMINGS_7D: usize = 32;

/// Upper bound of one blocklist entry's storage (key: a token address, reporter <= 64 bytes, evidence
/// sha256, note <= `MAX_NOTE`, length prefixes, 40 bytes per record), measured by a test. A reporter's
/// credit pays it, so reporting cannot eat into the contract's balance.
const ENTRY_STORAGE_BYTES: u128 = 500;
/// Bounds of the owner's gas settings. A Uniswap V2 swap uses about 140,000 gas; a token may need
/// more to let a sale through, so the owner can raise the limit up to 2,000,000 and retry an exit.
const MIN_GAS_LIMIT: u64 = 21_000;
const MAX_GAS_LIMIT: u64 = 2_000_000;
/// 10 gwei, about 2,000 times Base's usual base fee.
const MAX_FEE_PER_GAS: u128 = 10_000_000_000;
/// Most entries `list_entries` returns per call.
const MAX_PAGE: u32 = 50;
/// Longest note on a blocklist entry.
const MAX_NOTE: usize = 140;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    /// Arms the agent within the human's bounds; does not set those bounds.
    armer: AccountId,
    /// The accounts that post verdicts, each with its own key, and how many must post the same
    /// `allow` or `warn` for it to count (`set_sentinels`). One at init, the account named there.
    sentinels: Vec<AccountId>,
    quorum: u8,
    bounds: Bounds,
    price: u128,
    credits: LookupMap<AccountId, u128>,
    budgets: LookupMap<AccountId, Budget>,
    /// Armings less than 7 days old per agent: (block time, armed budget). Survives `disarm`,
    /// otherwise disarming then re-arming would reset the cap to zero.
    armings: LookupMap<AccountId, Vec<(u64, u128)>>,
    checks: LookupMap<u64, Check>,
    /// Agents registered by the owner: only these can be armed, so the armer does not make the
    /// contract's storage (budget, log) grow for accounts of its choosing.
    agents: LookupSet<AccountId>,
    /// Agents frozen by an owner disarm: the armer can no longer arm them until
    /// the owner unfreezes them.
    frozen: LookupSet<AccountId>,
    /// Fees collected (verdicts rendered) and signed buys, paid to the owner who funds the address
    /// derived in ETH; accounted separately from the agents' credit.
    fees: u128,
    /// Price of requests awaiting a verdict and cost of the buy being signed: belongs neither to the agent
    /// nor to the owner.
    escrow: u128,
    /// Sum of every account's credit: what `refund_credit` may pay out, which `withdraw_fees` never takes.
    credits_total: u128,
    next_id: u64,
    evm: EvmConfig,
    /// EVM nonce of the derived address: advances only when a signature comes back.
    evm_nonce: u64,
    /// Buy (or exit) being signed. Only one at a time: one address, one nonce sequence;
    /// a failure therefore leaves no gap.
    signing: Option<Job>,
    /// Latest signed exit, overwritten by the next one (bounded storage); earlier ones stay in the
    /// `exit_signed` events.
    last_exit: Option<Exit>,
    /// Accounts the owner allows to `report` to the blocklist. A sentinel is not one: its votes list a
    /// token only with the quorum.
    reporters: LookupSet<AccountId>,
    /// Shared blocklist of tokens, keyed by address (lowercase).
    blocklist: IterableMap<String, Entry>,
    /// Per target (lowercase), the check whose verdict saw its code last.
    seen: LookupMap<String, u64>,
    /// Per token (lowercase), the one agent it is held for and the amount it may still sell: credited
    /// from the signed buy's `min_out`, reserved by `sell_quoted`, removed at 0. The guard's EVM address
    /// holds every agent's tokens together, so a token is held for one agent at a time: a credit whose
    /// buy reverted on Base can never sell another agent's tokens. Only the owner clears or reassigns
    /// a holding (`set_holding`).
    holdings: LookupMap<String, (AccountId, u128)>,
    /// Decision digests anchored by `request_check` and `buy`, with the check each backs: one signed
    /// model decision backs one guard call. An entry (at most 117 bytes) is paid by its check's price
    /// (`CHECK_STORAGE_BYTES` counts the check's and its buy's); a refunded check or a refunded unsettled
    /// buy frees its digest, so a check never holds more than two.
    decisions: LookupMap<String, u64>,
    /// Transactions whose signature did not come back, by nonce, until the owner settles them. A buy's
    /// entry takes the place of the signed transaction it did not get, within its check's price.
    unsettled: LookupMap<u64, Unsettled>,
    /// Per agent, the block time of the owner's last stop (`disarm`): a check requested until then never
    /// buys or sells, even after `unfreeze` and a new arming within its verdict's 120 s.
    stopped: LookupMap<AccountId, u64>,
    /// Block time at which the job in `signing` was requested; its callback must name it.
    signing_since_ns: u64,
    /// The owner's limits on what one token can cost (`set_quarantine`, `set_token_cap`).
    limits: TokenLimits,
    /// Per token (lowercase), the block time until which its last `block` vote naming its code keeps
    /// it from being checked or bought. Kept after it expires (one entry per token, overwritten by the
    /// next such vote; paid by that check, which is then never bought).
    quarantine: LookupMap<String, u64>,
    /// Per token (lowercase), the buy check awaiting its verdict: one at a time for all agents, so that
    /// parallel requests are not as many draws. Removed by the verdict or the refund.
    pending: LookupMap<String, u64>,
    /// Per token (lowercase), the buys sent to signing within the cap's period: (block time, wei).
    token_buys: LookupMap<String, Vec<(u64, u128)>>,
}

/// Strict EVM address: `0x` + 40 hexadecimal digits (42 characters, not one more).
fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// The owner's gas settings must stay within `MIN_GAS_LIMIT`..=`MAX_GAS_LIMIT` and `MAX_FEE_PER_GAS`.
fn check_gas(gas_limit: u64, max_fee_per_gas: u128, max_priority_fee_per_gas: u128) {
    require!(
        (MIN_GAS_LIMIT..=MAX_GAS_LIMIT).contains(&gas_limit),
        "gas limit out of bounds: 21,000 to 2,000,000"
    );
    require!(
        max_fee_per_gas <= MAX_FEE_PER_GAS,
        "max fee per gas above 10 gwei"
    );
    require!(
        max_priority_fee_per_gas <= max_fee_per_gas,
        "priority fee above max fee"
    );
}

/// Validates an optional decision digest (64 hex digits, no `0x`) and lowercases it.
fn decision_digest(d: Option<String>) -> Option<String> {
    d.map(|d| {
        require!(
            d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid decision sha256: 64 hex digits"
        );
        d.to_ascii_lowercase()
    })
}

/// `0x` + 64 hexadecimal digits (a 32-byte hash).
fn is_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// The transaction hashes posted with a vote, validated and lowercased.
fn posted_hashes(tx_hashes: &[String]) -> Vec<String> {
    require!(
        tx_hashes.len() <= MAX_TX_HASHES
            && tx_hashes
                .iter()
                .all(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid tx hashes: at most 2, 64 hex digits each"
    );
    tx_hashes.iter().map(|h| h.to_ascii_lowercase()).collect()
}

/// The target's code posted with a vote, validated and lowercased.
fn posted_code(c: Code) -> Code {
    require!(is_hash(&c.code_hash), "invalid code hash");
    require!(
        c.implementation.as_deref().is_none_or(is_evm_address),
        "invalid implementation"
    );
    Code {
        code_hash: c.code_hash.to_ascii_lowercase(),
        implementation: c.implementation.map(|i| i.to_ascii_lowercase()),
    }
}

/// Blocklist map key: the token's EVM address, lowercase.
fn token_key(token: &str) -> String {
    require!(
        is_evm_address(token),
        "invalid token: expected 0x + 40 hex digits"
    );
    token.to_ascii_lowercase()
}

/// EVM signature taken from the MPC response: r = `big_r` without its prefix byte, v = `recovery_id`,
/// leading zeros of r and s removed (canonical RLP integers). `None` if the format differs.
fn parse_signature(bytes: &[u8]) -> Option<Signature> {
    let response: SignResponse = near_sdk::serde_json::from_slice(bytes).ok()?;
    let big_r = hex::decode(response.big_r.affine_point).ok()?;
    let s = hex::decode(response.s.scalar).ok()?;
    if big_r.len() != 33 || s.len() != 32 || response.recovery_id > 1 {
        return None;
    }
    let trim = |b: &[u8]| b.iter().copied().skip_while(|&x| x == 0).collect();
    Some(Signature {
        v: response.recovery_id.into(),
        r: trim(&big_r[1..]),
        s: trim(&s),
    })
}

/// Minimum output of a swap: the sentinel's `quote` minus `slippage_bps`, rounded down, without
/// intermediate overflow.
fn floor(quote: u128, slippage_bps: u16) -> u128 {
    let keep = u128::from(10_000 - slippage_bps);
    quote / 10_000 * keep + quote % 10_000 * keep / 10_000
}

/// An approve amount as `0x` + 1 to 64 hex digits (up to 2^256 - 1), as a 32-byte ABI word.
fn approve_word(s: &str) -> Option<[u8; 32]> {
    let digits = s.strip_prefix("0x")?;
    if digits.is_empty() || digits.len() > 64 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = hex::decode(format!("{digits:0>64}")).ok()?;
    bytes.try_into().ok()
}

/// The swap deadline of a buy or an agent's exit: `SWAP_DEADLINE_S` after the check's request.
fn deadline_of(c: &Check) -> u64 {
    c.requested_ns.0 / 1_000_000_000 + SWAP_DEADLINE_S
}

/// Refusal of `buy` and `sell_quoted` on a check requested before the owner's last stop of its agent.
const STOPPED: &str = "check requested before the owner's stop: request a new check";

/// Refusal of `buy` and `sell_quoted` when the transactions differ from the simulated ones.
const SIMULATED_ONLY: &str = "transaction differs from the one simulated (nonce, gas or fees changed since the verdict): request a new check";

/// What the MPC signs for `tx`: keccak256 of its unsigned EIP-1559 encoding, lowercase hex.
fn signing_hash(tx: &EVMTransaction) -> String {
    hex(&env::keccak256_array(tx.build_for_signing()))
}

/// 32-byte ABI word, `bytes` right-padded.
fn word(bytes: &[u8]) -> [u8; 32] {
    let mut w = [0; 32];
    w[32 - bytes.len()..].copy_from_slice(bytes);
    w
}

/// Sum of a token's buys (`buys_in_period`); saturating, so an overflow reads as a cap reached.
fn bought(log: &[(u64, u128)]) -> u128 {
    log.iter().fold(0, |sum, &(_, wei)| sum.saturating_add(wei))
}

/// True while an arming made at `armed_ns` stays within the 7-day window (block time).
fn in_window(armed_ns: u64) -> bool {
    env::block_timestamp().saturating_sub(armed_ns) < WEEK_NS
}

/// Lowercase hexadecimal, without `0x` prefix.
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| [DIGITS[usize::from(b >> 4)], DIGITS[usize::from(b & 15)]])
        .map(char::from)
        .collect()
}

/// NEP-297 event: `EVENT_JSON:` followed by a serialized (hence escaped) object.
fn emit(event: &str, data: &near_sdk::serde_json::Value) {
    let event = near_sdk::serde_json::json!({
        "standard": "goblin_guard",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

#[near]
impl Guard {
    /// To call in the deployment transaction (`with-init-call`): the caller
    /// is then the contract account, and nobody can re-initialize afterwards.
    /// `armer` may be `owner`: a single human then holds both roles, at the cost of
    /// separation (whoever sets the bounds also arms), but the bounds still apply.
    #[init]
    #[must_use]
    pub fn new(
        owner: AccountId,
        armer: AccountId,
        sentinel: AccountId,
        price: U128,
        evm: EvmConfig,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init reserved to the contract account"
        );
        require!(
            price.0 >= CHECK_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear(),
            "price below the storage cost of a check"
        );
        require!(is_evm_address(&evm.address), "invalid derived address");
        check_gas(
            evm.gas_limit,
            evm.max_fee_per_gas.0,
            evm.max_priority_fee_per_gas.0,
        );
        require!(evm.yocto_per_wei.0 > 0, "zero rate");
        require!(evm.max_slippage_bps < 10_000, "slippage of 100 % or more");
        require!(
            is_evm_address(&evm.withdraw_to),
            "invalid withdrawal address"
        );
        Self {
            owner,
            armer,
            sentinels: vec![sentinel],
            quorum: 1,
            bounds: Bounds::default(),
            price: price.0,
            credits: LookupMap::new(b"c"),
            budgets: LookupMap::new(b"b"),
            armings: LookupMap::new(b"a"),
            checks: LookupMap::new(b"k"),
            agents: LookupSet::new(b"g"),
            frozen: LookupSet::new(b"f"),
            fees: 0,
            escrow: 0,
            credits_total: 0,
            next_id: 0,
            evm,
            evm_nonce: 0,
            signing: None,
            last_exit: None,
            reporters: LookupSet::new(b"r"),
            blocklist: IterableMap::new(b"l"),
            seen: LookupMap::new(b"s"),
            holdings: LookupMap::new(b"h"),
            decisions: LookupMap::new(b"d"),
            unsettled: LookupMap::new(b"u"),
            stopped: LookupMap::new(b"t"),
            signing_since_ns: 0,
            limits: TokenLimits {
                quarantine_s: DEFAULT_QUARANTINE_S,
                cap_wei: U128(0),
                cap_period_s: DEFAULT_CAP_PERIOD_S,
            },
            quarantine: LookupMap::new(b"q"),
            pending: LookupMap::new(b"p"),
            token_buys: LookupMap::new(b"o"),
        }
    }

    /// Credits `account_id` (the caller by default) with the attached deposit: the human funds
    /// the agent, whose function-call key cannot attach anything.
    /// A new account pays the storage of its entry, taken from the deposit.
    #[payable]
    pub fn deposit_credit(&mut self, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "zero deposit");
        let previous = self.credits.get(&who).copied();
        let storage_cost = if previous.is_none() {
            let usage = env::storage_usage();
            self.credits.insert(who.clone(), 0); // same size as the final value (u128)
            self.credits.flush();
            u128::from(env::storage_usage() - usage) * env::storage_byte_cost().as_yoctonear()
        } else {
            0
        };
        require!(amount > storage_cost, "deposit does not cover storage");
        self.set_credit(&who, previous.unwrap_or(0) + amount - storage_cost);
    }

    /// Owner only: bounds of every future arming, and the largest buy (`max_buy_wei`, applied to every
    /// check and buy from now on). An already armed budget is not reduced: for that, `disarm`.
    pub fn set_bounds(
        &mut self,
        max_budget: U128,
        max_duration_s: u64,
        max_7d: U128,
        max_buy_wei: U128,
    ) {
        self.assert_owner();
        self.bounds = Bounds {
            max_budget,
            max_duration_s,
            max_7d,
            max_buy_wei,
        };
    }

    #[must_use]
    pub fn bounds(&self) -> &Bounds {
        &self.bounds
    }

    /// Owner only: how long a `block` keeps its token from being checked or bought, from the next
    /// block verdict on (10 min to 24 h). A quarantine already running keeps its end.
    pub fn set_quarantine(&mut self, seconds: u64) {
        self.assert_owner();
        require!(
            (MIN_QUARANTINE_S..=MAX_QUARANTINE_S).contains(&seconds),
            "quarantine out of bounds: 600 to 86,400 s"
        );
        self.limits.quarantine_s = seconds;
        emit(
            "quarantine_set",
            &near_sdk::serde_json::json!({ "seconds": seconds }),
        );
    }

    /// Owner only: the most wei all agents together may buy of one token over a rolling `period_s`
    /// (1 h to 7 days), applied to every check and buy from now on. Zero closes every buy.
    pub fn set_token_cap(&mut self, cap_wei: U128, period_s: u64) {
        self.assert_owner();
        require!(
            (MIN_CAP_PERIOD_S..=MAX_CAP_PERIOD_S).contains(&period_s),
            "cap period out of bounds: 3,600 to 604,800 s"
        );
        self.limits.cap_wei = cap_wei;
        self.limits.cap_period_s = period_s;
        emit(
            "token_cap_set",
            &near_sdk::serde_json::json!({ "cap_wei": cap_wei, "period_s": period_s }),
        );
    }

    /// Owner only: ends `token`'s quarantine now (a block on an honest token: a check that failed for
    /// a reason of its own, or a lying sentinel since replaced). The blocklist is apart: `unlist`.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn lift_quarantine(&mut self, token: String) {
        self.assert_owner();
        let key = token_key(&token);
        require!(
            self.quarantine.remove(&key).is_some(),
            "token not quarantined"
        );
        emit(
            "quarantine_lifted",
            &near_sdk::serde_json::json!({ "token": key, "by": self.owner }),
        );
    }

    /// The owner's limits per token: quarantine after a block, cap and its rolling period.
    #[must_use]
    pub fn token_limits(&self) -> &TokenLimits {
        &self.limits
    }

    /// Block time until which `token` can be neither checked nor bought; none when it can.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn quarantined_until(&self, token: String) -> Option<U64> {
        self.quarantine
            .get(&token_key(&token))
            .filter(|&&until| env::block_timestamp() < until)
            .map(|&until| U64(until))
    }

    /// True while a vote of `sentinel` on check `id` can still count, so that a sentinel knows in one
    /// call whether to judge it (after a restart, every old check answers false). Always false for an
    /// account that is not a sentinel, one that voted on it, a check 300 s old, signed, reserved or
    /// being signed. Otherwise:
    /// - a buy check without a verdict: true (the next vote may decide it);
    /// - a buy check decided `allow` or `warn`: true within 180 s of its request, while a `block` can
    ///   still stop its buy (any other vote is refused);
    /// - a buy check blocked: true while fewer votes than the quorum are in (listing takes them);
    /// - an exit quote: true (every sentinel's quote counts toward the floor), until the guard's
    ///   nonce, gas or fees move under a quote already posted (`exit_over`).
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn vote_due(&self, id: u64, sentinel: AccountId) -> bool {
        let Some(c) = self.checks.get(&id) else {
            return false;
        };
        let within = |ns: u64| env::block_timestamp() < c.requested_ns.0.saturating_add(ns);
        if !self.sentinels.contains(&sentinel)
            || c.settled
            || self.signing_for(id)
            || c.votes.iter().any(|v| v.sentinel == sentinel)
            || !within(VERDICT_TIMEOUT_NS)
            || self.exit_over(c)
        {
            return false;
        }
        match c.verdict {
            _ if c.exit_amount.is_some() => c.votes.len() < self.sentinels.len(),
            None => true,
            Some(Verdict::Allow | Verdict::Warn) => within(VERDICT_FRESH_NS),
            Some(Verdict::Block) => self.counted(c) < usize::from(self.quorum),
        }
    }

    /// True once exit quote `id` no longer waits for other sentinels (a `block` is no quote): every
    /// sentinel's quote is in; or the quorum's are and 15 s have passed since the request; or one vote
    /// is and 60 s have. `sell_quoted` is refused until then; whether there is a quote to sell on is
    /// the check's verdict. True as well once the guard's nonce, gas or fees moved under its quotes:
    /// it waits for no vote any more, `sell_quoted` refuses it, and the agent asks another.
    #[must_use]
    pub fn exit_ready(&self, id: u64) -> bool {
        self.checks.get(&id).is_some_and(|c| {
            c.exit_amount.is_some() && (self.exit_votes_in(c) || self.exit_over(c))
        })
    }

    /// True once exit quote `c` holds every sentinel's quote, so that one key never sets the floor
    /// while the others answer (the median of three); or the quorum's quotes after `EXIT_GRACE_NS`,
    /// so that a sentinel that is down costs a short wait; or one vote after `EXIT_VOTES_WAIT_NS`.
    fn exit_votes_in(&self, c: &Check) -> bool {
        let quotes = c.votes.iter().filter(|v| v.quote.is_some()).count();
        let since = |ns: u64| env::block_timestamp() >= c.requested_ns.0.saturating_add(ns);
        quotes >= self.sentinels.len()
            || (quotes >= usize::from(self.quorum) && since(EXIT_GRACE_NS))
            || (!c.votes.is_empty() && since(EXIT_VOTES_WAIT_NS))
    }

    /// True once exit quote `c` holds a quote whose transactions the guard would no longer sign: its
    /// nonce, gas or fees moved since. The sentinels that quoted cannot quote again, so a later quote
    /// would stand alone and sell on the strength of their votes and of the time elapsed: the exit
    /// quote takes no more votes and never sells (`sell_quoted` refuses it), and the agent asks
    /// another. Every quote on a check is thus of the same transactions.
    fn exit_over(&self, c: &Check) -> bool {
        c.exit_amount.is_some() && c.verdict == Some(Verdict::Allow) && !self.previewed(c)
    }

    /// The buy check of `token` awaiting its verdict, if any: no other can be requested meanwhile.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn pending_check(&self, token: String) -> Option<u64> {
        self.pending_of(&token_key(&token))
    }

    /// Wei all agents together sent to signing for `token` within the cap's period, at block time.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn token_bought(&self, token: String) -> U128 {
        U128(bought(&self.buys_in_period(&token_key(&token))))
    }

    /// Panics while `token` (a `token_key`) is quarantined by a block verdict.
    fn require_not_quarantined(&self, token: &str) {
        require!(
            self.quarantine
                .get(token)
                .is_none_or(|&until| env::block_timestamp() >= until),
            "target is quarantined after a block verdict"
        );
    }

    /// The buy check of `token` still awaiting its verdict: an entry counts until its check gets a
    /// verdict or a refund, and no longer than `VERDICT_TIMEOUT_NS` (an agent that never asks its
    /// refund would otherwise close the token to every agent). A check whose votes already make a
    /// quorum the owner lowered since no longer waits (`decide_waiting`).
    fn pending_of(&self, token: &str) -> Option<u64> {
        let id = *self.pending.get(token)?;
        let waiting = self.checks.get(&id).is_some_and(|c| {
            c.verdict.is_none()
                && self.counted(c) < usize::from(self.quorum)
                && env::block_timestamp() < c.requested_ns.0.saturating_add(VERDICT_TIMEOUT_NS)
        });
        waiting.then_some(id)
    }

    /// Buys of `token` still within the cap's rolling period, at block time.
    fn buys_in_period(&self, token: &str) -> Vec<(u64, u128)> {
        let period = self.limits.cap_period_s.saturating_mul(1_000_000_000);
        let mut log = self.token_buys.get(token).cloned().unwrap_or_default();
        log.retain(|&(at_ns, _)| env::block_timestamp().saturating_sub(at_ns) < period);
        log
    }

    /// Panics unless `amount_wei` more of `token` fits in the owner's per-token cap.
    fn require_cap_room(&self, log: &[(u64, u128)], amount_wei: u128) {
        require!(
            bought(log)
                .checked_add(amount_wei)
                .is_some_and(|total| total <= self.limits.cap_wei.0),
            "amount above what the owner's per-token cap leaves"
        );
    }

    /// Counts a buy of `amount_wei` of `token` (lowercase) within the owner's per-token cap, for all
    /// agents together, or panics: counted when the buy is sent to signing, and kept if its signature
    /// does not come back (the MPC may still publish it).
    fn count_buy(&mut self, token: String, amount_wei: u128) {
        let mut buys = self.buys_in_period(&token);
        self.require_cap_room(&buys, amount_wei);
        if buys.len() >= MAX_TOKEN_BUYS {
            // A full log: the two oldest entries become one, counted until the newer of them leaves
            // the period. Refusing the buy instead let 32 small buys close the token to every agent.
            let (_, wei) = buys.remove(0);
            buys[0].1 = buys[0].1.saturating_add(wei);
        }
        buys.push((env::block_timestamp(), amount_wei));
        self.token_buys.insert(token, buys);
    }

    /// Owner only: makes `agent` armable. Its storage is paid by the contract, at the
    /// owner's sole choice.
    pub fn register_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agents.insert(agent);
    }

    /// Owner only: names the sentinels (1 to 3 distinct accounts) and how many of them must post the
    /// same `allow` or `warn` for it to count; any one of them blocks. One call replaces a compromised
    /// key or changes the quorum, with no delay: from this call on, only the votes of these sentinels
    /// count, on the checks already voted on too (`buy`, `approve_warn` and `sell_quoted` count them
    /// again), and a check still waiting is decided by this set and quorum, at its next vote or at
    /// its `buy`. The guard cannot walk its checks, so nothing is rewritten here: a vote is weighed
    /// when it is used. An account removed and named again counts again on the checks it voted on
    /// (those less than 180 s old still buy): name another account after a theft.
    pub fn set_sentinels(&mut self, sentinels: Vec<AccountId>, quorum: u8) {
        self.assert_owner();
        require!(
            (1..=MAX_SENTINELS).contains(&sentinels.len())
                && sentinels
                    .iter()
                    .enumerate()
                    .all(|(i, a)| !sentinels[..i].contains(a)),
            "1 to 3 distinct sentinels"
        );
        require!(
            (1..=sentinels.len()).contains(&usize::from(quorum)),
            "quorum out of bounds: 1 to the number of sentinels"
        );
        let previous = std::mem::replace(&mut self.sentinels, sentinels);
        self.quorum = quorum;
        emit(
            "sentinels_changed",
            &near_sdk::serde_json::json!({
                "previous": previous, "sentinels": self.sentinels, "quorum": quorum,
            }),
        );
    }

    /// The sentinels and the quorum of identical votes an `allow` or a `warn` needs.
    #[must_use]
    pub fn sentinels(&self) -> Sentinels {
        Sentinels {
            sentinels: self.sentinels.clone(),
            quorum: self.quorum,
        }
    }

    /// Owner only: replaces the armer (revocation of a compromised armer).
    pub fn set_armer(&mut self, armer: AccountId) {
        self.assert_owner();
        let previous = std::mem::replace(&mut self.armer, armer);
        emit(
            "armer_changed",
            &near_sdk::serde_json::json!({ "previous": previous, "armer": self.armer }),
        );
    }

    /// Owner only: lifts the freeze set by its disarm; the armer can re-arm.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn unfreeze(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(self.frozen.remove(&agent), "agent not frozen");
        emit("unfrozen", &near_sdk::serde_json::json!({ "agent": agent }));
    }

    /// Owner only: clears `agent`'s 7-day arming log. A compromised armer can fill the log or the
    /// 7-day cap and lock the agent out for a week; after `set_armer`, this restores service.
    /// The cleared armings no longer count toward the cap: the owner decides that, not the armer.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn reset_armings(&mut self, agent: AccountId) {
        self.assert_owner();
        let log = self.armings_in_window(&agent);
        self.armings.remove(&agent);
        emit(
            "armings_reset",
            &near_sdk::serde_json::json!({
                "agent": agent, "cleared": log.len(),
                "armed_7d": U128(log.iter().map(|&(_, b)| b).sum()),
            }),
        );
    }

    /// Armer only: arms `budget` for `agent` for `duration_s` seconds, within the
    /// human's bounds and if the agent's credit is at least `expected_credit` (integrity check: credit
    /// spent or drained since the armer read it is refused; anyone may top it up with
    /// `deposit_credit`, which must not block an arming). Re-arming replaces the current budget.
    pub fn arm(&mut self, agent: AccountId, budget: U128, duration_s: u64, expected_credit: U128) {
        require!(env::predecessor_account_id() == self.armer, "armer only");
        require!(agent != self.armer, "the armer cannot arm itself");
        require!(
            self.agents.contains(&agent),
            "agent not registered by the owner"
        );
        require!(!self.frozen.contains(&agent), "agent frozen by the owner");
        require!(budget.0 > 0, "zero budget");
        require!(
            budget.0 <= self.bounds.max_budget.0,
            "budget above the human's bound"
        );
        require!(
            duration_s <= self.bounds.max_duration_s,
            "duration above the human's bound"
        );
        // An agent never credited has no entry: refused even with a zero `expected_credit`,
        // otherwise the armer creates a budget and log for any account, at the contract's expense.
        let Some(credit) = self.credits.get(&agent).copied() else {
            env::panic_str("integrity check failed: agent never credited")
        };
        require!(
            credit >= expected_credit.0,
            "integrity check failed: credit below what the armer read"
        );
        // The armed budget counts in full, even if unspent; re-arming adds to the total.
        let now = env::block_timestamp();
        let mut log = self.armings_in_window(&agent);
        let armed: u128 = log.iter().map(|&(_, b)| b).sum();
        let Some(armed_7d) = armed
            .checked_add(budget.0)
            .filter(|&total| total <= self.bounds.max_7d.0)
        else {
            env::panic_str("7-day cap exceeded")
        };
        require!(log.len() < MAX_ARMINGS_7D, "too many armings in 7 days");
        log.push((now, budget.0));
        self.armings.insert(agent.clone(), log);
        let expires_ns = now.saturating_add(duration_s.saturating_mul(1_000_000_000));
        emit(
            "armed",
            &near_sdk::serde_json::json!({
                "agent": agent, "armer": self.armer, "budget": budget,
                "expires_ns": U64(expires_ns), "armed_7d": U128(armed_7d),
            }),
        );
        self.budgets.insert(
            agent,
            Budget {
                remaining: budget.0,
                expires_ns,
            },
        );
    }

    /// Removes `agent`'s armed budget: the owner's emergency stop, which also freezes the agent
    /// (the armer can no longer re-arm it before `unfreeze`), or an abnormal stop noticed by the armer,
    /// without freeze. Purges the log of armings outside the window, and its entry if empty.
    pub fn disarm(&mut self, agent: AccountId) {
        let by = env::predecessor_account_id();
        require!(by == self.owner || by == self.armer, "owner or armer only");
        self.budgets.remove(&agent);
        let log = self.armings_in_window(&agent);
        if log.is_empty() {
            self.armings.remove(&agent);
        } else {
            self.armings.insert(agent.clone(), log);
        }
        emit(
            "disarmed",
            &near_sdk::serde_json::json!({ "agent": agent, "by": by }),
        );
        if by == self.owner {
            emit("frozen", &near_sdk::serde_json::json!({ "agent": agent }));
            self.stopped.insert(agent.clone(), env::block_timestamp());
            self.frozen.insert(agent);
        }
    }

    /// Debits the fixed price from the caller's credit and the armed budget; returns the request id.
    /// `target` must be a strict EVM address (0x + 40 hexadecimal digits). `amount_wei` is the buy the
    /// agent asks to be checked: the sentinel simulates exactly that amount and `buy` accepts no other,
    /// so it must fit in what the armed budget keeps after the price. Refused for a token that is
    /// listed, quarantined by a block verdict, already awaiting a verdict (one check per token at a
    /// time, for all agents), or whose per-token cap the amount would exceed.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn request_check(
        &mut self,
        target: String,
        amount_wei: U128,
        decision_sha256: Option<String>,
    ) -> u64 {
        let decision = decision_digest(decision_sha256);
        require!(
            is_evm_address(&target),
            "invalid target: expected 0x + 40 hex digits"
        );
        let key = token_key(&target);
        require!(
            !self.blocklist.contains_key(&key),
            "target is on the shared blocklist"
        );
        self.require_not_quarantined(&key);
        // One draw at a time per token, for all agents: N parallel requests would be N draws of the
        // sales a check simulates, and the first lucky one would buy.
        require!(
            self.pending_of(&key).is_none(),
            "a check of this target is already awaiting its verdict"
        );
        require!(amount_wei.0 > 0, "zero amount");
        require!(
            amount_wei.0 <= self.bounds.max_buy_wei.0,
            "amount above the owner's per-buy limit"
        );
        // Refused here rather than after a paid check: `buy` enforces it.
        self.require_cap_room(&self.buys_in_period(&key), amount_wei.0);
        let cost = self.cost(amount_wei.0, 1);
        let id = self.new_check(&target, None, amount_wei, decision.as_deref());
        self.pending.insert(key, id);
        self.anchor(decision.as_deref(), id);
        require!(
            cost <= self.budget_left(&env::predecessor_account_id()).0,
            "budget exceeded"
        );
        id
    }

    /// Exit quote for an agent: asks the sentinels what selling `amount` of the token bought by the
    /// agent's signed check `buy_id` yields (ETH, in wei). Priced like a check, from the credit alone: a
    /// sale never needs buying budget. Only a token the guard bought for this agent; a listed or changed
    /// token may still be quoted: the exit is never blocked.
    pub fn request_exit(&mut self, buy_id: u64, amount: U128) -> u64 {
        let who = env::predecessor_account_id();
        require!(
            self.agents.contains(&who) && !self.frozen.contains(&who),
            "unfrozen registered agent only"
        );
        let Some(bought) = self.checks.get(&buy_id) else {
            env::panic_str("unknown check")
        };
        require!(
            bought.agent == who && bought.exit_amount.is_none() && bought.signed_tx.is_some(),
            "not a buy signed for this agent"
        );
        require!(amount.0 > 0, "zero amount");
        let target = bought.target.clone();
        self.require_holding(&who, &target, amount.0);
        self.new_check(&target, Some(amount), U128(0), None)
    }

    fn require_holding(&self, agent: &AccountId, token: &str, amount: u128) {
        require!(
            amount <= self.held(agent, token),
            "exit amount above the agent's holding"
        );
    }

    /// What `agent` may still sell of `token` (0 when the token is held for another agent or none).
    fn held(&self, agent: &AccountId, token: &str) -> u128 {
        self.holdings
            .get(&token.to_ascii_lowercase())
            .filter(|(a, _)| a == agent)
            .map_or(0, |&(_, n)| n)
    }

    /// Sets `agent`'s holding of `token`; at 0 the token is free for another agent.
    fn set_held(&mut self, agent: &AccountId, token: &str, amount: u128) {
        let key = token.to_ascii_lowercase();
        if amount == 0 {
            self.holdings.remove(&key);
        } else {
            self.holdings.insert(key, (agent.clone(), amount));
        }
    }

    /// Debits the price from the caller and stores a new check of `target` (a buy of `amount_wei`, or
    /// an exit quote with `exit_amount`); returns its id.
    fn new_check(
        &mut self,
        target: &str,
        exit_amount: Option<U128>,
        amount_wei: U128,
        decision: Option<&str>,
    ) -> u64 {
        let who = env::predecessor_account_id();
        if exit_amount.is_some() {
            self.debit_credit(&who, self.price); // a sale never needs buying budget
        } else {
            self.debit(&who, self.price);
        }
        self.escrow += self.price;
        self.next_id += 1;
        self.checks.insert(
            self.next_id,
            Check {
                agent: who.clone(),
                target: target.to_owned(),
                requested_ns: U64(env::block_timestamp()),
                verdict: None,
                judged_ns: U64(0),
                reasons: String::new(),
                evidence_sha256: String::new(),
                amount_wei,
                quote: U128(0),
                settled: false,
                approved: false,
                signed_tx: None,
                code: None,
                exit_amount,
                decision_sha256: decision.map(str::to_owned),
                buy_decision_sha256: None,
                tx_hashes: vec![],
                list_target: false,
                votes: vec![],
            },
        );
        emit(
            "check_requested",
            &near_sdk::serde_json::json!({
                "id": self.next_id, "agent": who, "target": target, "amount_wei": amount_wei,
                "exit_amount": exit_amount, "decision_sha256": decision,
            }),
        );
        self.next_id
    }

    /// A sentinel's vote on check `id`, one per sentinel, within 300 s of the check's request:
    /// reasons, proof logged (event `verdict_posted`, one per vote), quote (tokens the guard's address
    /// received in its simulated buy of the check's amount, or ETH out of the simulated exit; also in
    /// the proof) required on an `allow`. `tx_hashes`: signing hashes of the transactions simulated
    /// from the guard's address, built by `preview_check`; only those are ever signed for this check.
    ///
    /// **A buy check.** Only the votes of the current sentinels count: a vote whose sentinel the owner
    /// removed is dropped here, and the quorum is the one in force now. `quorum` votes identical on the
    /// verdict, the quote, the transaction hashes, the code and `list_target` make an `allow` or a
    /// `warn`; each sentinel simulates the same reference block with the same derived draws, so honest
    /// ones agree (their evidence strings may differ, by the NEAR facts read at another moment: each
    /// sha256 is stored, none is compared). A single `block` vote blocks at once, and so does any
    /// disagreement. A `block` also overturns an `allow` or a `warn` already decided, while that
    /// verdict can still buy: within 180 s of the request and until the buy is sent to signing. Every
    /// `block` vote that carries the token's code quarantines the token, whatever was decided before
    /// it. Listing a token takes the quorum, of identical `block` votes.
    ///
    /// **An exit quote** (`exit_vote`): every sentinel may quote until the exit is sent to signing.
    // near-sdk's JSON ABI requires owned types; the votes' state machine reads top to bottom
    #[allow(
        clippy::needless_pass_by_value,
        clippy::too_many_arguments,
        clippy::too_many_lines
    )]
    pub fn post_verdict(
        &mut self,
        id: u64,
        verdict: Verdict,
        reasons: String,
        evidence: String,
        quote: U128,
        code: Option<Code>,
        list_target: bool,
        tx_hashes: Vec<String>,
    ) {
        let who = env::predecessor_account_id();
        require!(self.sentinels.contains(&who), "sentinel only");
        require!(reasons.len() <= MAX_REASONS, "reasons too long");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence too long");
        let tx_hashes = posted_hashes(&tx_hashes);
        let code = code.map(posted_code);
        require!(
            verdict != Verdict::Allow || quote.0 > 0,
            "allow without a quote"
        );
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        let exit = check.exit_amount.is_some();
        let needed = usize::from(self.quorum);
        let before = check.verdict;
        let vetoed = before == Some(Verdict::Block);
        // The votes this one is weighed with: the current sentinels' (an exit quote keeps them all: a
        // vote from a sentinel removed since voids it at the sale).
        let counted = if exit {
            check.votes.len()
        } else {
            self.counted(check)
        };
        // A check takes votes for 300 s (after it, it is refunded or too old to buy: a vote would only
        // quarantine again a token the owner has lifted since), and never once sent to signing, nor
        // once an exit's quotes are of transactions the guard no longer signs. A buy check decided
        // `allow` or `warn` takes only a block, while that verdict can still buy.
        let within = |ns: u64| env::block_timestamp() < check.requested_ns.0.saturating_add(ns);
        let open = within(VERDICT_TIMEOUT_NS)
            && !check.settled
            && !self.signing_for(id)
            && !self.exit_over(check)
            && (exit
                || before.is_none()
                || vetoed
                || (verdict == Verdict::Block && within(VERDICT_FRESH_NS)));
        require!(
            open && counted < self.sentinels.len(),
            "verdict already posted"
        );
        require!(
            check.votes.iter().all(|v| v.sentinel != who),
            "sentinel already voted"
        );
        // An allow or a warn is only usable on the transactions simulated: they must be what the guard
        // would sign now (a preview read on a node behind the guard is refused here, not at the buy).
        require!(
            verdict == Verdict::Block || self.signs(check, quote.0, &tx_hashes),
            "tx hashes are not what the guard would sign now: preview again"
        );
        let evidence_sha256 = hex(&env::sha256(evidence.as_bytes()));
        let posted = |votes: usize, decided: Option<Verdict>| {
            emit(
                "verdict_posted",
                &near_sdk::serde_json::json!({
                    "id": id, "sentinel": who, "verdict": verdict, "reasons": reasons,
                    "evidence": evidence, "quote": quote, "tx_hashes": tx_hashes,
                    "list_target": list_target, "votes": votes, "quorum": needed, "decided": decided,
                }),
            );
        };
        if exit {
            // an exit quote holds no slot, quarantines and lists nothing
            let (votes, decided) = self.exit_vote(
                id,
                &who,
                verdict,
                &reasons,
                &evidence_sha256,
                quote,
                &tx_hashes,
            );
            return posted(votes, decided);
        }
        let target = check.target.to_ascii_lowercase();
        // Code changed since the last verdict on this target: at most warn, the human decides.
        let mut unchanged = false;
        if let Some(code) = &code {
            unchanged = self.same_code(&target, code);
            require!(
                verdict != Verdict::Allow || unchanged,
                "code changed since the last check: at most warn"
            );
        } else {
            require!(
                verdict == Verdict::Block,
                "allow or warn without the target's code"
            );
        }
        // This vote against the ones that count: `same` when every one names this verdict and this
        // quote, transactions, code and listing; `agreed` when that makes the quorum (or more: the
        // owner lowered it while they waited).
        let first = counted == 0;
        let same = check
            .votes
            .iter()
            .filter(|v| self.sentinels.contains(&v.sentinel))
            .all(|v| v.verdict == verdict)
            && (first
                || (check.quote == quote
                    && check.tx_hashes == tx_hashes
                    && check.code == code
                    && check.list_target == list_target));
        let agreed = same && counted + 1 >= needed;
        let decided = if vetoed || verdict == Verdict::Block || !same {
            Some(Verdict::Block)
        } else {
            agreed.then_some(verdict)
        };
        let sentinels = &self.sentinels;
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        check.votes.retain(|v| sentinels.contains(&v.sentinel));
        if first {
            check.quote = quote;
            check.code.clone_from(&code);
            check.tx_hashes.clone_from(&tx_hashes);
            check.list_target = list_target;
        }
        if !vetoed && (first || verdict == Verdict::Block) {
            // the first vote, or a veto: the check now rests on this vote
            check.reasons.clone_from(&reasons);
            check.evidence_sha256.clone_from(&evidence_sha256);
        } else if !vetoed && !same {
            DISAGREE.clone_into(&mut check.reasons);
        }
        check.votes.push(Vote {
            sentinel: who.clone(),
            verdict,
            evidence_sha256: evidence_sha256.clone(),
            quote: None,
        });
        let votes = check.votes.len();
        // The verdict's 120 s run from the vote that sets it.
        if decided != before {
            check.verdict = decided;
            check.judged_ns = U64(env::block_timestamp());
        }
        // The price is earned once, by the first decision.
        let closes = before.is_none() && decided.is_some();
        if closes {
            self.escrow -= self.price;
            self.fees += self.price;
        }
        posted(votes, decided);
        // The reference code moves only with the quorum's own verdict, to the same code (or to the
        // first code seen); on changed code, only the owner's `approve_warn` moves it.
        if agreed && unchanged {
            self.seen.insert(target.clone(), id);
        }
        if closes {
            self.release(id, &target);
        }
        if verdict == Verdict::Block && code.is_some() {
            self.quarantine_token(id, &target);
        }
        // Only the quorum's block of a buy check that rests on the target's code, and that every vote
        // asks to list, lists its target (never the fail-closed fallback, nor a reputation-only
        // block), unless already listed (the first entry stays).
        if agreed
            && verdict == Verdict::Block
            && code.is_some()
            && list_target
            && !self.blocklist.contains_key(&target)
        {
            let entry = Entry {
                reporter: who,
                at_ns: U64(env::block_timestamp()),
                evidence_sha256,
                note: format!("verdict #{id}"),
            };
            self.list(target, entry);
        }
    }

    /// A sentinel's vote on exit quote `id`, validated by `post_verdict`. Two sentinels quote an exit
    /// at two Base blocks, so their quotes differ and none can be asked to match: the quote that
    /// stands is the median of the `allow` quotes once three are in, which one liar moves neither way,
    /// and the highest of fewer (a floor too high makes the sale revert, tokens kept; one too low
    /// gives them away). A `block` never cancels another sentinel's quote. Every quote is of the
    /// transactions the guard signs now: once its nonce, gas or fees moved under a quote, `post_verdict`
    /// takes no more votes (`exit_over`). The quote's 120 s run from the first one. Returns the votes
    /// in and the verdict that stands.
    #[allow(clippy::too_many_arguments)] // one vote, as `post_verdict` received it
    fn exit_vote(
        &mut self,
        id: u64,
        who: &AccountId,
        verdict: Verdict,
        reasons: &str,
        evidence_sha256: &str,
        quote: U128,
        tx_hashes: &[String],
    ) -> (usize, Option<Verdict>) {
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        let before = check.verdict;
        let had_quote = before == Some(Verdict::Allow);
        let allow = verdict == Verdict::Allow;
        // The quote that stands with this one: its vote's evidence, and the transactions the guard
        // signs on it (those its sentinel posted: nothing moved since).
        let standing = allow.then(|| {
            let mut quotes: Vec<(u128, &str)> = check
                .votes
                .iter()
                .filter_map(|v| v.quote.map(|q| (q.0, v.evidence_sha256.as_str())))
                .collect();
            quotes.push((quote.0, evidence_sha256));
            quotes.sort_unstable();
            let middle = if quotes.len() < 3 {
                quotes.len() - 1 // the highest
            } else {
                quotes.len() / 2
            };
            let (stands, sha) = quotes[middle];
            let hashes: Vec<String> = self
                .check_txs(check, stands)
                .iter()
                .map(signing_hash)
                .collect();
            (U128(stands), sha.to_owned(), hashes)
        });
        let now = U64(env::block_timestamp());
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        if let Some((stands, sha, hashes)) = standing {
            if stands == quote && sha == evidence_sha256 {
                reasons.clone_into(&mut check.reasons);
            }
            check.quote = stands;
            check.evidence_sha256 = sha;
            check.tx_hashes = hashes;
            check.verdict = Some(Verdict::Allow);
            if !had_quote {
                check.judged_ns = now;
            }
        } else if before.is_none() {
            // no quote yet: the check rests on this first vote
            reasons.clone_into(&mut check.reasons);
            evidence_sha256.clone_into(&mut check.evidence_sha256);
            check.quote = quote;
            check.tx_hashes = tx_hashes.to_vec();
            check.verdict = Some(verdict);
            check.judged_ns = now;
        }
        check.votes.push(Vote {
            sentinel: who.clone(),
            verdict,
            evidence_sha256: evidence_sha256.to_owned(),
            quote: allow.then_some(quote),
        });
        let (votes, decided) = (check.votes.len(), check.verdict);
        if before.is_none() {
            self.escrow -= self.price; // the price is earned by the first vote
            self.fees += self.price;
        }
        (votes, decided)
    }
    /// Votes on `c` cast by sentinels of the current set, the only ones that count: a sentinel the
    /// owner removed (a stolen key) stops counting at once, on the checks it already voted on too.
    fn counted(&self, c: &Check) -> usize {
        c.votes
            .iter()
            .filter(|v| self.sentinels.contains(&v.sentinel))
            .count()
    }

    /// True while the guard has the buy or the exit of check `id` at the MPC: a signature requested is
    /// not recalled, and what is being signed is not voted on.
    fn signing_for(&self, id: u64) -> bool {
        match &self.signing {
            Some(Job::Buy(p)) => p.id == id,
            Some(Job::Exit(_, Some(charge))) => charge.check == id,
            _ => false,
        }
    }

    /// True if `code` is the one `target` (lowercase) had at its last verdict, or the first seen.
    fn same_code(&self, target: &str, code: &Code) -> bool {
        self.seen
            .get(target)
            .and_then(|last| self.checks.get(last))
            .and_then(|c| c.code.as_ref())
            .is_none_or(|p| p == code)
    }

    /// Decides buy check `id` when the votes in already make the quorum as it stands and no vote is
    /// left to come: the owner lowered the quorum, or removed the sentinel still awaited, while the
    /// check waited. Called by `buy` and `approve_warn` (the next vote would decide it as well); the
    /// verdict's 120 s run from this call. Event `verdict_decided`.
    fn decide_waiting(&mut self, id: u64) {
        let sentinels = &self.sentinels;
        let Some(check) = self.checks.get_mut(&id).filter(|c| {
            c.verdict.is_none()
                && c.exit_amount.is_none()
                && env::block_timestamp() < c.requested_ns.0.saturating_add(VERDICT_FRESH_NS)
        }) else {
            return;
        };
        let live = |v: &&Vote| sentinels.contains(&v.sentinel);
        // A block or a difference decides at once: the votes of a check still waiting are identical.
        let Some(verdict) = check.votes.iter().find(live).map(|v| v.verdict) else {
            return;
        };
        if check.votes.iter().filter(live).count() < usize::from(self.quorum) {
            return;
        }
        check.votes.retain(|v| sentinels.contains(&v.sentinel));
        check.verdict = Some(verdict);
        check.judged_ns = U64(env::block_timestamp());
        let (votes, code) = (check.votes.len(), check.code.clone());
        let target = check.target.to_ascii_lowercase();
        self.escrow -= self.price;
        self.fees += self.price;
        emit(
            "verdict_decided",
            &near_sdk::serde_json::json!({
                "id": id, "verdict": verdict, "votes": votes, "quorum": self.quorum,
            }),
        );
        if code.is_some_and(|c| self.same_code(&target, &c)) {
            self.seen.insert(target.clone(), id);
        }
        self.release(id, &target);
    }

    /// The verdict of buy check `id` frees its `token` (lowercase) for the next check.
    fn release(&mut self, id: u64, token: &str) {
        if self.pending.get(token) == Some(&id) {
            self.pending.remove(token);
        }
    }

    /// A `block` vote that carries the code of `token` (lowercase), on buy check `id`, quarantines it,
    /// listed or not, decided or not: a block that lists nothing (a sale refused at one drawn delay)
    /// is the one an agent would otherwise ask again until a draw misses it. Two blocks quarantine
    /// nothing, since no sentinel found a refusal: a disagreement between votes that are not blocks,
    /// and the fail-closed fallback, posted without the code when a simulation could not run (a node
    /// that times out must not close an honest token for every agent). A quarantine already running
    /// is never shortened. Never called for an exit quote: an exit is never blocked.
    fn quarantine_token(&mut self, id: u64, token: &str) {
        let until = env::block_timestamp()
            .saturating_add(self.limits.quarantine_s.saturating_mul(1_000_000_000))
            .max(self.quarantine.get(token).copied().unwrap_or(0));
        self.quarantine.insert(token.to_owned(), until);
        emit(
            "quarantined",
            &near_sdk::serde_json::json!({ "token": token, "id": id, "until_ns": U64(until) }),
        );
    }

    /// Buy on Base signed by NEAR, on a non-expired `allow` verdict of this request: the guard
    /// builds the WETH -> request target swap on the Uniswap V2 router, tokens to its
    /// derived address, and asks the MPC to sign it (1 yoctoNEAR taken from its balance). The agent
    /// chooses only the value in wei, stated at `request_check` (any other is refused); the minimum
    /// tokens come from the sentinel's quote, minus the tolerated slippage. The guard signs only the
    /// transaction the sentinel simulated (`tx_hashes` of the verdict): if the nonce, gas or fees moved
    /// since, the agent asks a new check. The armed budget and the credit are debited by the value plus
    /// the gas at the cap, at the owner's fixed rate. Refused more than 180 s after the check's request,
    /// for a token quarantined since (a later check blocked it), once the reference code is no longer the
    /// one its verdict saw (a later check's approved warn moved it), or beyond the owner's per-token cap,
    /// which counts every agent's buys of the token over its rolling period.
    pub fn buy(&mut self, id: u64, amount_wei: U128, decision_sha256: Option<String>) -> Promise {
        let decision = decision_digest(decision_sha256);
        require!(self.signing.is_none(), "a signature is already in progress");
        let who = env::predecessor_account_id();
        // Votes that already make a quorum lowered since decide the check now (a refusal below
        // undoes it with the rest of the call).
        self.decide_waiting(id);
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.agent == who, "check belongs to another agent");
        require!(!check.settled, "check already settled");
        match check.verdict {
            None => env::panic_str("no verdict yet"),
            Some(Verdict::Allow) => {}
            Some(Verdict::Warn) if check.approved => {}
            Some(Verdict::Warn) => env::panic_str("warn verdict not approved by the owner"),
            Some(Verdict::Block) => env::panic_str("verdict does not allow the purchase"),
        }
        // The sentinels and the quorum as they stand now: a verdict decided under a lower quorum, or
        // resting on the vote of a sentinel removed since, no longer buys.
        require!(
            self.counted(check) >= usize::from(self.quorum),
            "verdict below the sentinels' quorum: request a new check"
        );
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        require!(
            check.exit_amount.is_none(),
            "an exit quote is not a buy verdict"
        );
        require!(
            env::block_timestamp() < check.requested_ns.0.saturating_add(VERDICT_FRESH_NS),
            "check requested more than 180 s ago: request a new check"
        );
        let key = token_key(&check.target);
        require!(
            !self.blocklist.contains_key(&key),
            "target is on the shared blocklist"
        );
        // A later check of the same token got a block: this earlier allow no longer buys.
        self.require_not_quarantined(&key);
        // Nor once the reference code moved: a later check's warn on other code, approved since.
        require!(
            check.code.as_ref().is_some_and(|c| self.same_code(&key, c)),
            "code changed since the verdict: request a new check"
        );
        require!(
            amount_wei == check.amount_wei,
            "amount is not the one checked"
        );
        require!(
            amount_wei.0 <= self.bounds.max_buy_wei.0,
            "amount above the owner's per-buy limit"
        );
        require!(self.requested_since_stop(check), STOPPED);
        let target = check.target.clone();
        require!(
            self.holdings
                .get(&target.to_ascii_lowercase())
                .is_none_or(|(a, _)| *a == who),
            "token held for another agent"
        );
        // Signed within `VERDICT_FRESH_NS` of the request: at least 120 s remain to broadcast it.
        let deadline_s = deadline_of(check);
        let min_out = floor(check.quote.0, self.evm.max_slippage_bps);
        require!(min_out > 0, "minimum output rounds to zero");
        require!(self.previewed(check), SIMULATED_ONLY);
        self.count_buy(key, amount_wei.0);
        let cost = self.cost(amount_wei.0, 1);
        self.debit(&who, cost);
        self.escrow += cost;
        let pending = Pending {
            id,
            agent: who.clone(),
            target,
            value: amount_wei.0,
            min_out,
            deadline_s,
            cost,
            armed_until_ns: self.budgets.get(&who).map_or(0, |b| b.expires_ns),
        };
        let tx = self.swap_tx(&pending.target, pending.value, min_out, deadline_s);
        let hash = signing_hash(&tx);
        emit(
            "sign_requested",
            &near_sdk::serde_json::json!({
                "id": id, "agent": who, "target": pending.target, "amount_wei": amount_wei,
                "min_out": U128(min_out), "nonce": self.evm_nonce, "hash": hash,
                "decision_sha256": decision,
            }),
        );
        self.anchor(decision.as_deref(), id);
        if let Some(check) = self.checks.get_mut(&id) {
            check.buy_decision_sha256 = decision;
        }
        self.signing = Some(Job::Buy(pending));
        self.signing_since_ns = env::block_timestamp();
        self.sign_all(
            &[tx],
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_signed(self.signing_since_ns),
        )
    }

    /// The owner's exit, signed by NEAR: sells `amount` of `token` held by the guard's EVM address
    /// for ETH, back to that address (approve of the router, then the swap: two signatures, two
    /// nonces). No verdict, no quote, no budget, any token, listed or not, frozen agent or not: the
    /// human can always get out. `min_out_wei` is the owner's own floor. `approve`: the amount the
    /// router is approved for, `0x` + 1 to 64 hex digits up to 2^256 - 1 (the maximum, if a token lets
    /// only that sell), `amount` when absent. Agents use `sell_quoted`.
    pub fn sell(
        &mut self,
        token: String,
        amount: U128,
        min_out_wei: U128,
        approve: Option<String>,
    ) -> Promise {
        self.assert_owner();
        require!(
            is_evm_address(&token),
            "invalid token: expected 0x + 40 hex digits"
        );
        require!(amount.0 > 0, "zero amount");
        let approve = approve.map(|a| {
            let Some(w) = approve_word(&a) else {
                env::panic_str("invalid approve amount: 0x + 1 to 64 hex digits")
            };
            format!("0x{}", hex(&w))
        });
        let exit = Exit {
            by: self.owner.clone(),
            token: Some(token),
            amount,
            min_out: min_out_wei,
            deadline_s: env::block_timestamp() / 1_000_000_000 + SWAP_DEADLINE_S,
            nonce: self.evm_nonce,
            approve,
            signed_txs: vec![],
        };
        self.start_exit(exit, None)
    }

    /// An agent's exit on the sentinels' exit quote `id` (`request_exit`), within 120 s of it, once:
    /// the floor is the quoted ETH out minus the owner's slippage bound, never the agent's choice. The
    /// quote is the median of three, or the highest of fewer, by current sentinels only, and it sells
    /// once every sentinel's quote is in (a `block` is no quote), 15 s after the request with the
    /// quorum's, or 60 s after it with one vote (`exit_ready`): a sentinel that is down delays an
    /// exit, and under a quorum of two or more one key alone neither refuses it nor sets its floor
    /// while the other sentinels answer with a quote. The guard signs only the approve and swap the
    /// sentinel simulated (`tx_hashes`). Two transactions at
    /// the gas cap are charged to the credit alone (a sale never needs buying budget); never refused
    /// because the token was listed or its code changed, nor because the budget is spent or expired.
    pub fn sell_quoted(&mut self, id: u64) -> Promise {
        require!(self.signing.is_none(), "a signature is already in progress");
        let who = env::predecessor_account_id();
        require!(
            self.agents.contains(&who) && !self.frozen.contains(&who),
            "unfrozen registered agent only"
        );
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.agent == who, "check belongs to another agent");
        let Some(amount) = check.exit_amount else {
            env::panic_str("not an exit quote")
        };
        require!(!check.settled, "check already settled");
        require!(
            check.verdict == Some(Verdict::Allow),
            "no exit quote: the sentinel found no sale"
        );
        // Every vote on the quote must be a current sentinel's: the quote that stands may be the one
        // a removed sentinel posted.
        require!(
            self.counted(check) == check.votes.len(),
            "a sentinel that voted on this exit quote was replaced: request a new quote"
        );
        // One key does not set the floor while another sentinel may still quote higher. Quotes of
        // transactions the guard no longer signs wait for no vote (`exit_over`): refused below.
        require!(
            self.exit_votes_in(check) || self.exit_over(check),
            "exit quote awaits the other sentinels: it sells once all quoted, 15 s after the request with the quorum's quotes, or 60 s after it"
        );
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        require!(self.requested_since_stop(check), STOPPED);
        let token = check.target.clone();
        self.require_holding(&who, &token, amount.0);
        let exit = self.agent_exit(check, amount, check.quote.0);
        require!(
            env::block_timestamp() / 1_000_000_000 + MIN_BROADCAST_S <= exit.deadline_s,
            "swap deadline too close: request a new check"
        );
        require!(exit.min_out.0 > 0, "minimum output rounds to zero");
        require!(self.previewed(check), SIMULATED_ONLY);
        let per_tx = self.cost(0, 1);
        let cost = self.cost(0, 2);
        self.debit_credit(&who, cost); // a sale never needs buying budget
        self.escrow += cost;
        // Reserve the tokens until the exit is signed (restored in `on_exit_signed` otherwise).
        self.set_held(&who, &token, self.held(&who, &token) - amount.0);
        let charge = Charge {
            agent: who.clone(),
            check: id,
            per_tx,
        };
        self.start_exit(exit, Some(charge))
    }

    /// Owner only: sends `amount_wei` from the guard's EVM address to `evm.withdraw_to`, fixed at
    /// init. One signature.
    pub fn withdraw_eth(&mut self, amount_wei: U128) -> Promise {
        self.assert_owner();
        require!(amount_wei.0 > 0, "zero amount");
        let exit = Exit {
            by: self.owner.clone(),
            token: None,
            amount: amount_wei,
            min_out: U128(0),
            deadline_s: env::block_timestamp() / 1_000_000_000 + SWAP_DEADLINE_S,
            nonce: self.evm_nonce,
            approve: None,
            signed_txs: vec![],
        };
        self.start_exit(exit, None)
    }

    /// Has the MPC sign `exit`'s transactions (built at its nonce, the current one), then
    /// `on_exit_signed`.
    fn start_exit(&mut self, exit: Exit, charge: Option<Charge>) -> Promise {
        require!(self.signing.is_none(), "a signature is already in progress");
        let txs = self.exit_txs(&exit);
        let hashes: Vec<String> = txs.iter().map(signing_hash).collect();
        emit(
            "exit_requested",
            &near_sdk::serde_json::json!({
                "by": exit.by, "token": exit.token, "amount": exit.amount, "min_out": exit.min_out,
                "approve": exit.approve, "nonce": exit.nonce, "hashes": hashes,
                "check": charge.as_ref().map(|c| c.check),
            }),
        );
        self.signing = Some(Job::Exit(exit, charge));
        self.signing_since_ns = env::block_timestamp();
        self.sign_all(
            &txs,
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_exit_signed(self.signing_since_ns),
        )
    }

    /// One `sign` call to the MPC per transaction (1 yoctoNEAR each, from the guard's balance),
    /// joined, then `callback`.
    fn sign_all(&self, txs: &[EVMTransaction], callback: Promise) -> Promise {
        let sign = |tx: &EVMTransaction| {
            let hash = signing_hash(tx);
            let args = near_sdk::serde_json::json!({
                "request": { "path": DERIVATION_PATH, "payload_v2": { "Ecdsa": hash }, "domain_id": 0 },
            });
            Promise::new(self.evm.mpc.clone()).function_call(
                "sign".to_owned(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                SIGN_GAS,
            )
        };
        let Some(all) = txs.iter().map(sign).reduce(Promise::and) else {
            env::panic_str("nothing to sign")
        };
        all.then(callback)
    }

    /// Callback of an exit's `sign` calls, for the job requested at `since_ns`: keeps the signatures
    /// up to the first missing one (`finish_exit`). Never panics after taking the job.
    #[private]
    pub fn on_exit_signed(&mut self, since_ns: u64) -> Vec<String> {
        self.require_job(since_ns);
        let Some(Job::Exit(exit, charge)) = self.signing.take() else {
            env::panic_str("no exit signature in progress")
        };
        let mut signatures = vec![];
        for i in 0..self.exit_txs(&exit).len() as u64 {
            let signature = env::promise_result_checked(i, MAX_SIGN_RESPONSE)
                .ok()
                .and_then(|bytes| parse_signature(&bytes));
            let Some(signature) = signature else { break };
            signatures.push(signature);
        }
        self.finish_exit(exit, charge.as_ref(), &signatures)
    }

    /// Settles an exit with its first `signatures` (a swap without its approve is dropped) and stores
    /// the signed transactions as `last_exit`. Every nonce of the exit stays used: a missing signature
    /// may still be published, so its transaction is reserved (`unsettled`), with its share of the
    /// charge and, for an agent's swap, the tokens it sells. A replacement (a nonce already used,
    /// `sign_replacement`) reserves nothing; once signed, it is recorded on the entry it replaces.
    fn finish_exit(
        &mut self,
        mut exit: Exit,
        charge: Option<&Charge>,
        signatures: &[Signature],
    ) -> Vec<String> {
        let replacement = exit.nonce < self.evm_nonce;
        let txs = self.exit_txs(&exit);
        let signed: Vec<Vec<u8>> = txs
            .iter()
            .zip(signatures)
            .map(|(tx, signature)| tx.build_with_signature(signature))
            .collect();
        let hexes: Vec<String> = signed.iter().map(|raw| format!("0x{}", hex(raw))).collect();
        emit(
            "exit_signed",
            &near_sdk::serde_json::json!({
                "by": exit.by, "token": exit.token, "amount": exit.amount, "nonce": exit.nonce, "txs": hexes,
            }),
        );
        let done = signed.len();
        if replacement {
            if let Some(u) = self.unsettled.get_mut(&exit.nonce).filter(|_| done > 0) {
                u.replaced = true;
            }
        } else {
            self.evm_nonce = exit.nonce + txs.len() as u64;
            let per_tx = charge.map_or(0, |c| c.per_tx);
            self.escrow -= per_tx * done as u128;
            self.fees += per_tx * done as u128;
            for i in done..txs.len() {
                // The swap is the last transaction: an agent's tokens stay reserved with it.
                let restore = exit
                    .token
                    .clone()
                    .filter(|_| charge.is_some() && i + 1 == txs.len())
                    .map(|t| (t, exit.amount));
                self.reserve(
                    exit.nonce + i as u64,
                    Unsettled {
                        agent: charge.map(|c| c.agent.clone()),
                        check: charge.map(|c| c.check),
                        cost: U128(per_tx),
                        armed_until_ns: U64(0), // a sale debits no budget
                        restore,
                        replaced: false,
                    },
                );
            }
            // The quote served: its transactions are signed or reserved.
            if let Some(check) = charge.and_then(|c| self.checks.get_mut(&c.check)) {
                check.settled = true;
            }
        }
        if !signed.is_empty() {
            exit.signed_txs = signed.into_iter().map(Into::into).collect();
            self.last_exit = Some(exit);
        }
        hexes
    }

    /// Panics unless `since_ns` names the job in progress: a callback that arrives after the owner
    /// released its job (`release_signing`) never settles the next one.
    fn require_job(&self, since_ns: u64) {
        require!(
            self.signing.is_some() && since_ns == self.signing_since_ns,
            "no signature in progress for this callback"
        );
    }

    /// Owner only: frees the signature slot when its callback never ran (out of gas, say), once
    /// `RELEASE_DELAY_NS` has passed since the request, longer than the MPC's own timeout. What it was
    /// signing is reserved as unsettled, as when no signature comes back: a late signature may still
    /// be published, so the owner replaces it before any refund. Event `signing_released`.
    pub fn release_signing(&mut self) {
        self.assert_owner();
        let since = self.signing_since_ns;
        require!(
            env::block_timestamp() >= since.saturating_add(RELEASE_DELAY_NS),
            "signature requested less than 600 s ago"
        );
        match self.signing.take() {
            Some(Job::Buy(p)) => {
                self.finish_buy(&p, None);
            }
            Some(Job::Exit(exit, charge)) => {
                self.finish_exit(exit, charge.as_ref(), &[]);
            }
            None => env::panic_str("no signature in progress"),
        }
        emit(
            "signing_released",
            &near_sdk::serde_json::json!({ "since_ns": U64(since) }),
        );
    }

    /// Latest signed exit (sale or withdrawal), for the relay.
    #[must_use]
    pub fn last_exit(&self) -> Option<&Exit> {
        self.last_exit.as_ref()
    }

    /// EVM parameters: derived address, withdrawal address, gas, fees, rate (gas and fees set by
    /// the owner, the rest fixed at init).
    #[must_use]
    pub fn evm_config(&self) -> &EvmConfig {
        &self.evm
    }

    /// Owner only: gas limit and fees of every transaction the guard signs from now on (buys, exits,
    /// withdrawals), within bounds, so a sale that needs more gas can be retried. A verdict simulated
    /// with another gas limit no longer buys or exits. Refused during a signature, whose callback
    /// rebuilds the transaction from these settings.
    pub fn set_evm_gas(
        &mut self,
        gas_limit: u64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) {
        self.assert_owner();
        require!(self.signing.is_none(), "a signature is already in progress");
        check_gas(gas_limit, max_fee_per_gas.0, max_priority_fee_per_gas.0);
        self.evm.gas_limit = gas_limit;
        self.evm.max_fee_per_gas = max_fee_per_gas;
        self.evm.max_priority_fee_per_gas = max_priority_fee_per_gas;
        emit(
            "evm_gas_set",
            &near_sdk::serde_json::json!({
                "gas_limit": gas_limit, "max_fee_per_gas": max_fee_per_gas,
                "max_priority_fee_per_gas": max_priority_fee_per_gas,
            }),
        );
    }

    /// Owner only: approves a `warn` verdict so the agent may buy on it. The approval does not
    /// extend the verdict: it must come, and the purchase too, within `VERDICT_TTL_NS` of the
    /// verdict, because what the human approves is that simulation, and it ages the same.
    pub fn approve_warn(&mut self, id: u64) {
        self.assert_owner();
        self.decide_waiting(id); // votes that already make a quorum lowered since
        let backed = self
            .checks
            .get(&id)
            .is_some_and(|c| self.counted(c) >= usize::from(self.quorum));
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.verdict == Some(Verdict::Warn), "not a warn verdict");
        // counted again now: not on the vote of a sentinel removed since, nor under a lower quorum
        require!(backed, "verdict below the sentinels' quorum");
        require!(!check.settled, "check already settled");
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        check.approved = true;
        if check.exit_amount.is_none() && check.code.is_some() {
            self.seen.insert(check.target.to_ascii_lowercase(), id);
        }
        emit(
            "warn_approved",
            &near_sdk::serde_json::json!({
                "id": id, "agent": check.agent, "target": check.target, "by": self.owner,
            }),
        );
    }

    /// Callback of `sign`: assembles the signed transaction, stores it with the request and returns
    /// its hex. Without a readable signature nothing is stored, yet the MPC may still publish one (a
    /// response after the yield timed out): the buy is reserved at its nonce, never reused, its cost
    /// stays debited and its decision anchored until the owner settles it (`unsettled`). Does not panic
    /// after taking back the pending buy: a failure here would keep the lock until `release_signing`.
    #[private]
    pub fn on_signed(&mut self, since_ns: u64) -> Option<String> {
        self.require_job(since_ns);
        let Some(Job::Buy(p)) = self.signing.take() else {
            env::panic_str("no signature in progress")
        };
        let signature = env::promise_result_checked(0, MAX_SIGN_RESPONSE)
            .ok()
            .and_then(|bytes| parse_signature(&bytes));
        self.finish_buy(&p, signature.as_ref())
    }

    /// Settles a buy with its signature, or reserves it at its nonce without one.
    fn finish_buy(&mut self, p: &Pending, signature: Option<&Signature>) -> Option<String> {
        let Some(signature) = signature else {
            let nonce = self.evm_nonce;
            self.evm_nonce += 1;
            self.reserve(
                nonce,
                Unsettled {
                    agent: Some(p.agent.clone()),
                    check: Some(p.id),
                    cost: U128(p.cost),
                    armed_until_ns: U64(p.armed_until_ns),
                    restore: None,
                    replaced: false,
                },
            );
            // Sent to signing, so used: the MPC may still publish the signature, and no late vote
            // overturns what it would then have bought.
            if let Some(check) = self.checks.get_mut(&p.id) {
                check.settled = true;
            }
            return None;
        };
        self.escrow -= p.cost;
        let raw = self
            .swap_tx(&p.target, p.value, p.min_out, p.deadline_s)
            .build_with_signature(signature);
        let tx = format!("0x{}", hex(&raw));
        emit(
            "signed",
            &near_sdk::serde_json::json!({
                "id": p.id, "agent": p.agent, "target": p.target, "nonce": self.evm_nonce, "tx": tx,
            }),
        );
        self.evm_nonce += 1;
        self.fees += p.cost;
        let held = self.held(&p.agent, &p.target).saturating_add(p.min_out);
        self.set_held(&p.agent, &p.target, held);
        if let Some(check) = self.checks.get_mut(&p.id) {
            check.settled = true;
            check.signed_tx = Some(raw.into());
        }
        Some(tx)
    }

    /// The unsigned transactions (EIP-1559, `0x` + hex, as the MPC hashes them) that `buy` or
    /// `sell_quoted` would sign for check `id` now, if its verdict carried `quote`: the buy of the
    /// check's amount, or the exit's approve and swap, at the current nonce, gas and fees. The sentinel
    /// simulates exactly these from the guard's address and posts their hashes with its verdict; the
    /// guard signs nothing else for that check.
    #[must_use]
    pub fn preview_check(&self, id: u64, quote: U128) -> Vec<String> {
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        self.check_txs(check, quote.0)
            .iter()
            .map(|tx| format!("0x{}", hex(&tx.build_for_signing())))
            .collect()
    }

    /// The approve and swap an exit of `amount` of `token` is signed as (any floor: 0 here, swap
    /// deadline `deadline_s`), at the current nonce, gas and fees, unsigned as `preview_check`. The
    /// sentinel simulates the sales that follow a buy with them.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn preview_sale(&self, token: String, amount: U128, deadline_s: u64) -> Vec<String> {
        require!(
            is_evm_address(&token),
            "invalid token: expected 0x + 40 hex digits"
        );
        let exit = Exit {
            by: self.owner.clone(),
            token: Some(token),
            amount,
            min_out: U128(0),
            deadline_s,
            nonce: self.evm_nonce,
            approve: None,
            signed_txs: vec![],
        };
        self.exit_txs(&exit)
            .iter()
            .map(|tx| format!("0x{}", hex(&tx.build_for_signing())))
            .collect()
    }

    /// What the guard signs for check `c` with `quote`: the buy, or the agent's exit.
    fn check_txs(&self, c: &Check, quote: u128) -> Vec<EVMTransaction> {
        match c.exit_amount {
            None => vec![self.swap_tx(
                &c.target,
                c.amount_wei.0,
                floor(quote, self.evm.max_slippage_bps),
                deadline_of(c),
            )],
            Some(amount) => self.exit_txs(&self.agent_exit(c, amount, quote)),
        }
    }

    /// True if what the guard would sign for `c` now is what the sentinel simulated (`tx_hashes`).
    fn previewed(&self, c: &Check) -> bool {
        self.signs(c, c.quote.0, &c.tx_hashes)
    }

    /// True if the guard would sign for `c`, with `quote`, exactly the transactions of `hashes`.
    fn signs(&self, c: &Check, quote: u128, hashes: &[String]) -> bool {
        self.check_txs(c, quote)
            .iter()
            .map(signing_hash)
            .eq(hashes.iter().cloned())
    }

    /// The agent's exit of `amount` on exit quote `c`: floor = `quote` minus the slippage bound,
    /// deadline fixed by the check's request, at the current nonce.
    fn agent_exit(&self, c: &Check, amount: U128, quote: u128) -> Exit {
        Exit {
            by: c.agent.clone(),
            token: Some(c.target.clone()),
            amount,
            min_out: U128(floor(quote, self.evm.max_slippage_bps)),
            deadline_s: deadline_of(c),
            nonce: self.evm_nonce,
            approve: None,
            signed_txs: vec![],
        }
    }

    /// Value plus `txs` transactions of gas at the cap, in yoctoNEAR at the owner's fixed rate.
    fn cost(&self, value_wei: u128, txs: u128) -> u128 {
        let Some(cost) = u128::from(self.evm.gas_limit)
            .checked_mul(self.evm.max_fee_per_gas.0)
            .and_then(|gas| gas.checked_mul(txs))
            .and_then(|gas| gas.checked_add(value_wei))
            .and_then(|wei| wei.checked_mul(self.evm.yocto_per_wei.0))
        else {
            env::panic_str("amount too large")
        };
        cost
    }

    /// EIP-1559 transaction of the WETH -> `target` swap of `value` wei on the router, tokens to the
    /// derived address, at the current nonce; every field comes from the guard.
    fn swap_tx(&self, target: &str, value: u128, min_out: u128, deadline_s: u64) -> EVMTransaction {
        let words = [
            word(&min_out.to_be_bytes()),
            word(&[0x80]), // offset of the `path` array after the 4 head words
            word(&parse_eth_address(&self.evm.address[2..])),
            word(&deadline_s.to_be_bytes()),
            word(&[2]),
            word(&parse_eth_address(WETH)),
            word(&parse_eth_address(&target[2..])),
        ];
        self.tx(self.evm_nonce, ROUTER, value, SWAP_SELECTOR, &words)
    }

    /// The exit's transactions from `e.nonce`: approve then swap for a sale, the transfer for a
    /// withdrawal.
    fn exit_txs(&self, e: &Exit) -> Vec<EVMTransaction> {
        let Some(token) = &e.token else {
            return vec![self.tx(e.nonce, &self.evm.withdraw_to[2..], e.amount.0, [], &[])];
        };
        let amount = word(&e.amount.0.to_be_bytes());
        let allowed = e
            .approve
            .as_deref()
            .and_then(approve_word)
            .unwrap_or(amount);
        let approve = [word(&parse_eth_address(ROUTER)), allowed];
        let swap = [
            amount,
            word(&e.min_out.0.to_be_bytes()),
            word(&[0xa0]), // offset of the `path` array after the 5 head words
            word(&parse_eth_address(&self.evm.address[2..])),
            word(&e.deadline_s.to_be_bytes()),
            word(&[2]),
            word(&parse_eth_address(&token[2..])),
            word(&parse_eth_address(WETH)),
        ];
        vec![
            self.tx(e.nonce, &token[2..], 0, APPROVE_SELECTOR, &approve),
            self.tx(e.nonce + 1, ROUTER, 0, SELL_SELECTOR, &swap),
        ]
    }

    /// EIP-1559 transaction from the guard's EVM address: `to` without `0x`, calldata = selector and
    /// ABI words (no calldata if both are empty); gas and fees from the init.
    fn tx<const N: usize>(
        &self,
        nonce: u64,
        to: &str,
        value: u128,
        selector: [u8; N],
        words: &[[u8; 32]],
    ) -> EVMTransaction {
        let mut input = selector.to_vec();
        for w in words {
            input.extend_from_slice(w);
        }
        EVMTransaction {
            chain_id: CHAIN_ID,
            nonce,
            to: Some(parse_eth_address(to)),
            value,
            input,
            gas_limit: self.evm.gas_limit.into(),
            max_fee_per_gas: self.evm.max_fee_per_gas.0,
            max_priority_fee_per_gas: self.evm.max_priority_fee_per_gas.0,
            access_list: vec![],
        }
    }

    /// Gives back to the agent the price of a request left without a verdict after `VERDICT_TIMEOUT_NS`,
    /// and erases the request (its storage is no longer paid by anyone). The credit comes back,
    /// not the budget: a re-arming in between must not end up exceeded.
    pub fn refund_check(&mut self, id: u64) {
        let who = env::predecessor_account_id();
        let price = self.price;
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.agent == who, "check belongs to another agent");
        require!(check.verdict.is_none(), "verdict already posted");
        require!(!check.settled, "check already settled");
        require!(
            env::block_timestamp() >= check.requested_ns.0.saturating_add(VERDICT_TIMEOUT_NS),
            "timeout not reached"
        );
        let digest = check.decision_sha256.take(); // the decision backed nothing that happened
        let token = check.target.to_ascii_lowercase();
        if let Some(d) = digest {
            self.decisions.remove(&d);
        }
        if self.pending.get(&token) == Some(&id) {
            self.pending.remove(&token);
        }
        self.checks.remove(&id);
        self.escrow -= price;
        self.set_credit(&who, self.credit_of(&who).0 + price);
        emit(
            "check_refunded",
            &near_sdk::serde_json::json!({ "id": id, "agent": who }),
        );
    }

    #[must_use]
    pub fn get_check(&self, id: u64) -> Option<&Check> {
        self.checks.get(&id)
    }

    /// The check a decision digest backs (anchored by its `request_check` or its `buy`), if any.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn decision_of(&self, decision_sha256: String) -> Option<U64> {
        self.decisions
            .get(&decision_sha256.to_ascii_lowercase())
            .map(|&n| U64(n))
    }

    /// Anchors `decision`, if any, on check `id`: a digest already anchored is refused, so one signed
    /// decision backs one guard call.
    fn anchor(&mut self, decision: Option<&str>, id: u64) {
        let Some(d) = decision else { return };
        if let Some(n) = self.decisions.get(d) {
            env::panic_str(&format!("decision already anchored on check #{n}"));
        }
        self.decisions.insert(d.to_owned(), id);
    }

    /// Refunds to the caller all of their unused credit (the storage held at opening stays acquired).
    pub fn refund_credit(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let credit = self.credit_of(&who).0;
        require!(credit > 0, "no credit to refund");
        self.set_credit(&who, 0);
        Promise::new(who).transfer(NearToken::from_yoctonear(credit))
    }

    /// Owner only: withdraws collected fees, never more than their total, and never what the guard
    /// needs: the balance left must still pay for its storage (a check's price or a report's cost
    /// paid for some of it), every credit and the escrow.
    pub fn withdraw_fees(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.fees, "withdrawal exceeds collected fees");
        let needed = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear()
            + self.credits_total
            + self.escrow;
        let balance = env::account_balance().as_yoctonear();
        if balance < needed.saturating_add(amount.0) {
            env::panic_str(&format!(
                "withdrawal leaves less than storage, credits and escrow need: at most {} yoctoNEAR",
                balance.saturating_sub(needed).min(self.fees)
            ));
        }
        self.fees -= amount.0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Id of the last request (0 if none): the sentinel reads up to there.
    #[must_use]
    pub fn last_check_id(&self) -> u64 {
        self.next_id
    }

    #[must_use]
    pub fn fees(&self) -> U128 {
        U128(self.fees)
    }

    /// yoctoNEAR owned by nobody yet: prices of checks awaiting a verdict, charges of a signature in
    /// progress and of reserved (unsettled) transactions.
    #[must_use]
    pub fn escrow(&self) -> U128 {
        U128(self.escrow)
    }

    /// Sum of every account's credit: with `escrow` and the storage, what `withdraw_fees` never takes.
    #[must_use]
    pub fn credits_total(&self) -> U128 {
        U128(self.credits_total)
    }

    /// True while `account` is frozen by the owner's stop (`disarm`), until `unfreeze`.
    #[must_use]
    pub fn is_frozen(&self, account: &AccountId) -> bool {
        self.frozen.contains(account)
    }

    /// Block time of the owner's last stop of `account`: checks it requested until then never buy or
    /// sell. None if never stopped.
    #[must_use]
    pub fn stopped_at(&self, account: &AccountId) -> Option<U64> {
        self.stopped.get(account).map(|&ns| U64(ns))
    }

    /// Block time at which the signature in progress was requested; none when the slot is free.
    #[must_use]
    pub fn signing_since(&self) -> Option<U64> {
        self.signing.as_ref().map(|_| U64(self.signing_since_ns))
    }

    #[must_use]
    pub fn credit_of(&self, account: &AccountId) -> U128 {
        U128(self.credits.get(account).copied().unwrap_or(0))
    }

    /// Sum of the budgets armed for `account` still in the 7-day window, at block time.
    #[must_use]
    pub fn armed_7d(&self, account: &AccountId) -> U128 {
        U128(
            self.armings_in_window(account)
                .iter()
                .map(|&(_, b)| b)
                .sum(),
        )
    }

    /// Armings of `agent` still in the 7-day window, at block time.
    fn armings_in_window(&self, agent: &AccountId) -> Vec<(u64, u128)> {
        let mut log = self.armings.get(agent).cloned().unwrap_or_default();
        log.retain(|&(armed_ns, _)| in_window(armed_ns));
        log
    }

    #[must_use]
    pub fn budget_left(&self, account: &AccountId) -> U128 {
        U128(self.budgets.get(account).map_or(0, |b| b.remaining))
    }

    /// Debits `amount` from the armed budget (present, not expired, sufficient) and from `who`'s credit.
    fn debit(&mut self, who: &AccountId, amount: u128) {
        let Some(budget) = self.budgets.get(who).copied() else {
            env::panic_str("budget not armed")
        };
        require!(env::block_timestamp() < budget.expires_ns, "budget expired");
        require!(amount <= budget.remaining, "budget exceeded");
        self.debit_credit(who, amount);
        self.budgets.insert(
            who.clone(),
            Budget {
                remaining: budget.remaining - amount,
                ..budget
            },
        );
    }

    /// Debits `amount` from `who`'s credit alone: what an exit costs (a sale never needs buying budget).
    fn debit_credit(&mut self, who: &AccountId, amount: u128) {
        let credit = self.credit_of(who).0;
        require!(amount <= credit, "insufficient credit");
        self.set_credit(who, credit - amount);
    }

    /// Sets `who`'s credit, keeping `credits_total` the sum of every credit.
    fn set_credit(&mut self, who: &AccountId, amount: u128) {
        self.credits_total = self.credits_total - self.credit_of(who).0 + amount;
        self.credits.insert(who.clone(), amount);
    }

    /// False if `c` was requested before (or in the same block as) the owner's last stop of its agent.
    fn requested_since_stop(&self, c: &Check) -> bool {
        self.stopped
            .get(&c.agent)
            .is_none_or(|&stop| c.requested_ns.0 > stop)
    }

    /// Owner only: allows or revokes `account` as a reporter to the shared blocklist.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn set_reporter(&mut self, account: AccountId, allowed: bool) {
        self.assert_owner();
        if allowed {
            self.reporters.insert(account.clone());
        } else {
            self.reporters.remove(&account);
        }
        emit(
            "reporter_set",
            &near_sdk::serde_json::json!({ "account": account, "allowed": allowed }),
        );
    }

    /// Lists `token` on the shared blocklist with the sha256 of the evidence and a note; reporters
    /// registered by the owner only (a sentinel's votes list with the quorum). Tokens only: a code template is never listed,
    /// so copies of an honest token's code cannot get it blocked. The entry's storage is paid from the reporter's credit (`deposit_credit`),
    /// so a reporter spends its own deposit, never the contract's balance. An entry is never
    /// overwritten; only the owner removes one.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn report(&mut self, token: String, evidence_sha256: String, note: String) {
        let who = env::predecessor_account_id();
        require!(self.reporters.contains(&who), "reporter only");
        let map_key = token_key(&token);
        require!(
            evidence_sha256.len() == 64
                && evidence_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid evidence sha256: 64 lowercase hex digits"
        );
        require!(note.len() <= MAX_NOTE, "note too long");
        require!(!self.blocklist.contains_key(&map_key), "already listed");
        let cost = ENTRY_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear();
        let credit = self.credit_of(&who).0;
        require!(
            credit >= cost,
            "insufficient credit for the entry's storage"
        );
        self.set_credit(&who, credit - cost);
        self.fees += cost;
        let entry = Entry {
            reporter: who,
            at_ns: U64(env::block_timestamp()),
            evidence_sha256,
            note,
        };
        self.list(map_key, entry);
    }

    /// Owner only: removes an entry from the blocklist.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn unlist(&mut self, token: String) {
        self.assert_owner();
        let map_key = token_key(&token);
        require!(self.blocklist.remove(&map_key).is_some(), "not listed");
        emit(
            "unlisted",
            &near_sdk::serde_json::json!({ "token": map_key, "by": self.owner }),
        );
    }

    /// The blocklist entry of `token`, if listed.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn get_entry(&self, token: String) -> Option<&Entry> {
        self.blocklist.get(&token_key(&token))
    }

    /// A page of the blocklist, `limit` capped at `MAX_PAGE`: (token, lowercase, entry).
    /// Order is unspecified and changes after `unlist` (O(1) removal swaps the last entry in).
    #[must_use]
    pub fn list_entries(&self, from_index: u32, limit: u32) -> Vec<(String, &Entry)> {
        self.blocklist
            .iter()
            .skip(from_index as usize)
            .take(limit.min(MAX_PAGE) as usize)
            .map(|(k, e)| (k.clone(), e))
            .collect()
    }

    /// The code `target` had at its last verdict, and that verdict's check id.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn last_code(&self, target: String) -> Option<LastCode> {
        let id = *self.seen.get(&target.to_ascii_lowercase())?;
        let code = self.checks.get(&id)?.code.clone()?;
        Some(LastCode { id, code })
    }

    /// Tokens `agent` may still sell through `request_exit` (0 when none).
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn holding(&self, agent: AccountId, token: String) -> U128 {
        U128(self.held(&agent, &token))
    }

    /// Owner only: `token` is now held for `agent`, `amount` to sell (0 frees it for any agent).
    /// Undoes a lock no agent can lift: a credit whose buy reverted on Base, or an agent that never
    /// sells. Refused during a signature, whose callback may restore the seller's holding.
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn set_holding(&mut self, token: String, agent: AccountId, amount: U128) {
        self.assert_owner();
        require!(self.signing.is_none(), "a signature is already in progress");
        let key = token_key(&token);
        let previous = self.holdings.get(&key).cloned();
        self.set_held(&agent, &key, amount.0);
        emit(
            "holding_set",
            &near_sdk::serde_json::json!({
                "token": key, "agent": agent, "amount": amount,
                "previous": previous.map(|(a, n)| near_sdk::serde_json::json!({ "agent": a, "amount": U128(n) })),
            }),
        );
    }

    /// The transaction reserved at `nonce` whose signature did not come back, if any.
    #[must_use]
    pub fn get_unsettled(&self, nonce: u64) -> Option<&Unsettled> {
        self.unsettled.get(&nonce)
    }

    /// Owner only: settles the transaction reserved at `nonce`. `refund` once it can no longer be mined
    /// (the owner's replacement at that nonce was mined first; refused until a replacement is signed):
    /// the agent gets its charge back (its budget too if it is the same arming), an exit's tokens return
    /// to its holding, a buy's decision digest is freed. Otherwise its late signature was mined: the
    /// charge is spent. Event `unsettled_cleared`.
    pub fn clear_unsettled(&mut self, nonce: u64, refund: bool) {
        self.assert_owner();
        require!(self.signing.is_none(), "a signature is already in progress");
        let Some(u) = self.unsettled.remove(&nonce) else {
            env::panic_str("no unsettled transaction at this nonce")
        };
        require!(
            !refund || u.replaced,
            "no replacement signed at this nonce: sign_replacement first"
        );
        self.escrow -= u.cost.0;
        match (&u.agent, refund) {
            (Some(agent), true) => {
                self.refund(agent, u.cost.0, u.armed_until_ns.0);
                if let Some((token, amount)) = &u.restore {
                    require!(
                        self.holdings
                            .get(&token.to_ascii_lowercase())
                            .is_none_or(|(a, _)| a == agent),
                        "token held for another agent: set_holding first"
                    );
                    self.set_held(agent, token, self.held(agent, token) + amount.0);
                }
                let digest = u
                    .check
                    .and_then(|id| self.checks.get_mut(&id))
                    .filter(|c| c.exit_amount.is_none())
                    .and_then(|c| c.buy_decision_sha256.take());
                if let Some(d) = digest {
                    self.decisions.remove(&d);
                }
            }
            _ => self.fees += u.cost.0,
        }
        emit(
            "unsettled_cleared",
            &near_sdk::serde_json::json!({
                "nonce": nonce, "refund": refund, "agent": u.agent, "check": u.check, "cost": u.cost,
            }),
        );
    }

    /// Owner only: has NEAR sign 0 wei to `evm.withdraw_to` at `nonce`, reserved because its signature
    /// never came back (`unsettled`). It fills that nonce, so that later transactions can be mined, and
    /// once mined it voids a late MPC signature (if the base fee is above the guard's fees, raise them
    /// first, `set_evm_gas`). A transaction that was signed is never replaced: its agent was charged
    /// for it. The relay broadcasts it like any exit (`last_exit`); once signed, it is recorded on the
    /// reserved entry, which only then can be refunded.
    pub fn sign_replacement(&mut self, nonce: u64) -> Promise {
        self.assert_owner();
        require!(
            self.unsettled.contains_key(&nonce),
            "no unsettled transaction at this nonce: nothing to replace"
        );
        let exit = Exit {
            by: self.owner.clone(),
            token: None,
            amount: U128(0),
            min_out: U128(0),
            deadline_s: env::block_timestamp() / 1_000_000_000 + SWAP_DEADLINE_S,
            nonce,
            approve: None,
            signed_txs: vec![],
        };
        self.start_exit(exit, None)
    }

    /// Reserves the transaction at `nonce` whose signature did not come back (event `sign_unsettled`).
    fn reserve(&mut self, nonce: u64, u: Unsettled) {
        emit(
            "sign_unsettled",
            &near_sdk::serde_json::json!({
                "nonce": nonce, "id": u.check, "agent": u.agent, "cost": u.cost,
            }),
        );
        self.unsettled.insert(nonce, u);
    }

    /// Stores a blocklist entry under `token` (lowercase) and emits `listed`.
    fn list(&mut self, token: String, entry: Entry) {
        emit(
            "listed",
            &near_sdk::serde_json::json!({
                "token": token, "reporter": entry.reporter,
                "evidence_sha256": entry.evidence_sha256, "note": entry.note,
            }),
        );
        self.blocklist.insert(token, entry);
    }

    /// Gives `amount` back to `agent`'s credit, and to its budget if it is still the arming that
    /// was debited (`armed_until_ns`): a re-arming in between is never topped up.
    fn refund(&mut self, agent: &AccountId, amount: u128, armed_until_ns: u64) {
        if amount == 0 {
            return;
        }
        self.set_credit(agent, self.credit_of(agent).0 + amount);
        if let Some(budget) = self
            .budgets
            .get_mut(agent)
            .filter(|b| b.expires_ns == armed_until_ns)
        {
            budget.remaining += amount;
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

#[cfg(test)]
mod tests;
