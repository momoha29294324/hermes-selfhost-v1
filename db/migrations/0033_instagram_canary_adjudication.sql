-- 0033_instagram_canary_adjudication.sql — IG2.1, trancher l'issue d'un canari
-- déjà tenté, sans jamais retenter.
--
-- Ce que le premier canari a laissé, et pourquoi il manquait un mot
-- -----------------------------------------------------------------
-- Le 14 août, un DM a été cliqué une fois, sur un seul manifeste. Le rail a
-- rendu `AMBIGUOUS` : il avait cliqué, il n'avait pas su prouver. Le job est
-- resté `REVIEW_REQUIRED`, aucun `outreach_event` n'a été écrit, et l'arrêt
-- global a été réengagé. Tout cela était correct.
--
-- Ce qui manquait n'était pas une garde, c'était un VOCABULAIRE. La taxonomie
-- de 0029 connaît « envoyé » et « on ne sait pas » ; elle ne connaît pas
-- « Instagram a refusé de le remettre ». Or c'est un troisième état, et il est
-- distinct des deux autres sur le seul point qui compte pour la suite : rien
-- n'est parti, personne n'a été joint, et pourtant l'unique tentative autorisée
-- a bien été dépensée.
--
-- Le confondre avec `AMBIGUOUS` coûte une information vraie. Le confondre avec
-- `SENT` serait pire : un message non remis reste AFFICHÉ dans le fil, aligné
-- du côté sortant, portant le texte exact — il satisfait donc mot pour mot les
-- quatre preuves « positives » que le rail exigeait. Sans un état qui le nomme,
-- le durcissement de la preuve aurait rendu l'échec indiscernable du succès.
--
-- Ce que cette migration n'autorise pas
-- --------------------------------------
-- Rien. Elle n'insère aucune ligne, ne touche ni `ig_kill_switch`, ni
-- `ig_live_canary_authorizations`, ni `outreach_events`, ni `prospects`. Une
-- base qui vient de la subir est exactement aussi incapable d'envoyer qu'avant.
-- Elle ne rouvre aucun job non plus : `DELIVERY_FAILED` est ABSORBANT, au même
-- titre que `SENT` et `REVIEW_REQUIRED`, et n'apparaît dans aucun index de
-- réclamation.

-- ---------------------------------------------------------------------------
-- 1. Le troisième mot, dans les deux tables qui décrivent une issue
-- ---------------------------------------------------------------------------

alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_status_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_status_check check (
  status in ('PENDING', 'CLAIMED', 'DRY_RUN_VALIDATED',
             'BLOCKED', 'FAILED', 'SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED')
);

-- Absorbant, donc horodaté comme les deux autres. `CLAIMABLE_JOB_STATUSES` ne
-- le contient pas et `ig_dispatch_jobs_claimable_idx` ne l'indexe pas : un job
-- qui porte cet état est hors de la requête de prise, pas « ignoré » par elle.
alter table ig_dispatch_jobs drop constraint ig_job_terminal_has_timestamp;
alter table ig_dispatch_jobs add constraint ig_job_terminal_has_timestamp check (
  (status in ('SENT', 'REVIEW_REQUIRED', 'DELIVERY_FAILED')) = (terminated_at is not null)
);

-- Un échec de LIVRAISON suppose qu'on a tenté de livrer. Sans cette contrainte,
-- le mot pourrait se poser sur un job qui n'a jamais rien tenté — et le
-- compteur « aucun effet Instagram » cesserait de vouloir dire quelque chose.
alter table ig_dispatch_jobs add constraint ig_job_delivery_failed_requires_effect check (
  status <> 'DELIVERY_FAILED' or external_effect_attempted = true
);

alter table ig_job_events drop constraint ig_job_events_status_check;
alter table ig_job_events add constraint ig_job_events_status_check check (
  status in ('DRY_RUN_OK', 'BLOCKED', 'FAILED', 'SENT', 'AMBIGUOUS', 'DELIVERY_FAILED')
);

-- Les trois issues qui supposent un geste chez Instagram n'existent qu'en LIVE,
-- et seulement après ce geste. `DELIVERY_FAILED` rejoint les deux autres.
alter table ig_job_events drop constraint ig_job_event_effectful_outcome_is_live;
alter table ig_job_events add constraint ig_job_event_effectful_outcome_is_live check (
  status not in ('SENT', 'AMBIGUOUS', 'DELIVERY_FAILED')
  or (mode = 'LIVE' and external_effect_attempted = true and job_id is not null and manifest_id is not null)
);

