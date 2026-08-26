-- 0062_manifest_operator_retirement.sql
-- HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — retirer une intention de dispatch
-- AVANT tout effet extérieur, sans supprimer une seule ligne.
--
-- ---------------------------------------------------------------------------
-- Le trou que cette migration ferme
-- ---------------------------------------------------------------------------
-- Le dépôt savait refermer un job pour DEUX raisons, et deux seulement :
--
--   * la POLITIQUE n'autorise plus ce prospect (`ig:queue:invalidate`, §10 de
--     HERMES-SERVICE-SCOPE-TARGETING-R1) — le motif vient de la politique elle-même,
--     et le module refuse d'en inventer un ;
--   * une GARDE a refusé à l'exécution (`evaluateInstagramEligibility`).
--
-- Il ne savait pas refermer un job dont le prospect est TOUJOURS éligible et
-- dont l'intention est intacte, mais dont le TEXTE a été rédigé sous un prompt
-- qu'on ne veut plus envoyer. C'était le cas des trois manifestes du 25 août
-- 2026 (@wash.lh, @laveautocaen, @caautodetail_), figés avant le correctif
-- 0fec132 « obtenir une réponse, pas une qualification ».
--
-- Il n'existait alors AUCUN chemin canonique. Ce qui restait à un opérateur
-- était du SQL à la main — c'est-à-dire la seule façon de se tromper que ce
-- dépôt n'avait pas encore fermée.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration N'AUTORISE PAS
-- ---------------------------------------------------------------------------
-- Aucun envoi. Aucune levée d'arrêt global. Aucun DELETE, aucun UPDATE de
-- contenu : le manifeste garde son texte, son empreinte, son destinataire, sa
-- provenance et son vote d'approbation. Seul son STATUT change, exactement
-- comme lors d'un re-lock (0019/0020) — le patron append-only du dépôt.
--
-- Et surtout : rien ici ne peut s'appliquer à une intention qui a touché le
-- monde. La contrainte `ig_manifest_retirement_never_after_effect` le dit en
-- base, pas dans une consigne.

-- ---------------------------------------------------------------------------
-- 1. Un motif de refus de plus, et il nomme un GESTE HUMAIN
-- ---------------------------------------------------------------------------
--
-- Pourquoi pas `review_required`, `duplicate` ou `icp_not_target` : aucun n'est
-- vrai. Le prospect est éligible, l'identité est confirmée, rien n'est en
-- double, aucun humain n'a de question à trancher. Réutiliser un motif qui dit
-- autre chose rendrait le refus illisible six mois plus tard — le dépôt a déjà
-- écrit ce raisonnement en 0039 pour `INELIGIBLE` contre `REVIEW_REQUIRED`.
--
-- TERMINAL, et sans hésitation : une intention retirée par une personne ne se
-- rouvre pas parce que l'horloge tourne. Ce qui repart, s'il doit repartir, est
-- une intention NEUVE — nouveau brouillon, nouveau vote, nouveau manifeste,
-- nouveau job — et elle passe toutes les portes comme la première fois.
alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_last_skip_reason_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_last_skip_reason_check
  check (last_skip_reason is null or last_skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline', 'service_scope_not_in_scope_only',
    'market_scope_unknown',
    'operator_retired'
  ));

alter table ig_job_events drop constraint ig_job_events_skip_reason_check;
alter table ig_job_events add constraint ig_job_events_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline', 'service_scope_not_in_scope_only',
    'market_scope_unknown',
    'operator_retired'
  ));

