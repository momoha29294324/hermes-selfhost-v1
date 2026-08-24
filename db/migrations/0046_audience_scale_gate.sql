-- 0046_audience_scale_gate.sql — R7.6-GATE, l'échelle d'audience atteint enfin
-- les portes d'envoi (audit du 21 août 2026, @demo_account_09).
--
-- ---------------------------------------------------------------------------
-- Le problème que cette migration résout
-- ---------------------------------------------------------------------------
--
-- La règle métier « au-delà de 10 000 abonnés attribués, l'entreprise sort du
-- créneau » existe, elle est écrite, publiée et testée depuis R7.6 :
-- `classifyAudienceScale` la calcule, `assessTargetEligibility` la transforme
-- en `OUT_OF_SCOPE`, et `config/commercial-intelligence/example-shadow-v1.json`
-- porte le seuil (`outOfSweetSpotAtOrAbove: 10000`, `hardExcludeOutOfSweetSpot`).
--
-- Le 21 août 2026, `Centre d'Esthétique Auto à Aix` (@demo_account_09,
-- 20 179 abonnés, identité MATCH) est pourtant entré dans un batch de review
-- humaine. Ni la donnée ni la règle ne manquaient : c'est le CÂBLAGE qui
-- manquait. `assessTargetEligibility` n'est appelée que par le rail d'ANALYSE
-- R7 (`evaluateCorpus(..., opportunity)`), jamais par la génération de batch —
-- qui sélectionne sur `stage` et `score` — ni par les deux portes qui décident
-- réellement d'un envoi (`lockManifestForItem`, `evaluateInstagramEligibility`).
-- Ces deux portes ne lisent que la base, et le nombre d'abonnés observé vivait
-- exclusivement dans `var/r7/instagram-maturity/observations.jsonl` (R7.3C §32),
-- donc hors de leur portée.
--
-- ---------------------------------------------------------------------------
-- Ce que cette table porte, et ce qu'elle refuse de porter
-- ---------------------------------------------------------------------------
--
-- UN FAIT DE TAILLE, et son attribution. Rien d'autre. R7.3C §32 refusait
-- d'importer les observations Instagram en base parce qu'une observation
-- entière — biographie, publications, captures, rubriques — deviendrait
-- consultable par le CRM, projetable vers un sous-compte, et finirait par être
-- lue comme un fait établi sur un prospect. Cette objection tient toujours, et
-- la table y répond en n'important qu'un compteur, le compte auquel il est
-- attribué, la date à laquelle il a été lu et la source qui l'a rendu. Le
-- profil complet reste sous `var/`, hors Git, hors Supabase.
--
-- `attributed` est séparée de `followers_count` parce que ce sont deux
-- questions : « qu'avons-nous lu » et « à qui cela appartient-il ». Le corpus
-- porte le cas qui l'exige — un profil à 308 000 abonnés dont l'identité est
-- `UNCORROBORATED`. Un compteur non attribué ne ferme aucune porte.
--
-- `followers_count` est NULLABLE et le reste : un profil ouvert dont le
-- compteur n'a pas été lu est inconnu, pas nul. Une ligne sans compteur
-- n'exclut personne — « ne pas savoir n'est pas savoir le contraire »
-- (CLAUDE.md §2).
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
--   * elle n'insère AUCUNE ligne. La base qui vient de la subir se comporte
--     exactement comme avant : sans observation d'audience, la nouvelle porte
--     passe et journalise « audience non observée » ;
--   * elle ne modifie ni `prospects`, ni `prospect_evidence`, ni
--     `prospect_icp_assessments`. Le verdict ICP n'est ni réécrit, ni élargi :
--     une audience trop grande n'est pas une franchise, et les deux refus
--     restent nommés séparément ;
--   * elle n'efface aucun vote humain, aucun manifeste, aucun message ;
--   * elle n'ouvre aucun chemin d'envoi et ne touche ni `ig_kill_switch`, ni
--     `ig_live_canary_authorizations`, ni `outreach_events`. Elle ne sait que
--     REFUSER davantage.
--
-- Additive au sens strict : aucune colonne supprimée, aucune valeur retirée
-- d'un `check` existant — les deux `check` de motifs de report ci-dessous sont
-- ÉLARGIS, jamais rétrécis.

create table prospect_audience_observations (
  id                uuid primary key default gen_random_uuid(),

  prospect_id       uuid not null references prospects(id) on delete cascade,

  -- Une liste fermée d'un seul élément, aujourd'hui. La colonne existe pour que
  -- le jour où un autre canal porte une audience, le compteur d'Instagram ne
  -- soit pas silencieusement comparé au sien.
  platform          text not null check (platform in ('instagram')),

  -- Le compte RÉELLEMENT ouvert, sans `@`. C'est lui, pas le prospect, qui
  -- porte le compteur : un prospect qui change de handle change d'audience
  -- observée, et la ligne précédente cesse de le décrire.
  handle            text not null check (length(btrim(handle)) between 1 and 120),

  -- Le compteur lu. `null` = profil ouvert mais compteur non lu. Jamais estimé,
  -- jamais complété, jamais arrondi.
  followers_count   int check (followers_count is null or followers_count >= 0),

  -- L'identité du compte a-t-elle été corroborée (`MATCH`) au moment de la
  -- lecture ? `false` ⇒ le compteur n'est pas celui de ce prospect et n'entre
  -- dans aucune décision.
  attributed        boolean not null,

  observed_at       timestamptz not null,

  -- D'où vient le nombre, en toutes lettres : « blob JSON embarqué dans le
  -- document du profil », « meta og:description »… La même exigence de
  -- provenance que `prospect_evidence`.
  source            text not null check (length(btrim(source)) between 1 and 300),

  -- L'exécution de collecte qui l'a produit, quand elle est connue. Permet de
  -- retrouver l'observation complète sous `var/` sans la dupliquer ici.
  observation_run_id text check (observation_run_id is null or length(btrim(observation_run_id)) between 1 and 100),

  imported_at       timestamptz not null default now(),

  -- Qui a demandé l'import. Un fait importé sans demandeur est un fait dont
  -- personne ne répond.
  imported_by       text not null check (length(btrim(imported_by)) between 1 and 120),

  -- Une observation est identifiée par le compte ET l'instant où il a été lu.
  -- Rejouer un import n'invente donc pas d'historique.
  constraint prospect_audience_observation_unique unique (prospect_id, platform, handle, observed_at)
);

create index prospect_audience_observations_latest_idx
  on prospect_audience_observations (prospect_id, platform, observed_at desc);

-- ---------------------------------------------------------------------------
-- Le vocabulaire de refus, élargi d'un motif
-- ---------------------------------------------------------------------------
--
-- `audience_out_of_scope` est TERMINAL au même titre qu'`icp_not_target` : une
-- entreprise trop grande pour notre créneau ne le devient pas moins au
-- prochain essai. Il est nommé séparément parce qu'il dit une autre chose —
-- « hors créneau par la taille » et non « réseau ou franchise constaté » — et
-- qu'un refus qui se déguise en un autre est un refus qu'on relira de travers.
--
-- Aucune valeur n'est retirée : les deux `check` sont reconstruits à
-- l'identique, plus le nouveau motif.

alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_last_skip_reason_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_last_skip_reason_check
  check (last_skip_reason is null or last_skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope'
  ));

alter table ig_job_events drop constraint ig_job_events_skip_reason_check;
alter table ig_job_events add constraint ig_job_events_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope'
  ));