-- ---------------------------------------------------------------------------
-- 2. ig_canary_adjudications — qui a tranché, sur quoi, et avec quelle preuve
-- ---------------------------------------------------------------------------
--
-- Une ligne = une décision humaine sur l'issue d'UNE tentative déjà faite.
--
-- Pourquoi une table plutôt qu'une colonne de plus sur le job : parce qu'une
-- adjudication est un ÉVÉNEMENT daté, signé et argumenté, pas un attribut. Le
-- job dit « où en est cette intention » ; cette table dit « ce jour-là,
-- quelqu'un a regardé la conversation et voici ce qu'il y a vu ». Écraser la
-- première décision par une seconde effacerait précisément ce qu'on veut garder.
create table ig_canary_adjudications (
  id                        uuid primary key default gen_random_uuid(),

  job_id                    uuid not null references ig_dispatch_jobs(id) on delete cascade,
  manifest_id               uuid not null references r6b_dispatch_manifests(id),
  prospect_id               uuid not null references prospects(id),
  -- L'autorisation qui couvrait la tentative adjugée. Une adjudication sans
  -- tentative n'a pas d'objet.
  canary_authorization_id   uuid not null references ig_live_canary_authorizations(id),

  verdict                   text not null check (verdict in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')),

  -- L'humain qui tranche. Même exigence que `ig_kill_switch.set_by` et que
  -- l'armement : « system », « agent » ou une chaîne vide ne sont pas des
  -- auteurs. Une issue d'envoi réel se constate au nom de quelqu'un.
  adjudicated_by            text not null check (length(btrim(adjudicated_by)) between 1 and 120),
  -- Le worker qui a exécuté l'observation, pour rapprocher la ligne d'un log.
  observed_by               text not null check (length(btrim(observed_by)) between 1 and 200),

  -- Ce qui a été VU, tel que `deliveryProof` l'a mesuré : périmètre retenu,
  -- occurrences du texte, côté sortant, marqueurs d'échec, preuves et refus.
  -- Du JSON, parce que la forme de la preuve évoluera avec le DOM d'Instagram —
  -- mais le verdict, lui, reste une union fermée.
  evidence                  jsonb not null default '{}'::jsonb,
  detail                    text not null check (length(btrim(detail)) between 1 and 2000),
  -- Capture d'écran, sous `var/` donc hors Git.
  screenshot_path           text check (screenshot_path is null or length(screenshot_path) <= 500),

  -- Le nombre de requêtes d'écriture refusées par la garde pendant
  -- l'observation. Attendu : 0. Une valeur non nulle veut dire qu'Instagram a
  -- tenté quelque chose de son propre chef et que la garde l'a arrêté — c'est
  -- exactement ce qu'on veut savoir, et c'est pour cela que c'est une colonne
  -- et pas une ligne de log.
  blocked_write_requests    int not null default 0 check (blocked_write_requests >= 0),
  -- Clics posés pour ouvrir la conversation. Aucun ne vise un contrôle d'envoi.
  open_clicks               int not null default 0 check (open_clicks >= 0),

  created_at                timestamptz not null default now()
);

-- UN verdict d'envoi par job, dans toute la base.
--
-- L'index ne porte que sur `SENT` : réexaminer une conversation et confirmer
-- deux fois un échec ne coûte rien, mais deux `SENT` sur le même job voudraient
-- dire deux messages — et il n'y en a eu qu'un. C'est la même logique que
-- `outreach_events_one_sent_per_manifest_idx` (0023), dite dans le vocabulaire
-- du rail Instagram.
create unique index ig_canary_adjudication_one_sent_per_job_idx
  on ig_canary_adjudications (job_id)
  where verdict = 'SENT';

create index ig_canary_adjudications_job_idx on ig_canary_adjudications (job_id, created_at desc);
create index ig_canary_adjudications_manifest_idx on ig_canary_adjudications (manifest_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'adjuge rien : `ig_canary_adjudications` sort vide.
--
-- Elle ne change l'état d'aucun job existant. Le job du 14 août reste
-- `REVIEW_REQUIRED` tant qu'une commande nominative ne l'a pas tranché.
--
-- Elle ne lève pas l'arrêt global, n'arme aucune autorisation, et n'écrit
-- aucun `outreach_event`.