-- ---------------------------------------------------------------------------
-- 2. Le journal du geste — l'histoire, conservée en entier
-- ---------------------------------------------------------------------------
--
-- Le manifeste, le vote, le brouillon et le job SURVIVENT tous : rien n'est
-- supprimé nulle part. Cette table ne les remplace pas, elle répond à ce
-- qu'aucun d'eux ne sait dire — QUI a retiré, QUAND, et POURQUOI.
--
-- Le texte est recopié, et ce n'est pas une duplication gratuite : c'est la
-- seule façon que « le vieux message reste reconstructible » ne dépende pas de
-- la survie d'une jointure. Son empreinte l'accompagne, pour que la copie soit
-- vérifiable plutôt que crue.
create table ig_manifest_retirements (
  id uuid primary key default gen_random_uuid(),

  manifest_id   uuid not null references r6b_dispatch_manifests(id),
  -- Nul est un cas NORMAL : un manifeste peut avoir été verrouillé sans que le
  -- job n'ait jamais été enfilé (une porte d'éligibilité a refusé entre les
  -- deux). Retirer l'intention doit rester possible.
  job_id        uuid references ig_dispatch_jobs(id),
  prospect_id   uuid not null references prospects(id),
  batch_item_id uuid not null references r6b_batch_items(id),
  -- L'approbation qui portait cette intention. Elle n'est ni effacée ni
  -- modifiée : elle DIT quelque chose de vrai — la politique a bien approuvé ce
  -- texte-là ce jour-là — et c'est l'intention qui est retirée, pas le fait.
  approval_vote_id uuid not null references r6b_batch_votes(id),

  -- L'état d'AVANT, recopié. Une décision se relit avec l'état qui l'a
  -- produite, jamais avec l'état d'aujourd'hui (même raisonnement qu'en 0057).
  previous_manifest_status text not null check (previous_manifest_status = 'LOCKED'),
  previous_job_status      text,

  -- LA garde de ce round, en base plutôt qu'en consigne : une intention qui a
  -- touché le monde ne se retire pas. Un `SENT`, un `AMBIGUOUS` (ici
  -- `REVIEW_REQUIRED`), un `DELIVERY_FAILED` — tout ce qui a pu produire un
  -- effet — est hors d'atteinte, et la colonne ne peut littéralement pas porter
  -- autre chose que `false`.
  previous_external_effect_attempted boolean not null default false,

  -- Le message retiré, conservé mot pour mot avec son empreinte.
  retired_text        text not null check (length(retired_text) > 0),
  retired_text_sha256 text not null check (retired_text_sha256 ~ '^[0-9a-f]{64}$'),
  recipient           text not null check (length(btrim(recipient)) > 0),

  -- §10 — la révision du dépôt qui a PRODUIT le brouillon, si elle est connue,
  -- et celle sous laquelle le geste est posé. Deux faits distincts : le premier
  -- est la raison du retrait, le second en est le contexte.
  generation_code_revision text
    check (generation_code_revision is null or generation_code_revision ~ '^[0-9a-f]{40}$'),
  retirement_code_revision text
    check (retirement_code_revision is null or retirement_code_revision ~ '^[0-9a-f]{40}$'),

  operator   text not null check (length(btrim(operator)) between 2 and 120),
  reason     text not null check (length(btrim(reason)) between 8 and 600),

  created_at timestamptz not null default now(),

  constraint ig_manifest_retirement_never_after_effect
    check (previous_external_effect_attempted = false),

  -- Un manifeste ne se retire qu'UNE fois dans toute l'histoire. C'est
  -- l'idempotence du geste, portée par la base : rejouer la commande ne peut
  -- pas écrire une seconde ligne, même sous une course.
  constraint ig_manifest_retirement_once unique (manifest_id)
);

create index ig_manifest_retirements_prospect_idx
  on ig_manifest_retirements (prospect_id, created_at desc);

comment on table ig_manifest_retirements is
  'HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — le journal des intentions de dispatch retirées par un opérateur nommé, avant tout effet extérieur. Ne remplace rien : manifeste, vote, brouillon et job survivent tous. Une ligne par manifeste, pour toujours.';

-- ---------------------------------------------------------------------------
-- 3. §10 — sous quelle révision ce brouillon a-t-il été écrit ?
-- ---------------------------------------------------------------------------
--
-- Le défaut à détecter est précis, et il vient d'être vécu :
--
--     un runtime NEUF + un brouillon VERROUILLÉ SOUS L'ANCIEN PROMPT
--     → l'ancien message part.
--
-- Aucune ligne du dépôt ne pouvait le voir. `model_runs` porte le modèle et le
-- coût, jamais la révision du code ; le manifeste porte l'heure du LOCK, qui
-- est postérieure à la rédaction et peut donc être « fraîche » sur un texte
-- périmé. La seule date qui répond est celle de la GÉNÉRATION.
--
-- NULLABLE, et cela veut dire « on ne sait pas » — jamais « c'est à jour ».
-- Toutes les lignes existantes restent nulles : aucune n'est réécrite, et
-- prétendre après coup sous quelle révision un texte de la semaine dernière a
-- été écrit serait exactement l'affirmation sans preuve que CLAUDE.md interdit.
-- `--reuse-messages` la laisse nulle pour la même raison : le texte repris vient
-- d'`outreach_messages`, écrit à une date que cette commande n'a pas observée.
alter table r6b_batch_items
  add column generation_code_revision text
    check (generation_code_revision is null or generation_code_revision ~ '^[0-9a-f]{40}$');

comment on column r6b_batch_items.generation_code_revision is
  'HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 §10 — la révision du dépôt qui a produit original_draft, quand elle est connue. NULL = non observée, jamais « à jour ». Écrite uniquement par r6b:generate --generate-messages, jamais rétroactivement.';
