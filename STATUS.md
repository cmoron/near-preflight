# STATUS (mis a jour 2026-11-11 13:10 UTC)

## Ce qui tourne

- Contrat garde sur testnet `guard.goblin-guard-00044.testnet` : credit prepaye depose par l'humain,
  budget arme en duree, liste de destinataires, verdict poste par la sentinelle seule, achat paye seulement
  sur `allow`, sequestre du prix jusqu'au verdict, remboursement apres 5 min sans verdict, desarmement.
  43 tests unitaires, clippy pedantic propre.
- Sentinelle : trois controles par `eth_simulateV1` (reprise par transferFrom, vente immediate, vente a
  +1 h, taxe contre le devis du pool, a l'achat et aux deux ventes), acheteur neuf a chaque controle, echec
  ferme (block) si la simulation est impossible. Sur un fork anvil de Base epingle au bloc 55836672 avec
  nos 5 jetons pieges, et aussi sur Base reel (USDC -> allow). 8 tests bun.
- Demo de bout en bout `./demo.sh` : arret par la sentinelle, par le contrat, par le protocole (cle
  function-call), temoin USDC paye, depassement du budget refuse. Journal reel dans le README.
- Revue de securite automatique a chaque commit : 9 remarques, 8 corrigees, 1 assumee et documentee
  (verdict lie a la cible seule, destinataire et montant ont leurs propres barrieres).

## Prochain (jeudi 12/11)

- Controle du hook Uniswap V4 (bits bas de l'adresse, positions verifiees dans v4-core `Hooks.sol`) avec un
  pool V4 sur le fork.
- `warn` -> approbation humaine (contrat + enveloppe).
- Script de rejeu d'une preuve `proofs/<id>.json`.
- Role « armeur » distinct du proprietaire, bornes de l'humain (montant par armement, duree max, plafond 7 jours).
- Callback sur le virement de `spend` (un destinataire disparu renvoie les fonds sans recrediter l'agent).
- Retirer la cle complete du compte `guard.` une fois le code fige.
- Agent pilote par un vrai LLM au lieu d'un script (voir « Attendu de Cyril »).

## Non verifie

- Pages testnet.nearblocks.io : repondent 403 a un script ; les transactions sont verifiees par
  `near transaction view-status`.
- docs.near.org n'a pas ete relu page a page : les limites de la cle function-call sont verifiees par
  l'experience (refus « Access key requires full access »), l'API near-api-js 7.5 par ses types installes.

## Bloque

- Rien.

## Attendu de Cyril

- Un LLM pour l'agent : NEAR AI Cloud demande une cle API sur un compte tiers (a toi seul ; 10 $ offerts via
  NEAR Builders). Oui ou non ? Sans, l'agent reste scripte et le README le dit.
- Avant vendredi : lot B (sentinelle vendue sur le marche d'agents, mainnet, quelques USDC) ou pas.
- Samedi : depot GitHub public, video, post X, compte NEAR mainnet pour le prix, soumission.
