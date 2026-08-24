-- 0039_instagram_ig3_queue_scheduling.sql — IG3, ordonnancement, éligibilité,
-- cycle de vie (mission « IG3.1 — QUEUE + SCHEDULING + CAPS + DRY-RUN
-- PRODUCTION »).
--
-- Ce que cette migration ajoute, et ce qu'elle refuse d'ajouter
-- -------------------------------------------------------------
-- Elle n'crée PAS une seconde file. `ig_dispatch_jobs` (0029) reste la seule,
-- et la mission le demande explicitement : « Réutilise l'existant au lieu de
-- créer une seconde architecture ». Ce qui manquait n'était pas une table,
-- c'était trois choses que la file ne savait pas dire :
--
--   1. « pas maintenant » — un report d'ordonnancement, distinct d'un refus.
--      Tout ce qui n'aboutissait pas devenait `BLOCKED`, mot qui servait aussi
--      bien à « le plafond horaire est atteint » (vrai pendant dix minutes)
--      qu'à « ce prospect recrute des franchisés » (vrai pour toujours). Deux
--      durées de vie sous un seul mot, donc un rejeu qui ne pouvait pas être
--      correct dans les deux cas.
--   2. « plus jamais, pour une raison métier » — `SENT`, `REVIEW_REQUIRED` et
--      `DELIVERY_FAILED` étaient les seuls états absorbants, et tous les trois
--      supposent qu'on a tenté quelque chose. Il n'existait aucun mot pour un
--      travail qu'on refuse AVANT de rien tenter et qu'on ne reprendra pas.
--   3. « pourquoi », dans un vocabulaire fermé et interrogeable. `last_detail`
--      est une phrase pour un humain ; on ne compte pas des phrases.
--
-- Elle n'insère aucune ligne, ne modifie aucune ligne existante, ne touche ni
-- `ig_kill_switch` (qui reste armé), ni `ig_live_canary_authorizations` (qui
-- reste vide), ni `outreach_events`, ni `prospects`, ni
-- `r6b_dispatch_manifests`. Une base qui vient de la subir est exactement aussi
-- incapable d'envoyer qu'avant : rien ici ne crée de chemin d'effet, et le seul
-- qui existe (IG2) garde ses gardes intactes.
--
-- Additive au sens strict : aucune colonne supprimée, aucune valeur de statut
-- retirée d'un `check`. `DRY_RUN_OK` reste accepté dans `ig_job_events` alors
-- que le worker écrit désormais `DRY_RUN_COMPLETED` — les lignes d'hier
-- décrivent des faits d'hier, et une migration qui les rendrait illégales
-- effacerait la preuve qu'ils ont eu lieu.

-- ---------------------------------------------------------------------------
-- 1. Le vocabulaire fermé des reports et des refus
-- ---------------------------------------------------------------------------
--
-- Vingt-quatre motifs, et rien d'autre. Une chaîne libre aurait laissé chaque
-- appelant inventer le sien — « cap » ici, « rate_limit » là — et rendu
-- impossible la question que pose la mission au §9 : « raison des skips »,
-- comptée, pas lue.
--
-- Le domaine (`InstagramSkipReason`) porte la même liste, et le classement
-- TEMPORARY/TERMINAL qui va avec. La base ne réplique pas ce classement motif
-- par motif — elle contraint la propriété qui compte vraiment, plus bas : un
-- refus TERMINAL ne peut pas s'écrire sur un job qui reste réclamable.
--
-- Défini deux fois plutôt qu'en `domain` partagé : `ig_dispatch_jobs` porte le
-- DERNIER motif d'un job, `ig_job_events` porte celui d'un événement précis.
-- Ce sont deux colonnes de nature différente qui partagent une liste, pas une
-- liste dont on aurait extrait deux colonnes.

