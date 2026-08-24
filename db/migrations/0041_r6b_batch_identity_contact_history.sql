-- 0041_r6b_batch_identity_contact_history.sql — R7-PILOT §1
--
-- `r6b_batch_items.contact_history` ne savait dire que deux choses :
-- `not_contacted` (aucune ligne `outreach_events` pour CE prospect) et
-- `unknown` (il y en avait, mais on ne se prononçait pas). Les deux réponses
-- portaient sur une LIGNE, jamais sur le commerce.
--
-- Le 19 août 2026, `example-campaign` a recréé `DEMO PROSPECT A` /
-- `@demo_prospect_a` sous un nouvel identifiant. La nouvelle ligne avait bien
-- zéro `outreach_events`, et la carte de review affichait donc « jamais
-- contacté » — pendant que le compte Instagram de ce commerce avait reçu un DM
-- six jours plus tôt sous l'ancienne ligne. Le champ n'a pas menti : il ne
-- savait pas dire la vérité, faute d'une troisième valeur.
--
-- Elle est ajoutée ici. `already_contacted` est écrit quand le GROUPE
-- d'identité (les lignes qui partagent une clé décisive — SIREN, domaine,
-- identifiant de lieu, compte Instagram, e-mail — toutes campagnes confondues)
-- porte au moins une preuve de contact abouti. Voir
-- `src/lib/pipeline/businessContactGuard.ts`.
--
-- Rien n'est réécrit : les lignes existantes gardent leur valeur. Seule la
-- contrainte s'élargit.

alter table r6b_batch_items
  drop constraint if exists r6b_batch_items_contact_history_check;

alter table r6b_batch_items
  add constraint r6b_batch_items_contact_history_check
  check (contact_history in ('not_contacted', 'unknown', 'already_contacted'));
