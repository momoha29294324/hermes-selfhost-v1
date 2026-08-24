-- 0029_instagram_dispatch_rail.sql — IG-R1, rail de dispatch Instagram
-- (mission « Instagram Fast Lane R1 — Browser Rail + Queue + Safety Core +
-- DRY-RUN »).
--
-- Ce que cette migration crée, et ce qu'elle ne crée pas
-- -----------------------------------------------------
-- Elle crée la file durable, le registre de session navigateur, le journal de
-- vérification d'identité, le journal d'audit et l'interrupteur d'arrêt d'un
-- futur envoi Instagram.
--
-- Elle ne crée aucun envoi, et le mot est faible : `LIVE_CAPABLE_TRANSPORTS`
-- (`r6bTransportAdapters`) déclare `instagram_dm: false` et aucun code de ce
-- dépôt ne sait produire un DM. Un `UPDATE` sur les tables ci-dessous ne
-- changerait rien à cela — il n'y a pas de fonction à appeler.
--
-- Elle ne touche à aucune donnée existante : ni les 286 prospects, ni les
-- manifestes R6B, ni `outreach_events`. Aucun `alter table` sur une table
-- existante, aucun `insert`, aucun `update`. Après elle comme avant elle :
-- 0 DM, 0 outreach_event Instagram.
--
-- Pourquoi de nouvelles tables plutôt que réutiliser celles de R6B
-- ----------------------------------------------------------------
-- `r6b_dispatch_manifests` reste la source de vérité de l'intention — quel
-- prospect, quel transport, quel destinataire, quel texte — et rien ici ne la
-- duplique ni ne la réécrit : tout part d'une clé étrangère vers elle.
--
-- Ce que R6B n'a pas, c'est un travail *ordonnançable*. Un email part en un
-- appel HTTP synchrone ; un DM Instagram passe par un navigateur persistant,
-- une session qui peut expirer, un profil qui peut avoir disparu, et une
-- cadence à borner. Cela demande un état repris après un redémarrage, une
-- location (lease) attribuable à un worker, et des compteurs — c'est-à-dire
-- une file, que `r6b_live_send_attempts` (un registre par manifeste, sans
-- ordonnancement ni worker) ne sait pas représenter.