-- ---------------------------------------------------------------------------
-- 2. ig_dispatch_jobs — deux états de plus
-- ---------------------------------------------------------------------------
--
--   SKIPPED     — reporté. Réclamable, et `not_before` porte la date à
--                 laquelle la condition qui a reporté aura pu changer. C'est
--                 l'état d'un plafond atteint, d'une fenêtre horaire fermée,
--                 d'un intervalle de cadence non écoulé.
--
--   INELIGIBLE  — refusé pour une raison métier, définitivement. Absorbant, et
--                 la seule issue absorbante qui n'a JAMAIS rien tenté : la
--                 contrainte `ig_job_ineligible_has_no_effect` l'impose. C'est
--                 l'état d'un prospect hors ICP, d'un opt-out, d'un doublon,
--                 d'un contact déjà établi.
--
-- Pourquoi `INELIGIBLE` plutôt que réutiliser `REVIEW_REQUIRED` : ce dernier
-- veut dire « on ne sait pas ce qui s'est passé chez Instagram, un humain doit
-- trancher » (0029). Un prospect hors ICP ne pose aucune question à personne —
-- la réponse est connue, et confondre les deux mettrait dans la file d'attente
-- humaine des lignes qui n'ont rien à y faire.
alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_status_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_status_check check (
  status in ('PENDING', 'CLAIMED', 'DRY_RUN_VALIDATED', 'SKIPPED',
             'BLOCKED', 'FAILED', 'SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED',
             'INELIGIBLE')
);

-- Quatre absorbants désormais. Même règle qu'en 0033 : un état de fin porte sa
-- date de fin, et lui seul.
alter table ig_dispatch_jobs drop constraint ig_job_terminal_has_timestamp;
alter table ig_dispatch_jobs add constraint ig_job_terminal_has_timestamp check (
  (status in ('SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED', 'INELIGIBLE'))
  = (terminated_at is not null)
);

-- Un refus métier n'a rien tenté. Sans cette contrainte, `INELIGIBLE` pourrait
-- se poser sur un job qui a cliqué, et le compteur « effets Instagram réels »
-- (qui lit `external_effect_attempted`) resterait juste tandis que l'état du
-- job mentirait sur ce qui lui est arrivé.
alter table ig_dispatch_jobs add constraint ig_job_ineligible_has_no_effect check (
  status <> 'INELIGIBLE' or external_effect_attempted = false
);

alter table ig_dispatch_jobs
  add column last_skip_reason text check (last_skip_reason is null or last_skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing'
  ));

alter table ig_dispatch_jobs
  add column last_skip_class text check (last_skip_class is null or last_skip_class in ('TEMPORARY', 'TERMINAL'));

-- Combien de fois ce job a été reporté. Sert à voir, dans `ig:queue --status`,
-- un job qui tourne en rond sans jamais aboutir — un plafond mal réglé, une
-- fenêtre trop étroite, un prospect qu'on ne rattrapera jamais.
alter table ig_dispatch_jobs add column skip_count int not null default 0 check (skip_count >= 0);

-- La date à laquelle le worker AURAIT agi, telle que l'ordonnanceur l'a
-- calculée à la dernière évaluation. Distincte de `not_before`, qui est une
-- borne de réclamation : celle-ci est une réponse à « quand », y compris quand
-- le job reste réclamable parce qu'on est en DRY-RUN.
alter table ig_dispatch_jobs add column last_planned_for timestamptz;

alter table ig_dispatch_jobs add column last_dry_run_at timestamptz;

-- LA contrainte de la mission §8 : « un blocage métier terminal ne doit pas
-- être rejoué ». Elle n'est pas écrite comme une intention du worker mais comme
-- une impossibilité : un motif classé TERMINAL ne peut s'inscrire que sur un
-- job qui a cessé d'être réclamable. Un code qui voudrait « juste reporter »
-- un opt-out verrait sa transaction refusée.
--
-- L'inverse n'est pas contraint, et c'est voulu : un job `SENT` peut porter un
-- `last_skip_class = 'TEMPORARY'` hérité d'un report d'il y a trois jours. Une
-- histoire n'a pas à être réécrite parce qu'elle s'est bien terminée.
alter table ig_dispatch_jobs add constraint ig_job_terminal_skip_is_absorbing check (
  last_skip_class is distinct from 'TERMINAL'
  or status in ('SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED', 'INELIGIBLE')
);

