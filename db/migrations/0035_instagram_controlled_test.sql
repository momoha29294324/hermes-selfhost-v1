-- 0035_instagram_controlled_test.sql — IG2.2, validation de remise en
-- environnement contrôlé.
--
-- La question à laquelle ce rail existe pour répondre
-- ----------------------------------------------------
-- Le 14 août, le premier canari LIVE a produit exactement un effet externe et
-- l'adjudication a tranché `DELIVERY_FAILED`. Deux explications restaient
-- ouvertes, et elles n'ont pas les mêmes conséquences :
--
--   * le chemin d'envoi lui-même ne sait pas remettre un DM (session, compte
--     émetteur, primitive) — auquel cas aucun autre prospect ne doit être
--     approché ;
--   * le chemin sait remettre, et c'est la DESTINATION qui a refusé — auquel
--     cas le diagnostic porte sur le contexte de ce compte-là.
--
-- On ne peut pas départager sans une remise réussie quelque part. Cette
-- migration crée le seul endroit où l'on a le droit d'essayer : un compte de
-- test contrôlé et consentant, jamais un prospect.
--
-- Pourquoi de NOUVELLES tables, et pas une colonne « is_test »
-- ------------------------------------------------------------
-- Un drapeau sur `ig_dispatch_jobs` aurait été plus court, et faux. Cette
-- table-là exige un `manifest_id` vers `r6b_dispatch_manifests` et un
-- `prospect_id` vers `prospects` : un test technique n'a ni manifeste
-- commercial, ni prospect, et lui en fabriquer un aurait créé exactement la
-- chose que la mission interdit — une ligne de test dans les données
-- commerciales, à un `where is_test = false` d'être comptée comme un outreach.
--
-- La séparation n'est donc pas une convention de lecture, c'est une absence de
-- colonnes : il n'existe ici AUCUNE clé étrangère vers `r6b_dispatch_manifests`,
-- `prospects`, `outreach_events` ou `campaigns`. Un test ne peut pas se
-- rattacher à un prospect parce qu'il n'y a pas de champ pour le dire, et un
-- KPI commercial ne peut pas le compter parce qu'il ne lit pas ces tables.
--
-- Ce que cette migration ne fait pas
-- -----------------------------------
-- Elle n'insère aucune ligne, n'arme aucun test, ne lève aucun arrêt. L'arrêt
-- global (`ig_kill_switch`, 0029) continue de commander : ces tables ne le
-- contournent pas, elles s'y soumettent comme le canari commercial. Elle ne
-- touche à aucune table existante — ni `ig_dispatch_jobs`, ni `ig_job_events`,
-- ni `outreach_events`, ni `prospects`.

