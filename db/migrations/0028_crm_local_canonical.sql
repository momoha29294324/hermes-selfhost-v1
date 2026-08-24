-- 0028_crm_local_canonical.sql — CRM1, le CRM local devient la destination
-- canonique et GoHighLevel une projection externe optionnelle.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration corrige
-- ---------------------------------------------------------------------------
--
-- R6B-D2/D2.1 a été écrite en supposant qu'un CRM était forcément ailleurs :
-- le dépôt classait une réponse, construisait une charge utile, puis écrivait
-- `SKIPPED_NOT_CONFIGURED` — « aucune destination configurée ». Ce nom porte
-- une affirmation implicite : que le dossier commercial de ce prospect
-- N'EXISTE PAS tant qu'un tiers ne l'a pas reçu, et qu'il faut donc réessayer
-- jusqu'à ce qu'il l'ait reçu.
--
-- C'est faux, et ça l'était déjà : le dossier commercial complet vit dans ce
-- dépôt (`prospects`, `prospect_evidence`, `prospect_research`,
-- `prospect_scores`, `r6b_dispatch_manifests`, `outreach_events`,
-- `r6b_live_send_attempts`, `r6b_inbound_messages`, `r6b_reply_analyses`,
-- `r6b_reply_drafts`, `r6b_prospect_outreach_states`,
-- `r6b_prospect_state_transitions`, `r6b_alerts`). Un CRM externe n'est pas
-- la source de vérité : c'en est une COPIE, utile le jour où quelqu'un d'autre
-- que un opérateur doit lire le dossier.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration NE fait PAS
-- ---------------------------------------------------------------------------
--
--   * elle ne crée aucune table. Le CRM local n'a pas besoin d'un second
--     modèle de données : il a besoin d'une INTERFACE au-dessus de celui qui
--     existe. Dupliquer `prospects` dans un `crm_contacts` produirait deux
--     tables en désaccord dès la première divergence ;
--   * elle ne supprime ni l'adapter GoHighLevel, ni `r6b_crm_destinations`,
--     ni les gardes de D2.1. Une destination externe reste possible, reste
--     soumise à une confirmation humaine en base, et reste refusée par défaut ;
--   * elle n'écrit aucune ligne de projection, n'appelle aucun réseau, et ne
--     relâche aucune garde d'envoi. `OUTBOUND_ALLOW_SENDING` reste à 0.
--
-- ---------------------------------------------------------------------------
-- LOCAL_ONLY
-- ---------------------------------------------------------------------------
--
-- Un seul état nouveau, qui dit ce qui est vrai : le dossier canonique est
-- tenu localement, et aucune projection externe n'a été demandée. Ce n'est ni
-- un échec (`FAILED`), ni un refus (`BLOCKED_*`), ni une attente d'un tiers
-- (`PENDING`) — c'est le régime NORMAL de ce dépôt.
--
-- Il reste repris par `npm run r6b:crm:sync` (voir RETRYABLE_CRM_STATUSES) et
-- c'est délibéré : cette commande est explicite, en dry-run par défaut, et
-- c'est elle qui permettra de rattraper l'historique le jour où une
-- destination externe sera confirmée. « Retentable par une commande qu'on
-- lance » n'est pas « bloquant pour le runtime » — le traitement des réponses,
-- lui, ne s'arrête sur aucun de ces états.

alter table r6b_crm_projections drop constraint r6b_crm_projections_status_check;

alter table r6b_crm_projections add constraint r6b_crm_projections_status_check
  check (status in ('PENDING', 'LOCAL_ONLY', 'SKIPPED_NOT_CONFIGURED', 'BLOCKED_POLICY',
                    'BLOCKED_CONFIG', 'APPLIED', 'FAILED', 'FAILED_PERMANENT'));

-- Les lignes déjà écrites sous l'ancienne sémantique décrivaient déjà un
-- dossier canonique local sans destination externe : elles prennent le nom
-- exact de ce qu'elles sont. Aucune donnée n'est perdue — seul le nom de
-- l'état change, et `updated_at` en garde la trace.
--
-- Aucune ligne n'existe au moment où cette migration est écrite (0 projection
-- en base) ; l'instruction est écrite pour être correcte, pas pour être
-- observée aujourd'hui.
update r6b_crm_projections
   set status = 'LOCAL_ONLY',
       updated_at = now()
 where status = 'SKIPPED_NOT_CONFIGURED';

-- `SKIPPED_NOT_CONFIGURED` reste accepté par la contrainte plutôt que d'être
-- retiré. Une valeur d'énumération retirée d'un `check` fait échouer toute
-- restauration d'une sauvegarde antérieure à cette migration
-- (la documentation d’installation rappelle ce que coûte une base qu'on ne
-- peut pas remonter). Le code, lui, ne l'écrit plus.
