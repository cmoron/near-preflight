# STATUS (mis a jour 2026-11-11 13:35 UTC)

## Ce qui tourne

- Contrat garde sur testnet `guard.goblin-guard-72130.testnet` (code sha256 `7a08a0cc...be359`, egal au wasm local) :
  credit prepaye, roles humain / armeur / agent / sentinelle, bornes de l'humain (0,1 NEAR par armement, 3600 s,
  0,5 NEAR sur 7 jours glissants), agents enregistres par l'humain seuls armables, arret d'urgence qui gele l'agent
  (`disarm` de l'humain, `unfreeze`), revocation de l'armeur (`set_armer`), verdict poste par la sentinelle seule et
  lie a sa preuve (`evidence_sha256`), achat paye seulement sur `allow` de moins de 120 s, remboursement apres 5 min.
  83 tests unitaires, clippy pedantic et fmt propres. Stockage d'une demande au pire cas mesure : 534 o (majorant 600).
- Sentinelle : trois controles par `eth_simulateV1`, preuve `proofs/<id>.json` contenant la chaine `evidence` exacte postee.
- Replay : reverifie tout le contenu de la preuve (requete, chaine, heure du 1er bloc simule, adresses de sonde neuves,
  libelles, rejugement, code, implementation de proxy) et, avec `--check`, l'empreinte, la cible, le verdict, les raisons
  en chaine et l'heure du bloc EVM entre demande et verdict NEAR (verifiable sur Base reel, signale SKIPPED sur le fork).
  49 tests bun (dont un par refus du replay), controle de types `bunx tsc --noEmit` propre.
- Demo `./demo.sh` (code 0) : armement hors bornes refuse, arret par la sentinelle, le contrat et le protocole, temoin
  USDC paye, budget depasse refuse, arret d'urgence -> rearmement refuse -> degel. Replays `--check` concordants pour
  #4 (block) et #5 (allow) sur le fork, #7 (allow) sur Base mainnet ; copies falsifiees -> code 1.

## Prochain

- Controle du hook Uniswap V4 et pool V4 sur le fork.
- `warn` -> approbation humaine.
- Callback sur le virement de `spend`.
- Retirer la cle complete du compte `guard.` une fois le code fige.
- Agent pilote par un vrai LLM (voir « Attendu de Cyril »).

## Non verifie

- `setup.ts` n'a pas ete relance apres le correctif des permissions (0600) : correctif teste par `app/near.test.ts`, fichiers
  du deploiement 72130 passes en 0600 a la main.
- `evm/fork.sh` n'a pas ete relance (le fork tournait deja) ; replay de preuves de plus de quelques minutes sur mainnet.base.org.
- Pages testnet.nearblocks.io (403 a un script) : transactions verifiees par near CLI.

## Bloque

- Rien.

## Attendu de Cyril

- Un LLM pour l'agent : cle API NEAR AI Cloud (oui ou non).
- Permissions 0664 des fichiers de cle de l'instance 00044 et des dossiers du trousseau near-cli (non modifies).
- Avant vendredi : lot B (sentinelle vendue sur le marche d'agents, mainnet) ou pas.
