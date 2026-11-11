//! Garde de depense : l'agent signe avec une cle function-call limitee a ce
//! contrat ; le contrat tient son credit prepaye et son budget arme.
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

/// Une demande de verdict : la cible EVM, le verdict de la sentinelle et ses raisons.
#[near(serializers = [borsh, json])]
pub struct Check {
    pub agent: AccountId,
    pub target: String,
    pub requested_ns: U64,
    pub verdict: Option<Verdict>,
    pub reasons: String,
    /// Vrai une fois l'achat paye : un verdict ne sert qu'une fois.
    pub settled: bool,
}

/// Plafonds de taille : raisons stockees, preuve seulement journalisee (journal NEAR <= 16 Kio).
const MAX_REASONS: usize = 280;
const MAX_EVIDENCE: usize = 8_000;
/// Delai au-dela duquel l'agent recupere le prix d'une demande restee sans verdict.
/// Majorant du stockage d'une demande (cle, agent <= 64 o, cible 42 o, raisons <= 280 o,
/// surcout du trie) : le prix doit le couvrir, sinon chaque demande ronge le solde du contrat.
const CHECK_STORAGE_BYTES: u128 = 600;
pub const VERDICT_TIMEOUT_NS: u64 = 300 * 1_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    sentinel: AccountId,
    price: u128,
    credits: LookupMap<AccountId, u128>,
    budgets: LookupMap<AccountId, Budget>,
    checks: LookupMap<u64, Check>,
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
    #[init]
    #[must_use]
    pub fn new(owner: AccountId, sentinel: AccountId, price: U128) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "initialisation reservee au contrat"
        );
        require!(
            price.0 >= CHECK_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear(),
            "prix inferieur au stockage d'une demande"
        );
        Self {
            owner,
            sentinel,
            price: price.0,
            credits: LookupMap::new(b"c"),
            budgets: LookupMap::new(b"b"),
            checks: LookupMap::new(b"k"),
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
        require!(amount > 0, "depot nul");
        let previous = self.credits.get(&who).copied();
        let storage_cost = if previous.is_none() {
            let usage = env::storage_usage();
            self.credits.insert(who.clone(), 0); // meme taille que la valeur finale (u128)
            self.credits.flush();
            u128::from(env::storage_usage() - usage) * env::storage_byte_cost().as_yoctonear()
        } else {
            0
        };
        require!(amount > storage_cost, "depot insuffisant pour le stockage");
        self.credits
            .insert(who, previous.unwrap_or(0) + amount - storage_cost);
    }

    /// Reserve au proprietaire : arme `budget` pour `agent` pendant `duration_s` secondes.
    pub fn arm(&mut self, agent: AccountId, budget: U128, duration_s: u64) {
        self.assert_owner();
        let expires_ns =
            env::block_timestamp().saturating_add(duration_s.saturating_mul(1_000_000_000));
        self.budgets.insert(
            agent,
            Budget {
                remaining: budget.0,
                expires_ns,
            },
        );
    }

    /// Arret d'urgence, reserve au proprietaire : retire le budget arme de `agent`.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn disarm(&mut self, agent: AccountId) {
        self.assert_owner();
        self.budgets.remove(&agent);
    }

    /// Debite le prix fixe du credit de l'appelant et du budget arme ; renvoie l'id de la demande.
    /// `target` doit etre une adresse EVM stricte (0x + 40 hexadecimaux).
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn request_check(&mut self, target: String) -> u64 {
        require!(
            is_evm_address(&target),
            "cible invalide : 0x + 40 hexadecimaux"
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
                reasons: String::new(),
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
            "reserve a la sentinelle"
        );
        require!(reasons.len() <= MAX_REASONS, "raisons trop longues");
        require!(evidence.len() <= MAX_EVIDENCE, "preuve trop longue");
        let Some(check) = self.checks.get_mut(&id) else {
            env::panic_str("demande inconnue")
        };
        require!(check.verdict.is_none(), "verdict deja poste");
        require!(!check.settled, "demande deja reglee");
        check.verdict = Some(verdict);
        check.reasons.clone_from(&reasons);
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
    /// pour cette demande, dans le budget arme. Un verdict ne paie qu'un achat.
    pub fn spend(&mut self, id: u64, recipient: AccountId, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let Some(check) = self.checks.get(&id) else {
            env::panic_str("demande inconnue")
        };
        require!(check.agent == who, "demande d'un autre agent");
        require!(!check.settled, "demande deja reglee");
        match check.verdict {
            None => env::panic_str("verdict absent"),
            Some(Verdict::Allow) => {}
            Some(_) => env::panic_str("verdict refuse l'achat"),
        }
        require!(
            self.recipients.contains(&recipient),
            "destinataire non permis"
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
            env::panic_str("demande inconnue")
        };
        require!(check.agent == who, "demande d'un autre agent");
        require!(check.verdict.is_none(), "verdict deja poste");
        require!(!check.settled, "demande deja reglee");
        require!(
            env::block_timestamp() >= check.requested_ns.0.saturating_add(VERDICT_TIMEOUT_NS),
            "delai non ecoule"
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
        require!(credit > 0, "aucun credit a rembourser");
        self.credits.insert(who.clone(), 0);
        Promise::new(who).transfer(NearToken::from_yoctonear(credit))
    }

    /// Reserve au proprietaire : retire des frais percus, jamais plus que leur total.
    pub fn withdraw_fees(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.fees, "retrait au-dela des frais percus");
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

    #[must_use]
    pub fn budget_left(&self, account: &AccountId) -> U128 {
        U128(self.budgets.get(account).map_or(0, |b| b.remaining))
    }

    /// Debite `amount` du budget arme (present, non echu, suffisant) et du credit de `who`.
    fn debit(&mut self, who: &AccountId, amount: u128) {
        let Some(budget) = self.budgets.get(who).copied() else {
            env::panic_str("budget non arme")
        };
        require!(env::block_timestamp() < budget.expires_ns, "budget expire");
        require!(amount <= budget.remaining, "budget depasse");
        let credit = self.credit_of(who).0;
        require!(amount <= credit, "credit insuffisant");
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
        require!(
            env::predecessor_account_id() == self.owner,
            "reserve au proprietaire"
        );
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
        Guard::new(id("owner.test"), id("sentinel.test"), U128(PRICE))
    }

    fn last_event() -> near_sdk::serde_json::Value {
        let log = get_logs().pop().unwrap();
        let json = log.strip_prefix("EVENT_JSON:").expect("prefixe NEP-297");
        near_sdk::serde_json::from_str(json).unwrap()
    }

    /// Credit depose par le proprietaire pour l'agent, budget arme pour `secs` secondes.
    fn funded(credit: u128, budget: u128, secs: u64) -> Guard {
        let mut g = guard();
        ctx("owner.test", credit, 0);
        g.deposit_credit(Some(id("agent.test")));
        g.arm(id("agent.test"), U128(budget), secs);
        g
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
    #[should_panic(expected = "credit insuffisant")]
    fn request_check_refuse_sans_credit_suffisant() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 0);
        let _ = g.refund_credit(); // credit a zero
        ctx("owner.test", 0, 0);
        g.arm(id("agent.test"), U128(100 * U), 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget expire")]
    fn depense_refusee_apres_l_echeance() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, SEC);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget depasse")]
    fn depense_refusee_au_dela_du_budget() {
        let mut g = funded(ONE_NEAR, 15 * U, 1);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget non arme")]
    fn depense_refusee_sans_budget_arme() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit(None);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
    fn seul_le_proprietaire_arme() {
        let mut g = guard();
        ctx("agent.test", 0, 0);
        g.arm(id("agent.test"), U128(100 * U), 1);
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
    #[should_panic(expected = "initialisation reservee au contrat")]
    fn new_refuse_un_tiers() {
        ctx("intrus.test", 0, 0);
        let _ = Guard::new(id("intrus.test"), id("intrus.test"), U128(PRICE));
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
    #[should_panic(expected = "au-dela des frais percus")]
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
    #[should_panic(expected = "reserve au proprietaire")]
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
    #[should_panic(expected = "depot insuffisant pour le stockage")]
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
    #[should_panic(expected = "reserve a la sentinelle")]
    fn seule_la_sentinelle_poste_un_verdict() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into());
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
    }

    #[test]
    #[should_panic(expected = "verdict deja poste")]
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
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
        assert_eq!(g.credit_of(&id("agent.test")).0, credit - 30 * U);
        assert_eq!(g.budget_left(&id("agent.test")).0, 100 * U - PRICE - 30 * U);
        let v = last_event();
        assert_eq!(v["event"], "spent");
        assert_eq!(v["data"][0]["target"], TARGET);
        assert_eq!(v["data"][0]["recipient"], "shop.test");
        assert_eq!(v["data"][0]["amount"], (30 * U).to_string());
    }

    #[test]
    #[should_panic(expected = "verdict refuse l'achat")]
    fn achat_refuse_sur_block() {
        let (mut g, check) = judged(Verdict::Block);
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "verdict refuse l'achat")]
    fn achat_refuse_sur_warn_sans_humain() {
        let (mut g, check) = judged(Verdict::Warn);
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "verdict absent")]
    fn achat_refuse_sans_verdict() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.allow_recipient(id("shop.test"));
        ctx("agent.test", 0, 500);
        let check = g.request_check(TARGET.into());
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "destinataire non permis")]
    fn achat_refuse_vers_un_destinataire_non_permis() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, id("attacker.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "budget depasse")]
    fn achat_refuse_au_dela_du_budget_arme() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, id("shop.test"), U128(100 * U - PRICE + 1));
    }

    #[test]
    #[should_panic(expected = "budget expire")]
    fn achat_refuse_apres_l_echeance() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("agent.test", 0, SEC);
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "demande d'un autre agent")]
    fn achat_refuse_a_un_autre_agent() {
        let (mut g, check) = judged(Verdict::Allow);
        ctx("intrus.test", 0, 700);
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "demande deja reglee")]
    fn un_seul_achat_par_verdict() {
        let (mut g, check) = judged(Verdict::Allow);
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
        let _ = g.spend(check, id("shop.test"), U128(30 * U));
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
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
        ctx("owner.test", 0, 10 * SEC);
        g.arm(id("agent.test"), U128(100 * U), 60);
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
    #[should_panic(expected = "budget non arme")]
    fn le_desarmement_coupe_toute_depense() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("owner.test", 0, 0);
        g.disarm(id("agent.test"));
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
    fn seul_le_proprietaire_desarme() {
        let mut g = funded(ONE_NEAR, 100 * U, 1);
        ctx("agent.test", 0, 0);
        g.disarm(id("agent.test"));
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
    #[should_panic(expected = "delai non ecoule")]
    fn pas_de_remboursement_avant_le_delai() {
        let (mut g, check) = pending();
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS - 1);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "verdict deja poste")]
    fn pas_de_remboursement_apres_un_verdict() {
        let (mut g, check) = pending();
        ctx("sentinel.test", 0, 1);
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "demande inconnue")]
    fn un_seul_remboursement() {
        let (mut g, check) = pending();
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
        g.refund_check(check);
    }

    #[test]
    #[should_panic(expected = "demande inconnue")]
    fn pas_de_verdict_apres_remboursement() {
        let (mut g, check) = pending();
        ctx("agent.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
        ctx("sentinel.test", 0, VERDICT_TIMEOUT_NS);
        g.post_verdict(check, Verdict::Allow, String::new(), String::new());
    }

    #[test]
    #[should_panic(expected = "demande d'un autre agent")]
    fn seul_l_agent_se_fait_rembourser() {
        let (mut g, check) = pending();
        ctx("intrus.test", 0, VERDICT_TIMEOUT_NS);
        g.refund_check(check);
    }

    // 11. le prix d'une demande reste sous sequestre jusqu'au verdict
    #[test]
    #[should_panic(expected = "au-dela des frais percus")]
    fn le_prix_en_attente_n_est_pas_retirable() {
        let (mut g, _check) = pending();
        ctx("owner.test", 0, 0);
        let _ = g.withdraw_fees(U128(PRICE));
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
    #[should_panic(expected = "prix inferieur au stockage d'une demande")]
    fn le_prix_couvre_le_stockage_d_une_demande() {
        ctx("guard.test", 0, 0);
        let _ = Guard::new(id("owner.test"), id("sentinel.test"), U128(U));
    }

    #[test]
    fn un_remboursement_ne_depasse_pas_le_nouvel_armement() {
        let (mut g, check) = pending();
        ctx("owner.test", 0, 0);
        g.arm(id("agent.test"), U128(100 * U), 1000);
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
}