-- Un refus définitif nomme sa raison, dans le vocabulaire fermé. « Inéligible,
-- sans plus » serait exactement l'affirmation sans preuve que l'interdit n°2 de
-- CLAUDE.md refuse.
alter table ig_dispatch_jobs add constraint ig_job_ineligible_names_its_reason check (
  status <> 'INELIGIBLE'
  or (last_skip_reason is not null and last_skip_class = 'TERMINAL')
);

-- L'index de prise apprend le nouvel état réclamable. `INELIGIBLE` n'y figure
-- pas : comme `SENT`, il est HORS de la requête de prise, pas ignoré par elle.
drop index ig_dispatch_jobs_claimable_idx;
create index ig_dispatch_jobs_claimable_idx
  on ig_dispatch_jobs (not_before asc, created_at asc)
  where status in ('PENDING', 'DRY_RUN_VALIDATED', 'BLOCKED', 'FAILED', 'SKIPPED');

-- La lecture « qu'est-ce qui est reporté, et pourquoi ? » du CLI opérateur.
create index ig_dispatch_jobs_skipped_idx
  on ig_dispatch_jobs (last_skip_reason, not_before asc)
  where status = 'SKIPPED';

-- ---------------------------------------------------------------------------
-- 3. ig_job_events — le cycle de vie, pas seulement les issues
-- ---------------------------------------------------------------------------
--
-- Le journal ne portait que des CONCLUSIONS : une ligne quand on savait
-- comment ça s'était terminé. Un worker tué entre la prise et la conclusion ne
-- laissait donc rien — ni « j'ai pris ce job », ni « j'ai commencé ». La
-- reprise de bail (`recoverExpiredLeases`) rattrapait l'état du job, mais
-- personne ne pouvait dire, en lisant le journal, ce que ce worker avait eu le
-- temps de faire.
--
-- Cinq statuts de plus, tous sans effet par construction (contrainte plus
-- bas) :
--
--   ENQUEUED          — une intention est entrée dans la file.
--   CLAIMED           — un worker nommé a pris le bail.
--   SKIPPED           — l'ordonnanceur a dit « pas maintenant », et dit quand.
--   DRY_RUN_STARTED   — le traitement commence. Un STARTED sans conclusion est
--                       la signature exacte d'un worker mort en route.
--   DRY_RUN_COMPLETED — le traitement est allé au bout sans rien envoyer.
--                       C'est le mot de la mission §10 ; `DRY_RUN_OK` était le
--                       mot d'IG-R1 et reste accepté pour les lignes d'hier.
--   REVIEW_REQUIRED   — une issue a été renvoyée à un humain.
alter table ig_job_events drop constraint ig_job_events_status_check;
alter table ig_job_events add constraint ig_job_events_status_check check (
  status in ('ENQUEUED', 'CLAIMED', 'SKIPPED', 'DRY_RUN_STARTED', 'DRY_RUN_COMPLETED',
             'REVIEW_REQUIRED',
             'DRY_RUN_OK', 'BLOCKED', 'FAILED', 'SENT', 'AMBIGUOUS', 'DELIVERY_FAILED')
);

-- La garde structurelle du DRY-RUN, reconduite mot pour mot sur le vocabulaire
-- élargi : en mode DRY_RUN, aucun effet déclaré, et aucun statut qui supposerait
-- un envoi. Le jour où un bug ferait envoyer un dry-run, la ligne d'audit serait
-- REFUSÉE — la transaction échouerait plutôt que de consigner un mensonge.
alter table ig_job_events drop constraint ig_job_event_dry_run_has_no_effect;
alter table ig_job_events add constraint ig_job_event_dry_run_has_no_effect check (
  mode <> 'DRY_RUN'
  or (external_effect_attempted = false
      and status in ('ENQUEUED', 'CLAIMED', 'SKIPPED', 'DRY_RUN_STARTED', 'DRY_RUN_COMPLETED',
                     'REVIEW_REQUIRED', 'DRY_RUN_OK', 'BLOCKED', 'FAILED'))
);

