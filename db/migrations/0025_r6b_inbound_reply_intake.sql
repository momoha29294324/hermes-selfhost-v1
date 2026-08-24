-- 0025_r6b_inbound_reply_intake.sql — R6B-D1, le premier côté entrant du
-- système (mission « Hermes R6B-D1 — Gmail Reply Intake &
-- Correlation »).
--
-- Jusqu'ici le dépôt ne savait qu'écrire vers l'extérieur, et une seule fois :
-- un manifeste verrouillé, un envoi, un `outreach_event`. Il ne savait rien
-- lire. Cette migration pose ce qui manque pour qu'une réponse existe dans le
-- système autrement que dans la boîte mail de un opérateur : une table de messages
-- entrants, un curseur de boîte, et un registre de jetons de réponse.
--
-- Ce qu'elle ne fait pas, et ne peut pas faire :
--
--   * elle n'envoie rien et n'arme rien. `OUTBOUND_ALLOW_SENDING` reste à 0,
--     le gate des 20 prospects reste non validé, et aucune garde de 0023/0024
--     n'est relâchée ;
--   * elle ne touche aucun manifeste : aucun `update`, aucune colonne ajoutée
--     à `r6b_dispatch_manifests` ;
--   * elle ne crée aucune ligne. Après elle comme avant elle : 1 envoi,
--     1 `outreach_event`, 0 message entrant.
--
-- Elle est lue par un module qui n'a le droit de parler qu'à Gmail, en lecture
-- seule (`src/lib/inbound/`), et jamais à un provider d'envoi.

