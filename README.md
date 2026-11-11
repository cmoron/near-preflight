# goblin-near

Garde de depense pour agents IA sur NEAR (NEAR Hackathon, piste AI Security & Defense).

Etat reel, jalon 1 : un seul contrat Rust (`src/lib.rs`, near-sdk 5), pas encore deploye, sans sentinelle ni agent.
- `deposit_credit` credite l'appelant du depot attache ; un compte neuf paie le stockage de son entree, retenu sur son depot.
- `arm` (proprietaire) arme un budget et une echeance pour un agent.
- `request_check(target)` : `target` = adresse EVM stricte (0x + 40 hex) ; debite un prix fixe du credit ET du budget, l'ajoute aux frais percus, emet un evenement `EVENT_JSON:` (NEP-297). Refus sans credit, sans budget arme, apres l'echeance, au-dela du budget.
- `refund_credit` rend a l'agent son credit inutilise ; `withdraw_fees` (proprietaire) retire les frais percus, jamais plus que leur total.
- `new` exige que l'appelant soit le compte du contrat (verifie dans le code, equivalent d'un `#[private]` testable en unitaire) : l'initialiser dans la transaction de deploiement (`with-init-call`), sans fenetre pour un tiers.

Tester : `cargo test` (tests unitaires, sans reseau ni compte). Lint : `cargo clippy --all-targets -- -D warnings`.
Compiler en wasm : `cargo near build non-reproducible-wasm` (sortie `target/near/goblin_near.wasm`). Licence MIT.