-- Et la même chose vue depuis les statuts plutôt que depuis le mode : les cinq
-- événements de cycle de vie ne peuvent porter aucun effet, quel que soit le
-- mode. Un `CLAIMED` en LIVE qui prétendrait avoir cliqué serait refusé — prendre
-- un bail n'a jamais envoyé quoi que ce soit.
alter table ig_job_events add constraint ig_job_event_lifecycle_has_no_effect check (
  status not in ('ENQUEUED', 'CLAIMED', 'SKIPPED', 'DRY_RUN_STARTED', 'DRY_RUN_COMPLETED')
  or external_effect_attempted = false
);

-- L'ordre d'écriture, rendu total.
--
-- `created_at` ne suffit plus. Le worker écrit maintenant `CLAIMED` puis
-- `DRY_RUN_STARTED` coup sur coup, et `now()` — l'horodatage de début de
-- transaction — peut rendre la MÊME valeur aux deux : sur une base rapide, les
-- deux inserts tiennent dans la même microseconde. Trier sur `created_at, id`
-- revenait alors à trier sur un UUID aléatoire, c'est-à-dire à rendre l'ordre
-- des faits non déterministe — dans la table dont le seul rôle est de dire
-- dans quel ordre les choses se sont passées.
--
-- `bigserial` donne un ordre total, croissant, indépendant de l'horloge. Les
-- lignes existantes reçoivent une valeur dans leur ordre physique, qui est leur
-- ordre d'insertion : l'historique garde son sens.
alter table ig_job_events add column seq bigserial;

create index ig_job_events_seq_idx on ig_job_events (job_id, seq asc);

alter table ig_job_events
  add column skip_reason text check (skip_reason is null or skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing'
  ));

alter table ig_job_events
  add column skip_class text check (skip_class is null or skip_class in ('TEMPORARY', 'TERMINAL'));

-- « Quand », persisté. C'est la moitié de la question que pose la mission :
-- « observer exactement ce que le worker aurait envoyé ET QUAND ». Une raison
-- de report sans date de reprise ne répond qu'à la première moitié.
alter table ig_job_events add column next_eligible_at timestamptz;

alter table ig_job_events add constraint ig_job_event_skip_names_its_reason check (
  status <> 'SKIPPED' or (skip_reason is not null and skip_class is not null)
);

-- La lecture « raison des skips » du CLI opérateur (§9), sur un journal dominé
-- par des lignes qui ne sont pas des skips.
create index ig_job_events_skipped_idx
  on ig_job_events (created_at desc)
  where status = 'SKIPPED';

