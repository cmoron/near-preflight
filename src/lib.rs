//! Garde de depense : l'agent signe avec une cle function-call limitee a ce
//! contrat ; le contrat tient son credit prepaye et son budget arme.
//! Trois roles : l'humain (owner) fixe les bornes, enregistre les agents et garde l'arret
//! d'urgence, l'armeur arme un agent enregistre dans ces bornes, l'agent depense. Chaque
//! armement, desarmement, gel et changement d'armeur est journalise.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

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
    /// Vrai une fois l'achat paye : un verdict ne sert qu'une fois.
    pub settled: bool,
}

/// Plafonds de taille : raisons stockees, preuve seulement journalisee (journal NEAR <= 16 Kio).
const MAX_REASONS: usize = 280;
const MAX_EVIDENCE: usize = 8_000;
/// Delai au-dela duquel l'agent recupere le prix d'une demande restee sans verdict.
/// Majorant du stockage d'une demande (cle 9 o, agent <= 64 o, cible 42 o, raisons <= 280 o,
/// empreinte 64 o, prefixes de longueur, 40 o de surcout par entree) : 534 o au pire cas,
/// mesure par un test. Le prix doit le couvrir, sinon chaque demande ronge le solde du contrat.
const CHECK_STORAGE_BYTES: u128 = 600;
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
    /// Destinataires permis, fixes par le proprietaire.
    recipients: LookupSet<AccountId>,
    /// Frais percus (verdicts rendus), comptes a part du credit des agents.
    fees: u128,
    /// Prix des demandes en attente de verdict : ni a l'agent ni au proprietaire.
    escrow: u128,
    next_id: u64,
}

