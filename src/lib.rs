//! Garde de depense : l'agent signe avec une cle function-call limitee a ce
//! contrat ; le contrat tient son credit prepaye et son budget arme.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct Budget {
    remaining: u128,
    expires_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    price: u128,
    credits: LookupMap<AccountId, u128>,
    budgets: LookupMap<AccountId, Budget>,
    /// Frais percus, comptes a part du credit des agents.
    fees: u128,
    next_id: u64,
}

/// Adresse EVM stricte : `0x` + 40 hexadecimaux (42 caracteres, pas un de plus).
fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

#[near]
impl Guard {
    /// A appeler dans la transaction de deploiement (`with-init-call`) : l'appelant
    /// est alors le compte du contrat, et personne ne peut reinitialiser apres.
    #[init]
    #[must_use]
    pub fn new(owner: AccountId, price: U128) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "initialisation reservee au contrat"
        );
        Self {
            owner,
            price: price.0,
            credits: LookupMap::new(b"c"),
            budgets: LookupMap::new(b"b"),
            fees: 0,
            next_id: 0,
        }
    }

    /// Credite l'appelant du depot attache (une cle function-call ne peut pas en attacher).
    /// Un compte neuf paie le stockage de son entree, retenu sur son depot.
    #[payable]
    pub fn deposit_credit(&mut self) {
        let who = env::predecessor_account_id();
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

    /// Reserve au proprietaire : arme un budget pour `agent` jusqu'a `expires_ns`.
    pub fn arm(&mut self, agent: AccountId, budget: U128, expires_ns: u64) {
        self.assert_owner();
        self.budgets.insert(
            agent,
            Budget {
                remaining: budget.0,
                expires_ns,
            },
        );
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
        let budget = self.budgets.get(&who).copied();
        let Some(budget) = budget else {
            env::panic_str("budget non arme")
        };
        require!(env::block_timestamp() < budget.expires_ns, "budget expire");
        require!(self.price <= budget.remaining, "budget depasse");
        let credit = self.credit_of(&who);
        require!(self.price <= credit, "credit insuffisant");
        self.credits.insert(who.clone(), credit - self.price);
        self.fees += self.price;
        self.budgets.insert(
            who.clone(),
            Budget {
                remaining: budget.remaining - self.price,
                ..budget
            },
        );
        self.next_id += 1;
        let event = near_sdk::serde_json::json!({
            "standard": "goblin_guard",
            "version": "1.0.0",
            "event": "check_requested",
            "data": [{ "id": self.next_id, "agent": who, "target": target }],
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
        self.next_id
    }

    /// Rembourse a l'appelant tout son credit inutilise (le stockage retenu a l'ouverture reste acquis).
    pub fn refund_credit(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let credit = self.credit_of(&who);
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

    #[must_use]
    pub fn fees(&self) -> U128 {
        U128(self.fees)
    }

    #[must_use]
    pub fn credit_of(&self, account: &AccountId) -> u128 {
        self.credits.get(account).copied().unwrap_or(0)
    }

    #[must_use]
    pub fn budget_left(&self, account: &AccountId) -> u128 {
        self.budgets.get(account).map_or(0, |b| b.remaining)
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

    const PRICE: u128 = 10;
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
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
        Guard::new(id("owner.test"), U128(PRICE))
    }

    fn funded(credit: u128, budget: u128, expires: u64) -> Guard {
        let mut g = guard();
        ctx("agent.test", credit, 0);
        g.deposit_credit();
        ctx("owner.test", 0, 0);
        g.arm(id("agent.test"), U128(budget), expires);
        g
    }

    #[test]
    fn deposit_credit_credite_le_compte() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit();
        let first = g.credit_of(&id("agent.test"));
        assert!(first > 0 && first < ONE_NEAR); // depot moins le stockage du compte neuf
        ctx("agent.test", 25, 0);
        g.deposit_credit();
        assert_eq!(g.credit_of(&id("agent.test")), first + 25);
        assert_eq!(g.credit_of(&id("autre.test")), 0);
    }

    #[test]
    fn request_check_debite_le_prix_fixe() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        let before = g.credit_of(&id("agent.test"));
        ctx("agent.test", 0, 500);
        assert_eq!(g.request_check(TARGET.into()), 1);
        assert_eq!(g.credit_of(&id("agent.test")), before - PRICE);
        assert_eq!(g.budget_left(&id("agent.test")), 90);
    }

    #[test]
    #[should_panic(expected = "credit insuffisant")]
    fn request_check_refuse_sans_credit_suffisant() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 0);
        let _ = g.refund_credit(); // credit a zero
        ctx("owner.test", 0, 0);
        g.arm(id("agent.test"), U128(100), 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget expire")]
    fn depense_refusee_apres_l_echeance() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 1000);
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget depasse")]
    fn depense_refusee_au_dela_du_budget() {
        let mut g = funded(ONE_NEAR, 15, 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "budget non arme")]
    fn depense_refusee_sans_budget_arme() {
        let mut g = guard();
        ctx("agent.test", ONE_NEAR, 0);
        g.deposit_credit();
        g.request_check(TARGET.into());
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
    fn seul_le_proprietaire_arme() {
        let mut g = guard();
        ctx("agent.test", 0, 0);
        g.arm(id("agent.test"), U128(100), 1000);
    }

    // 1. journal : evenement JSON structure, cible validee
    #[test]
    fn evenement_json_structure() {
        let mut g = funded(ONE_NEAR, 100, 1000);
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
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 500);
        let before = g.credit_of(&id("agent.test"));
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
        assert_eq!(g.credit_of(&id("agent.test")), before);
    }

    // 2. initialiseur reserve au compte du contrat
    #[test]
    #[should_panic(expected = "initialisation reservee au contrat")]
    fn new_refuse_un_tiers() {
        ctx("intrus.test", 0, 0);
        let _ = Guard::new(id("intrus.test"), U128(PRICE));
    }

    // 3. frais perçus et crédit récupérables
    #[test]
    fn frais_comptes_a_part_et_retirables() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        g.request_check(TARGET.into());
        assert_eq!(g.fees(), U128(2 * PRICE));
        ctx("owner.test", 0, 500);
        let _ = g.withdraw_fees(U128(15));
        assert_eq!(g.fees(), U128(2 * PRICE - 15));
    }

    #[test]
    #[should_panic(expected = "au-dela des frais percus")]
    fn retrait_plafonne_aux_frais() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        ctx("owner.test", 0, 500);
        let _ = g.withdraw_fees(U128(PRICE + 1));
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
    fn retrait_reserve_au_proprietaire() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        let _ = g.withdraw_fees(U128(1));
    }

    #[test]
    fn remboursement_du_credit_inutilise() {
        let mut g = funded(ONE_NEAR, 100, 1000);
        ctx("agent.test", 0, 500);
        g.request_check(TARGET.into());
        let left = g.credit_of(&id("agent.test"));
        assert!(left > 0);
        let _ = g.refund_credit();
        assert_eq!(g.credit_of(&id("agent.test")), 0);
        assert_eq!(g.fees(), U128(PRICE)); // les frais restent au proprietaire
    }

    // 4. stockage d'un compte neuf couvert par son depot
    #[test]
    #[should_panic(expected = "depot insuffisant pour le stockage")]
    fn depot_minuscule_refuse_pour_un_compte_neuf() {
        let mut g = guard();
        ctx("agent.test", 1, 0);
        g.deposit_credit();
    }
}
