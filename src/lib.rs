//! Garde de depense : l'agent signe avec une cle function-call limitee a ce
//! contrat ; le contrat tient son credit prepaye et son budget arme.
//! Trois roles : l'humain (owner) fixe les bornes, enregistre les agents et garde l'arret
//! d'urgence, l'armeur arme un agent enregistre dans ces bornes, l'agent achete. Chaque
//! armement, desarmement, gel et changement d'armeur est journalise.
//! L'achat sur Base est signe par NEAR (Chain Signatures) : la garde construit elle-meme la
//! transaction du swap pour la cible jugee `allow` et la fait signer par le contrat MPC.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::utils::parse_eth_address;
use omni_transaction::evm::EVMTransaction;

/// Achat sur Base : chain id, routeur Uniswap V2 et WETH fixes. Une transaction signee pour 8453
/// est valable sur Base reel.
pub const CHAIN_ID: u64 = 8453;
const ROUTER: &str = "4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const WETH: &str = "4200000000000000000000000000000000000006";
/// `swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)`
const SWAP_SELECTOR: [u8; 4] = [0xb6, 0xf9, 0xde, 0x95];
/// `approve(address,uint256)`
const APPROVE_SELECTOR: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)`
const SELL_SELECTOR: [u8; 4] = [0x79, 0x1a, 0xc9, 0x47];
/// Chemin de derivation Chain Signatures, fixe : l'adresse EVM ne depend que du compte de la garde.
pub const DERIVATION_PATH: &str = "evm-1";
/// Echeance courte du swap, comptee depuis la demande de signature (~10 s de signature, puis diffusion).
const SWAP_DEADLINE_S: u64 = 300;
/// Montant de l'achat simule par la sentinelle (0,01 ETH) : son devis est en jetons pour ce montant.
pub const QUOTE_WEI: u128 = 10_000_000_000_000_000;
/// Gaz reserve a `sign` (le MPC en exige 15 `TGas`) et au callback ; le reste du gaz attache par
/// l'agent leur est reparti.
const SIGN_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Reponse de `sign` lue au plus (environ 200 o attendus).
const MAX_SIGN_RESPONSE: usize = 1024;

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

/// Bornes fixees par l'humain pour tout armement. Nulles a l'init : aucun armement possible
/// tant que l'humain ne les a pas fixees.
#[near(serializers = [borsh, json])]
#[derive(Default)]
pub struct Bounds {
    pub max_budget: U128,
    pub max_duration_s: u64,
    /// Cumul des budgets armes pour un agent sur 7 jours glissants.
    pub max_7d: U128,
}

/// Une demande de verdict : la cible EVM, le verdict de la sentinelle et ses raisons.
#[near(serializers = [borsh, json])]
pub struct Check {
    pub agent: AccountId,
    pub target: String,
    pub requested_ns: U64,
    pub verdict: Option<Verdict>,
    /// Heure du bloc ou le verdict a ete poste (0 tant qu'il n'y en a pas).
    pub judged_ns: U64,
    pub reasons: String,
    /// sha256 (hexadecimal minuscule) de la chaine `evidence` recue avec le verdict, calcule par
    /// le contrat : lie la preuve journalisee au verdict stocke. Vide tant qu'il n'y a pas de verdict.
    pub evidence_sha256: String,
    /// Devis de la sentinelle : jetons recus par son achat simule de `QUOTE_WEI` (0 sans devis), lie
    /// a la preuve. La garde en tire le minimum de jetons du swap.
    pub quote: U128,
    /// Vrai une fois la transaction d'achat signee : un verdict ne sert qu'une fois.
    pub settled: bool,
    /// True once the owner approved this `warn` verdict (`approve_warn`): only then can it buy.
    pub approved: bool,
    /// Transaction EIP-1559 signee par le MPC pour cet achat (base64 en JSON), a diffuser sur Base.
    pub signed_tx: Option<Base64VecU8>,
    /// The target's code posted with the verdict (none for an exit quote or a fallback block).
    pub code: Option<Code>,
    /// An exit quote: tokens to sell (`request_exit`); the quote is then the ETH out, in wei.
    pub exit_amount: Option<U128>,
    /// sha256 (64 lowercase hex) of the attested LLM decision the agent anchored at `request_check`.
    pub decision_sha256: Option<String>,
    /// Same, as given to the `buy` that last asked for the signature (a retry overwrites it).
    pub buy_decision_sha256: Option<String>,
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

/// Parametres de l'achat EVM fixes par le proprietaire a l'init ; l'agent n'en choisit aucun.
#[near(serializers = [borsh, json])]
pub struct EvmConfig {
    /// Contrat Chain Signatures qui signe pour la garde (testnet : v1.signer-prod.testnet).
    pub mpc: AccountId,
    /// Adresse derivee de la garde et de `DERIVATION_PATH`, calculee hors chaine : signataire de
    /// la transaction et destinataire des jetons achetes.
    pub address: String,
    pub gas_limit: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    /// Taux fixe, sans oracle : yoctoNEAR debites du budget par wei signe (valeur et gaz au plafond).
    pub yocto_per_wei: U128,
    /// Glissement tolere sous le devis de la sentinelle, en points de base (300 = 3 %).
    pub max_slippage_bps: u16,
    /// The owner's EVM address: the only destination of `withdraw_eth`.
    pub withdraw_to: String,
}

/// Achat en attente de la signature du MPC.
#[near(serializers = [borsh])]
struct Pending {
    id: u64,
    agent: AccountId,
    target: String,
    value: u128,
    min_out: u128,
    deadline_s: u64,
    /// yoctoNEAR debites du credit et du budget, sous sequestre jusqu'au callback.
    cost: u128,
    /// Echeance de l'armement debite : un echec ne rend le budget qu'a ce meme armement.
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
    /// Signed transactions in nonce order (base64 in JSON); empty while signing.
    pub signed_txs: Vec<Base64VecU8>,
}

/// An agent's exit, charged like a buy: `per_tx` yoctoNEAR per transaction (gas at the cap, at the
/// fixed rate) in escrow until the callback, which keeps what was signed and refunds the rest.
#[near(serializers = [borsh])]
struct Charge {
    agent: AccountId,
    /// The exit quote used, settled once a transaction is signed.
    check: u64,
    per_tx: u128,
    armed_until_ns: u64,
}

/// What the single signature slot is waiting for.
#[near(serializers = [borsh])]
enum Job {
    Buy(Pending),
    /// An exit, and its charge when an agent asked for it (the owner's exits are not charged).
    Exit(Exit, Option<Charge>),
}

/// Reponse de `sign` du contrat MPC (domaine secp256k1).
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

/// Plafonds de taille : raisons stockees, preuve seulement journalisee (journal NEAR <= 16 Kio).
const MAX_REASONS: usize = 280;
const MAX_EVIDENCE: usize = 8_000;
/// Delai au-dela duquel l'agent recupere le prix d'une demande restee sans verdict.
/// Majorant du stockage d'une demande (cle 9 o, agent <= 64 o, cible 42 o, raisons <= 280 o,
/// empreinte 64 o, transaction signee <= 396 o, prefixes de longueur, 40 o de surcout par
/// entree), mesure au pire cas par un test. Le prix doit le couvrir, sinon chaque demande ronge
/// le solde du contrat. It also covers the code posted with the verdict, the target's `seen` record
/// and, on a `block`, the blocklist entry the verdict adds. Two exclusive worst cases (a block is
/// never bought): the block path, and the buy path with the signed tx, both decision hashes and the
/// agent's holdings entry.
const CHECK_STORAGE_BYTES: u128 = 1500;
/// Duree de validite d'un verdict : la cible peut changer (proprietaire, proxy, liquidite),
/// un `allow` ancien ne paie donc plus ; l'agent redemande un controle.
pub const VERDICT_TTL_NS: u64 = 120 * 1_000_000_000;
pub const VERDICT_TIMEOUT_NS: u64 = 300 * 1_000_000_000;
/// Fenetre du plafond glissant : un armement compte tant qu'il a moins de 7 jours.
const WEEK_NS: u64 = 7 * 24 * 3600 * 1_000_000_000;
/// Taille du journal glissant d'un agent. Une entree (heure du bloc u64, budget u128) occupe
/// 24 o payes par le contrat, pas par l'armeur : 32 entrees = 768 o (~0,008 NEAR) par agent au
/// plus, et un parcours de 32 elements par armement. Au-dela, l'armement est refuse : oublier une
/// entree encore dans la fenetre sous-compterait le cumul, et ne rien borner laisserait l'armeur
/// faire grossir le stockage du contrat sans fin (un budget de 1 yocto suffit a ajouter une entree).
const MAX_ARMINGS_7D: usize = 32;

/// Upper bound of one blocklist entry's storage (key `code:0x` + 64 hex, reporter <= 64 bytes, evidence
/// sha256, note <= `MAX_NOTE`, length prefixes, 40 bytes per record), measured by a test. A reporter's
/// credit pays it, so reporting cannot eat into the contract's balance.
const ENTRY_STORAGE_BYTES: u128 = 500;
/// Most entries `list_entries` returns per call.
const MAX_PAGE: u32 = 50;
/// Longest note on a blocklist entry.
const MAX_NOTE: usize = 140;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    /// Arme l'agent dans les bornes de l'humain ; ne fixe pas ces bornes.
    armer: AccountId,
    sentinel: AccountId,
    bounds: Bounds,
    price: u128,
    credits: LookupMap<AccountId, u128>,
    budgets: LookupMap<AccountId, Budget>,
    /// Armements de moins de 7 jours par agent : (heure du bloc, budget arme). Survit a `disarm`,
    /// sinon desarmer puis rearmer remettrait le plafond a zero.
    armings: LookupMap<AccountId, Vec<(u64, u128)>>,
    checks: LookupMap<u64, Check>,
    /// Agents enregistres par le proprietaire : seuls ceux-ci s'arment, l'armeur ne fait donc pas
    /// grossir le stockage du contrat (budget, journal) pour des comptes de son choix.
    agents: LookupSet<AccountId>,
    /// Agents geles par un desarmement du proprietaire : l'armeur ne peut plus les armer tant que
    /// le proprietaire ne les a pas degeles.
    frozen: LookupSet<AccountId>,
    /// Frais percus (verdicts rendus) et achats signes, payes au proprietaire qui finance l'adresse
    /// derivee en ETH ; comptes a part du credit des agents.
    fees: u128,
    /// Prix des demandes en attente de verdict et cout de l'achat en signature : ni a l'agent ni
    /// au proprietaire.
    escrow: u128,
    next_id: u64,
    evm: EvmConfig,
    /// Nonce EVM de l'adresse derivee : avance seulement quand une signature revient.
    evm_nonce: u64,
    /// Achat (or exit) en cours de signature. Un seul a la fois : une adresse, une suite de nonces ;
    /// un echec ne laisse donc pas de trou.
    signing: Option<Job>,
    /// Latest signed exit, overwritten by the next one (bounded storage); earlier ones stay in the
    /// `exit_signed` events.
    last_exit: Option<Exit>,
    /// Accounts the owner allows to `report` to the blocklist (the sentinel always may).
    reporters: LookupSet<AccountId>,
    /// Shared blocklist, keyed `token:0x..` or `code:0x..` (lowercase).
    blocklist: IterableMap<String, Entry>,
    /// Per target (lowercase), the check whose verdict saw its code last.
    seen: LookupMap<String, u64>,
    /// Tokens (lowercase) each agent may still sell, keyed `agent:token`: credited from the signed
    /// buy's `min_out`, reserved by `sell_quoted`. The guard's EVM address holds them all together.
    holdings: LookupMap<String, u128>,
}

/// Adresse EVM stricte : `0x` + 40 hexadecimaux (42 caracteres, pas un de plus).
fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// Holdings map key: the agent account (no `:` possible) and the lowercase token address.
fn holding_key(agent: &AccountId, token: &str) -> String {
    format!("{agent}:{}", token.to_ascii_lowercase())
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

/// Blocklist map key `kind:key`, key lowercase: `token` and an EVM address, or `code` and a code hash.
fn list_key(kind: &str, key: &str) -> String {
    let valid = match kind {
        "token" => is_evm_address(key),
        "code" => is_hash(key),
        _ => env::panic_str("invalid kind: token or code"),
    };
    require!(valid, "invalid key");
    format!("{kind}:{}", key.to_ascii_lowercase())
}

/// Signature EVM tiree de la reponse du MPC : r = `big_r` sans son octet de prefixe, v = `recovery_id`,
/// zeros de tete de r et s retires (entiers RLP canoniques). `None` si le format differe.
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

/// Minimum de jetons du swap : `quote` (pour `QUOTE_WEI`) ramene a `amount` wei, moins
/// `slippage_bps`, arrondi bas et sans debordement intermediaire. `None` si le resultat deborde.
fn min_out(quote: u128, amount: u128, slippage_bps: u16) -> Option<u128> {
    let expected = (quote / QUOTE_WEI)
        .checked_mul(amount)?
        .checked_add((quote % QUOTE_WEI).checked_mul(amount)? / QUOTE_WEI)?;
    let keep = u128::from(10_000 - slippage_bps);
    Some(expected / 10_000 * keep + expected % 10_000 * keep / 10_000)
}

/// Mot ABI de 32 octets, `bytes` cale a droite.
fn word(bytes: &[u8]) -> [u8; 32] {
    let mut w = [0; 32];
    w[32 - bytes.len()..].copy_from_slice(bytes);
    w
}

/// Vrai tant qu'un armement fait a `armed_ns` reste dans la fenetre de 7 jours (heure du bloc).
fn in_window(armed_ns: u64) -> bool {
    env::block_timestamp().saturating_sub(armed_ns) < WEEK_NS
}

/// Hexadecimal minuscule, sans prefixe `0x`.
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|b| [DIGITS[usize::from(b >> 4)], DIGITS[usize::from(b & 15)]])
        .map(char::from)
        .collect()
}

/// Evenement NEP-297 : `EVENT_JSON:` suivi d'un objet serialise (donc echappe).
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
    /// A appeler dans la transaction de deploiement (`with-init-call`) : l'appelant
    /// est alors le compte du contrat, et personne ne peut reinitialiser apres.
    /// `armer` peut etre `owner` : un humain seul tient alors les deux roles, au prix de la
    /// separation (celui qui fixe les bornes arme aussi), mais les bornes s'appliquent toujours.
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
        require!(
            evm.gas_limit > 0 && evm.yocto_per_wei.0 > 0,
            "zero gas limit or rate"
        );
        require!(
            evm.max_priority_fee_per_gas.0 <= evm.max_fee_per_gas.0,
            "priority fee above max fee"
        );
        require!(evm.max_slippage_bps < 10_000, "slippage of 100 % or more");
        require!(
            is_evm_address(&evm.withdraw_to),
            "invalid withdrawal address"
        );
        Self {
            owner,
            armer,
            sentinel,
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
            next_id: 0,
            evm,
            evm_nonce: 0,
            signing: None,
            last_exit: None,
            reporters: LookupSet::new(b"r"),
            blocklist: IterableMap::new(b"l"),
            seen: LookupMap::new(b"s"),
            holdings: LookupMap::new(b"h"),
        }
    }

    /// Credite `account_id` (par defaut l'appelant) du depot attache : l'humain finance
    /// l'agent, dont la cle function-call ne peut rien attacher.
    /// Un compte neuf paie le stockage de son entree, retenu sur le depot.
    #[payable]
    pub fn deposit_credit(&mut self, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "zero deposit");
        let previous = self.credits.get(&who).copied();
        let storage_cost = if previous.is_none() {
            let usage = env::storage_usage();
            self.credits.insert(who.clone(), 0); // meme taille que la valeur finale (u128)
            self.credits.flush();
            u128::from(env::storage_usage() - usage) * env::storage_byte_cost().as_yoctonear()
        } else {
            0
        };
        require!(amount > storage_cost, "deposit does not cover storage");
        self.credits
            .insert(who, previous.unwrap_or(0) + amount - storage_cost);
    }

    /// Reserve au proprietaire : bornes de tout armement a venir. Un budget deja arme n'est
    /// pas reduit : pour cela, `disarm`.
    pub fn set_bounds(&mut self, max_budget: U128, max_duration_s: u64, max_7d: U128) {
        self.assert_owner();
        self.bounds = Bounds {
            max_budget,
            max_duration_s,
            max_7d,
        };
    }

    #[must_use]
    pub fn bounds(&self) -> &Bounds {
        &self.bounds
    }

    /// Reserve au proprietaire : rend `agent` armable. Son stockage est paye par le contrat, au
    /// choix du proprietaire seul.
    pub fn register_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agents.insert(agent);
    }

    /// Reserve au proprietaire : remplace l'armeur (revocation d'un armeur compromis).
    pub fn set_armer(&mut self, armer: AccountId) {
        self.assert_owner();
        let previous = std::mem::replace(&mut self.armer, armer);
        emit(
            "armer_changed",
            &near_sdk::serde_json::json!({ "previous": previous, "armer": self.armer }),
        );
    }

    /// Reserve au proprietaire : leve le gel pose par son desarmement ; l'armeur peut rearmer.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn unfreeze(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(self.frozen.remove(&agent), "agent not frozen");
        emit("unfrozen", &near_sdk::serde_json::json!({ "agent": agent }));
    }

    /// Owner only: clears `agent`'s 7-day arming log. A compromised armer can fill the log or the
    /// 7-day cap and lock the agent out for a week; after `set_armer`, this restores service.
    /// The cleared armings no longer count toward the cap: the owner decides that, not the armer.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
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

    /// Reserve a l'armeur : arme `budget` pour `agent` pendant `duration_s` secondes, dans les
    /// bornes de l'humain et si le credit de l'agent vaut exactement `expected_credit` (controle
    /// d'integrite : l'armeur arme l'etat qu'il a lu). Rearmer remplace le budget courant.
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
        // Un agent jamais credite n'a pas d'entree : refuse meme avec `expected_credit` nul,
        // sinon l'armeur cree budget et journal pour n'importe quel compte, aux frais du contrat.
        require!(
            self.credits.get(&agent).copied() == Some(expected_credit.0),
            "integrity check failed: unexpected credit"
        );
        // Le budget arme compte en entier, meme non depense ; rearmer s'ajoute au cumul.
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

    /// Retire le budget arme de `agent` : arret d'urgence du proprietaire, qui gele aussi l'agent
    /// (l'armeur ne peut plus le rearmer avant `unfreeze`), ou arret anormal constate par l'armeur,
    /// sans gel. Purge le journal des armements sortis de la fenetre, et son entree s'il est vide.
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
            self.frozen.insert(agent);
        }
    }

    /// Debite le prix fixe du credit de l'appelant et du budget arme ; renvoie l'id de la demande.
    /// `target` doit etre une adresse EVM stricte (0x + 40 hexadecimaux).
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn request_check(&mut self, target: String, decision_sha256: Option<String>) -> u64 {
        let decision = decision_digest(decision_sha256);
        require!(
            is_evm_address(&target),
            "invalid target: expected 0x + 40 hex digits"
        );
        require!(
            !self.blocklist.contains_key(&list_key("token", &target)),
            "target is on the shared blocklist"
        );
        self.new_check(&target, None, decision.as_deref())
    }

    /// Exit quote for an agent: asks the sentinel what selling `amount` of the token bought by the
    /// agent's signed check `buy_id` yields (ETH, in wei). Priced like a check. Only a token the guard
    /// bought for this agent; a listed or changed token may still be quoted: the exit is never blocked.
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
        self.new_check(&target, Some(amount), None)
    }

    fn require_holding(&self, agent: &AccountId, token: &str, amount: u128) {
        let held = self
            .holdings
            .get(&holding_key(agent, token))
            .copied()
            .unwrap_or(0);
        require!(amount <= held, "exit amount above the agent's holding");
    }

    /// Debits the price from the caller and stores a new check of `target` (an exit quote with
    /// `exit_amount`); returns its id.
    fn new_check(
        &mut self,
        target: &str,
        exit_amount: Option<U128>,
        decision: Option<&str>,
    ) -> u64 {
        let who = env::predecessor_account_id();
        self.debit(&who, self.price);
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
                quote: U128(0),
                settled: false,
                approved: false,
                signed_tx: None,
                code: None,
                exit_amount,
                decision_sha256: decision.map(str::to_owned),
                buy_decision_sha256: None,
            },
        );
        emit(
            "check_requested",
            &near_sdk::serde_json::json!({
                "id": self.next_id, "agent": who, "target": target, "exit_amount": exit_amount,
                "decision_sha256": decision,
            }),
        );
        self.next_id
    }

    /// Reserve a la sentinelle : un verdict par demande, raisons stockees, preuve journalisee, devis
    /// (jetons recus par l'achat simule de `QUOTE_WEI`, aussi dans la preuve) exige sur un `allow`.
    #[allow(clippy::needless_pass_by_value, clippy::too_many_arguments)] // l'ABI JSON de near-sdk exige un type possede
    pub fn post_verdict(
        &mut self,
        id: u64,
        verdict: Verdict,
        reasons: String,
        evidence: String,
        quote: U128,
        code: Option<Code>,
        list_target: bool,
    ) {
        require!(
            env::predecessor_account_id() == self.sentinel,
            "sentinel only"
        );
        require!(reasons.len() <= MAX_REASONS, "reasons too long");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence too long");
        require!(
            verdict != Verdict::Allow || quote.0 > 0,
            "allow without a quote"
        );
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.verdict.is_none(), "verdict already posted");
        require!(!check.settled, "check already settled");
        let target = check.target.to_ascii_lowercase();
        let exit = check.exit_amount.is_some();
        let code = code.map(|c| {
            require!(is_hash(&c.code_hash), "invalid code hash");
            require!(
                c.implementation.as_deref().is_none_or(is_evm_address),
                "invalid implementation"
            );
            Code {
                code_hash: c.code_hash.to_ascii_lowercase(),
                implementation: c.implementation.map(|i| i.to_ascii_lowercase()),
            }
        });
        // Code changed since the last verdict on this target: at most warn, the human decides.
        if !exit {
            if let Some(code) = &code {
                let unchanged = self
                    .seen
                    .get(&target)
                    .and_then(|last| self.checks.get(last))
                    .and_then(|c| c.code.as_ref())
                    .is_none_or(|p| p == code);
                require!(
                    verdict != Verdict::Allow || unchanged,
                    "code changed since the last check: at most warn"
                );
                // The reference moves only to the same code (or to the first code seen); on changed
                // code, only the owner's `approve_warn` moves it.
                if unchanged {
                    self.seen.insert(target.clone(), id);
                }
            } else {
                require!(
                    verdict == Verdict::Block,
                    "allow or warn without the target's code"
                );
            }
        }
        let has_code = code.is_some();
        let evidence_sha256 = hex(&env::sha256(evidence.as_bytes()));
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        check.verdict = Some(verdict);
        check.judged_ns = U64(env::block_timestamp());
        check.reasons.clone_from(&reasons);
        check.evidence_sha256.clone_from(&evidence_sha256);
        check.quote = quote;
        check.code = code;
        self.escrow -= self.price;
        self.fees += self.price;
        emit(
            "verdict_posted",
            &near_sdk::serde_json::json!({
                "id": id, "verdict": verdict, "reasons": reasons, "evidence": evidence, "quote": quote,
            }),
        );
        // Only a block of a buy check that rests on the target's code, and that the sentinel asks to
        // list, lists its target (never the fail-closed fallback, nor a reputation-only block), unless
        // already listed (the first entry stays).
        let key = format!("token:{target}");
        if verdict == Verdict::Block
            && !exit
            && has_code
            && list_target
            && !self.blocklist.contains_key(&key)
        {
            let entry = Entry {
                reporter: self.sentinel.clone(),
                at_ns: U64(env::block_timestamp()),
                evidence_sha256,
                note: format!("verdict #{id}"),
            };
            self.list(key, entry);
        }
    }

    /// Achat sur Base signe par NEAR, sur un verdict `allow` non perime de cette demande : la garde
    /// construit le swap WETH -> cible de la demande sur le routeur Uniswap V2, jetons vers son
    /// adresse derivee, et en demande la signature au MPC (1 yoctoNEAR pris sur son solde). L'agent
    /// ne choisit que la valeur en wei ; le minimum de jetons vient du devis de la sentinelle, moins
    /// le glissement tolere. Le budget arme et le credit sont debites de la valeur plus le gaz au
    /// plafond, au taux fixe du proprietaire.
    pub fn buy(&mut self, id: u64, amount_wei: U128, decision_sha256: Option<String>) -> Promise {
        let decision = decision_digest(decision_sha256);
        require!(self.signing.is_none(), "a signature is already in progress");
        let who = env::predecessor_account_id();
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
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        require!(
            check.exit_amount.is_none(),
            "an exit quote is not a buy verdict"
        );
        require!(
            !self
                .blocklist
                .contains_key(&list_key("token", &check.target)),
            "target is on the shared blocklist"
        );
        require!(amount_wei.0 > 0, "zero amount");
        let target = check.target.clone();
        let Some(min_out) = min_out(check.quote.0, amount_wei.0, self.evm.max_slippage_bps) else {
            env::panic_str("amount too large")
        };
        require!(min_out > 0, "minimum output rounds to zero");
        let Some(cost) = u128::from(self.evm.gas_limit)
            .checked_mul(self.evm.max_fee_per_gas.0)
            .and_then(|gas| gas.checked_add(amount_wei.0))
            .and_then(|wei| wei.checked_mul(self.evm.yocto_per_wei.0))
        else {
            env::panic_str("amount too large")
        };
        self.debit(&who, cost);
        self.escrow += cost;
        let pending = Pending {
            id,
            agent: who.clone(),
            target,
            value: amount_wei.0,
            min_out,
            deadline_s: env::block_timestamp() / 1_000_000_000 + SWAP_DEADLINE_S,
            cost,
            armed_until_ns: self.budgets.get(&who).map_or(0, |b| b.expires_ns),
        };
        let tx = self.swap_tx(&pending);
        let hash = hex(&env::keccak256_array(tx.build_for_signing()));
        emit(
            "sign_requested",
            &near_sdk::serde_json::json!({
                "id": id, "agent": who, "target": pending.target, "amount_wei": amount_wei,
                "min_out": U128(min_out), "nonce": self.evm_nonce, "hash": hash,
                "decision_sha256": decision,
            }),
        );
        if let Some(check) = self.checks.get_mut(&id) {
            check.buy_decision_sha256 = decision;
        }
        self.signing = Some(Job::Buy(pending));
        self.sign_all(
            &[tx],
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_signed(),
        )
    }

    /// The owner's exit, signed by NEAR: sells `amount` of `token` held by the guard's EVM address
    /// for ETH, back to that address (approve of the router, then the swap: two signatures, two
    /// nonces). No verdict, no quote, no budget, any token, listed or not, frozen agent or not: the
    /// human can always get out. `min_out_wei` is the owner's own floor. Agents use `sell_quoted`.
    pub fn sell(&mut self, token: String, amount: U128, min_out_wei: U128) -> Promise {
        self.assert_owner();
        require!(
            is_evm_address(&token),
            "invalid token: expected 0x + 40 hex digits"
        );
        require!(amount.0 > 0, "zero amount");
        self.start_exit(self.owner.clone(), Some(token), amount, min_out_wei, None)
    }

    /// An agent's exit on the sentinel's exit quote `id` (`request_exit`), within 120 s of it, once:
    /// the floor is the quoted ETH out minus the owner's slippage bound, never the agent's choice. Two
    /// transactions at the gas cap are charged to the armed budget and credit, like a buy; never
    /// refused because the token was listed or its code changed.
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
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        let Some(floor) = min_out(check.quote.0, QUOTE_WEI, self.evm.max_slippage_bps) else {
            env::panic_str("quote too large")
        };
        require!(floor > 0, "minimum output rounds to zero");
        let token = check.target.clone();
        self.require_holding(&who, &token, amount.0);
        let Some(per_tx) = u128::from(self.evm.gas_limit)
            .checked_mul(self.evm.max_fee_per_gas.0)
            .and_then(|wei| wei.checked_mul(self.evm.yocto_per_wei.0))
        else {
            env::panic_str("gas cost too large")
        };
        let Some(cost) = per_tx.checked_mul(2) else {
            env::panic_str("gas cost too large")
        };
        self.debit(&who, cost);
        self.escrow += cost;
        // Reserve the tokens until the exit is signed (restored in `on_exit_signed` otherwise).
        let key = holding_key(&who, &token);
        let held = self.holdings.get(&key).copied().unwrap_or(0);
        self.holdings.insert(key, held - amount.0);
        let charge = Charge {
            agent: who.clone(),
            check: id,
            per_tx,
            armed_until_ns: self.budgets.get(&who).map_or(0, |b| b.expires_ns),
        };
        self.start_exit(who, Some(token), amount, U128(floor), Some(charge))
    }

    /// Owner only: sends `amount_wei` from the guard's EVM address to `evm.withdraw_to`, fixed at
    /// init. One signature.
    pub fn withdraw_eth(&mut self, amount_wei: U128) -> Promise {
        self.assert_owner();
        require!(amount_wei.0 > 0, "zero amount");
        self.start_exit(self.owner.clone(), None, amount_wei, U128(0), None)
    }

    fn start_exit(
        &mut self,
        by: AccountId,
        token: Option<String>,
        amount: U128,
        min_out: U128,
        charge: Option<Charge>,
    ) -> Promise {
        require!(self.signing.is_none(), "a signature is already in progress");
        let exit = Exit {
            by,
            token,
            amount,
            min_out,
            deadline_s: env::block_timestamp() / 1_000_000_000 + SWAP_DEADLINE_S,
            nonce: self.evm_nonce,
            signed_txs: vec![],
        };
        let txs = self.exit_txs(&exit);
        let hashes: Vec<String> = txs
            .iter()
            .map(|tx| hex(&env::keccak256_array(tx.build_for_signing())))
            .collect();
        emit(
            "exit_requested",
            &near_sdk::serde_json::json!({
                "by": exit.by, "token": exit.token, "amount": exit.amount, "min_out": exit.min_out,
                "nonce": exit.nonce, "hashes": hashes, "check": charge.as_ref().map(|c| c.check),
            }),
        );
        self.signing = Some(Job::Exit(exit, charge));
        self.sign_all(
            &txs,
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_exit_signed(),
        )
    }

    /// One `sign` call to the MPC per transaction (1 yoctoNEAR each, from the guard's balance),
    /// joined, then `callback`.
    fn sign_all(&self, txs: &[EVMTransaction], callback: Promise) -> Promise {
        let sign = |tx: &EVMTransaction| {
            let hash = hex(&env::keccak256_array(tx.build_for_signing()));
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

    /// Callback of an exit's `sign` calls: keeps the signed transactions up to the first missing
    /// signature (nonces stay contiguous: a swap without its approve is dropped), advances the
    /// nonce by that many and stores them as `last_exit`. Never panics after taking the job.
    #[private]
    pub fn on_exit_signed(&mut self) -> Vec<String> {
        let Some(Job::Exit(mut exit, charge)) = self.signing.take() else {
            env::panic_str("no exit signature in progress")
        };
        let txs = self.exit_txs(&exit);
        let mut signed = vec![];
        for (i, tx) in (0u64..).zip(txs.iter()) {
            let signature = env::promise_result_checked(i, MAX_SIGN_RESPONSE)
                .ok()
                .and_then(|bytes| parse_signature(&bytes));
            let Some(signature) = signature else { break };
            signed.push(tx.build_with_signature(&signature));
        }
        let hexes: Vec<String> = signed.iter().map(|raw| format!("0x{}", hex(raw))).collect();
        emit(
            "exit_signed",
            &near_sdk::serde_json::json!({
                "by": exit.by, "token": exit.token, "amount": exit.amount, "nonce": exit.nonce, "txs": hexes,
            }),
        );
        self.evm_nonce += signed.len() as u64;
        if let Some(c) = charge {
            let (all, done) = (txs.len() as u128, signed.len() as u128);
            self.escrow -= c.per_tx * all;
            self.fees += c.per_tx * done;
            self.refund(&c.agent, c.per_tx * (all - done), c.armed_until_ns);
            // The swap is the last transaction: not signed, the tokens are still the agent's.
            if let (Some(token), true) = (&exit.token, done < all) {
                let key = holding_key(&c.agent, token);
                let held = self.holdings.get(&key).copied().unwrap_or(0);
                self.holdings.insert(key, held + exit.amount.0);
            }
            if let Some(check) = self.checks.get_mut(&c.check).filter(|_| done > 0) {
                check.settled = true;
            }
        }
        if !signed.is_empty() {
            exit.signed_txs = signed.into_iter().map(Into::into).collect();
            self.last_exit = Some(exit);
        }
        hexes
    }

    /// Latest signed exit (sale or withdrawal), for the relay.
    #[must_use]
    pub fn last_exit(&self) -> Option<&Exit> {
        self.last_exit.as_ref()
    }

    /// EVM parameters fixed at init: derived address, withdrawal address, gas, fees, rate.
    #[must_use]
    pub fn evm_config(&self) -> &EvmConfig {
        &self.evm
    }

    /// Owner only: approves a `warn` verdict so the agent may buy on it. The approval does not
    /// extend the verdict: it must come, and the purchase too, within `VERDICT_TTL_NS` of the
    /// verdict, because what the human approves is that simulation, and it ages the same.
    pub fn approve_warn(&mut self, id: u64) {
        self.assert_owner();
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.verdict == Some(Verdict::Warn), "not a warn verdict");
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

    /// Callback de `sign` : assemble la transaction signee, la stocke avec la demande et renvoie
    /// son hexadecimal. Sans signature lisible, rien n'est diffusable : le credit revient, le budget
    /// aussi s'il s'agit du meme armement, le nonce reste libre. Ne panique pas apres avoir repris
    /// l'achat en attente : un echec ici garderait le verrou pour toujours.
    #[private]
    pub fn on_signed(&mut self) -> Option<String> {
        let Some(Job::Buy(p)) = self.signing.take() else {
            env::panic_str("no signature in progress")
        };
        self.escrow -= p.cost;
        let signature = env::promise_result_checked(0, MAX_SIGN_RESPONSE)
            .ok()
            .and_then(|bytes| parse_signature(&bytes));
        let Some(signature) = signature else {
            self.refund(&p.agent, p.cost, p.armed_until_ns);
            emit(
                "sign_failed",
                &near_sdk::serde_json::json!({ "id": p.id, "agent": p.agent }),
            );
            return None;
        };
        let raw = self.swap_tx(&p).build_with_signature(&signature);
        let tx = format!("0x{}", hex(&raw));
        emit(
            "signed",
            &near_sdk::serde_json::json!({
                "id": p.id, "agent": p.agent, "target": p.target, "nonce": self.evm_nonce, "tx": tx,
            }),
        );
        self.evm_nonce += 1;
        self.fees += p.cost;
        let key = holding_key(&p.agent, &p.target);
        let held = self.holdings.get(&key).copied().unwrap_or(0);
        self.holdings.insert(key, held.saturating_add(p.min_out));
        if let Some(check) = self.checks.get_mut(&p.id) {
            check.settled = true;
            check.signed_tx = Some(raw.into());
        }
        Some(tx)
    }

    /// Transaction EIP-1559 du swap WETH -> `p.target` sur le routeur, jetons vers l'adresse
    /// derivee, au nonce courant ; tous les champs viennent de la garde.
    fn swap_tx(&self, p: &Pending) -> EVMTransaction {
        let words = [
            word(&p.min_out.to_be_bytes()),
            word(&[0x80]), // position du tableau `path` apres les 4 mots de tete
            word(&parse_eth_address(&self.evm.address[2..])),
            word(&p.deadline_s.to_be_bytes()),
            word(&[2]),
            word(&parse_eth_address(WETH)),
            word(&parse_eth_address(&p.target[2..])),
        ];
        self.tx(self.evm_nonce, ROUTER, p.value, SWAP_SELECTOR, &words)
    }

    /// The exit's transactions from `e.nonce`: approve then swap for a sale, the transfer for a
    /// withdrawal.
    fn exit_txs(&self, e: &Exit) -> Vec<EVMTransaction> {
        let Some(token) = &e.token else {
            return vec![self.tx(e.nonce, &self.evm.withdraw_to[2..], e.amount.0, [], &[])];
        };
        let amount = word(&e.amount.0.to_be_bytes());
        let approve = [word(&parse_eth_address(ROUTER)), amount];
        let swap = [
            amount,
            word(&e.min_out.0.to_be_bytes()),
            word(&[0xa0]), // position du tableau `path` apres les 5 mots de tete
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

    /// Rend a l'agent le prix d'une demande restee sans verdict apres `VERDICT_TIMEOUT_NS`,
    /// et efface la demande (son stockage n'est plus paye par personne). Le credit revient,
    /// pas le budget : un rearmement entre-temps ne doit pas se retrouver depasse.
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
        self.checks.remove(&id);
        self.escrow -= price;
        let credit = self.credit_of(&who).0;
        self.credits.insert(who.clone(), credit + price);
        emit(
            "check_refunded",
            &near_sdk::serde_json::json!({ "id": id, "agent": who }),
        );
    }

    #[must_use]
    pub fn get_check(&self, id: u64) -> Option<&Check> {
        self.checks.get(&id)
    }

    /// Rembourse a l'appelant tout son credit inutilise (le stockage retenu a l'ouverture reste acquis).
    pub fn refund_credit(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let credit = self.credit_of(&who).0;
        require!(credit > 0, "no credit to refund");
        self.credits.insert(who.clone(), 0);
        Promise::new(who).transfer(NearToken::from_yoctonear(credit))
    }

    /// Reserve au proprietaire : retire des frais percus, jamais plus que leur total.
    pub fn withdraw_fees(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.fees, "withdrawal exceeds collected fees");
        self.fees -= amount.0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Id de la derniere demande (0 si aucune) : la sentinelle lit jusque-la.
    #[must_use]
    pub fn last_check_id(&self) -> u64 {
        self.next_id
    }

    #[must_use]
    pub fn fees(&self) -> U128 {
        U128(self.fees)
    }

    #[must_use]
    pub fn credit_of(&self, account: &AccountId) -> U128 {
        U128(self.credits.get(account).copied().unwrap_or(0))
    }

    /// Cumul des budgets armes pour `account` encore dans la fenetre de 7 jours, a l'heure du bloc.
    #[must_use]
    pub fn armed_7d(&self, account: &AccountId) -> U128 {
        U128(
            self.armings_in_window(account)
                .iter()
                .map(|&(_, b)| b)
                .sum(),
        )
    }

    /// Armements de `agent` encore dans la fenetre de 7 jours, a l'heure du bloc.
    fn armings_in_window(&self, agent: &AccountId) -> Vec<(u64, u128)> {
        let mut log = self.armings.get(agent).cloned().unwrap_or_default();
        log.retain(|&(armed_ns, _)| in_window(armed_ns));
        log
    }

    #[must_use]
    pub fn budget_left(&self, account: &AccountId) -> U128 {
        U128(self.budgets.get(account).map_or(0, |b| b.remaining))
    }

    /// Debite `amount` du budget arme (present, non echu, suffisant) et du credit de `who`.
    fn debit(&mut self, who: &AccountId, amount: u128) {
        let Some(budget) = self.budgets.get(who).copied() else {
            env::panic_str("budget not armed")
        };
        require!(env::block_timestamp() < budget.expires_ns, "budget expired");
        require!(amount <= budget.remaining, "budget exceeded");
        let credit = self.credit_of(who).0;
        require!(amount <= credit, "insufficient credit");
        self.credits.insert(who.clone(), credit - amount);
        self.budgets.insert(
            who.clone(),
            Budget {
                remaining: budget.remaining - amount,
                ..budget
            },
        );
    }

    /// Owner only: allows or revokes `account` as a reporter to the shared blocklist.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
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

    /// Lists `key` (`kind` `token`: an EVM address, `code`: a code template hash) on the shared
    /// blocklist with the sha256 of the evidence and a note; reporters registered by the owner and
    /// the sentinel only. The entry's storage is paid from the reporter's credit (`deposit_credit`),
    /// so a reporter spends its own deposit, never the contract's balance. An entry is never
    /// overwritten; only the owner removes one.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn report(&mut self, kind: String, key: String, evidence_sha256: String, note: String) {
        let who = env::predecessor_account_id();
        require!(
            who == self.sentinel || self.reporters.contains(&who),
            "reporter only"
        );
        let map_key = list_key(&kind, &key);
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
        self.credits.insert(who.clone(), credit - cost);
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
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn unlist(&mut self, kind: String, key: String) {
        self.assert_owner();
        let map_key = list_key(&kind, &key);
        require!(self.blocklist.remove(&map_key).is_some(), "not listed");
        emit(
            "unlisted",
            &near_sdk::serde_json::json!({
                "kind": kind, "key": key.to_ascii_lowercase(), "by": self.owner,
            }),
        );
    }

    /// The blocklist entry of `key` (`kind` `token` or `code`), if listed.
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn get_entry(&self, kind: String, key: String) -> Option<&Entry> {
        self.blocklist.get(&list_key(&kind, &key))
    }

    /// A page of the blocklist, `limit` capped at `MAX_PAGE`: (`token:0x..` or `code:0x..`, entry).
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
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn last_code(&self, target: String) -> Option<LastCode> {
        let id = *self.seen.get(&target.to_ascii_lowercase())?;
        let code = self.checks.get(&id)?.code.clone()?;
        Some(LastCode { id, code })
    }

    /// Tokens `agent` may still sell through `request_exit` (0 when none).
    #[must_use]
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn holding(&self, agent: AccountId, token: String) -> U128 {
        U128(
            self.holdings
                .get(&holding_key(&agent, &token))
                .copied()
                .unwrap_or(0),
        )
    }

    /// Stores a blocklist entry under `map_key` (`kind:key`) and emits `listed`.
    fn list(&mut self, map_key: String, entry: Entry) {
        let (kind, key) = map_key.split_once(':').unwrap_or_default();
        emit(
            "listed",
            &near_sdk::serde_json::json!({
                "kind": kind, "key": key, "reporter": entry.reporter,
                "evidence_sha256": entry.evidence_sha256, "note": entry.note,
            }),
        );
        self.blocklist.insert(map_key, entry);
    }

    /// Gives `amount` back to `agent`'s credit, and to its budget if it is still the arming that
    /// was debited (`armed_until_ns`): a re-arming in between is never topped up.
    fn refund(&mut self, agent: &AccountId, amount: u128, armed_until_ns: u64) {
        if amount == 0 {
            return;
        }
        let credit = self.credit_of(agent).0;
        self.credits.insert(agent.clone(), credit + amount);
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

    /// Unite des montants de test : PRICE = 0,015 NEAR, assez pour le stockage d'une demande.
    const U: u128 = 1_000_000_000_000_000_000_000;
    const PRICE: u128 = 15 * U;
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const SEC: u64 = 1_000_000_000;
    const TARGET: &str = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    /// Adresse de la cle privee 0x00..01 : tient lieu d'adresse derivee dans les vecteurs viem.
    const ADDR: &str = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const RATE: u128 = 1_000_000_000; // yoctoNEAR par wei : 1 ETH = 1000 NEAR
    /// Devis de la sentinelle : jetons recus par l'achat simule de 0,01 ETH (USDC sur le fork).
    const QUOTE: u128 = 20_435_000;
    /// The owner's EVM address for ETH withdrawals, fixed at init.
    const WITHDRAW_TO: &str = "0x000000000000000000000000000000000000bEEF";

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

    /// Gaz 250 000 a 0,05 gwei au plus, pourboire 0,001 gwei.
    fn evm() -> EvmConfig {
        EvmConfig {
            mpc: id("mpc.test"),
            address: ADDR.into(),
            gas_limit: 250_000,
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
        ctx("guard.test", 0, 0);
        Guard::new(
            id("owner.test"),
            id("armer.test"),
            id("sentinel.test"),
            U128(PRICE),
            evm(),
        )
    }

    fn last_event() -> near_sdk::serde_json::Value {
        let log = get_logs().pop().unwrap();
        let json = log.strip_prefix("EVENT_JSON:").expect("prefixe NEP-297");
        near_sdk::serde_json::from_str(json).unwrap()
    }

    /// Tous les evenements NEP-297 de l'appel courant, dans l'ordre.
    fn events() -> Vec<near_sdk::serde_json::Value> {
        get_logs()
            .iter()
            .map(|log| {
                let json = log.strip_prefix("EVENT_JSON:").expect("prefixe NEP-297");
                near_sdk::serde_json::from_str(json).unwrap()
            })
            .collect()
    }

    /// L'humain fixe les bornes, enregistre l'agent puis depose `credit` pour lui ; rien n'est arme.
    fn credited(credit: u128, max_budget: u128, max_duration_s: u64, max_7d: u128) -> Guard {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(max_budget), max_duration_s, U128(max_7d));
        g.register_agent(id("agent.test"));
        ctx("owner.test", credit, 0);
        g.deposit_credit(Some(id("agent.test")));
        g
    }

    /// Credit depose par le proprietaire pour l'agent, budget arme par l'armeur pour `secs`
    /// secondes, dans des bornes larges (100 U par armement, 1000 s, 1000 U sur 7 jours).
    fn funded(credit: u128, budget: u128, secs: u64) -> Guard {
        let mut g = credited(credit, 100 * U, 1000, 1000 * U);
        arm_at(&mut g, budget, secs, 0);
        g
    }

    /// L'armeur arme `agent.test` a l'heure de bloc `now_ns`, en attendant le credit qu'il lit.
    fn arm_at(g: &mut Guard, budget: u128, secs: u64, now_ns: u64) {
        ctx("armer.test", 0, now_ns);
        let credit = g.credit_of(&id("agent.test"));
        g.arm(id("agent.test"), U128(budget), secs, credit);
    }

    #[test]
    fn deposit_credit_credite_le_compte() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit(None);
        let first = g.credit_of(&id("agent.test")).0;
        assert!(first > 0 && first < ONE_NEAR); // depot moins le stockage du compte neuf
        ctx("agent.test", 25, 0);
        g.deposit_credit(None);
        assert_eq!(g.credit_of(&id("agent.test")).0, first + 25);
        assert_eq!(g.credit_of(&id("autre.test")).0, 0);
    }

    #[test]
    fn request_check_debite_le_prix_fixe() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        let before = g.credit_of(&id("agent.test")).0;
        ctx("agent.test", 0, 500);
        assert_eq!(g.request_check(TARGET.into(), None), 1);
        assert_eq!(g.credit_of(&id("agent.test")).0, before - PRICE);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE);
    }

    #[test]
    #[should_panic(expected = "insufficient credit")]
    fn request_check_refuse_sans_credit_suffisant() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 0);
        let _ = g.refund_credit(); // credit a zero
        arm_at(&mut g, 100 * U, 1, 0);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    #[should_panic(expected = "budget expired")]
    fn depense_refusee_apres_l_echeance() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, SEC);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    #[should_panic(expected = "budget exceeded")]
    fn depense_refusee_au_dela_du_budget() {
        let mut g = funded(ONE_NEAR, 15 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    #[should_panic(expected = "budget not armed")]
    fn depense_refusee_sans_budget_arme() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit(None);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    #[should_panic(expected = "armer only")]
    fn l_agent_n_arme_pas() {
        let mut g = guard();
        ctx("agent.test", 0, 0);
        g.arm(id("agent.test"), U128(100 * U), 1, U128(0));
    }

    // bornes de l'humain : nulles a l'init, fixees par le proprietaire seul
    #[test]
    fn bornes_nulles_a_l_init_puis_fixees_par_le_proprietaire() {
        let mut g = guard();
        let b = g.bounds();
        assert_eq!(
            (b.max_budget, b.max_duration_s, b.max_7d),
            (U128(0), 0, U128(0))
        );
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(50 * U), 60, U128(200 * U));
        let b = g.bounds();
        assert_eq!(
            (b.max_budget, b.max_duration_s, b.max_7d),
            (U128(50 * U), 60, U128(200 * U))
        );
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn l_armeur_ne_fixe_pas_les_bornes() {
        let mut g = guard();
        ctx("armer.test", 0, 0);
        g.set_bounds(U128(ONE_NEAR), 1000, U128(ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "budget above the human's bound")]
    fn aucun_armement_sans_bornes() {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.register_agent(id("agent.test"));
        ctx("owner.test", ONE_NEAR, 0);
        g.deposit_credit(Some(id("agent.test")));
        arm_at(&mut g, 1, 1, 0);
    }

    // sinon budget 0 et duree 0 passeraient les bornes nulles de l'init
    #[test]
    #[should_panic(expected = "zero budget")]
    fn budget_nul_refuse() {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.register_agent(id("agent.test"));
        ctx("owner.test", ONE_NEAR, 0);
        g.deposit_credit(Some(id("agent.test")));
        arm_at(&mut g, 0, 0, 0);
    }

    #[test]
    fn budget_et_duree_acceptes_a_la_borne() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
        arm_at(&mut g, 50 * U, 60, 0);
        assert_eq!(g.budget_left(&id("agent.test")).0, 50 * U);
    }

    #[test]
    #[should_panic(expected = "budget above the human's bound")]
    fn budget_au_dela_de_la_borne_refuse() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
        arm_at(&mut g, 50 * U + 1, 60, 0);
    }

    #[test]
    #[should_panic(expected = "duration above the human's bound")]
    fn duree_au_dela_de_la_borne_refusee() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
        arm_at(&mut g, 50 * U, 61, 0);
    }

    // controle d'integrite : l'armeur arme sur l'etat qu'il a lu, pas sur un autre
    #[test]
    #[should_panic(expected = "integrity check failed: unexpected credit")]
    fn armement_refuse_si_le_credit_differe() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 1000 * U);
        ctx("armer.test", 0, 0);
        let credit = g.credit_of(&id("agent.test")).0;
        g.arm(id("agent.test"), U128(50 * U), 60, U128(credit + 1));
    }

    // sinon l'armeur cree budget et journal pour n'importe quel compte, aux frais du contrat
    #[test]
    #[should_panic(expected = "integrity check failed: unexpected credit")]
    fn armement_refuse_pour_un_agent_jamais_credite() {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(50 * U), 60, U128(1000 * U));
        g.register_agent(id("agent.test"));
        arm_at(&mut g, 50 * U, 60, 0);
    }

    // plafond glissant de 7 jours : le budget arme entier compte, meme non depense
    #[test]
    fn le_plafond_de_7_jours_admet_le_cumul_exact() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
        assert_eq!(g.armed_7d(&id("agent.test")), U128(0));
        arm_at(&mut g, 60 * U, 1000, 0);
        arm_at(&mut g, 40 * U, 1000, SEC);
        assert_eq!(g.armed_7d(&id("agent.test")), U128(100 * U));
    }

    #[test]
    #[should_panic(expected = "7-day cap exceeded")]
    fn le_plafond_de_7_jours_cumule_les_budgets_armes() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
        arm_at(&mut g, 60 * U, 1000, 0);
        arm_at(&mut g, 41 * U, 1000, SEC);
    }

    #[test]
    #[should_panic(expected = "7-day cap exceeded")]
    fn un_armement_compte_jusqu_a_7_jours() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
        arm_at(&mut g, 60 * U, 1000, SEC);
        arm_at(&mut g, 60 * U, 1000, SEC + WEEK_NS - 1);
    }

    #[test]
    fn un_armement_sort_de_la_fenetre_apres_7_jours() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
        arm_at(&mut g, 60 * U, 1000, SEC);
        ctx("agent.test", 0, SEC + WEEK_NS);
        assert_eq!(g.armed_7d(&id("agent.test")), U128(0)); // la vue suit l'heure du bloc
        arm_at(&mut g, 60 * U, 1000, SEC + WEEK_NS);
        assert_eq!(g.armed_7d(&id("agent.test")), U128(60 * U));
    }

    // sinon l'armeur contournerait le plafond en desarmant puis rearmant
    #[test]
    #[should_panic(expected = "7-day cap exceeded")]
    fn le_desarmement_ne_remet_pas_le_plafond_a_zero() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 100 * U);
        arm_at(&mut g, 60 * U, 1000, 0);
        g.disarm(id("agent.test"));
        arm_at(&mut g, 60 * U, 1000, SEC);
    }

    #[test]
    fn rearmer_remplace_le_budget_courant() {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 0);
        g.request_check(TARGET.into(), None);
        arm_at(&mut g, 30 * U, 1000, SEC);
        assert_eq!(g.budget_left(&id("agent.test")).0, 30 * U);
        assert_eq!(g.armed_7d(&id("agent.test")), U128(130 * U));
    }

    #[test]
    fn l_armement_est_journalise() {
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

    // stockage paye par le contrat : nombre d'armements sur 7 jours borne, refus au-dela
    #[test]
    fn le_journal_est_borne_puis_purge_apres_7_jours() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
        for i in 0..MAX_ARMINGS_7D {
            arm_at(&mut g, 1, 1000, u64::try_from(i).unwrap() * SEC);
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            arm_at(&mut g, 1, 1000, 100 * SEC);
        }));
        assert!(r.is_err(), "armement au-dela du journal refuse");
        arm_at(&mut g, 1, 1000, 100 * SEC + WEEK_NS); // les anciennes entrees sont purgees
        assert_eq!(g.armed_7d(&id("agent.test")), U128(1));
    }

    #[test]
    #[should_panic(expected = "too many armings in 7 days")]
    fn armement_refuse_journal_plein() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
        for _ in 0..=MAX_ARMINGS_7D {
            arm_at(&mut g, 1, 1000, 0);
        }
    }

    // un humain seul peut tenir les deux roles ; les bornes s'appliquent toujours
    #[test]
    fn un_humain_seul_peut_etre_proprietaire_et_armeur() {
        ctx("guard.test", 0, 0);
        let mut g = Guard::new(
            id("owner.test"),
            id("owner.test"),
            id("sentinel.test"),
            U128(PRICE),
            evm(),
        );
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(50 * U), 60, U128(100 * U));
        g.register_agent(id("agent.test"));
        ctx("owner.test", ONE_NEAR, 0);
        g.deposit_credit(Some(id("agent.test")));
        ctx("owner.test", 0, 0);
        let credit = g.credit_of(&id("agent.test"));
        g.arm(id("agent.test"), U128(50 * U), 60, credit);
        assert_eq!(g.budget_left(&id("agent.test")).0, 50 * U);
    }

    // l'agent qui paie n'est jamais celui qui arme
    #[test]
    #[should_panic(expected = "the armer cannot arm itself")]
    fn l_armeur_ne_s_arme_pas_lui_meme() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 100 * U);
        ctx("owner.test", ONE_NEAR, 0);
        g.deposit_credit(Some(id("armer.test")));
        ctx("armer.test", 0, 0);
        let credit = g.credit_of(&id("armer.test"));
        g.arm(id("armer.test"), U128(50 * U), 60, credit);
    }

    #[test]
    #[should_panic(expected = "armer only")]
    fn le_proprietaire_n_arme_plus() {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.arm(id("agent.test"), U128(100 * U), 1, U128(0));
    }

    // 1. journal : evenement JSON structure, cible validee
    #[test]
    fn evenement_json_structure() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
        let log = get_logs().pop().unwrap();
        let json = log.strip_prefix("EVENT_JSON:").expect("prefixe NEP-297");
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        assert_eq!(v["event"], "check_requested");
        assert_eq!(v["data"][0]["target"], TARGET);
        assert_eq!(v["data"][0]["agent"], "agent.test");
        assert_eq!(v["data"][0]["id"], 1);
    }

    #[test]
    fn cible_invalide_refusee_sans_debit() {
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
                g.request_check(t.to_string(), None)
            }));
            assert!(r.is_err(), "doit refuser {t:?}");
        }
        assert_eq!(g.credit_of(&id("agent.test")).0, before);
    }

    // 2. initialiseur reserve au compte du contrat
    #[test]
    #[should_panic(expected = "init reserved to the contract account")]
    fn new_refuse_un_tiers() {
        ctx("intrus.test", 0, 0);
        let _ = Guard::new(
            id("intrus.test"),
            id("intrus.test"),
            id("intrus.test"),
            U128(PRICE),
            evm(),
        );
    }

    // 3. frais perçus et crédit récupérables
    #[test]
    fn frais_comptes_a_part_et_retirables() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let a = g.request_check(TARGET.into(), None);
        let b = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 500);
        g.post_verdict(
            a,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        g.post_verdict(
            b,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        assert_eq!(g.fees(), U128(2 * PRICE));
        ctx("owner.test", 0, 500);
        let _ = g.withdraw_fees(U128(15 * U));
        assert_eq!(g.fees(), U128(2 * PRICE - 15 * U));
    }

    #[test]
    #[should_panic(expected = "exceeds collected fees")]
    fn retrait_plafonne_aux_frais() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let a = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 500);
        g.post_verdict(
            a,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        ctx("owner.test", 0, 500);
        let _ = g.withdraw_fees(U128(PRICE + 1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn retrait_reserve_au_proprietaire() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
        let _ = g.withdraw_fees(U128(1));
    }

    #[test]
    fn remboursement_du_credit_inutilise() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
        let left = g.credit_of(&id("agent.test")).0;
        assert!(left > 0);
        let _ = g.refund_credit();
        assert_eq!(g.credit_of(&id("agent.test")).0, 0);
        assert_eq!(g.fees(), U128(0)); // le prix de la demande reste sous sequestre
    }

    // 4. stockage d'un compte neuf couvert par son depot
    #[test]
    #[should_panic(expected = "deposit does not cover storage")]
    fn depot_minuscule_refuse_pour_un_compte_neuf() {
        let mut g = guard();
        ctx("agent.test", 1, 0);
        g.deposit_credit(None);
    }

    // 5. verdict poste par la sentinelle seule, une fois
    #[test]
    fn la_sentinelle_poste_un_verdict_lisible() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 600);
        g.post_verdict(
            check,
            Verdict::Block,
            "reprise par transferFrom".into(),
            "{\"block\":1}".into(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        let c = g.get_check(check).unwrap();
        assert_eq!(c.verdict, Some(Verdict::Block));
        assert_eq!(c.reasons, "reprise par transferFrom");
        let v = &events()[0]; // then `listed`: a block lists its target
        assert_eq!(v["event"], "verdict_posted");
        assert_eq!(v["data"][0]["id"], 1);
        assert_eq!(v["data"][0]["verdict"], "block");
        assert_eq!(v["data"][0]["evidence"], "{\"block\":1}");
    }

    #[test]
    #[should_panic(expected = "sentinel only")]
    fn seule_la_sentinelle_poste_un_verdict() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into(), None);
        g.post_verdict(
            check,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
    }

    #[test]
    #[should_panic(expected = "verdict already posted")]
    fn un_verdict_ne_se_reecrit_pas() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 600);
        g.post_verdict(
            check,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        g.post_verdict(
            check,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
    }

    // 6. achat signe par NEAR : la garde construit le swap pour la cible de la demande et le fait
    // signer par le MPC ; l'agent ne choisit que le montant et le minimum de jetons recus.
    const VALUE: u128 = 10_000_000_000_000; // 0,00001 ETH
    /// Calcule par la garde : QUOTE ramene a VALUE (20 435), moins 3 % de glissement, arrondi bas.
    const MIN_OUT: u128 = 19_821;
    /// Valeur plus gaz au plafond (250 000 x 0,05 gwei), au taux fixe : 22,5 U.
    const COST: u128 = (VALUE + 250_000 * 50_000_000) * RATE;
    // Vecteurs viem 2.57 (serializeTransaction, keccak256, signTransaction avec la cle 0x00..01) :
    // swap de VALUE wei, minimum MIN_OUT, chemin [WETH, TARGET], destinataire ADDR, echeance 300 s,
    // gaz 250 000, frais 0,05 / 0,001 gwei, chain id 8453, nonce 0.
    const HASH0: &str = "314bf89cb90d7232250c56241836f4ab662a81de9030d250712eedbcdd5fd5e0";
    const R0: &str = "edd513dba0e03506152548756199a93ca6e97d19067f21b928c1d3d093b85058";
    const S0: &str = "554415cb6774e8a2fa43e6b66b4326492d07b9a4dba38722e3e973885f70733d"; // y = 1
    const RAW0: &str = "0x02f9015782210580830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de950000000000000000000000000000000000000000000000000000000000004d6d00000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c001a0edd513dba0e03506152548756199a93ca6e97d19067f21b928c1d3d093b85058a0554415cb6774e8a2fa43e6b66b4326492d07b9a4dba38722e3e973885f70733d";
    /// Meme swap au nonce 7, signature fictive r = 00aa..aa, s = 0000bb..bb, y = 1 : viem retire
    /// les zeros de tete (entiers RLP canoniques).
    const HASH7: &str = "09c441fe3699e56cd3c6d7646c8e3242427e00fd8816adc1b8c2b5771675fea0";
    const RAW7: &str = "0x02f9015482210507830f42408402faf0808303d090944752ba5dbc23f44d87826276bf6fd6b1c372ad248609184e72a000b8e4b6f9de950000000000000000000000000000000000000000000000000000000000004d6d00000000000000000000000000000000000000000000000000000000000000800000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000020000000000000000000000004200000000000000000000000000000000000006000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7c0019faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9ebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn judged(verdict: Verdict) -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 600);
        g.post_verdict(
            check,
            verdict,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        ctx("agent.test", 0, 700);
        (g, check)
    }

    fn buy(g: &mut Guard, check: u64) {
        let _ = g.buy(check, U128(VALUE), None);
    }

    /// Reponse de `sign` au format de `v1.signer-prod.testnet` ; `big_r` = prefixe 02 + r.
    fn mpc_response(r: &str, s: &str, recovery_id: u8) -> Vec<u8> {
        format!(
            r#"{{"big_r":{{"affine_point":"02{r}"}},"recovery_id":{recovery_id},"s":{{"scalar":"{s}"}},"scheme":"Secp256k1"}}"#
        )
        .into_bytes()
    }

    /// Le callback de la garde recoit `result`, le resultat de `sign`.
    fn signed(g: &mut Guard, result: PromiseResult) -> Option<String> {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(id("guard.test"))
                .predecessor_account_id(id("guard.test"))
                .block_timestamp(800)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            vec![result],
        );
        g.on_signed()
    }

    /// Arguments de l'appel `sign` cree par `buy` (1 yoctoNEAR au MPC), suivi du callback.
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
            panic!("appel de sign attendu")
        };
        assert_eq!(method_name, b"sign");
        assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
        assert_eq!(receipts[1].receiver_id, id("guard.test"));
        let MockAction::FunctionCallWeight { method_name, .. } = &receipts[1].actions[0] else {
            panic!("callback attendu")
        };
        assert_eq!(method_name, b"on_signed");
        near_sdk::serde_json::from_slice(args).unwrap()
    }

    #[test]
    fn l_achat_fait_signer_au_mpc_le_hash_de_la_transaction_viem() {
        let (mut g, check) = judged(Verdict::Allow);
        buy(&mut g, check);
        let args = sign_args();
        assert_eq!(args["request"]["path"], DERIVATION_PATH);
        assert_eq!(args["request"]["payload_v2"]["Ecdsa"], HASH0);
        assert_eq!(args["request"]["domain_id"], 0);
    }

    #[test]
    fn l_achat_debite_valeur_et_gaz_au_taux_fixe() {
        let (mut g, check) = judged(Verdict::Allow);
        let credit = g.credit_of(&id("agent.test")).0;
        buy(&mut g, check);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit - COST);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - COST);
        assert_eq!(g.fees(), U128(PRICE)); // le cout reste sous sequestre jusqu'a la signature
        let v = last_event();
        assert_eq!(v["event"], "sign_requested");
        assert_eq!(v["data"][0]["target"], TARGET);
        assert_eq!(v["data"][0]["nonce"], 0);
        assert_eq!(v["data"][0]["hash"], HASH0);
        assert_eq!(v["data"][0]["min_out"], MIN_OUT.to_string());
    }

    // la cible, le routeur, le destinataire et le chemin viennent de la garde : le vecteur viem
    // achete TARGET (la cible de la demande) pour ADDR via le routeur Uniswap V2 de Base
    #[test]
    fn la_signature_du_mpc_donne_la_transaction_viem() {
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
    fn r_et_s_sont_encodes_sans_zero_de_tete() {
        let (mut g, check) = judged(Verdict::Allow);
        g.evm_nonce = 7;
        buy(&mut g, check);
        assert_eq!(sign_args()["request"]["payload_v2"]["Ecdsa"], HASH7);
        let r = format!("00{}", "aa".repeat(31));
        let s = format!("0000{}", "bb".repeat(30));
        let raw = signed(&mut g, PromiseResult::Successful(mpc_response(&r, &s, 1)));
        assert_eq!(raw.as_deref(), Some(RAW7));
        assert_eq!(g.evm_nonce, 8);
    }

    // sans signature rien n'est diffusable : credit et budget reviennent, le nonce reste libre
    #[test]
    fn un_echec_de_signature_rend_credit_budget_et_nonce() {
        let (mut g, check) = judged(Verdict::Allow);
        let credit = g.credit_of(&id("agent.test")).0;
        buy(&mut g, check);
        assert_eq!(signed(&mut g, PromiseResult::Failed), None);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE);
        assert_eq!(g.fees(), U128(PRICE));
        assert_eq!(g.evm_nonce, 0);
        assert!(!g.get_check(check).unwrap().settled);
        assert_eq!(last_event()["event"], "sign_failed");
        ctx("agent.test", 0, 900); // verrou libere : l'agent reessaie, au meme nonce
        buy(&mut g, check);
        assert_eq!(sign_args()["request"]["payload_v2"]["Ecdsa"], HASH0);
    }

    #[test]
    fn une_reponse_illisible_vaut_un_echec() {
        let bad = [
            b"not json".to_vec(),
            b"{\"oops\":1}".to_vec(),
            mpc_response(R0, &S0[2..], 0), // s sur 31 octets
            mpc_response(&R0[2..], S0, 0), // big_r sur 32 octets
            mpc_response("zz", S0, 0),
            mpc_response(R0, S0, 2),
        ];
        for response in bad {
            let (mut g, check) = judged(Verdict::Allow);
            buy(&mut g, check);
            assert_eq!(signed(&mut g, PromiseResult::Successful(response)), None);
            assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE);
            assert_eq!(g.evm_nonce, 0);
        }
    }

    // le budget n'est rendu qu'a l'armement debite : ni a un rearmement, ni apres l'arret d'urgence
    #[test]
    fn un_echec_apres_rearmement_ne_regonfle_pas_le_nouveau_budget() {
        let (mut g, check) = judged(Verdict::Allow);
        let credit = g.credit_of(&id("agent.test")).0;
        buy(&mut g, check);
        arm_at(&mut g, 30 * U, 1000, 750);
        signed(&mut g, PromiseResult::Failed);
        assert_eq!(g.budget_left(&id("agent.test")).0, 30 * U);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit);
    }

    #[test]
    fn un_echec_apres_l_arret_d_urgence_ne_rend_pas_le_budget() {
        let (mut g, check) = judged(Verdict::Allow);
        buy(&mut g, check);
        ctx("owner.test", 0, 750);
        g.disarm(id("agent.test"));
        signed(&mut g, PromiseResult::Failed);
        assert_eq!(g.budget_left(&id("agent.test")).0, 0);
    }

    // reentrance : une demande en cours de signature ne s'achete pas deux fois
    #[test]
    #[should_panic(expected = "a signature is already in progress")]
    fn pas_de_second_achat_pendant_la_signature() {
        let (mut g, check) = judged(Verdict::Allow);
        buy(&mut g, check);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "check already settled")]
    fn un_seul_achat_par_verdict() {
        let (mut g, check) = judged(Verdict::Allow);
        buy(&mut g, check);
        signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
        ctx("agent.test", 0, 900);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "verdict does not allow the purchase")]
    fn achat_refuse_sur_block() {
        let (mut g, check) = judged(Verdict::Block);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "warn verdict not approved by the owner")]
    fn achat_refuse_sur_warn_sans_humain() {
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
    fn achat_refuse_sans_verdict() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into(), None);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "budget exceeded")]
    fn achat_refuse_au_dela_du_budget_arme() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.buy(check, U128(10 * VALUE), None);
    }

    #[test]
    #[should_panic(expected = "budget expired")]
    fn achat_refuse_apres_l_echeance() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("agent.test", 0, SEC);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "check belongs to another agent")]
    fn achat_refuse_a_un_autre_agent() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("intrus.test", 0, 700);
        buy(&mut g, check);
    }

    #[test]
    #[should_panic(expected = "zero amount")]
    fn achat_de_zero_wei_refuse() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.buy(check, U128(0), None);
    }

    #[test]
    #[should_panic(expected = "amount too large")]
    fn montant_qui_deborde_au_taux_refuse() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.buy(check, U128(u128::MAX), None);
    }

    // devis : poste par la sentinelle avec son verdict, base du minimum de jetons calcule par la garde
    #[test]
    fn le_devis_est_stocke_et_journalise_avec_le_verdict() {
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
        );
        assert_eq!(g.get_check(check).unwrap().quote, U128(QUOTE));
        let v = last_event();
        assert_eq!(v["event"], "verdict_posted");
        assert_eq!(v["data"][0]["quote"], QUOTE.to_string());
    }

    #[test]
    #[should_panic(expected = "allow without a quote")]
    fn un_allow_sans_devis_est_refuse() {
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
        );
    }

    #[test]
    fn un_block_sans_devis_est_accepte() {
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
        );
        assert_eq!(g.get_check(check).unwrap().verdict, Some(Verdict::Block));
    }

    #[test]
    fn le_minimum_recu_suit_le_devis_sans_debordement() {
        assert_eq!(min_out(QUOTE, VALUE, 300), Some(MIN_OUT));
        assert_eq!(min_out(QUOTE, VALUE, 0), Some(20_435));
        // jeton a 18 decimales tres bon marche : quote * amount depasserait u128
        let quote = 10u128.pow(30);
        assert_eq!(
            min_out(quote, 10u128.pow(14), 300),
            Some(97 * 10u128.pow(26))
        );
        assert_eq!(min_out(u128::MAX, u128::MAX, 300), None);
    }

    #[test]
    #[should_panic(expected = "minimum output rounds to zero")]
    fn un_achat_dont_le_minimum_est_nul_est_refuse() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.buy(check, U128(1), None);
    }

    #[test]
    fn une_configuration_evm_invalide_est_refusee() {
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

    // 7. credit depose par l'humain pour l'agent (sa cle function-call ne peut rien attacher)
    #[test]
    fn le_proprietaire_credite_l_agent() {
        let g = funded(ONE_NEAR, 100 * U, 1);
        let credit = g.credit_of(&id("agent.test")).0;
        assert!(credit > 0 && credit < ONE_NEAR);
        assert_eq!(g.credit_of(&id("owner.test")).0, 0);
    }

    // 8. armement en duree, a partir de l'heure du bloc
    #[test]
    fn l_armement_court_a_partir_du_bloc() {
        let mut g = funded(ONE_NEAR, 100 * U, 0);
        arm_at(&mut g, 100 * U, 60, 10 * SEC);
        ctx("agent.test", 0, 69 * SEC);
        g.request_check(TARGET.into(), None);
        ctx("agent.test", 0, 70 * SEC);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            g.request_check(TARGET.into(), None)
        }));
        assert!(r.is_err(), "echu a 10 s + 60 s");
    }

    // 9. arret d'urgence par l'humain
    #[test]
    #[should_panic(expected = "budget not armed")]
    fn le_desarmement_coupe_toute_depense() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    #[should_panic(expected = "owner or armer only")]
    fn l_agent_ne_desarme_pas() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 0);
        g.disarm(id("agent.test"));
    }

    // arret anormal : l'armeur desarme aussi
    #[test]
    #[should_panic(expected = "budget not armed")]
    fn l_armeur_desarme_aussi() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("armer.test", 0, 0);
        g.disarm(id("agent.test"));
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
    }

    #[test]
    fn le_desarmement_est_journalise() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        let v = &events()[0];
        assert_eq!(v["event"], "disarmed");
        assert_eq!(v["data"][0]["agent"], "agent.test");
        assert_eq!(v["data"][0]["by"], "owner.test");
    }

    // arret d'urgence de l'humain : l'agent est gele, l'armeur ne peut pas le rearmer aussitot
    #[test]
    #[should_panic(expected = "agent frozen by the owner")]
    fn l_armeur_ne_rearme_pas_apres_l_arret_de_l_humain() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        arm_at(&mut g, 10 * U, 1000, SEC);
    }

    #[test]
    fn le_gel_est_journalise() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        let v = last_event();
        assert_eq!(v["event"], "frozen");
        assert_eq!(v["data"][0]["agent"], "agent.test");
    }

    // arret anormal constate par l'armeur : pas de gel, il peut rearmer
    #[test]
    fn le_desarmement_par_l_armeur_ne_gele_pas() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("armer.test", 0, 0);
        g.disarm(id("agent.test"));
        assert!(events().iter().all(|v| v["event"] != "frozen"));
        arm_at(&mut g, 10 * U, 1000, SEC);
        assert_eq!(g.budget_left(&id("agent.test")).0, 10 * U);
    }

    #[test]
    fn seul_l_humain_degele_puis_l_armeur_rearme() {
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
    fn l_armeur_ne_degele_pas() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        ctx("armer.test", 0, 0);
        g.unfreeze(id("agent.test"));
    }

    // revocation d'un armeur compromis par l'humain
    #[test]
    #[should_panic(expected = "armer only")]
    fn un_armeur_revoque_n_arme_plus() {
        let mut g = credited(ONE_NEAR, 50 * U, 60, 100 * U);
        ctx("owner.test", 0, 0);
        g.set_armer(id("armer2.test"));
        arm_at(&mut g, 10 * U, 60, 0);
    }

    #[test]
    fn le_nouvel_armeur_arme_et_le_changement_est_journalise() {
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
    fn l_armeur_ne_se_remplace_pas() {
        let mut g = guard();
        ctx("armer.test", 0, 0);
        g.set_armer(id("armer2.test"));
    }

    // stockage du journal paye par le contrat : seuls les agents enregistres par l'humain s'arment
    #[test]
    #[should_panic(expected = "agent not registered by the owner")]
    fn l_armeur_n_arme_pas_un_compte_non_enregistre() {
        let mut g = guard();
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(50 * U), 60, U128(100 * U));
        ctx("intrus.test", ONE_NEAR, 0); // credit depose par le compte lui-meme
        g.deposit_credit(None);
        ctx("armer.test", 0, 0);
        let credit = g.credit_of(&id("intrus.test"));
        g.arm(id("intrus.test"), U128(10 * U), 60, credit);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn seul_l_humain_enregistre_un_agent() {
        let mut g = guard();
        ctx("armer.test", 0, 0);
        g.register_agent(id("intrus.test"));
    }

    #[test]
    fn le_journal_purge_les_armements_sortis_de_la_fenetre() {
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
    fn le_journal_vide_est_supprime_au_desarmement() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("armer.test", 0, WEEK_NS);
        g.disarm(id("agent.test"));
        assert!(g.armings.get(&id("agent.test")).is_none());
    }

    // 10. remboursement du prix si la sentinelle ne repond pas dans le delai
    fn pending() -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 0);
        let check = g.request_check(TARGET.into(), None);
        (g, check)
    }

    #[test]
    fn prix_rembourse_sans_verdict_apres_le_delai() {
        let (mut g, check) = pending();
        let credit = g.credit_of(&id("agent.test")).0;
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit + PRICE);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE); // le budget ne revient pas
        assert_eq!(g.fees(), U128(0));
        assert!(g.get_check(check).is_none(), "stockage libere");
    }

    #[test]
    #[should_panic(expected = "timeout not reached")]
    fn pas_de_remboursement_avant_le_delai() {
        let (mut g, check) = pending();
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS - 1);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "verdict already posted")]
    fn pas_de_remboursement_apres_un_verdict() {
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
        );
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "unknown check")]
    fn un_seul_remboursement() {
        let (mut g, check) = pending();
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "unknown check")]
    fn pas_de_verdict_apres_remboursement() {
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
        );
    }

    #[test]
    #[should_panic(expected = "check belongs to another agent")]
    fn seul_l_agent_se_fait_rembourser() {
        let (mut g, check) = pending();
        ctx("intrus.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
    }

    // 11. le prix d'une demande reste sous sequestre jusqu'au verdict
    #[test]
    #[should_panic(expected = "exceeds collected fees")]
    fn le_prix_en_attente_n_est_pas_retirable() {
        let (mut g, _check) = pending();
        ctx("owner.test", 0, 0);
        let _ = g.withdraw_fees(U128(PRICE));
    }

    // la preuve postee est liee au verdict : empreinte sha256 de la chaine recue, en hexadecimal
    #[test]
    fn le_verdict_stocke_l_empreinte_de_la_preuve() {
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
        );
        let v = near_sdk::serde_json::to_value(g.get_check(check).unwrap()).unwrap();
        assert_eq!(
            v["evidence_sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    // agent de 64 caracteres, raisons et preuve au maximum : le prix couvre toujours la demande
    /// Storage bytes of one worst-case check, on the block path (`allow == false`: code, `seen` and a
    /// listing) or the buy path (`allow == true`: code, `seen`, signed tx, both decision hashes and the
    /// agent's holdings entry).
    fn worst_case_bytes(allow: bool) -> u128 {
        let big = id(&"a".repeat(64));
        ctx("guard.test", 0, 0);
        // l'agent est aussi la sentinelle : demande et verdict dans le meme contexte de mesure
        let mut g = Guard::new(
            id("owner.test"),
            id("armer.test"),
            big.clone(),
            U128(PRICE),
            evm(),
        );
        ctx("owner.test", 0, 0);
        g.set_bounds(U128(100 * U), 1000, U128(1000 * U));
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
        let check = g.request_check(TARGET.into(), Some("f".repeat(64)));
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
        );
        let c = g.checks.get_mut(&check).unwrap();
        c.exit_amount = Some(U128(u128::MAX));
        if allow {
            // Transaction signee la plus longue : type 1, en-tete de liste 3, chain id 3, nonce 9,
            // frais 17 + 17, gaz 9, routeur 21, valeur 17, donnees 3 + 228, acces 1, v 1, r 33, s 33.
            c.signed_tx = Some(vec![0xff; 396].into());
            c.settled = true;
            c.buy_decision_sha256 = Some("f".repeat(64));
            g.holdings.insert(holding_key(&big, TARGET), u128::MAX);
        }
        g.checks.flush();
        g.credits.flush();
        g.budgets.flush();
        g.seen.flush();
        g.blocklist.flush();
        g.holdings.flush();
        u128::from(env::storage_usage() - before)
    }

    // A block check is never bought and only a block lists, so the two worst cases are exclusive
    // (each in its own test: the mock storage outlives a guard).
    #[test]
    fn le_majorant_couvre_une_demande_au_pire_cas() {
        let used = worst_case_bytes(true);
        assert!(
            used > 0 && used <= CHECK_STORAGE_BYTES,
            "{used} o pour une demande"
        );
    }

    #[test]
    fn le_majorant_couvre_un_block_au_pire_cas() {
        let used = worst_case_bytes(false);
        assert!(
            used > 0 && used <= CHECK_STORAGE_BYTES,
            "{used} o pour un block"
        );
    }

    #[test]
    fn le_verdict_rend_le_prix_retirable() {
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
        );
        assert_eq!(g.fees(), U128(PRICE));
    }

    // 12. revue de securite : stockage couvert par le prix, budget jamais regonfle
    #[test]
    #[should_panic(expected = "price below the storage cost of a check")]
    fn le_prix_couvre_le_stockage_d_une_demande() {
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
    fn un_remboursement_ne_depasse_pas_le_nouvel_armement() {
        let (mut g, check) = pending();
        arm_at(&mut g, 100 * U, 1000, 0);
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U);
    }

    // 13. la sentinelle sait jusqu'ou lire, meme si une demande remboursee a ete effacee
    #[test]
    fn last_check_id_suit_les_demandes() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        assert_eq!(g.last_check_id(), 0);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into(), None);
        g.request_check(TARGET.into(), None);
        assert_eq!(g.last_check_id(), 2);
    }

    // 14. un verdict perime n'achete plus : la cible a pu changer depuis le controle
    fn judged_at_1s() -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 0);
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, SEC);
        g.post_verdict(
            check,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
        );
        (g, check)
    }

    #[test]
    fn le_verdict_date_son_jugement() {
        let (g, check) = judged_at_1s();
        assert_eq!(g.get_check(check).unwrap().judged_ns, U64(SEC));
    }

    #[test]
    fn achat_signe_juste_avant_l_echeance_du_verdict() {
        let (mut g, check) = judged_at_1s();
        ctx("agent.test", 0, SEC + VERDICT_TTL_NS - 1);
        buy(&mut g, check);
        assert_eq!(sign_args()["request"]["path"], DERIVATION_PATH);
    }

    #[test]
    #[should_panic(expected = "verdict expired")]
    fn achat_refuse_sur_verdict_perime() {
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

    fn ok_sig((r, s, v): (&str, &str, u8)) -> PromiseResult {
        PromiseResult::Successful(mpc_response(r, s, v))
    }

    /// `who` sells `SELL_AMOUNT` of `TARGET` at 700 ns; the agent is registered, credited, never armed.
    fn sell_as(who: &str) -> Guard {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
        ctx(who, 0, 700);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
        g
    }

    /// Payload hashes of the `sign` calls created by the last call, which must end with `callback`.
    fn signed_hashes(callback: &[u8]) -> Vec<String> {
        let receipts = get_created_receipts();
        let (last, signs) = receipts.split_last().unwrap();
        let MockAction::FunctionCallWeight { method_name, .. } = &last.actions[0] else {
            panic!("callback attendu")
        };
        assert_eq!(method_name, callback);
        signs
            .iter()
            .map(|r| {
                assert_eq!(r.receiver_id, id("mpc.test"));
                let MockAction::FunctionCallWeight { args, .. } = &r.actions[0] else {
                    panic!("appel de sign attendu")
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
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(id("guard.test"))
                .predecessor_account_id(id("guard.test"))
                .block_timestamp(800)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            std::collections::HashMap::default(),
            results,
        );
        g.on_exit_signed()
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

    // nonces stay contiguous: a swap without its approve is never kept
    #[test]
    fn a_failed_swap_signature_keeps_the_approve_only() {
        let mut g = sell_as("owner.test");
        assert_eq!(
            exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]),
            [APPROVE_RAW]
        );
        assert_eq!(g.evm_nonce, 1);
    }

    #[test]
    fn a_failed_approve_signature_keeps_nothing_and_frees_the_lock() {
        let mut g = sell_as("owner.test");
        assert!(exit_signed(&mut g, vec![PromiseResult::Failed, ok_sig(SIG_B)]).is_empty());
        assert_eq!(g.evm_nonce, 0);
        assert!(g.last_exit().is_none());
        ctx("owner.test", 0, 900);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
        assert_eq!(signed_hashes(b"on_exit_signed"), [APPROVE_HASH, SELL_HASH]);
    }

    #[test]
    #[should_panic(expected = "a signature is already in progress")]
    fn a_sale_takes_the_single_signature_lock() {
        let mut g = sell_as("owner.test");
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
    }

    #[test]
    #[should_panic(expected = "a signature is already in progress")]
    fn no_buy_while_a_sale_is_being_signed() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("owner.test", 0, 700);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
        ctx("agent.test", 0, 700);
        buy(&mut g, check);
    }

    // an agent never chooses its exit floor: it sells only on a sentinel exit quote (sell_quoted)
    #[test]
    #[should_panic(expected = "owner only")]
    fn an_agent_cannot_sell_at_a_floor_of_its_choice() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("agent.test", 0, 700);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(0));
    }

    #[test]
    fn the_owner_sells_even_with_the_agent_frozen() {
        let mut g = funded(ONE_NEAR, 10 * U, 1000);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        ctx("owner.test", 0, 700);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
        assert_eq!(signed_hashes(b"on_exit_signed"), [APPROVE_HASH, SELL_HASH]);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn an_unregistered_account_cannot_sell() {
        let _ = sell_as("intrus.test");
    }

    #[test]
    #[should_panic(expected = "invalid token")]
    fn a_sale_needs_a_valid_token_address() {
        let mut g = credited(ONE_NEAR, 100 * U, 1000, 1000 * U);
        ctx("owner.test", 0, 700);
        let _ = g.sell("0xabc".into(), U128(SELL_AMOUNT), U128(SELL_MIN));
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
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, now_ns + 1);
        g.post_verdict(
            check,
            verdict,
            String::new(),
            String::new(),
            U128(QUOTE),
            code,
            true,
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

    fn report_as(g: &mut Guard, who: &str, kind: &str, key: &str) {
        ctx(who, 0, 50);
        g.report(
            kind.into(),
            key.into(),
            SHA.into(),
            "honeypot seen by agent B".into(),
        );
    }

    #[test]
    fn a_registered_reporter_lists_a_token_with_its_evidence_and_pays_the_storage() {
        let mut g = with_reporter(ONE_NEAR);
        let credit = g.credit_of(&id("reporter.test")).0;
        let fees = g.fees().0;
        report_as(&mut g, "reporter.test", "token", TARGET);
        let e = g.get_entry("token".into(), TARGET.to_lowercase()).unwrap();
        assert_eq!(e.reporter, id("reporter.test"));
        assert_eq!(e.evidence_sha256, SHA);
        assert_eq!(e.at_ns, U64(50));
        assert_eq!(e.note, "honeypot seen by agent B");
        let cost = ENTRY_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear();
        assert_eq!(g.credit_of(&id("reporter.test")).0, credit - cost);
        assert_eq!(g.fees().0, fees + cost);
        let v = last_event();
        assert_eq!(v["event"], "listed");
        assert_eq!(v["data"][0]["kind"], "token");
        assert_eq!(v["data"][0]["key"], TARGET.to_lowercase());
        assert_eq!(v["data"][0]["reporter"], "reporter.test");
        assert_eq!(v["data"][0]["evidence_sha256"], SHA);
    }

    #[test]
    fn a_code_hash_can_be_listed() {
        let mut g = with_reporter(ONE_NEAR);
        let key = format!("0x{}", "AB".repeat(32));
        report_as(&mut g, "reporter.test", "code", &key);
        assert!(g.get_entry("code".into(), key.to_lowercase()).is_some());
    }

    #[test]
    #[should_panic(expected = "reporter only")]
    fn an_unregistered_account_cannot_report() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "agent.test", "token", TARGET);
    }

    #[test]
    #[should_panic(expected = "reporter only")]
    fn a_revoked_reporter_cannot_report() {
        let mut g = with_reporter(ONE_NEAR);
        ctx("owner.test", 0, 10);
        g.set_reporter(id("reporter.test"), false);
        report_as(&mut g, "reporter.test", "token", TARGET);
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
        report_as(&mut g, "reporter.test", "token", TARGET);
    }

    #[test]
    #[should_panic(expected = "already listed")]
    fn an_entry_is_never_overwritten() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        report_as(&mut g, "reporter.test", "token", &TARGET.to_lowercase());
    }

    #[test]
    #[should_panic(expected = "invalid kind")]
    fn a_report_needs_a_known_kind() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "wallet", TARGET);
    }

    #[test]
    #[should_panic(expected = "invalid key")]
    fn a_report_needs_a_valid_key() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "code", TARGET);
    }

    #[test]
    #[should_panic(expected = "invalid evidence sha256")]
    fn a_report_needs_an_evidence_sha256() {
        let mut g = with_reporter(ONE_NEAR);
        ctx("reporter.test", 0, 50);
        g.report("token".into(), TARGET.into(), "abc".into(), String::new());
    }

    #[test]
    fn the_owner_unlists_an_entry_with_an_event() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("owner.test", 0, 60);
        g.unlist("token".into(), TARGET.into());
        assert!(g.get_entry("token".into(), TARGET.into()).is_none());
        let v = last_event();
        assert_eq!(v["event"], "unlisted");
        assert_eq!(v["data"][0]["key"], TARGET.to_lowercase());
        assert_eq!(v["data"][0]["by"], "owner.test");
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_reporter_cannot_unlist() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("reporter.test", 0, 60);
        g.unlist("token".into(), TARGET.into());
    }

    #[test]
    fn a_block_verdict_lists_its_target_automatically() {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        let check = verdict_on(&mut g, Verdict::Block, code("aa"), 10);
        let e = g.get_entry("token".into(), TARGET.into()).unwrap();
        assert_eq!(e.reporter, id("sentinel.test"));
        assert_eq!(e.evidence_sha256, SHA_EMPTY);
        assert_eq!(e.note, format!("verdict #{check}"));
        assert_eq!(last_event()["event"], "listed");
    }

    #[test]
    fn a_block_on_a_listed_target_keeps_the_first_entry() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("agent.test", 0, 60);
        // the request is refused once listed: judge one made before the listing
        let mut g2 = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 10);
        let check = g2.request_check(TARGET.into(), None);
        verdict_on(&mut g2, Verdict::Block, code("aa"), 20);
        ctx("sentinel.test", 0, 30);
        g2.post_verdict(
            check,
            Verdict::Block,
            String::new(),
            "second".into(),
            U128(0),
            code("aa"),
            true,
        );
        assert_eq!(
            g2.get_entry("token".into(), TARGET.into()).unwrap().note,
            "verdict #2"
        );
        assert!(g.get_entry("token".into(), TARGET.into()).is_some());
    }

    #[test]
    #[should_panic(expected = "target is on the shared blocklist")]
    fn a_listed_target_cannot_be_checked_for_a_buy() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("agent.test", 0, 60);
        let _ = g.request_check(TARGET.to_lowercase(), None);
    }

    #[test]
    #[should_panic(expected = "target is on the shared blocklist")]
    fn buy_refuses_a_listed_target_even_with_an_allow() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("owner.test", 0, 0);
        g.set_reporter(id("reporter.test"), true);
        ctx("owner.test", ONE_NEAR, 0);
        g.deposit_credit(Some(id("reporter.test")));
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("agent.test", 0, 700);
        buy(&mut g, check);
    }

    #[test]
    fn the_owner_still_sells_a_listed_token() {
        let mut g = with_reporter(ONE_NEAR);
        report_as(&mut g, "reporter.test", "token", TARGET);
        ctx("owner.test", 0, 700);
        let _ = g.sell(TARGET.into(), U128(SELL_AMOUNT), U128(SELL_MIN));
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
        g.report(
            "code".into(),
            format!("0x{}", "ab".repeat(32)),
            SHA.into(),
            "n".repeat(MAX_NOTE),
        );
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
        g.holdings
            .insert(holding_key(&id("agent.test"), TARGET), amount);
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
    fn an_agent_exit_is_charged_to_its_budget_and_credit_like_a_buy() {
        let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
        let (credit, budget, fees) = (
            g.credit_of(&id("agent.test")).0,
            g.budget_left(&id("agent.test")).0,
            g.fees().0,
        );
        sell_quoted_at(&mut g, exit, 1100);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST);
        assert_eq!(g.budget_left(&id("agent.test")).0, budget - EXIT_COST);
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
        assert_eq!(g.fees().0, fees + EXIT_COST);
        assert!(g.get_check(exit).unwrap().settled);
    }

    #[test]
    fn a_failed_swap_signature_refunds_the_unsigned_transaction() {
        let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
        let (credit, budget, fees) = (
            g.credit_of(&id("agent.test")).0,
            g.budget_left(&id("agent.test")).0,
            g.fees().0,
        );
        sell_quoted_at(&mut g, exit, 1100);
        exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit - EXIT_COST / 2);
        assert_eq!(g.budget_left(&id("agent.test")).0, budget - EXIT_COST / 2);
        assert_eq!(g.fees().0, fees + EXIT_COST / 2);
    }

    #[test]
    fn an_exit_with_no_signature_is_fully_refunded_and_the_quote_stays_usable() {
        let (mut g, _, exit) = exit_judged(Verdict::Allow, EXIT_QUOTE);
        let credit = g.credit_of(&id("agent.test")).0;
        sell_quoted_at(&mut g, exit, 1100);
        exit_signed(&mut g, vec![PromiseResult::Failed, PromiseResult::Failed]);
        assert_eq!(g.credit_of(&id("agent.test")).0, credit);
        assert!(!g.get_check(exit).unwrap().settled);
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
        ctx("owner.test", ONE_NEAR, 900);
        g.deposit_credit(Some(id("sentinel.test"))); // the sentinel's report is paid from its credit
        ctx("sentinel.test", 0, 900);
        g.report("token".into(), TARGET.into(), SHA.into(), String::new());
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
        let check = g.request_check(TARGET.into(), Some(DIGEST.into()));
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
        g.request_check(TARGET.into(), Some(format!("0x{}", "a".repeat(62))));
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
        g.request_check(TARGET.into(), Some("g".repeat(64)));
    }

    #[test]
    fn a_retried_buy_overwrites_the_buy_digest() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.buy(check, U128(VALUE), Some("1".repeat(64)));
        signed(&mut g, PromiseResult::Failed);
        ctx("agent.test", 0, 750);
        let _ = g.buy(check, U128(VALUE), Some("2".repeat(64)));
        let c = g.get_check(check).unwrap();
        assert_eq!(c.buy_decision_sha256, Some("2".repeat(64)));
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
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, now_ns + 2);
        g.post_verdict(
            check,
            Verdict::Allow,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("aa"),
            true,
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

    #[test]
    #[should_panic(expected = "exit amount above the agent's holding")]
    fn agent_b_cannot_exit_the_tokens_bought_for_agent_a() {
        let (mut g, _) = judged(Verdict::Allow);
        let bought_a = bought_for(&mut g, "agent.test", 2000);
        let bought_b = bought_for(&mut g, "agentb.test", 4000);
        assert_ne!(bought_a, bought_b);
        // the guard's address holds both, B may sell only its own share
        ctx("agentb.test", 0, 6000);
        let _ = g.request_exit(bought_b, U128(2 * MIN_OUT));
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
    fn a_failed_exit_signature_restores_the_holding() {
        let (mut g, bought) = judged(Verdict::Allow);
        buy(&mut g, bought);
        signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
        let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
        sell_quoted_at(&mut g, exit, 1100);
        assert_eq!(holding_of(&g, "agent.test"), 0);
        exit_signed(&mut g, vec![ok_sig(SIG_A), PromiseResult::Failed]); // the swap is not signed
        assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
    }

    #[test]
    fn an_exit_with_no_signature_restores_the_holding() {
        let (mut g, bought) = judged(Verdict::Allow);
        buy(&mut g, bought);
        signed(&mut g, PromiseResult::Successful(mpc_response(R0, S0, 1)));
        let exit = exit_quote(&mut g, "agent.test", bought, MIN_OUT, 1000);
        sell_quoted_at(&mut g, exit, 1100);
        exit_signed(&mut g, vec![PromiseResult::Failed, PromiseResult::Failed]);
        assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
    }

    #[test]
    #[should_panic(expected = "exit amount above the agent's holding")]
    fn two_exit_quotes_for_the_full_holding_the_second_sale_is_refused() {
        let (mut g, bought) = judged(Verdict::Allow);
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
        let _ = g.sell(TARGET.into(), U128(5 * MIN_OUT), U128(0));
        exit_signed(&mut g, vec![ok_sig(SIG_A), ok_sig(SIG_B)]);
        ctx("owner.test", 0, 950);
        let _ = g.withdraw_eth(U128(1));
        exit_signed(&mut g, vec![ok_sig(SIG_A)]);
        assert_eq!(holding_of(&g, "agent.test"), MIN_OUT);
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
        let block = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 21);
        g.post_verdict(
            block,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(QUOTE),
            code("bb"),
            false, // not listed: the next check is still possible
        );
        assert_eq!(g.last_code(TARGET.into()).unwrap().id, first);
        let back = verdict_on(&mut g, Verdict::Warn, code("aa"), 30); // same code, any verdict
        assert_eq!(g.last_code(TARGET.into()).unwrap().id, back);
    }

    // 20. only a block substantiated by the target's code, and asked to list, lists the token
    fn block_with(code: Option<Code>, list_target: bool) -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("agent.test", 0, 10);
        let check = g.request_check(TARGET.into(), None);
        ctx("sentinel.test", 0, 11);
        g.post_verdict(
            check,
            Verdict::Block,
            String::new(),
            String::new(),
            U128(QUOTE),
            code,
            list_target,
        );
        ctx("agent.test", 0, 12);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = g.buy(check, U128(VALUE), None);
        }));
        assert!(refused.is_err(), "a blocked check must refuse buy");
        (g, check)
    }

    fn listed(g: &Guard) -> bool {
        g.get_entry("token".into(), TARGET.to_lowercase()).is_some()
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
            report_as(
                &mut g,
                "reporter.test",
                "code",
                &format!("0x{}", n.repeat(64)),
            );
        }
        report_as(&mut g, "reporter.test", "token", TARGET);
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
                format!("code:0x{}", "1".repeat(64)),
                format!("code:0x{}", "2".repeat(64)),
                format!("code:0x{}", "3".repeat(64)),
                format!("token:{}", TARGET.to_lowercase()),
            ]
        );
        assert!(g.list_entries(4, 10).is_empty());
        assert_eq!(page[0].1.reporter, id("reporter.test"));
        ctx("owner.test", 0, 60);
        g.unlist("token".into(), TARGET.into());
        assert_eq!(g.list_entries(0, 50).len(), 3);
    }

    #[test]
    fn list_entries_caps_the_page_size() {
        let mut g = with_reporter(ONE_NEAR);
        for n in 0..=MAX_PAGE {
            let key = format!("0x{}{}", hex(&n.to_be_bytes()[3..]), "0".repeat(62));
            report_as(&mut g, "reporter.test", "code", &key);
        }
        assert_eq!(g.list_entries(0, u32::MAX).len(), MAX_PAGE as usize);
    }
}