/// Adresse EVM stricte : `0x` + 40 hexadecimaux (42 caracteres, pas un de plus).
fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
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
    pub fn new(owner: AccountId, armer: AccountId, sentinel: AccountId, price: U128) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "init reserved to the contract account"
        );
        require!(
            price.0 >= CHECK_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear(),
            "price below the storage cost of a check"
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
            recipients: LookupSet::new(b"r"),
            fees: 0,
            escrow: 0,
            next_id: 0,
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
    pub fn request_check(&mut self, target: String) -> u64 {
        require!(
            is_evm_address(&target),
            "invalid target: expected 0x + 40 hex digits"
        );
        let who = env::predecessor_account_id();
        self.debit(&who, self.price);
        self.escrow += self.price;
        self.next_id += 1;
        self.checks.insert(
            self.next_id,
            Check {
                agent: who.clone(),
                target: target.clone(),
                requested_ns: U64(env::block_timestamp()),
                verdict: None,
                judged_ns: U64(0),
                reasons: String::new(),
                evidence_sha256: String::new(),
                settled: false,
            },
        );
        emit(
            "check_requested",
            &near_sdk::serde_json::json!({ "id": self.next_id, "agent": who, "target": target }),
        );
        self.next_id
    }

    /// Reserve a la sentinelle : un verdict par demande, raisons stockees, preuve journalisee.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn post_verdict(&mut self, id: u64, verdict: Verdict, reasons: String, evidence: String) {
        require!(
            env::predecessor_account_id() == self.sentinel,
            "sentinel only"
        );
        require!(reasons.len() <= MAX_REASONS, "reasons too long");
        require!(evidence.len() <= MAX_EVIDENCE, "evidence too long");
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.verdict.is_none(), "verdict already posted");
        require!(!check.settled, "check already settled");
        check.verdict = Some(verdict);
        check.judged_ns = U64(env::block_timestamp());
        check.reasons.clone_from(&reasons);
        check.evidence_sha256 = hex(&env::sha256(evidence.as_bytes()));
        self.escrow -= self.price;
        self.fees += self.price;
        emit(
            "verdict_posted",
            &near_sdk::serde_json::json!({
                "id": id, "verdict": verdict, "reasons": reasons, "evidence": evidence,
            }),
        );
    }

    /// Reserve au proprietaire : permet un destinataire d'achat.
    pub fn allow_recipient(&mut self, account: AccountId) {
        self.assert_owner();
        self.recipients.insert(account);
    }

    /// Paie `amount` a un destinataire permis, sur un verdict `allow` de la sentinelle
    /// pour cette demande, dans le budget arme. Un verdict ne paie qu'un achat, et seulement
    /// celui du jeton controle : `target` doit etre la cible de la demande (casse ignoree).
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn spend(
        &mut self,
        id: u64,
        target: String,
        recipient: AccountId,
        amount: U128,
    ) -> Promise {
        let who = env::predecessor_account_id();
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("unknown check")
        };
        require!(check.agent == who, "check belongs to another agent");
        require!(!check.settled, "check already settled");
        match check.verdict {
            None => env::panic_str("no verdict yet"),
            Some(Verdict::Allow) => {}
            Some(_) => env::panic_str("verdict does not allow the purchase"),
        }
        require!(
            check.target.eq_ignore_ascii_case(&target),
            "target differs from the checked token"
        );
        require!(
            env::block_timestamp() < check.judged_ns.0.saturating_add(VERDICT_TTL_NS),
            "verdict expired"
        );
        require!(
            self.recipients.contains(&recipient),
            "recipient not allowed"
        );
        let target = check.target.clone();
        self.debit(&who, amount.0);
        if let Some(check) = self.checks.get_mut(&id) {
            check.settled = true;
        }
        emit(
            "spent",
            &near_sdk::serde_json::json!({
                "id": id, "agent": who, "target": target, "recipient": recipient, "amount": amount,
            }),
        );
        // ponytail: virement sans rappel ; un destinataire supprime renvoie les fonds au contrat
        // sans recrediter l'agent. Ajouter un callback si des destinataires peuvent disparaitre.
        Promise::new(recipient).transfer(NearToken::from_yoctonear(amount.0))
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

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    /// Unite des montants de test : PRICE = 0,01 NEAR, assez pour le stockage d'une demande.
    const U: u128 = 1_000_000_000_000_000_000_000;
    const PRICE: u128 = 10 * U;
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const SEC: u64 = 1_000_000_000;
    const TARGET: &str = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
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
        assert_eq!(g.request_check(TARGET.into()), 1);
        assert_eq!(g.credit_of(&id("agent.test")).0, before - PRICE);
        assert_eq!(g.budget_left(&id("agent.test")).0, 90 * U);
    }

    #[test]
    #[should_panic(expected = "insufficient credit")]
    fn request_check_refuse_sans_credit_suffisant() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 0);
        let _ = g.refund_credit(); // credit a zero
        arm_at(&mut g, 100 * U, 1, 0);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget expired")]
    fn depense_refusee_apres_l_echeance() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, SEC);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget exceeded")]
    fn depense_refusee_au_dela_du_budget() {
        let mut g = funded(ONE_NEAR, 15 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget not armed")]
    fn depense_refusee_sans_budget_arme() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit(None);
        g.request_check(TARGET.into());
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
        g.request_check(TARGET.into());
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
        g.request_check(TARGET.into());
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
                g.request_check(t.to_string())
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
        );
    }

    // 3. frais perçus et crédit récupérables
    #[test]
    fn frais_comptes_a_part_et_retirables() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let a = g.request_check(TARGET.into());
        let b = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, 500);
        g.post_verdict(a, Verdict::Allow, String::new(), String::new());
        g.post_verdict(b, Verdict::Block, String::new(), String::new());
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
        let a = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, 500);
        g.post_verdict(a, Verdict::Allow, String::new(), String::new());
        ctx("owner.test", 0, 500);
        let _ = g.withdraw_fees(U128(PRICE + 1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn retrait_reserve_au_proprietaire() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        let _ = g.withdraw_fees(U128(1));
    }

    #[test]
    fn remboursement_du_credit_inutilise() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
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
        let check = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, 600);
        g.post_verdict(
            check,
            Verdict::Block,
            "reprise par transferFrom".into(),
            "{\"block\":1}".into(),
        );
        let c = g.get_check(check).unwrap();
        assert_eq!(c.verdict, Some(Verdict::Block));
        assert_eq!(c.reasons, "reprise par transferFrom");
        let v = last_event();
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
        let check = g.request_check(TARGET.into());
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
    }

    #[test]
    #[should_panic(expected = "verdict already posted")]
    fn un_verdict_ne_se_reecrit_pas() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, 600);
        g.post_verdict(check, Verdict::Block, String::new(), String::new());
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
    }

    // 6. achat : verdict allow, destinataire permis, budget, un achat par verdict
    fn judged(verdict: Verdict) -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.allow_recipient(id("shop.test"));
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, 600);
        g.post_verdict(check, verdict, String::new(), String::new());
        ctx("agent.test", 0, 700);
        (g, check)
    }

    #[test]
    fn achat_autorise_debite_et_journalise_la_cible() {
        let (mut g, check) = judged(Verdict::Allow);
        let credit = g.credit_of(&id("agent.test")).0;
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
        assert_eq!(g.credit_of(&id("agent.test")).0, credit - 30 * U);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - 30 * U);
        let v = last_event();
        assert_eq!(v["event"], "spent");
        assert_eq!(v["data"][0]["target"], TARGET);
        assert_eq!(v["data"][0]["recipient"], "shop.test");
        assert_eq!(v["data"][0]["amount"], (30 * U).to_string());
    }

    #[test]
    #[should_panic(expected = "verdict does not allow the purchase")]
    fn achat_refuse_sur_block() {
        let (mut g, check) = judged(Verdict::Block);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "verdict does not allow the purchase")]
    fn achat_refuse_sur_warn_sans_humain() {
        let (mut g, check) = judged(Verdict::Warn);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "no verdict yet")]
    fn achat_refuse_sans_verdict() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.allow_recipient(id("shop.test"));
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into());
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "recipient not allowed")]
    fn achat_refuse_vers_un_destinataire_non_permis() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, TARGET.into(), id("attacker.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "budget exceeded")]
    fn achat_refuse_au_dela_du_budget_arme() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(
            check,
            TARGET.into(),
            id("shop.test"),
            U128(100 * U - PRICE + 1),
        );
    }

    #[test]
    #[should_panic(expected = "budget expired")]
    fn achat_refuse_apres_l_echeance() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("agent.test", 0, SEC);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "check belongs to another agent")]
    fn achat_refuse_a_un_autre_agent() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("intrus.test", 0, 700);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    // un verdict ne paie que l'achat du jeton controle : un allow sur USDC ne paie pas un piege
    #[test]
    #[should_panic(expected = "target differs from the checked token")]
    fn achat_refuse_pour_un_autre_jeton_que_celui_controle() {
        let (mut g, check) = judged(Verdict::Allow);
        let piege = "0xaabfF6E27fdc021573753978741a5F88e01000C8";
        let _ = g.spend(check, piege.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    fn la_cible_de_l_achat_se_compare_sans_la_casse() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, TARGET.to_lowercase(), id("shop.test"), U128(30 * U));
        assert!(g.get_check(check).unwrap().settled);
    }

    #[test]
    #[should_panic(expected = "check already settled")]
    fn un_seul_achat_par_verdict() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn seul_le_proprietaire_permet_un_destinataire() {
        let mut g = guard();
        ctx("agent.test", 0, 0);
        g.allow_recipient(id("attacker.test"));
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
        g.request_check(TARGET.into());
        ctx("agent.test", 0, 70 * SEC);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            g.request_check(TARGET.into())
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
        g.request_check(TARGET.into());
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
        g.request_check(TARGET.into());
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
        let check = g.request_check(TARGET.into());
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
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
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
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
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
        g.post_verdict(check, Verdict::Block, String::new(), "abc".into());
        let v = near_sdk::serde_json::to_value(g.get_check(check).unwrap()).unwrap();
        assert_eq!(
            v["evidence_sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    // agent de 64 caracteres, raisons et preuve au maximum : le prix couvre toujours la demande
    #[test]
    fn le_majorant_couvre_une_demande_au_pire_cas() {
        let big = id(&"a".repeat(64));
        ctx("guard.test", 0, 0);
        // l'agent est aussi la sentinelle : demande et verdict dans le meme contexte de mesure
        let mut g = Guard::new(id("owner.test"), id("armer.test"), big.clone(), U128(PRICE));
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
        let check = g.request_check(TARGET.into());
        g.post_verdict(
            check,
            Verdict::Block,
            "r".repeat(MAX_REASONS),
            "e".repeat(MAX_EVIDENCE),
        );
        g.checks.flush();
        g.credits.flush();
        g.budgets.flush();
        let used = u128::from(env::storage_usage() - before);
        assert!(
            used > 0 && used <= CHECK_STORAGE_BYTES,
            "{used} o pour une demande"
        );
    }

    #[test]
    fn le_verdict_rend_le_prix_retirable() {
        let (mut g, check) = pending();
        ctx("sentinel.test", 0, 1);
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
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
        g.request_check(TARGET.into());
        g.request_check(TARGET.into());
        assert_eq!(g.last_check_id(), 2);
    }

    // 14. un verdict perime ne paie plus : la cible a pu changer depuis le controle
    fn judged_at_1s() -> (Guard, u64) {
        let mut g = funded(ONE_NEAR, 100 * U, 1000);
        ctx("owner.test", 0, 0);
        g.allow_recipient(id("shop.test"));
        ctx("agent.test", 0, 0);
        let check = g.request_check(TARGET.into());
        ctx("sentinel.test", 0, SEC);
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
        (g, check)
    }

    #[test]
    fn le_verdict_date_son_jugement() {
        let (g, check) = judged_at_1s();
        assert_eq!(g.get_check(check).unwrap().judged_ns, U64(SEC));
    }

    #[test]
    fn achat_paye_juste_avant_l_echeance_du_verdict() {
        let (mut g, check) = judged_at_1s();
        ctx("agent.test", 0, SEC + VERDICT_TTL_NS - 1);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
        assert!(g.get_check(check).unwrap().settled);
    }

    #[test]
    #[should_panic(expected = "verdict expired")]
    fn achat_refuse_sur_verdict_perime() {
        let (mut g, check) = judged_at_1s();
        ctx("agent.test", 0, SEC + VERDICT_TTL_NS);
        let _ = g.spend(check, TARGET.into(), id("shop.test"), U128(30 * U));
    }
}
