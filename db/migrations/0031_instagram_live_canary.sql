-- 0031_instagram_live_canary.sql — IG2, canari LIVE mono-manifeste
-- (mission « IG2 — LIVE CANARY MONO-MANIFESTE »).
--
-- Ce que cette migration rend possible, et ce qu'elle refuse
-- ---------------------------------------------------------
-- Elle crée l'autorisation nominative sans laquelle aucun DM Instagram ne peut
-- partir, et l'horodatage durable qui distingue « jamais tenté » de « tenté,
-- issue inconnue ».
--
-- Ce qu'elle n'autorise pas : rien. Elle n'insère aucune ligne. Une base qui
-- vient de la subir est exactement aussi incapable d'envoyer qu'avant — il n'y
-- a pas d'autorisation, et l'arrêt global reste ce qu'il était.
--
-- Pourquoi une table plutôt qu'une constante du code
-- --------------------------------------------------
-- R6B-C.2B avait fait l'inverse : `R6B_LIVE_ARMED_MANIFEST_ID` est une
-- constante, et le commentaire de 0029 promettait la même chose pour Instagram
-- (« le choix d'un jour ouvrir un canari LIVE sera un diff dans le code »).
--
-- Ce n'est pas ce qui est fait ici, et la raison est une différence de nature
-- entre les deux missions. Une constante arme POUR TOUJOURS : tant que la ligne
-- n'est pas modifiée, la porte reste ouverte à chaque invocation, et c'est
-- l'environnement (`OUTBOUND_ALLOW_SENDING`) qui doit refermer. La mission IG2
-- demande l'inverse — une autorisation qui EXPIRE, qui se CONSOMME
-- atomiquement, qui porte le nom de son auteur, et qu'un redémarrage ne peut
-- pas recréer. Aucune de ces quatre propriétés ne peut vivre dans une
-- constante : un `const` ne sait pas expirer, et un processus qui redémarre le
-- relit intact.
--
-- La garde ne s'en trouve pas affaiblie, elle change de forme :
--   * une ligne ARMED ne naît que d'une commande humaine explicite, nominative,
--     qui doit nommer le manifeste, l'action, le handle et les deux empreintes ;
--   * un seul ARMED peut exister à la fois (index unique partiel) ;
--   * la consommation est un `update … where state = 'ARMED'` — donc un seul
--     worker peut cliquer, quelle que soit la fenêtre de course ;
--   * elle porte une date d'expiration courte, vérifiée par la base à la
--     consommation, pas seulement par le code qui la lit.

-- ---------------------------------------------------------------------------
-- 1. ig_live_canary_authorizations — le droit de cliquer, une fois
-- ---------------------------------------------------------------------------
--
-- Une ligne = une autorisation d'UN effet externe, sur UNE cible exacte,
-- pendant UNE fenêtre courte.
--
-- Aucun caractère générique nulle part : ni `manifest_id = '*'`, ni
-- `action = 'any'`, ni `max_external_attempts` réglable. Les quatre colonnes
-- d'identité (manifeste, action, handle, empreintes) sont comparées à égalité
-- au moment de consommer ; une autorisation ne peut donc pas « couvrir » un
-- voisin, ni suivre un manifeste qui aurait bougé après l'armement.
create table ig_live_canary_authorizations (
  id                        uuid primary key default gen_random_uuid(),

  -- La cible, figée à l'armement. `manifest_id` est unique tout court : une
  -- seconde autorisation pour le même manifeste, même après consommation,
  -- demanderait une nouvelle décision humaine — et cette décision-là devra
  -- supprimer la ligne ou changer de manifeste, jamais « réarmer » celle-ci.
  manifest_id               uuid not null unique references r6b_dispatch_manifests(id),
  prospect_id               uuid not null references prospects(id),
  action                    text not null check (action in ('first_touch_dm')),
  transport                 text not null check (transport in ('instagram_dm')),

  -- La destination exacte et les deux empreintes attendues. Recopiées depuis le
  -- manifeste au moment de l'armement, puis comparées à ce que le worker relit
  -- juste avant de cliquer : si le manifeste a changé entre les deux,
  -- l'autorisation ne correspond plus à rien et refuse.
  expected_handle           text not null check (expected_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  approved_text_sha256      text not null check (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  transport_payload_sha256  text not null check (transport_payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- L'humain qui autorise. Même exigence que `ig_kill_switch.set_by` et que
  -- `r6b_crm_destinations` (0027) : « system », « agent » ou une chaîne vide ne
  -- sont pas des auteurs. Un envoi réel se fait au nom de quelqu'un.
  armed_by                  text not null check (length(btrim(armed_by)) between 1 and 120),
  reason                    text not null check (length(btrim(reason)) between 1 and 500),

  state                     text not null check (state in ('ARMED', 'CONSUMED', 'EXPIRED', 'REVOKED')),

  -- Un. Pas « configurable à un » : la contrainte n'accepte pas d'autre valeur.
  -- La colonne existe pour que la règle soit LISIBLE dans la table plutôt que
  -- seulement vraie dans un `where`.
  max_external_attempts     int not null default 1 check (max_external_attempts = 1),
  external_attempts_used    int not null default 0 check (external_attempts_used >= 0),

  -- Courte par construction : la borne haute est dans le code qui arme
  -- (`MAX_CANARY_TTL_MS`), mais une autorisation sans échéance est ici
  -- impossible — la colonne est `not null`.
  expires_at                timestamptz not null,

  armed_at                  timestamptz not null default now(),
  -- Horodaté au moment de la RÉSERVATION, donc avant le clic : c'est la trace
  -- qui survit à un processus tué pendant l'envoi.
  consumed_at               timestamptz,
  consumed_by               text check (consumed_by is null or length(btrim(consumed_by)) between 1 and 200),
  -- Le job qui a consommé l'autorisation. Renseigné dans la même écriture.
  consumed_job_id           uuid references ig_dispatch_jobs(id),
  closed_at                 timestamptz,
  closed_by                 text check (closed_by is null or length(btrim(closed_by)) between 1 and 200),
  closed_reason             text check (closed_reason is null or length(closed_reason) <= 500),

  created_at                timestamptz not null default now(),

  -- Consommée veut dire : une tentative comptée, un instant daté, un worker
  -- nommé. Les trois ensemble ou aucun — une consommation partielle serait un
  -- état dont personne ne saurait dire s'il a cliqué.
  constraint ig_canary_consumed_is_complete check (
    (state = 'CONSUMED') = (consumed_at is not null)
    and (consumed_at is null) = (consumed_by is null)
    and (state <> 'CONSUMED' or external_attempts_used = max_external_attempts)
  ),

  -- Armée veut dire : rien n'a encore été tenté. Sans cela, un `update` maladroit
  -- pourrait rendre à l'état ARMED une ligne qui a déjà cliqué.
  constraint ig_canary_armed_is_untouched check (
    state <> 'ARMED' or (external_attempts_used = 0 and consumed_at is null and closed_at is null)
  ),

  -- Le plafond est une contrainte de base, pas une intention du code : même un
  -- `update` écrit à la main ne peut pas faire compter deux tentatives.
  constraint ig_canary_attempts_bounded check (external_attempts_used <= max_external_attempts),

  -- Les deux fins non consommées portent leur date et leur auteur.
  constraint ig_canary_closed_is_terminal check (
    (state in ('EXPIRED', 'REVOKED')) = (closed_at is not null)
    and (closed_at is null) = (closed_by is null)
  )
);

-- UNE autorisation armée à la fois, dans toute la base.
--
-- L'expression `(true)` fait de l'index un singleton sur le sous-ensemble
-- `state = 'ARMED'` : la seconde insertion échoue, en base, quelle que soit la
-- fenêtre de course. C'est ce qui interdit d'armer deux prospects « pour aller
-- plus vite » — il faudra clore la première pour en ouvrir une autre, donc
-- décider deux fois.
create unique index ig_live_canary_one_armed_idx
  on ig_live_canary_authorizations ((true))
  where state = 'ARMED';

create index ig_live_canary_manifest_idx on ig_live_canary_authorizations (manifest_id, armed_at desc);

-- ---------------------------------------------------------------------------
-- 2. ig_dispatch_jobs — quand l'effet a été tenté
-- ---------------------------------------------------------------------------
--
-- `external_effect_attempted` existait depuis 0029 et n'a jamais pu passer à
-- `true` : aucun code ne savait produire un effet. C'est ce qui change avec
-- IG2, et le drapeau seul ne suffit plus — « on a tenté » sans « à quel
-- moment » ne permet pas de rapprocher une trace de base d'une conversation
-- Instagram observée à la main.
--
-- La contrainte lie les deux : le drapeau et l'horodatage vivent ensemble. Une
-- ligne qui déclarerait une tentative sans instant, ou l'inverse, est refusée.
alter table ig_dispatch_jobs
  add column external_effect_started_at timestamptz;

alter table ig_dispatch_jobs
  add constraint ig_job_effect_has_timestamp check (
    external_effect_attempted = (external_effect_started_at is not null)
  );

-- L'autorisation consommée par ce job, quand il y en a une. Nulle pour tous les
-- jobs qui n'ont jamais rien tenté — c'est-à-dire tous ceux d'avant IG2.
alter table ig_dispatch_jobs
  add column canary_authorization_id uuid references ig_live_canary_authorizations(id);

-- Un effet tenté vient forcément d'une autorisation consommée. La base refuse
-- donc un clic « orphelin » : il n'existe aucun chemin où
-- `external_effect_attempted` passe à `true` sans qu'une décision humaine
-- nominative l'ait précédé.
alter table ig_dispatch_jobs
  add constraint ig_job_effect_requires_canary check (
    external_effect_attempted = false or canary_authorization_id is not null
  );

-- ---------------------------------------------------------------------------
-- 3. ig_job_events — l'autorisation qui couvrait la tentative
-- ---------------------------------------------------------------------------
--
-- Le journal disait déjà quelles gardes avaient été évaluées ; il dit désormais
-- QUI avait autorisé, en pointant la ligne exacte. Un `SENT` sans autorisation
-- rattachée est refusé par la base.
alter table ig_job_events
  add column canary_authorization_id uuid references ig_live_canary_authorizations(id);

alter table ig_job_events
  add constraint ig_job_event_effect_requires_canary check (
    external_effect_attempted = false or canary_authorization_id is not null
  );

-- ---------------------------------------------------------------------------
-- 4. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'arme rien : `ig_live_canary_authorizations` sort vide, et une table
-- vide ne peut autoriser aucun clic.
--
-- Elle ne lève pas l'arrêt global : `ig_kill_switch` n'est pas touché, et son
-- absence de ligne vaut toujours « armé ».
--
-- Elle ne modifie ni `prospects`, ni `prospect_evidence`, ni
-- `r6b_dispatch_manifests`, ni `outreach_events` — et n'insère nulle part.
