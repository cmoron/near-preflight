//! Garde de depense : l'agent signe avec une cle function-call limitee a ce
//! contrat ; le contrat tient son credit prepaye et son budget arme.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, PanicOnDefault};

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
    next_id: u64,
}

#[near]
impl Guard {
    #[init]
    #[must_use]
    pub fn new(owner: AccountId, price: U128) -> Self {
        Self {
            owner,
            price: price.0,
            credits: LookupMap::new(b"c"),
            budgets: LookupMap::new(b"b"),
            next_id: 0,
        }
    }

    /// Credite l'appelant du depot attache (une cle function-call ne peut pas en attacher).
    #[payable]
    pub fn deposit_credit(&mut self) {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "depot nul");
        let now = self.credit_of(&who);
        self.credits.insert(who, now + amount);
    }

    /// Reserve au proprietaire : arme un budget pour `agent` jusqu'a `expires_ns`.
    pub fn arm(&mut self, agent: AccountId, budget: U128, expires_ns: u64) {
        require!(
            env::predecessor_account_id() == self.owner,
            "reserve au proprietaire"
        );
        self.budgets.insert(
            agent,
            Budget {
                remaining: budget.0,
                expires_ns,
            },
        );
    }

    /// Debite le prix fixe du credit de l'appelant et du budget arme ; renvoie l'id de la demande.
    #[allow(clippy::needless_pass_by_value)] // l'ABI JSON de near-sdk exige un type possede
    pub fn request_check(&mut self, target: String) -> u64 {
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
        self.budgets.insert(
            who.clone(),
            Budget {
                remaining: budget.remaining - self.price,
                ..budget
            },
        );
        self.next_id += 1;
        log!(
            "check_requested id={} agent={who} target={target}",
            self.next_id
        );
        self.next_id
    }

    #[must_use]
    pub fn credit_of(&self, account: &AccountId) -> u128 {
        self.credits.get(account).copied().unwrap_or(0)
    }

    #[must_use]
    pub fn budget_left(&self, account: &AccountId) -> u128 {
        self.budgets.get(account).map_or(0, |b| b.remaining)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    const PRICE: u128 = 10;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, deposit: u128, now_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(id(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now_ns)
            .build());
    }

    fn guard() -> Guard {
        ctx("owner.test", 0, 0);
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
        ctx("agent.test", 25, 0);
        g.deposit_credit();
        g.deposit_credit();
        assert_eq!(g.credit_of(&id("agent.test")), 50);
        assert_eq!(g.credit_of(&id("autre.test")), 0);
    }

    #[test]
    fn request_check_debite_le_prix_fixe() {
        let mut g = funded(25, 100, 1000);
        ctx("agent.test", 0, 500);
        assert_eq!(g.request_check("0xabc".into()), 1);
        assert_eq!(g.credit_of(&id("agent.test")), 15);
        assert_eq!(g.budget_left(&id("agent.test")), 90);
    }

    #[test]
    #[should_panic(expected = "credit insuffisant")]
    fn request_check_refuse_sans_credit_suffisant() {
        let mut g = funded(9, 100, 1000);
        ctx("agent.test", 0, 500);
        g.request_check("0xabc".into());
    }

    #[test]
    #[should_panic(expected = "budget expire")]
    fn depense_refusee_apres_l_echeance() {
        let mut g = funded(100, 100, 1000);
        ctx("agent.test", 0, 1000);
        g.request_check("0xabc".into());
    }

    #[test]
    #[should_panic(expected = "budget depasse")]
    fn depense_refusee_au_dela_du_budget() {
        let mut g = funded(100, 15, 1000);
        ctx("agent.test", 0, 500);
        g.request_check("a".into());
        g.request_check("b".into());
    }

    #[test]
    #[should_panic(expected = "budget non arme")]
    fn depense_refusee_sans_budget_arme() {
        let mut g = guard();
        ctx("agent.test", 10, 0);
        g.deposit_credit();
        g.request_check("a".into());
    }

    #[test]
    #[should_panic(expected = "reserve au proprietaire")]
    fn seul_le_proprietaire_arme() {
        let mut g = guard();
        ctx("agent.test", 0, 0);
        g.arm(id("agent.test"), U128(100), 1000);
    }
}