-- ---------------------------------------------------------------------------
-- 1. L'identité RFC de ce qui est réellement parti
-- ---------------------------------------------------------------------------
--
-- La corrélation forte d'une réponse repose sur un fait unique : l'en-tête
-- `In-Reply-To` d'une réponse porte le `Message-ID` RFC 5322 du message
-- d'origine. Ce n'est PAS l'identifiant Resend.
--
-- Vérifié dans la documentation Resend le 2026-08-13, pas supposé : la
-- réponse de `GET /emails/{id}` porte deux champs distincts —
--
--   * `id`         : `4ef9a417-02e9-4d39-ad75-9611e0fcc33c` (identifiant
--                    interne Resend, celui que le dépôt stocke déjà) ;
--   * `message_id` : `<111-222-333@email.example.com>` (l'en-tête RFC 5322
--                    réellement présent dans l'email).
--
-- Les deux ne sont pas interchangeables et l'un ne se dérive pas de l'autre.
-- D'où cette colonne : nullable, parce que l'envoi du 2026-08-12 est parti
-- avant qu'on sache la lire, et que « non observé » est la seule valeur
-- honnête pour lui (CLAUDE.md, interdit n°2 — jamais une supposition
-- présentée comme un fait).
--
-- Cette mission ne la remplit pas : la remplir demande un `GET` chez Resend,
-- et le module entrant n'a pas le droit d'ouvrir une connexion vers un
-- provider d'envoi, même en lecture. Elle existe pour que le chemin EXACT ait
-- une colonne à interroger le jour où une mission de réconciliation la
-- renseignera — et pour qu'entre-temps le système réponde « je ne sais pas »
-- plutôt que d'inventer une identité.
alter table r6b_live_send_attempts
  add column provider_rfc_message_id text
    check (provider_rfc_message_id is null or provider_rfc_message_id ~ '^<[^<>[:space:]]+@[^<>[:space:]]+>$');

comment on column r6b_live_send_attempts.provider_rfc_message_id is
  'En-tête Message-ID RFC 5322 de l''email envoyé, entre chevrons, tel que Resend l''expose '
  'dans le champ `message_id` de GET /emails/{id} — distinct de `provider_message_id` (l''id Resend). '
  'NULL = non observé, jamais « absent ».';

-- Un même `Message-ID` ne peut désigner qu'un envoi. Sans cet index, deux
-- lignes pourraient revendiquer le même en-tête et une réponse entrante
-- deviendrait ambiguë au moment précis où elle devrait être certaine.
create unique index r6b_live_send_attempts_rfc_message_id_idx
  on r6b_live_send_attempts (provider_rfc_message_id)
  where provider_rfc_message_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Les jetons de réponse (adresses plus-taguées) — registre, pas format
-- ---------------------------------------------------------------------------
--
-- Un futur `Reply-To` de la forme `hermesagencyy+ob_<token>@gmail.com` donne
-- une corrélation exacte sans dépendre d'aucun en-tête que le client mail du
-- prospect pourrait perdre. Trois propriétés en font une garde plutôt qu'une
-- commodité :
--
--   * le jeton est OPAQUE — il n'encode ni identifiant de manifeste, ni
--     adresse, ni date. Il ne dit donc rien à qui le lit dans un en-tête, et
--     ne peut pas être fabriqué en devinant une règle ;
--   * il est RÉSOLU EN BASE, jamais décodé. Un jeton inconnu n'est pas un
--     jeton « probablement valide dont on a perdu la clé » : c'est un jeton
--     rejeté, et il ne produit aucune corrélation ;
--   * il est RÉVOCABLE (`revoked_at`), donc réversible. C'est ce qui évite le
--     couplage irréversible qu'un format auto-descriptif créerait.
--
-- Cette mission ne change PAS l'expéditeur de production et n'émet aucun
-- jeton : la table reste vide. Elle existe pour que le parseur et la
-- résolution soient écrits, testés et immuables avant qu'un envoi les utilise
-- — jamais l'inverse.
create table r6b_reply_tokens (
  -- Minuscules et chiffres seulement : une adresse email n'est pas sensible à
  -- la casse dans sa partie locale chez la plupart des serveurs, et un jeton
  -- qui perdrait sa casse en route cesserait de se résoudre. Longueur minimale
  -- de 16 pour qu'un jeton ne se devine pas.
  token               text primary key check (token ~ '^[a-z0-9]{16,64}$'),

  manifest_id         uuid not null references r6b_dispatch_manifests(id),
  prospect_id         uuid not null references prospects(id),
  -- Nul tant que l'envoi n'a pas eu lieu : un jeton est émis AVEC le message,
  -- donc avant que son `outreach_event` existe.
  outreach_event_id   uuid references outreach_events(id),

  issued_at           timestamptz not null default now(),
  revoked_at          timestamptz
);

-- Au plus un jeton vivant par manifeste : deux jetons actifs pour le même
-- manifeste rendraient « ce jeton désigne cet envoi » faux dans un sens.
create unique index r6b_reply_tokens_one_active_per_manifest_idx
  on r6b_reply_tokens (manifest_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. Les messages entrants
-- ---------------------------------------------------------------------------
--
-- Append-safe : une ligne est écrite une fois, à l'ingestion, et n'est jamais
-- réécrite par le poller. Ce qui est stocké est une forme NORMALISÉE — pas le
-- blob Gmail brut : le corps en texte, les adresses déjà extraites, et le
-- sous-ensemble d'en-têtes dont la corrélation a réellement besoin. Garder le
-- brut ferait entrer dans la base des pièces jointes, du HTML et des en-têtes
-- de routage dont personne n'a l'usage ici.
--
-- Ce que la table ne porte JAMAIS : aucun jeton OAuth, aucun secret Google,
-- aucun en-tête `Authorization` (CLAUDE.md §6).
create table r6b_inbound_messages (
  id                            uuid primary key default gen_random_uuid(),

  -- Un seul fournisseur est implémenté. En ajouter un demandera une migration,
  -- donc une revue, plutôt qu'une valeur libre glissée par un appelant.
  provider                      text not null check (provider in ('gmail')),

  -- La boîte lue. Fait partie de l'identité d'un message : le même email vu
  -- depuis deux boîtes différentes est deux observations distinctes, et
  -- confondre les deux ferait disparaître la seconde en silence.
  mailbox                       text not null check (length(mailbox) between 3 and 320),

  -- La frontière d'idempotence, imposée par la base (voir l'index unique plus
  -- bas) et pas seulement par le code applicatif.
  provider_message_id           text not null check (length(provider_message_id) between 1 and 256),
  provider_thread_id            text,
  -- `historyId` du message tel que Gmail l'expose. Sert au diagnostic d'un
  -- curseur, jamais à décider d'une corrélation.
  provider_history_id           text,

  -- `internalDate` de Gmail : « The internal message creation timestamp
  -- (epoch ms), which determines ordering in the inbox » — l'heure à laquelle
  -- Gmail a accepté le message, pas l'en-tête `Date` que l'expéditeur contrôle.
  received_at                   timestamptz not null,

  from_address                  text not null,
  from_display                  text,
  to_addresses                  jsonb not null default '[]'::jsonb,
  cc_addresses                  jsonb not null default '[]'::jsonb,
  reply_to_addresses            jsonb not null default '[]'::jsonb,
  -- `Delivered-To` dit à quelle adresse le serveur a réellement livré, y
  -- compris une adresse plus-taguée qu'un `To:` réécrit aurait perdue.
  delivered_to_addresses        jsonb not null default '[]'::jsonb,

  subject                       text,
  -- Objet débarrassé de ses préfixes de réponse/transfert et de ses blancs
  -- superflus, en minuscules. Sert à comparer deux objets, jamais à prouver
  -- une identité à lui seul (§7 de la mission).
  normalized_subject            text not null,

  -- En-têtes d'identité RFC 5322, tels que lus. `in_reply_to` et `references`
  -- sont des listes parce que `References` en est une par définition et que
  -- certains clients en mettent plusieurs dans `In-Reply-To`.
  rfc_message_id                text,
  in_reply_to                   jsonb not null default '[]'::jsonb,
  reference_ids                 jsonb not null default '[]'::jsonb,

  -- Le corps lisible, immuable. Aucun rognage de citation n'est appliqué :
  -- une heuristique de découpe se trompe sur les clients mail qu'elle n'a pas
  -- vus, et un extrait tronqué au mauvais endroit est pire qu'un corps entier.
  body_text                     text not null,
  body_sha256                   text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- D'où vient ce texte. `text/html` signale un corps reconstruit faute de
  -- partie texte : ce n'est pas la même qualité de donnée, et le dire évite de
  -- traiter les deux comme équivalents plus tard.
  body_source                   text not null check (body_source in ('text/plain', 'text/html', 'none')),
  body_truncated                boolean not null default false,

  -- Sous-ensemble d'en-têtes conservés pour la corrélation et le diagnostic
  -- (voir `CORRELATION_HEADERS`), jamais l'intégralité du message.
  raw_headers                   jsonb not null default '{}'::jsonb,

  -- Indices d'automatisation OBSERVÉS (`Auto-Submitted`, `X-Autoreply`,
  -- expéditeur `mailer-daemon`, `Content-Type: multipart/report`…). Des faits,
  -- pas une classification : cette mission ingère et identifie, elle ne trie
  -- pas commercialement (§10).
  automation_signals            jsonb not null default '[]'::jsonb,

  -- -------------------------------------------------------------------------
  -- Corrélation
  -- -------------------------------------------------------------------------
  --
  --   EXACT            — un identifiant fort relie déterministement ce message
  --                      à un envoi : `In-Reply-To`/`References` portant le
  --                      `Message-ID` RFC d'un envoi connu, ou une adresse
  --                      plus-taguée dont le jeton se résout en base.
  --   HIGH_CONFIDENCE  — pas d'identifiant fort, mais une seule hypothèse
  --                      possible et rien qui la contredise (voir §7 de la
  --                      mission : le repli du premier envoi réel).
  --   REVIEW_REQUIRED  — plusieurs hypothèses plausibles. Le système ne
  --                      tranche pas ; il le dit.
  --   UNMATCHED        — rien ne relie ce message à un envoi connu.
  --
  -- Une heuristique faible ne peut pas devenir EXACT : les deux seuls chemins
  -- qui y mènent passent par une égalité d'identifiant, et le code refuse d'y
  -- arriver autrement (`src/lib/inbound/correlation.ts`).
  correlation_status            text not null
                                  check (correlation_status in
                                    ('EXACT', 'HIGH_CONFIDENCE', 'REVIEW_REQUIRED', 'UNMATCHED')),
  correlation_method            text,
  -- Ce qui a été observé pour conclure : identifiants comparés, candidats
  -- écartés, jeton rejeté. Une conclusion sans sa preuve n'est pas vérifiable.
  correlation_evidence          jsonb not null default '{}'::jsonb,

  correlated_manifest_id        uuid references r6b_dispatch_manifests(id),
  correlated_outreach_event_id  uuid references outreach_events(id),
  correlated_prospect_id        uuid references prospects(id),

  created_at                    timestamptz not null default now(),

  -- Une corrélation conclusive désigne les trois : le manifeste, l'événement
  -- d'envoi et le prospect. En désigner deux sur trois serait une conclusion à
  -- moitié écrite, donc inexploitable.
  constraint r6b_inbound_correlated_is_complete check (
    correlation_status not in ('EXACT', 'HIGH_CONFIDENCE')
    or (correlated_manifest_id is not null
        and correlated_outreach_event_id is not null
        and correlated_prospect_id is not null
        and correlation_method is not null)
  ),

  -- Une non-conclusion ne désigne RIEN. C'est ce qui empêche un
  -- `REVIEW_REQUIRED` d'être lu comme « probablement celui-ci » par une
  -- requête qui ne regarderait que la colonne manifeste.
  constraint r6b_inbound_uncorrelated_points_nowhere check (
    correlation_status in ('EXACT', 'HIGH_CONFIDENCE')
    or (correlated_manifest_id is null
        and correlated_outreach_event_id is null
        and correlated_prospect_id is null)
  ),

  -- Un `UNMATCHED` n'a pas de méthode : aucune n'a abouti. Un
  -- `REVIEW_REQUIRED`, si — c'est elle qui dit sur quoi l'ambiguïté porte.
  constraint r6b_inbound_unmatched_has_no_method check (
    correlation_status <> 'UNMATCHED' or correlation_method is null
  ),
  constraint r6b_inbound_review_has_method check (
    correlation_status <> 'REVIEW_REQUIRED' or correlation_method is not null
  )
);

