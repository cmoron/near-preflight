# STATUS (mis a jour 2026-11-11 13:00 UTC)

## Ce qui tourne

- Contrat garde sur testnet `guard.goblin-guard-00044.testnet` : credit prepaye depose par l'humain,
  budget arme en duree, liste de destinataires, verdict poste par la sentinelle seule, achat paye seulement
  sur `allow`, sequestre du prix jusqu'au verdict, remboursement apres 5 min sans verdict, desarmement.
  43 tests unitaires, clippy pedantic propre.
- Sentinelle : trois controles par `eth_simulateV1` (reprise par transferFrom, vente immediate, vente a
  +1 h, taxe contre le devis du pool), sur un fork anvil de Base epingle au bloc 55836672 avec nos 5 jetons
  pieges, et aussi sur Base reel (USDC -> allow). 7 tests.
- Demo de bout en bout `./demo.sh` : arret par la sentinelle, par le contrat, par le protocole (cle
  function-call), temoin USDC paye, depassement du budget refuse. Journal dans le README.

## En cours / prochain (jeudi 12/11)

- Controle du hook Uniswap V4 (bits bas de l'adresse) avec un pool V4 sur le fork.
- `warn` -> approbation humaine (contrat + enveloppe).
- Script de rejeu d'une preuve `proofs/<id>.json`.
- Role « armeur » distinct du proprietaire, bornes de l'humain (montant par armement, duree max, plafond 7 jours).
- Callback sur le virement de `spend` (un destinataire disparu renvoie les fonds sans recrediter l'agent).
- Agent pilote par un vrai LLM (NEAR AI Cloud ?) au lieu d'un script : demande l'avis de Cyril (cle API = compte tiers).

## Bloque

- Rien.

## Attendu de Cyril

- Rien d'urgent. Avant vendredi : decider si on passe au lot B (sentinelle vendue sur le marche d'agents,
  mainnet, quelques USDC : accord requis avant toute depense).
- Samedi : depot GitHub public, video, post X, compte NEAR mainnet pour le prix, soumission.