-- ---------------------------------------------------------------------------
-- 1. ig_controlled_tests — l'intention de test, et son autorisation
-- ---------------------------------------------------------------------------
--
-- Une ligne = un droit de produire UN effet Instagram, sur UN handle de test,
-- avec UN texte figé, pendant UNE fenêtre courte.
--
-- L'intention et l'autorisation sont FUSIONNÉES ici, alors que le rail
-- commercial les sépare (`ig_dispatch_jobs` d'un côté, 0029 ;
-- `ig_live_canary_authorizations` de l'autre, 0031). La séparation a un sens
-- là-bas : le manifeste est produit des jours avant qu'on décide d'envoyer, et
-- l'autorisation est cette décision-là. Ici, l'intention NAÎT de la décision —
-- personne ne planifie un test technique à l'avance, on le décide et on le fait
-- dans la même demi-heure. Deux tables auraient dupliqué la cible sans jamais
-- exister l'une sans l'autre.
--
-- Le texte, lui, n'est pas un paramètre
-- --------------------------------------
-- `payload_sha256` est contraint à une valeur littérale : l'empreinte du seul
-- message que ce rail peut porter. Ce n'est pas une précaution redondante avec
-- le code (qui n'expose, lui non plus, aucun paramètre de texte) — c'est ce qui
-- rend l'invariant vrai même pour un `INSERT` écrit à la main, un futur diff
-- distrait, ou un script de reprise. Un message commercial, une preuve
-- chiffrée, un lien : la base les refuse, sans avoir à savoir ce qu'ils sont.
create table ig_controlled_tests (
  id                        uuid primary key default gen_random_uuid(),

  -- Le type, écrit en toutes lettres et contraint à une seule valeur. Il ne
  -- sert pas à filtrer (aucune autre valeur n'existe) mais à ce qu'une lecture
  -- humaine de la table ne puisse jamais la confondre avec de l'outreach.
  kind                      text not null default 'CONTROLLED_TEST'
                              check (kind = 'CONTROLLED_TEST'),

  -- Une action, distincte de `first_touch_dm` : un test n'est pas un premier
  -- contact commercial, et les deux vocabulaires ne doivent pas se mélanger.
  action                    text not null check (action in ('controlled_test_dm')),
  transport                 text not null check (transport in ('instagram_dm')),

  -- Le compte de test, exact. Même forme que partout ailleurs dans le rail.
  target_handle             text not null check (target_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  -- Qui atteste que ce compte est contrôlé et consentant, et comment. Sans
  -- cette phrase, « compte de test » ne serait qu'une affirmation — et la
  -- mission la fait reposer sur une personne, pas sur une intention.
  consent_note              text not null check (length(btrim(consent_note)) between 1 and 500),

  payload_text              text not null check (length(btrim(payload_text)) between 1 and 500),
  -- L'empreinte du texte de test, et d'aucun autre. Voir l'en-tête de la table.
  payload_sha256            text not null
                              check (payload_sha256 = '7510b85b71c0bb4eb375d22d151ec04666403530f0ddeb293e8ccab72b367bff'),

  -- Dérivée du handle et de l'empreinte, donc identique d'un processus à
  -- l'autre et d'un redémarrage à l'autre. C'est elle que porte l'index
  -- d'unicité d'effet plus bas.
  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),

  armed_by                  text not null check (length(btrim(armed_by)) between 1 and 120),
  reason                    text not null check (length(btrim(reason)) between 1 and 500),

  state                     text not null check (state in ('ARMED', 'RESERVED', 'CONSUMED', 'EXPIRED', 'REVOKED')),

  -- Un, et pas « un par défaut » : la contrainte interdit toute autre valeur,
  -- comme en 0031. Un test qui pourrait réessayer ne serait plus un test à un
  -- seul effet.
  max_external_attempts     int not null default 1 check (max_external_attempts = 1),
  external_attempts_used    int not null default 0 check (external_attempts_used >= 0),

  -- Le drapeau et sa date, posés AVANT le clic, jamais après.
  external_effect_attempted boolean not null default false,
  external_effect_started_at timestamptz,

  -- L'issue adjugée par `judgeSendOutcome` — la même fonction que le canari
  -- commercial, donc la même exigence de preuve.
  outcome                   text check (outcome in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')),
  outcome_at                timestamptz,
  outcome_detail            text check (outcome_detail is null or length(outcome_detail) <= 2000),

  expires_at                timestamptz not null,
  armed_at                  timestamptz not null default now(),

  reserved_at               timestamptz,
  reserved_by               text check (reserved_by is null or length(btrim(reserved_by)) between 1 and 200),

  consumed_at               timestamptz,
  consumed_by               text check (consumed_by is null or length(btrim(consumed_by)) between 1 and 200),

  closed_at                 timestamptz,
  closed_by                 text check (closed_by is null or length(btrim(closed_by)) between 1 and 200),
  closed_reason             text check (closed_reason is null or length(closed_reason) <= 500),

  -- Un armement est intact : rien réservé, rien consommé, rien tenté.
  constraint ig_ct_armed_is_untouched check (
    state <> 'ARMED'
    or (external_attempts_used = 0 and external_effect_attempted = false
        and reserved_at is null and consumed_at is null and closed_at is null)
  ),

  -- Une réservation est entière, et ne compte aucune tentative. C'est la
  -- correction d'IG2.1 §7 reprise telle quelle : réserver départage, consommer
  -- dépense.
  constraint ig_ct_reservation_is_whole check (
    (reserved_at is null) = (reserved_by is null)
  ),
  constraint ig_ct_reserved_is_untouched check (
    state <> 'RESERVED'
    or (external_attempts_used = 0 and external_effect_attempted = false
        and reserved_at is not null and consumed_at is null)
  ),

  -- Une consommation est complète, et elle a été précédée d'une réservation.
  constraint ig_ct_consumed_is_complete check (
    state <> 'CONSUMED'
    or (consumed_at is not null and consumed_by is not null
        and reserved_at is not null and external_attempts_used = 1)
  ),

  constraint ig_ct_attempts_bounded check (external_attempts_used <= max_external_attempts),

  -- Le drapeau et sa date vivent ensemble : un effet sans date ne serait pas
  -- mesurable par la cadence, une date sans effet serait un mensonge.
  constraint ig_ct_effect_has_timestamp check (
    external_effect_attempted = (external_effect_started_at is not null)
  ),

  -- Un effet n'existe qu'après une consommation. L'ordre du code
  -- (consommer, puis marquer, puis cliquer) est ici une propriété de la base.
  constraint ig_ct_effect_requires_consumption check (
    external_effect_attempted = false or external_attempts_used = 1
  ),

  -- Une issue ne se prononce qu'après un effet : sans clic, il n'y a rien à
  -- adjuger. Et « SENT » exige, comme partout, d'avoir touché Instagram.
  constraint ig_ct_outcome_after_effect check (
    (outcome is null and outcome_at is null)
    or (outcome is not null and outcome_at is not null and external_effect_attempted = true)
  ),

  constraint ig_ct_closed_is_terminal check (
    state not in ('EXPIRED', 'REVOKED') or closed_at is not null
  )
);

-- L'idempotence, dite par la base et pas par une convention d'appelant : pour
-- une intention donnée (ce handle, ce texte), il ne peut exister qu'UNE ligne
-- ayant tenté un effet, pour toujours. Un redémarrage, une reprise, un second
-- armement après un refus : aucun ne peut produire un second message.
create unique index ig_controlled_test_one_effect_per_key_idx
  on ig_controlled_tests (idempotency_key)
  where external_effect_attempted = true;

-- Une seule autorisation vivante à la fois, tous handles confondus. Le rail
-- Instagram n'a qu'un compte émetteur et qu'un navigateur : deux tests armés
-- en parallèle décriraient une capacité qui n'existe pas.
create unique index ig_controlled_test_one_live_idx
  on ig_controlled_tests ((true))
  where state in ('ARMED', 'RESERVED');

create index ig_controlled_tests_recent_idx on ig_controlled_tests (armed_at desc);
create index ig_controlled_tests_effect_idx
  on ig_controlled_tests (external_effect_started_at desc)
  where external_effect_attempted = true;

-- ---------------------------------------------------------------------------
-- 2. ig_controlled_test_events — le journal DISTINCT
-- ---------------------------------------------------------------------------
--
-- Distinct de `ig_job_events`, et la mission le demande explicitement. La
-- raison n'est pas l'esthétique : `ig_job_events` est la table que lisent les
-- plafonds d'envoi, le rapport de gate et l'état du rail commercial. Y verser
-- des lignes de test obligerait chacun de ces lecteurs à se souvenir d'un
-- filtre — et le jour où l'un l'oublie, un test technique devient un envoi
-- commercial dans un chiffre.
--
-- Ce que ce journal partage tout de même avec le rail commercial :
-- `ig_browser_sessions`. C'est voulu — il n'y a qu'UN compte émetteur et UN
-- profil navigateur, donc une session non saine pendant un test est la même
-- panne qu'une session non saine pendant un envoi, et le plafond
-- `max_session_failures` doit la voir.
--
-- `test_id` est NULLABLE, et seulement pour la reconnaissance en lecture seule
-- (mode `PREFLIGHT`) : on doit pouvoir observer l'état d'un compte de test
-- AVANT de décider d'armer quoi que ce soit. La contrainte plus bas rend
-- l'inverse impossible — aucun effet externe ne peut être journalisé sans
-- l'intention qui l'autorise.
create table ig_controlled_test_events (
  id                        uuid primary key default gen_random_uuid(),

  test_id                   uuid references ig_controlled_tests(id) on delete cascade,
  session_id                uuid references ig_browser_sessions(id),

  worker_id                 text not null check (length(btrim(worker_id)) between 1 and 200),
  operator                  text not null check (length(btrim(operator)) between 1 and 120),

  -- Trois modes, et un seul peut produire un effet.
  mode                      text not null check (mode in ('PREFLIGHT', 'PREVIEW', 'LIVE')),

  status                    text not null check (status in (
                              'PREFLIGHT_OK', 'PREVIEWED', 'BLOCKED', 'FAILED',
                              'SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')),
  reason_code               text not null check (length(btrim(reason_code)) between 1 and 80),

  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),

  target_handle             text not null check (target_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  observed_handle           text,
  observed_url              text,
  session_state             text check (session_state is null or session_state in (
                              'SESSION_READY', 'LOGIN_REQUIRED', 'SESSION_EXPIRED',
                              'CHALLENGE', 'CAPTCHA', 'BLOCKED', 'UNKNOWN')),

  -- Provenance de l'observation d'identité, au même format que
  -- `ig_identity_checks` (0029) et `prospect_evidence` : qui a observé, comment.
  identity_verdict          text check (identity_verdict is null or identity_verdict in (
                              'MATCH', 'MISMATCH', 'NOT_FOUND', 'AMBIGUOUS', 'UNAVAILABLE')),
  identity_provider         text check (identity_provider is null or identity_provider in ('instagram_web')),
  identity_method           text check (identity_method is null or identity_method in ('browser_profile_page')),
  identity_signals          jsonb not null default '[]'::jsonb,

  -- IG2.2 §2 — la relation d'abonnement OBSERVÉE, jamais supposée.
  --
  -- `null` veut dire « non lu », et c'est un état de plein droit : un libellé
  -- absent n'autorise pas à conclure « ne suit pas ». La distinction compte
  -- pour le diagnostic — un DM vers un compte qui ne suit pas l'émetteur
  -- atterrit en demande de message, pas en boîte de réception, et c'est
  -- justement une des différences à isoler avec le premier canari.
  follows_viewer            boolean,
  followed_by_viewer        boolean,
  relationship_labels       jsonb not null default '[]'::jsonb,

  gates                     jsonb not null default '[]'::jsonb,

  external_effect_attempted boolean not null default false,

  duration_ms               integer check (duration_ms is null or duration_ms >= 0),
  detail                    text check (detail is null or length(detail) <= 2000),

  created_at                timestamptz not null default now(),

  -- Aucun effet sans intention. C'est ce qui rend `test_id` nullable
  -- inoffensif : la reconnaissance peut se passer d'une autorisation, l'envoi
  -- jamais.
  constraint ig_ct_event_effect_requires_test check (
    external_effect_attempted = false or test_id is not null
  ),

  -- « BLOCKED » veut dire refusé avant tout geste, et rien d'autre.
  constraint ig_ct_event_blocked_is_pre_effect check (
    status <> 'BLOCKED' or external_effect_attempted = false
  ),

  -- La garde structurelle des modes sans effet, posée dans la base plutôt que
  -- dans une convention : une reconnaissance ou un aperçu ne peuvent ni
  -- déclarer un effet, ni prendre un statut qui en suppose un. Le jour où un
  -- bug ferait cliquer un aperçu, la ligne d'audit serait REFUSÉE — la
  -- transaction échouerait plutôt que de consigner un mensonge.
  constraint ig_ct_event_dry_modes_have_no_effect check (
    mode = 'LIVE'
    or (external_effect_attempted = false
        and status in ('PREFLIGHT_OK', 'PREVIEWED', 'BLOCKED', 'FAILED'))
  ),

  -- Symétriquement : les trois issues qui supposent un geste chez Instagram
  -- n'existent qu'en LIVE, et seulement après ce geste.
  constraint ig_ct_event_effectful_outcome_is_live check (
    status not in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')
    or (mode = 'LIVE' and external_effect_attempted = true and test_id is not null)
  ),

  -- Un `MATCH` nomme ce qu'il a vu et où — même exigence que
  -- `ig_identity_match_is_observed` (0029). Sans handle observé ni URL, « ça
  -- correspond » ne serait qu'une affirmation.
  constraint ig_ct_event_match_is_observed check (
    identity_verdict is distinct from 'MATCH'
    or (observed_handle is not null and observed_url is not null)
  ),

  -- Une provenance est entière ou absente : un verdict d'identité sans
  -- fournisseur ni méthode ne serait pas une observation, juste une opinion.
  constraint ig_ct_event_identity_provenance_whole check (
    (identity_verdict is null) = (identity_provider is null)
    and (identity_verdict is null) = (identity_method is null)
  )
);

create index ig_controlled_test_events_test_idx on ig_controlled_test_events (test_id, created_at desc);
create index ig_controlled_test_events_recent_idx on ig_controlled_test_events (created_at desc);
-- Les plafonds d'envoi lisent exactement ceci : les remises réussies d'une
-- fenêtre. Un DM de test part du MÊME compte émetteur qu'un DM commercial, donc
-- il charge Instagram autant et compte dans les mêmes plafonds — ce qui n'est
-- pas la même chose que compter dans les KPI commerciaux, dont il reste exclu.
create index ig_controlled_test_events_sent_window_idx
  on ig_controlled_test_events (created_at desc)
  where status = 'SENT';