-- ---------------------------------------------------------------------------
-- 4. ig_enqueue_decisions — le verdict d'éligibilité, y compris quand il refuse
-- ---------------------------------------------------------------------------
--
-- Une ligne = une question posée (« ce prospect peut-il entrer dans la file
-- Instagram ? ») et sa réponse datée, motivée, signée. Append-only.
--
-- Pourquoi une table plutôt qu'un simple `throw` : un refus qui ne laisse pas
-- de trace n'est pas contestable, et n'est pas comptable. La mission §2 demande
-- un verdict EXPLICABLE — `ELIGIBLE`, `INELIGIBLE:<reason>`,
-- `REVIEW_REQUIRED:<reason>` — et §10 demande que `REVIEW_REQUIRED` soit un
-- événement durable. Un prospect qu'on a refusé quatre fois pour quatre raisons
-- différentes raconte quelque chose ; quatre exceptions perdues dans un
-- terminal ne racontent rien.
--
-- Et surtout : c'est ici que se lit la réponse à « pourquoi demo_prospect_a
-- n'est-il jamais revenu dans la file ? ». Pas dans l'absence d'une ligne —
-- une absence ne prouve rien — mais dans la présence d'un refus daté portant
-- `icp_not_target`.
--
-- Ce que cette table N'EST PAS : une file. Elle ne porte ni bail, ni worker, ni
-- tentative. Un verdict `ELIGIBLE` crée un job dans `ig_dispatch_jobs` et
-- pointe dessus ; les deux autres verdicts ne créent rien du tout.
create table ig_enqueue_decisions (
  id                uuid primary key default gen_random_uuid(),

  -- Nullables tous les deux : un manifeste introuvable ou un identifiant erroné
  -- doit pouvoir être refusé ET journalisé. Un refus qu'on ne peut pas écrire
  -- parce que la clé étrangère ne résout pas est un refus invisible.
  prospect_id       uuid references prospects(id),
  manifest_id       uuid references r6b_dispatch_manifests(id),
  requested_manifest_id text not null check (length(btrim(requested_manifest_id)) between 1 and 200),

  action            text not null check (action in ('first_touch_dm')),
  expected_handle   text check (expected_handle is null or expected_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  verdict           text not null check (verdict in ('ELIGIBLE', 'INELIGIBLE', 'REVIEW_REQUIRED')),

  -- Le code machine (vocabulaire fermé côté domaine) et la phrase humaine.
  -- Les deux, pas l'un ou l'autre : on compte le premier, on lit le second.
  reason_code       text not null check (length(btrim(reason_code)) between 1 and 80),
  reason            text not null check (length(btrim(reason)) between 1 and 1000),

  -- Chaque porte évaluée et son verdict : [{gate, verdict, detail}]. Écrit même
  -- quand tout passe — savoir qu'une porte a été ÉVALUÉE est aussi utile que
  -- savoir qu'elle a refusé (même raisonnement que `ig_job_events.gates`).
  gates             jsonb not null default '[]'::jsonb,

  job_id            uuid references ig_dispatch_jobs(id),
  -- `true` seulement si CE verdict a créé le job. Un second enfilement du même
  -- manifeste pointe le job existant avec `job_created = false` : l'idempotence
  -- se voit dans le journal, elle ne s'y devine pas.
  job_created       boolean not null default false,

  requested_by      text not null check (length(btrim(requested_by)) between 1 and 200),
  created_at        timestamptz not null default now(),

  -- Un job ne peut être rattaché qu'à un verdict favorable. C'est la garde qui
  -- rend la table utile plutôt que décorative : elle interdit, en base, qu'un
  -- refus s'accompagne quand même d'une entrée en file.
  constraint ig_enqueue_job_only_when_eligible check (job_id is null or verdict = 'ELIGIBLE'),
  constraint ig_enqueue_created_implies_job check (job_created = false or job_id is not null)
);

create index ig_enqueue_decisions_prospect_idx on ig_enqueue_decisions (prospect_id, created_at desc);
create index ig_enqueue_decisions_manifest_idx on ig_enqueue_decisions (manifest_id, created_at desc);
-- La lecture d'audit : « qui a été écarté de la file, et depuis quand ? ».
create index ig_enqueue_decisions_refused_idx
  on ig_enqueue_decisions (created_at desc)
  where verdict <> 'ELIGIBLE';

-- ---------------------------------------------------------------------------
-- 5. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'insère aucune ligne, dans aucune table.
--
-- Elle ne lève pas l'arrêt global : `ig_kill_switch` n'est pas touché, et la
-- ligne qui s'y trouve dit `engaged = true`.
--
-- Elle n'arme aucune autorisation canari, et n'en assouplit aucune garde :
-- `ig_live_canary_authorizations` garde son index unique partiel « une seule
-- armée », sa fenêtre d'expiration et son plafond d'une tentative.
--
-- Elle ne rouvre aucun job existant. Le seul job de la base
-- (`demo_prospect_a`, `DELIVERY_FAILED`, effet externe tenté) garde son état
-- absorbant : `DELIVERY_FAILED` n'est ni dans l'index de réclamation, ni dans
-- la liste des statuts réclamables du domaine, et son prospect porte par
-- ailleurs un verdict ICP `NOT_TARGET` qui interdit désormais tout nouvel
-- enfilement.
--
-- Elle ne modifie ni `prospects`, ni `prospect_evidence`, ni
-- `r6b_dispatch_manifests`, ni `outreach_events`, ni aucune table R6B, ni
-- aucune table de test contrôlé (0035–0037).
