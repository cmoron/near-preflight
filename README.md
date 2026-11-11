# goblin-near

Garde de depense pour agents IA sur NEAR (NEAR Hackathon, piste AI Security & Defense).

Etat reel, jalon 1 : un seul contrat Rust (`src/lib.rs`, near-sdk 5), pas encore deploye, sans sentinelle ni agent.
- `deposit_credit` credite l'appelant du depot attache ; `arm` (proprietaire) arme un budget et une echeance pour un agent.
- `request_check` debite un prix fixe du credit ET du budget ; refus sans credit, sans budget arme, apres l'echeance, au-dela du budget.

Tester : `cargo test` (tests unitaires, sans reseau ni compte). Lint : `cargo clippy --all-targets -- -D warnings`.
Compiler en wasm : `cargo near build non-reproducible-wasm` (sortie `target/near/goblin_near.wasm`).
Licence MIT.