-- ---------------------------------------------------------------------------
-- 1. ig_kill_switch — l'arrêt global, fermé par défaut
-- ---------------------------------------------------------------------------
--
-- L'invariant qui fait toute la valeur de cette table : **l'absence de ligne
-- vaut « armé »**. Pas « inconnu », pas « ouvert » — armé. La lecture
-- applicative (`loadKillSwitch`) traite une table vide comme un arrêt effectif,
-- donc l'état livré par cette migration est l'arrêt : elle n'insère rien.
--
-- Un interrupteur dont le défaut serait « ouvert » ne protégerait que les
-- machines où quelqu'un a pensé à le fermer. Celui-ci protège d'abord, et
-- demande une écriture humaine nominative pour s'ouvrir — même patron que
-- `r6b_crm_destinations` (0027) : `released_by` porte le nom d'un humain,
-- jamais « system » ni « agent ».
--
-- Singleton par construction : la clé primaire ne peut valoir que `true`, donc
-- une seconde ligne est impossible. Deux interrupteurs seraient deux vérités,
-- et l'une des deux serait la plus permissive.
create table ig_kill_switch (
  id            boolean primary key default true check (id = true),

  -- `true` = tout effet Instagram futur est refusé, file pleine ou non.
  engaged       boolean not null,

  -- Qui a positionné l'interrupteur, et pourquoi. Un arrêt levé sans auteur
  -- n'est pas une décision, c'est un accident qu'on ne peut pas rattacher.
  set_by        text not null check (length(btrim(set_by)) between 1 and 120),
  reason        text not null check (length(btrim(reason)) between 1 and 500),

  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. ig_browser_sessions — ce que le navigateur a répondu, jamais ce qu'il garde
-- ---------------------------------------------------------------------------
--
-- Cette table décrit l'ÉTAT d'une session, jamais son CONTENU. Aucun cookie,
-- aucun jeton, aucun `sessionid`, aucun en-tête : le profil navigateur vit hors
-- Git sous `var/instagram/` et n'est jamais lu par la base (CLAUDE.md §6).
-- `profile_label` est une étiquette (« default »), pas un chemin de cookie jar.
--
-- Les sept états sont ceux du rail (`InstagramSessionState`). Trois sont
-- fail-closed côté application — CHALLENGE, CAPTCHA, BLOCKED — et le restent
-- ici : la table les enregistre pour qu'un humain les voie, elle ne leur
-- accorde aucune suite automatique. Aucun contournement n'existe dans ce dépôt.
create table ig_browser_sessions (
  id                uuid primary key default gen_random_uuid(),

  worker_id         text not null check (length(btrim(worker_id)) between 1 and 200),
  profile_label     text not null check (length(btrim(profile_label)) between 1 and 120),
  headless          boolean not null,

  state             text not null check (state in (
                      'SESSION_READY', 'LOGIN_REQUIRED', 'SESSION_EXPIRED',
                      'CHALLENGE', 'CAPTCHA', 'BLOCKED', 'UNKNOWN')),
  -- Message court destiné à un humain. Jamais un corps de réponse brut, jamais
  -- une valeur de cookie.
  detail            text check (detail is null or length(detail) <= 1000),

  opened_at         timestamptz not null default now(),
  last_checked_at   timestamptz not null default now(),
  closed_at         timestamptz
);

create index ig_browser_sessions_recent_idx on ig_browser_sessions (opened_at desc);
-- Le plafond « max_session_failures » compte les sessions non saines sur une
-- fenêtre : l'index partiel sert exactement cette lecture.
create index ig_browser_sessions_unhealthy_idx
  on ig_browser_sessions (opened_at desc)
  where state <> 'SESSION_READY';

-- ---------------------------------------------------------------------------
-- 3. ig_dispatch_jobs — la file durable
-- ---------------------------------------------------------------------------
--
-- Une ligne = une intention Instagram, pour toujours.
--
-- `unique (manifest_id, action)` est la pièce maîtresse de l'idempotence, et
-- elle est volontairement TOTALE — pas un index partiel « sauf si terminé »
-- comme `r6b_live_send_attempts_one_open_per_manifest_idx` (0023). La
-- différence de traitement vient de la différence de nature : là-bas une ligne
-- décrivait UNE tentative et un échec documenté devait pouvoir en autoriser
-- une autre ; ici une ligne décrit LE travail, et ses tentatives successives
-- sont comptées dans `attempts` sans jamais créer de seconde ligne.
--
-- Conséquences, toutes voulues :
--   * deux jobs actifs pour le même manifeste/action : impossible ;
--   * un job terminal (SENT / REVIEW_REQUIRED) ne peut pas être « ré-enfilé »
--     comme un job neuf — l'insert échouerait sur la même clé ;
--   * un redémarrage ne rejoue rien : il retrouve la même ligne, dans l'état
--     où elle était.
--
-- Les statuts, et lesquels peuvent encore être pris :
--
--   PENDING            — jamais traité. Réclamable.
--   CLAIMED            — un worker détient la location. Réclamable seulement si
--                        la location a expiré ET qu'aucun effet externe n'a été
--                        tenté (voir plus bas).
--   DRY_RUN_VALIDATED  — une vérification est allée au bout. Réclamable : un
--                        dry-run ne produit rien, le rejouer est sans effet.
--   BLOCKED            — une garde a refusé (arrêt global, plafond, identité).
--                        Réclamable : la condition qui a bloqué peut changer.
--   FAILED             — panne technique documentée. Réclamable, sous plafond
--                        d'échecs.
--   SENT               — absorbant. Inatteignable dans ce dépôt : la contrainte
--                        `ig_job_sent_requires_effect` exige un effet externe,
--                        qu'aucun code ne sait produire.
--   REVIEW_REQUIRED    — absorbant. C'est la réponse au « on ne sait pas » :
--                        location expirée alors qu'un effet externe avait été
--                        tenté. Jamais un nouvel essai automatique.
create table ig_dispatch_jobs (
  id                        uuid primary key default gen_random_uuid(),

  -- L'intention approuvée. Le worker exécute ceci, il ne le recalcule pas.
  manifest_id               uuid not null references r6b_dispatch_manifests(id),
  prospect_id               uuid not null references prospects(id),

  -- Une seule action existe. En ajouter une demandera une migration — donc une
  -- revue — plutôt qu'une chaîne libre glissée par un appelant. `follow`,
  -- `like`, `comment` n'y figurent pas et n'y figureront pas : ce rail ne
  -- connaît qu'un premier contact.
  action                    text not null check (action in ('first_touch_dm')),

  -- Dérivée déterministiquement du manifeste et de l'action
  -- (`deriveInstagramIdempotencyKey`), donc identique d'un processus à l'autre
  -- et d'un redémarrage à l'autre. Stockée pour être confrontée, pas recalculée
  -- et espérée.
  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),

  -- Recopiés du manifeste à l'enfilement. Ils ne servent pas à agir — le worker
  -- relit le manifeste — mais à prouver, plus tard, sur quoi ce job portait.
  -- Un handle qui dérive entre l'enfilement et l'exécution est un refus, pas
  -- une mise à jour silencieuse.
  expected_handle           text not null check (expected_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  approved_text_sha256      text not null check (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  transport_payload_sha256  text not null check (transport_payload_sha256 ~ '^[0-9a-f]{64}$'),

  status                    text not null check (status in (
                              'PENDING', 'CLAIMED', 'DRY_RUN_VALIDATED',
                              'BLOCKED', 'FAILED', 'SENT', 'REVIEW_REQUIRED')),

  attempts                  int not null default 0 check (attempts >= 0),

  -- La location. Ces quatre colonnes vivent et meurent ensemble : elles
  -- décrivent le bail courant, pas l'historique (qui vit dans ig_job_events).
  claimed_by                text check (claimed_by is null or length(btrim(claimed_by)) between 1 and 200),
  -- Jeton du bail : régénéré à CHAQUE prise. Un worker dont le bail a expiré et
  -- qui revient écrire son résultat ne retrouve plus son jeton, donc n'écrit
  -- rien — c'est ce qui empêche deux workers de finaliser le même job.
  claim_token               uuid,
  claimed_at                timestamptz,
  lease_expires_at          timestamptz,

  -- Le drapeau qui interdit tout rejeu dangereux. Il passerait à `true` AVANT
  -- le premier geste ayant un effet chez Instagram — jamais après — pour qu'un
  -- processus tué à cet instant laisse « on a essayé, on ne sait pas » plutôt
  -- que « rien n'a été fait ». Aucun code de ce dépôt ne le met à `true` :
  -- il n'existe aucun geste à effet à poser.
  external_effect_attempted boolean not null default false,

  -- Intervalle minimal d'ordonnancement : un job n'est pas réclamable avant.
  not_before                timestamptz not null default now(),

  last_reason_code          text check (last_reason_code is null or length(last_reason_code) <= 80),
  last_detail               text check (last_detail is null or length(last_detail) <= 1000),

  enqueued_by               text not null check (length(btrim(enqueued_by)) between 1 and 200),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  terminated_at             timestamptz,

  -- Une intention, un job. Voir le commentaire d'en-tête de la table.
  constraint ig_dispatch_jobs_one_per_intent unique (manifest_id, action),
  -- La même vérité dite dans le vocabulaire d'un futur envoi : deux jobs ne
  -- peuvent pas présenter la même clé d'idempotence.
  constraint ig_dispatch_jobs_idempotency_unique unique (idempotency_key),

  -- Le bail est entier ou absent. Une ligne CLAIMED sans échéance serait un
  -- job verrouillé pour toujours ; une échéance sans statut CLAIMED serait un
  -- bail que personne ne détient.
  constraint ig_job_claim_lease_coherent check (
    (status = 'CLAIMED') = (claim_token is not null)
    and (claim_token is null) = (claimed_by is null)
    and (claim_token is null) = (claimed_at is null)
    and (claim_token is null) = (lease_expires_at is null)
  ),

  -- « Envoyé » exige d'avoir touché Instagram. Sans cela, le mot ne veut rien
  -- dire — et comme aucun code ne peut mettre `external_effect_attempted` à
  -- `true`, cette contrainte rend `SENT` inatteignable, en base, aujourd'hui.
  constraint ig_job_sent_requires_effect check (status <> 'SENT' or external_effect_attempted = true),

  -- Les deux statuts absorbants portent leur horodatage de fin, et eux seuls.
  constraint ig_job_terminal_has_timestamp check (
    (status in ('SENT', 'REVIEW_REQUIRED')) = (terminated_at is not null)
  )
);

-- La lecture du worker : « le prochain job réclamable ». Index sur les colonnes
-- exactes du `where` de `claimNextJob`, pour que la prise reste un accès par
-- index même quand la file grandit.
create index ig_dispatch_jobs_claimable_idx
  on ig_dispatch_jobs (not_before asc, created_at asc)
  where status in ('PENDING', 'DRY_RUN_VALIDATED', 'BLOCKED', 'FAILED');

-- La reprise après redémarrage : quels baux ont expiré.
create index ig_dispatch_jobs_lease_idx
  on ig_dispatch_jobs (lease_expires_at asc)
  where status = 'CLAIMED';

create index ig_dispatch_jobs_manifest_idx on ig_dispatch_jobs (manifest_id);
create index ig_dispatch_jobs_prospect_idx on ig_dispatch_jobs (prospect_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. ig_identity_checks — « profil confirmé » cesse d'être une impression
-- ---------------------------------------------------------------------------
--
-- CLAUDE.md, interdit n°2 : rien n'est affirmé sans provenance. Une
-- vérification d'identité est une observation, elle est donc journalisée comme
-- toute observation de ce dépôt — avec son fournisseur, sa méthode, son URL
-- source et son horodatage.
--
-- `signals` porte chaque indice séparément (handle de l'URL canonique, handle
-- du `og:url`, handle lu dans l'en-tête du profil) plutôt qu'une conclusion
-- unique. Un verdict qu'on ne peut pas décomposer ne peut pas être contesté ;
-- et c'est en confrontant ces indices que `MATCH` se distingue d'`AMBIGUOUS`.
--
-- Les cinq verdicts. Un seul autorise la suite (`MATCH`) ; les quatre autres
-- sont des refus, y compris `UNAVAILABLE` — « je n'ai pas pu vérifier » n'est
-- jamais « c'est bon ».
create table ig_identity_checks (
  id                uuid primary key default gen_random_uuid(),

  job_id            uuid references ig_dispatch_jobs(id) on delete cascade,
  manifest_id       uuid not null references r6b_dispatch_manifests(id),
  prospect_id       uuid not null references prospects(id),
  session_id        uuid references ig_browser_sessions(id),

  expected_handle   text not null,
  observed_handle   text,
  observed_url      text,
  -- L'URL finale diffère de l'URL demandée : changement de handle, redirection
  -- vers la connexion, ou profil déplacé. Jamais absorbé en silence.
  redirected        boolean not null default false,

  verdict           text not null check (verdict in ('MATCH', 'MISMATCH', 'NOT_FOUND', 'AMBIGUOUS', 'UNAVAILABLE')),

  -- Provenance, au même format que `prospect_evidence` : qui a observé, comment.
  provider          text not null check (provider in ('instagram_web')),
  method            text not null check (method in ('browser_profile_page')),
  signals           jsonb not null default '[]'::jsonb,

  detail            text check (detail is null or length(detail) <= 1000),
  observed_at       timestamptz not null default now(),

  -- Un `MATCH` nomme ce qu'il a vu et où. Sans handle observé ni URL, « ça
  -- correspond » ne serait qu'une affirmation — exactement ce que la mission
  -- interdit (« ne jamais transformer profil ressemblant en profil confirmé »).
  constraint ig_identity_match_is_observed check (
    verdict <> 'MATCH' or (observed_handle is not null and observed_url is not null)
  )
);

create index ig_identity_checks_job_idx on ig_identity_checks (job_id, observed_at desc);
create index ig_identity_checks_manifest_idx on ig_identity_checks (manifest_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- 5. ig_job_events — le journal append-only
-- ---------------------------------------------------------------------------
--
-- Une ligne par tentative, ajoutée quand l'issue est connue, jamais modifiée.
-- C'est ce qui en fait une preuve : un journal qu'on réécrit ne prouve rien
-- (même raisonnement qu'en 0021 pour `r6b_dispatch_attempts`).
--
-- Les colonnes répondent une à une aux questions du §8 de la mission : quel
-- prospect, quel manifeste, quel handle attendu, quel handle observé, quelle
-- session, quel job, quel worker, quel mode, quelles gardes, quelle clé
-- d'idempotence, quelle décision, quel motif, quelle durée, quelle erreur.
--
-- Ce qu'il ne porte jamais : cookie, jeton de session, en-tête d'autorisation,
-- HTML brut. `detail` est une phrase pour un humain.
create table ig_job_events (
  id                        uuid primary key default gen_random_uuid(),

  job_id                    uuid references ig_dispatch_jobs(id) on delete cascade,
  manifest_id               uuid references r6b_dispatch_manifests(id),
  prospect_id               uuid references prospects(id),
  session_id                uuid references ig_browser_sessions(id),

  worker_id                 text not null check (length(btrim(worker_id)) between 1 and 200),
  mode                      text not null check (mode in ('DRY_RUN', 'LIVE')),

  status                    text not null check (status in ('DRY_RUN_OK', 'BLOCKED', 'FAILED', 'SENT', 'AMBIGUOUS')),
  reason_code               text not null check (length(btrim(reason_code)) between 1 and 80),

  idempotency_key           text not null,

  expected_handle           text,
  observed_handle           text,
  session_state             text check (session_state is null or session_state in (
                              'SESSION_READY', 'LOGIN_REQUIRED', 'SESSION_EXPIRED',
                              'CHALLENGE', 'CAPTCHA', 'BLOCKED', 'UNKNOWN')),

  -- Chaque garde évaluée et son verdict, dans l'ordre : [{gate, verdict, detail}].
  -- Écrit même quand tout passe — savoir qu'une garde a été *évaluée* est aussi
  -- utile que savoir qu'elle a refusé.
  gates                     jsonb not null default '[]'::jsonb,

  external_effect_attempted boolean not null default false,

  duration_ms               integer check (duration_ms is null or duration_ms >= 0),
  detail                    text check (detail is null or length(detail) <= 2000),

  created_at                timestamptz not null default now(),

  -- « BLOCKED » veut dire refusé avant tout geste, et rien d'autre. Sans cette
  -- contrainte, un refus survenu après coup pourrait se journaliser comme un
  -- refus préventif — et le compteur « aucun effet Instagram » mentirait.
  constraint ig_job_event_blocked_is_pre_effect check (
    status <> 'BLOCKED' or external_effect_attempted = false
  ),

  -- La garde structurelle du DRY-RUN, posée dans la base plutôt que dans une
  -- convention : un événement DRY_RUN ne peut ni déclarer un effet externe, ni
  -- prendre un statut qui suppose un envoi. Le jour où un bug ferait envoyer
  -- un dry-run, la ligne d'audit serait REFUSÉE — la transaction échouerait
  -- plutôt que de consigner un mensonge.
  constraint ig_job_event_dry_run_has_no_effect check (
    mode <> 'DRY_RUN'
    or (external_effect_attempted = false and status in ('DRY_RUN_OK', 'BLOCKED', 'FAILED'))
  ),

  -- Symétriquement : les deux issues qui supposent un geste chez Instagram
  -- n'existent qu'en LIVE, et seulement après ce geste.
  constraint ig_job_event_effectful_outcome_is_live check (
    status not in ('SENT', 'AMBIGUOUS')
    or (mode = 'LIVE' and external_effect_attempted = true and job_id is not null and manifest_id is not null)
  )
);

create index ig_job_events_job_idx on ig_job_events (job_id, created_at desc);
create index ig_job_events_manifest_idx on ig_job_events (manifest_id, created_at desc);
-- Les plafonds horaire et journalier lisent exactement ceci : les envois
-- réussis d'une fenêtre. Index partiel — la table est dominée par des
-- DRY_RUN_OK, qu'aucun plafond d'envoi ne doit compter.
create index ig_job_events_sent_window_idx
  on ig_job_events (created_at desc)
  where status = 'SENT';
-- Le plafond d'échecs consécutifs lit la queue du journal, tous statuts
-- confondus, pour savoir où s'arrête la série.
create index ig_job_events_recent_idx on ig_job_events (created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'insère aucune ligne, dans aucune table — y compris `ig_kill_switch`,
-- dont la vacuité EST l'arrêt.
--
-- Elle n'arme aucun manifeste. Aucune colonne ne dit « celui-ci peut partir ».
-- Le choix d'un jour ouvrir un canari LIVE sera un diff dans le code, relu,
-- pas un `UPDATE` — même principe que `R6B_LIVE_ARMED_MANIFEST_ID` (0023 §4).
--
-- Elle ne modifie ni `prospects`, ni `prospect_evidence`, ni
-- `r6b_dispatch_manifests`, ni `outreach_events`, ni aucune table R6B.