-- LA garde d'idempotence. Elle vit en base et pas dans le code parce qu'un
-- `select` suivi d'un `insert` laisse toujours une fenêtre entre les deux :
-- deux pollers lancés en même temps y liraient tous les deux « inconnu ».
-- Ici, le second `insert` est refusé par Postgres quelle que soit la course —
-- ingérer le même message 1, 10 ou 100 fois donne exactement une ligne.
create unique index r6b_inbound_messages_provider_message_idx
  on r6b_inbound_messages (provider, mailbox, provider_message_id);

create index r6b_inbound_messages_received_idx on r6b_inbound_messages (received_at desc);
create index r6b_inbound_messages_manifest_idx on r6b_inbound_messages (correlated_manifest_id)
  where correlated_manifest_id is not null;
create index r6b_inbound_messages_status_idx on r6b_inbound_messages (correlation_status, received_at desc);
create index r6b_inbound_messages_thread_idx on r6b_inbound_messages (provider, provider_thread_id)
  where provider_thread_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Le curseur de boîte
-- ---------------------------------------------------------------------------
--
-- Sans curseur, un poller relit la boîte entière à chaque exécution : coûteux,
-- et surtout intrusif — la mission borne explicitement la lecture à ce qui
-- concerne l'outbound (§13), pas à la vie privée de un opérateur.
--
-- Gmail documente deux primitives, et elles ne se remplacent pas :
--
--   * `historyId` — curseur incrémental (`users.history.list`). Le bon outil,
--     mais périssable : « History records are typically available for at least
--     one week and often longer », et un `startHistoryId` trop vieux renvoie
--     « an HTTP 404 error response », auquel cas « your client must perform a
--     full sync ».
--   * `internalDate` — horodatage stable, jamais invalidé, utilisable dans une
--     requête `after:`. Plus grossier, mais il survit à l'expiration du
--     premier.
--
-- Les deux sont donc stockés ensemble : `history_id` pour l'incrémental,
-- `last_internal_date_ms` pour que l'expiration du curseur dégrade vers une
-- resynchronisation BORNÉE au lieu de « toute la boîte » ou, pire, d'un saut
-- silencieux par-dessus les messages perdus.
create table r6b_inbound_checkpoints (
  provider              text not null check (provider in ('gmail')),
  mailbox               text not null,

  history_id            text,
  last_internal_date_ms bigint,
  last_message_id       text,

  last_polled_at        timestamptz,
  -- Compte les fois où le curseur incrémental a été refusé par Gmail. Visible
  -- plutôt que silencieux : un curseur qui expire souvent est un symptôme.
  invalidation_count    integer not null default 0,
  last_invalidated_at   timestamptz,

  updated_at            timestamptz not null default now(),

  primary key (provider, mailbox)
);

comment on table r6b_inbound_checkpoints is
  'Curseur de lecture d''une boîte. Avancé UNIQUEMENT après persistance intégrale d''un tour de poll : '
  'un tour partiel laisse le curseur en arrière, et l''idempotence rend la relecture sans effet.';

-- ---------------------------------------------------------------------------
-- 5. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'ouvre aucun accès : les identifiants Gmail vivent dans
-- l'environnement, jamais en base, et leur absence bloque le poller au lieu de
-- le dégrader. Elle ne crée aucun jeton de réponse, ne modifie aucun
-- expéditeur, et ne déclenche aucune classification commerciale — savoir
-- qu'une réponse existe et à quel envoi elle répond est tout ce que R6B-D1
-- prétend faire.
