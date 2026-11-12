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
    /// quorum or blocked, the call that decided votes already in, or the vote whose exit quote stands.
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
    /// True once the buy transaction is signed: a verdict is used only once.
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
    /// the next vote drops those of sentinels removed since (their `verdict_posted` events stay). On
    /// an exit quote, `quote`, `tx_hashes`, `reasons` and `evidence_sha256` are those of the highest
    /// `allow` posted.
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
/// (`MAX_SENTINELS` of them: 2,412 bytes measured on the buy path, 1,882 before either).
const CHECK_STORAGE_BYTES: u128 = 2450;
/// Validity duration of a verdict: the target can change (owner, proxy, liquidity),
/// so an old `allow` no longer pays; the agent asks for a new check.
pub const VERDICT_TTL_NS: u64 = 120 * 1_000_000_000;
pub const VERDICT_TIMEOUT_NS: u64 = 300 * 1_000_000_000;
/// A buy is signed only within this long of its check's request. The sentinel judges the state of the
/// reference block, 4 s after the request, however late its verdict comes (a flooded queue): the 120 s
/// of `VERDICT_TTL_NS` count from the verdict, this bound from the state judged.
pub const VERDICT_FRESH_NS: u64 = 180 * 1_000_000_000;
/// How long an agent's exit waits for the quorum's quotes: after it, one sentinel's quote is enough,
/// so a sentinel that is down delays an exit by this much and never refuses it. Until then a second
/// sentinel's higher quote can still replace a low one.
pub const EXIT_VOTES_WAIT_NS: u64 = 60 * 1_000_000_000;
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
/// the check's price. A check never holds more votes than there are sentinels: a buy check drops the
/// votes of sentinels removed since, an exit quote takes no more votes than there are sentinels.
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
    /// call whether to judge it (after a restart, every old check answers false): `sentinel` is one of
    /// the guard's, has not voted on it, the check is less than 300 s old and not signed, and
    /// - a buy check without a verdict: always (the next vote may decide it);
    /// - a buy check decided `allow` or `warn`: while a `block` can still stop its buy, 180 s from
    ///   its request and before it is sent to signing (any other vote is refused);
    /// - a buy check blocked, or an exit quote: while fewer votes than the quorum are in (listing
    ///   takes the quorum's blocks, an exit waits for the quorum's quotes).
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // near-sdk's JSON ABI requires an owned type
    pub fn vote_due(&self, id: u64, sentinel: AccountId) -> bool {
        let Some(c) = self.checks.get(&id) else {
            return false;
        };
        let within = |ns: u64| env::block_timestamp() < c.requested_ns.0.saturating_add(ns);
        if !self.sentinels.contains(&sentinel)
            || c.settled
            || c.votes.iter().any(|v| v.sentinel == sentinel)
            || !within(VERDICT_TIMEOUT_NS)
        {
            return false;
        }
        let exit = c.exit_amount.is_some();
        match c.verdict {
            None if !exit => true,
            Some(Verdict::Allow | Verdict::Warn) if !exit => {
                within(VERDICT_FRESH_NS) && !self.buying(id)
            }
            _ if exit => c.votes.len() < usize::from(self.quorum),
            _ => self.counted(c) < usize::from(self.quorum),
        }
    }

    /// True once exit quote `id` no longer waits for other sentinels' votes: the quorum's are in, or
    /// one is and 60 s have passed since the request. `sell_quoted` is refused until then; whether
    /// there is a quote to sell on is the check's verdict.
    #[must_use]
    pub fn exit_ready(&self, id: u64) -> bool {
        self.checks
            .get(&id)
            .is_some_and(|c| c.exit_amount.is_some() && self.exit_votes_in(c))
    }

    /// True once exit quote `c` has the quorum's votes, or one vote 60 s after its request.
    fn exit_votes_in(&self, c: &Check) -> bool {
        c.votes.len() >= usize::from(self.quorum)
            || (!c.votes.is_empty()
                && env::block_timestamp() >= c.requested_ns.0.saturating_add(EXIT_VOTES_WAIT_NS))
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

    /// A sentinel's vote on check `id`, one per sentinel: reasons, proof logged (event
    /// `verdict_posted`, one per vote), quote (tokens the guard's address received in its simulated buy
    /// of the check's amount, or ETH out of the simulated exit; also in the proof) required on an
    /// `allow`. `tx_hashes`: signing hashes of the transactions simulated from the guard's address,
    /// built by `preview_check`; only those are ever signed for this check.
    ///
    /// **A buy check.** Only the votes of the current sentinels count: a vote whose sentinel the owner
    /// removed is dropped here, and the quorum is the one in force now. `quorum` votes identical on the
    /// verdict, the quote, the transaction hashes, the code and `list_target` make an `allow` or a
    /// `warn`; each sentinel simulates the same reference block with the same derived draws, so honest
    /// ones agree (their evidence strings may differ, by the NEAR facts read at another moment: each
    /// sha256 is stored, none is compared). A single `block` vote blocks at once, and so does any
    /// disagreement. A `block` also overturns an `allow` or a `warn` already decided, until that buy is
    /// sent to signing. Every `block` vote that carries the token's code quarantines the token,
    /// whatever was decided before it. Listing a token takes the quorum, of identical `block` votes.
    ///
    /// **An exit quote.** Every sentinel may vote until the exit is sold. The quote that stands is the
    /// highest `allow` posted: a `block` never cancels another sentinel's quote, and a low quote never
    /// lowers the floor under another's. `sell_quoted` waits for the quorum's votes, or 60 s.
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
        // An exit quote takes votes until it is sold; a buy check until an allow or a warn is decided,
        // and then only a block, while its buy is not yet sent to signing.
        let open = if exit {
            !check.settled
        } else {
            before.is_none()
                || vetoed
                || (verdict == Verdict::Block && !check.settled && !self.buying(id))
        };
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
        let target = check.target.to_ascii_lowercase();
        // Code changed since the last verdict on this target: at most warn, the human decides.
        let mut unchanged = false;
        if !exit {
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
        let agreed = !exit && same && counted + 1 >= needed;
        // `rests`: the check now rests on this vote, its reasons and its evidence. `keeps`: its quote,
        // transactions, code and listing are this vote's.
        let (decided, rests, keeps) = if exit {
            let better = verdict == Verdict::Allow
                && (before != Some(Verdict::Allow) || quote.0 > check.quote.0);
            let rests = first || better;
            (if rests { Some(verdict) } else { before }, rests, rests)
        } else if vetoed || verdict == Verdict::Block || !same {
            // a veto (the first block vote), or a disagreement
            let veto = !vetoed && verdict == Verdict::Block;
            (Some(Verdict::Block), veto || (first && !vetoed), first)
        } else {
            (agreed.then_some(verdict), first, first)
        };
        let evidence_sha256 = hex(&env::sha256(evidence.as_bytes()));
        let sentinels = &self.sentinels;
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        if !exit {
            check.votes.retain(|v| sentinels.contains(&v.sentinel));
        }
        if keeps {
            check.quote = quote;
            check.code.clone_from(&code);
            check.tx_hashes.clone_from(&tx_hashes);
            check.list_target = list_target;
        }
        if rests {
            check.reasons.clone_from(&reasons);
            check.evidence_sha256.clone_from(&evidence_sha256);
        } else if !exit && !vetoed && !same {
            DISAGREE.clone_into(&mut check.reasons);
        }
        check.votes.push(Vote {
            sentinel: who.clone(),
            verdict,
            evidence_sha256: evidence_sha256.clone(),
        });
        let votes = check.votes.len();
        // The verdict's 120 s run from the vote that sets it, or that gives an exit its quote.
        if decided != before || (exit && rests) {
            check.verdict = decided;
            check.judged_ns = U64(env::block_timestamp());
        }
        // The price is earned once, by the first decision.
        let closes = before.is_none() && decided.is_some();
        if closes {
            self.escrow -= self.price;
            self.fees += self.price;
        }
        emit(
            "verdict_posted",
            &near_sdk::serde_json::json!({
                "id": id, "sentinel": who, "verdict": verdict, "reasons": reasons, "evidence": evidence,
                "quote": quote, "tx_hashes": tx_hashes, "list_target": list_target,
                "votes": votes, "quorum": needed, "decided": decided,
            }),
        );
        if exit {
            return; // an exit quote holds no slot, quarantines and lists nothing
        }
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

    /// Votes on `c` cast by sentinels of the current set, the only ones that count: a sentinel the
    /// owner removed (a stolen key) stops counting at once, on the checks it already voted on too.
    fn counted(&self, c: &Check) -> usize {
        c.votes
            .iter()
            .filter(|v| self.sentinels.contains(&v.sentinel))
            .count()
    }

    /// True while the guard has the buy of check `id` at the MPC: a signature requested is not recalled.
    fn buying(&self, id: u64) -> bool {
        matches!(&self.signing, Some(Job::Buy(p)) if p.id == id)
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
        let Some(check) = self
            .checks
            .get_mut(&id)
            .filter(|c| c.verdict.is_none() && c.exit_amount.is_none())
        else {
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
    /// for a token quarantined since (a later check blocked it), or beyond the owner's per-token cap,
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
    /// quote is the highest one posted, by current sentinels only, and it sells once the quorum's
    /// votes are in or 60 s after the request (`exit_ready`): a sentinel that is down delays an exit,
    /// one key alone neither refuses it nor sets its floor while another sentinel answers. The
    /// guard signs only the approve and swap the sentinel simulated (`tx_hashes`). Two transactions at
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
        // One key does not set the floor while another sentinel may still quote higher.
        require!(
            self.exit_votes_in(check),
            "exit quote awaits the other sentinels: it sells once the quorum voted, or 60 s after the request"
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
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken, PromiseResult};

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
        // Empty storage: a test that builds several guards would otherwise share their maps' prefixes,
        // and one guard's credits would not add up to another's `credits_total`.
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        ctx("guard.test", 0, 0);
        let mut g = Guard::new(
            id("owner.test"),
            id("armer.test"),
            id("sentinel.test"),
            U128(PRICE),
            evm(),
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

    // 6. buy signed by NEAR: the guard builds the swap for the request's target and has it
    // signed by the MPC; the agent chooses only the amount and the minimum tokens received.
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
    fn approve(g: &mut Guard, check: u64, now_ns: u64) {
        ctx("owner.test", 0, now_ns);
        g.approve_warn(check);
    }

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

    // 7. credit deposited by the human for the agent (its function-call key cannot attach anything)
    #[test]
    fn the_owner_credits_the_agent() {
        let g = funded(ONE_NEAR, 100 * U, 1);
        let credit = g.credit_of(&id("agent.test")).0;
        assert!(credit > 0 && credit < ONE_NEAR);
        assert_eq!(g.credit_of(&id("owner.test")).0, 0);
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

    // 10. price refund if the sentinel does not answer within the delay
    fn pending() -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 0);
        let check = g.request_check(TARGET.into(), U128(VALUE), None);
        (g, check)
    }

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

    // Exit signed by NEAR: approve(router, amount) then swapExactTokensForETHSupportingFeeOnTransferTokens
    // back to the guard's EVM address, two signatures, no verdict and no budget needed.
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
    const SALE_FLOOR_0_HASH: &str =
        "4e63831862f4e2d50eab33966eee2e53843bd3f8cea8c0d01f4ece43e71cf1d1";

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
                let v: near_sdk::serde_json::Value =
                    near_sdk::serde_json::from_slice(args).unwrap();
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

    // 14. code changed since the last check: at most warn, the human decides
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

    // 15. shared blocklist: reporters registered by the owner, evidence sha256 attached, storage paid
    // by the reporter's credit; every block verdict lists its target; buy refuses a listed target
    const SHA: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    /// sha256 of the empty string: the evidence posted by `verdict_on`.
    const SHA_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

    // 16. agent exits: the floor comes from a sentinel exit quote, the exit is charged to the armed
    // budget, and only a token the guard bought for that agent can be sold by it
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

    #[test]
    fn list_entries_caps_the_page_size() {
        let mut g = with_reporter(ONE_NEAR);
        for n in 0..=MAX_PAGE {
            report_as(&mut g, "reporter.test", &format!("0x{n:040x}"));
        }
        assert_eq!(g.list_entries(0, u32::MAX).len(), MAX_PAGE as usize);
    }

    // 19. A signature that does not come back stays reserved (red team, after the fifth judge run): the
    // MPC may still publish it after the yield timed out (its `respond` transaction is public), so its
    // nonce, its charge and the tokens it sells stay reserved until the owner settles it.
    /// viem 2.57: 0 wei to `WITHDRAW_TO` at nonce 0, unsigned: the owner's replacement of nonce 0.
    const REPLACE0_HASH: &str = "5e976a8b891cb75214771ef2f4bfe5ffdae48108d6a5963befe2ddac772411d5";

    /// The owner signs a replacement at the reserved `nonce` at `now_ns`, and its signature comes back.
    fn replaced(g: &mut Guard, nonce: u64, now_ns: u64) {
        ctx("owner.test", 0, now_ns);
        let _ = g.sign_replacement(nonce);
        assert_eq!(exit_signed(g, vec![ok_sig(SIG_A)]).len(), 1);
        ctx("owner.test", 0, now_ns);
    }

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
    #[should_panic(expected = "transaction differs from the one simulated")]
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
    #[should_panic(expected = "transaction differs from the one simulated")]
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

    // 21. Design review: sampling sales at drawn delays does not converge, so the contract bounds what
    // any wrong `allow` costs. A block is remembered (quarantine), one check per token awaits its
    // verdict (N parallel checks are not N draws), a rolling cap per token for all agents together, and a
    // buy only within 180 s of the check's request.
    const OTHER: &str = "0x000000000000000000000000000000000000c0de";

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
        // The second check's verdict, late, does not free the slot the third now holds.
        verdict_at(&mut g, second, Verdict::Allow, 800 + VERDICT_TIMEOUT_NS);
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

    // 22. Sentinel quorum: an allow or a warn takes `quorum` identical votes, any one sentinel blocks,
    // a disagreement blocks, listing takes the quorum (exit quotes: section 23).
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
                },
                Vote {
                    sentinel: id("sentinel2.test"),
                    verdict: Verdict::Allow,
                    evidence_sha256: sha("sentinel2.test"),
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

    // Votes in are never more than the sentinels: a change of the whole set drops the old ones.
    #[test]
    fn a_check_never_holds_more_votes_than_there_are_sentinels() {
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

    // Exit quotes under a quorum: one key neither refuses an exit another sentinel quotes, nor sets
    // its floor below that sentinel's quote.
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
        sell_quoted_at(&mut g, exit, 1100);
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
        sell_quoted_at(&mut g, exit, 1100);
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
        exit_vote(&mut g, "sentinel2.test", exit, Verdict::Block, 0, 1002);
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
        // an exit quote: every sentinel up to the quorum
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

    // 24. Refusals a coverage measurement found without a test.
    /// The message of the panic `f` ends in.
    fn panic_of(f: impl FnOnce()) -> String {
        let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("no panic");
        e.downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    }

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

    #[test]
    fn a_refund_leaves_the_slot_a_later_check_of_the_token_holds() {
        let (mut g, first) = pending(); // requested at 0, never judged
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        let second = g.request_check(TARGET.into(), U128(VALUE), None);
        g.refund_check(first);
        assert_eq!(g.pending_check(TARGET.into()), Some(second));
        assert!(g.get_check(first).is_none());
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
}
