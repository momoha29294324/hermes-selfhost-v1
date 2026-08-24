-- 0042_ig5_instagram_inbound.sql — IG5.1, le rail Instagram ENTRANT
-- (mission « IG5.1 — INSTAGRAM INBOUND + REPLY INTELLIGENCE — NO AUTO-SEND »).
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration choisit, et ce qu'elle refuse de construire
-- ---------------------------------------------------------------------------
--
-- Elle ne crée PAS de seconde table de réponses. C'était la tentation évidente
-- — `ig_inbound_messages` à côté de `r6b_inbound_messages` — et c'était le
-- mauvais choix : tout l'aval du dépôt (classification, machine à états,
-- brouillon, projection CRM, alertes, Inbox, timeline prospect) est déjà écrit
-- au-dessus de `r6b_inbound_messages`, sans un seul filtre de canal. Une
-- seconde table aurait exigé un second classifieur, une seconde Inbox, une
-- seconde timeline — c'est-à-dire deux vérités sur « qu'a répondu ce prospect ».
--
-- Elle rend donc `r6b_inbound_messages` CHANNEL-AWARE, et paie honnêtement les
-- trois endroits où le vocabulaire e-mail ne dit pas la vérité sur Instagram :
--
--   1. `provider` acceptait `'gmail'` et rien d'autre ;
--   2. `from_address` porte une ADRESSE en e-mail et un HANDLE sur Instagram —
--      la colonne ne mentait pas tant qu'un seul canal existait ;
--   3. `provider_message_id` porte un identifiant ÉMIS PAR LE FOURNISSEUR en
--      e-mail, et Instagram web n'en expose aucun.
--
-- Les points 2 et 3 sont résolus par deux colonnes qui NOMMENT ce que la valeur
-- est (`counterparty_kind`, `message_identity_kind`) plutôt que par un
-- renommage qui aurait cassé les seize lecteurs existants. C'est l'interdit
-- n°2 de CLAUDE.md appliqué à un schéma : une empreinte calculée par nous ne
-- doit pas pouvoir se faire passer pour un identifiant qu'Instagram aurait émis.
--
-- ---------------------------------------------------------------------------
-- Ce qu'elle n'ouvre pas
-- ---------------------------------------------------------------------------
--
-- Aucune capacité d'envoi. Aucune table ci-dessous ne porte de statut d'envoi,
-- de destinataire sortant, ni de texte à remettre. Le rail entrant lit ; il
-- n'a pas de méthode pour agir, et `r6b_reply_drafts` (0026) reste plafonnée à
-- `PROPOSED` — cette migration n'y touche pas.
--
-- Aucune modification de la file sortante Instagram : `ig_dispatch_jobs`,
-- `ig_job_events`, `ig_canary_authorizations` et `ig_kill_switch` ne sont ni
-- altérées, ni lues en écriture ici. Le job canari du lundi reste octet pour
-- octet ce qu'il était.

-- ---------------------------------------------------------------------------
-- 1. r6b_inbound_messages devient channel-aware
-- ---------------------------------------------------------------------------

-- `provider` : la liste fermée s'ouvre d'exactement une valeur. Une liste
-- fermée reste une liste fermée — ajouter un canal demandera une migration,
-- donc une revue, plutôt qu'une chaîne libre glissée par un appelant.
alter table r6b_inbound_messages drop constraint r6b_inbound_messages_provider_check;
alter table r6b_inbound_messages
  add constraint r6b_inbound_messages_provider_check
  check (provider in ('gmail', 'instagram'));

-- `mailbox` porte le compte qui a REÇU. Une adresse e-mail fait au moins trois
-- caractères ; un handle Instagram peut en faire un. La borne basse descend, la
-- borne haute ne bouge pas : c'est un élargissement, jamais un relâchement de
-- ce qui était vrai.
alter table r6b_inbound_messages drop constraint r6b_inbound_messages_mailbox_check;
alter table r6b_inbound_messages
  add constraint r6b_inbound_messages_mailbox_check
  check (length(btrim(mailbox)) between 1 and 320);

-- `body_source` disait d'où venait le corps : une partie MIME, ou rien. Sur
-- Instagram il vient du DOM d'une bulle de conversation, ce qui n'est aucune
-- des trois valeurs existantes. Écrire `'text/plain'` aurait été commode et
-- faux — il n'y a pas de partie MIME.
alter table r6b_inbound_messages drop constraint r6b_inbound_messages_body_source_check;
alter table r6b_inbound_messages
  add constraint r6b_inbound_messages_body_source_check
  check (body_source in ('text/plain', 'text/html', 'none', 'instagram_dm_text'));

-- CE QUE `from_address` CONTIENT RÉELLEMENT.
--
-- Le défaut vaut `'email_address'` : les lignes déjà écrites en portent une, et
-- la colonne dit d'elles quelque chose de vrai sans qu'on ait à les relire.
alter table r6b_inbound_messages
  add column counterparty_kind text not null default 'email_address'
    check (counterparty_kind in ('email_address', 'instagram_handle'));

-- QUI A ÉMIS `provider_message_id`.
--
-- La colonne existe pour empêcher une phrase précise d'être écrite : « Instagram
-- nous a donné cet identifiant ». Il ne nous en a donné aucun. Ce que nous
-- stockons est une empreinte que NOUS calculons à partir de ce que la page a
-- laissé lire (compte, fil, expéditeur, rang d'occurrence, texte normalisé) —
-- déterministe, reproductible, et suffisante pour dédupliquer. Elle n'est pas
-- pour autant un identifiant de fournisseur, et la contrainte ci-dessous
-- interdit de le prétendre.
alter table r6b_inbound_messages
  add column message_identity_kind text not null default 'provider_issued'
    check (message_identity_kind in ('provider_issued', 'observed_fingerprint'));

-- Les trois cohérences par canal, dans les deux sens.
--
-- « Dans les deux sens » compte : une contrainte qui dirait seulement « si
-- Instagram alors handle » laisserait une ligne Gmail se déclarer handle. Ici
-- chaque canal est enfermé dans son vocabulaire, et un futur troisième canal
-- devra s'écrire explicitement plutôt que d'hériter par défaut d'un des deux.
alter table r6b_inbound_messages
  add constraint r6b_inbound_channel_vocabulary_is_coherent check (
    (provider = 'gmail'     and counterparty_kind = 'email_address'
                            and message_identity_kind = 'provider_issued'
                            and body_source in ('text/plain', 'text/html', 'none'))
    or
    (provider = 'instagram' and counterparty_kind = 'instagram_handle'
                            and message_identity_kind = 'observed_fingerprint'
                            and body_source = 'instagram_dm_text')
  );

-- Un DM n'a pas d'objet. Le laisser à `null` et `''` n'est pas une commodité :
-- c'est la seule écriture vraie, et la contrainte empêche qu'un jour un
-- « Re: … » fabriqué s'y glisse pour faire ressembler un DM à un e-mail.
alter table r6b_inbound_messages
  add constraint r6b_inbound_instagram_has_no_subject check (
    provider <> 'instagram' or (subject is null and normalized_subject = '')
  );

-- Un handle Instagram, aux deux bouts. La forme est celle que le rail impose
-- déjà partout ailleurs (`ig_dispatch_jobs.expected_handle`, 0029).
alter table r6b_inbound_messages
  add constraint r6b_inbound_instagram_identifiers_are_handles check (
    provider <> 'instagram'
    or (mailbox ~ '^[A-Za-z0-9._]{1,30}$' and from_address ~ '^[A-Za-z0-9._]{1,30}$')
  );

-- Une empreinte observée est une empreinte : 64 caractères hexadécimaux, comme
-- `body_sha256` et `approved_text_sha256` partout ailleurs dans ce schéma.
alter table r6b_inbound_messages
  add constraint r6b_inbound_fingerprint_is_a_digest check (
    message_identity_kind <> 'observed_fingerprint'
    or provider_message_id ~ '^[0-9a-f]{64}$'
  );

-- L'index d'idempotence existant (`r6b_inbound_messages_provider_message_idx`,
-- unique sur `(provider, mailbox, provider_message_id)`, 0025) couvre le
-- nouveau canal sans être touché : pour Instagram il devient
-- « (instagram, notre compte, empreinte) », c'est-à-dire exactement la clé de
-- déduplication voulue. Le même message vu cinquante fois s'insère une fois.

-- Lecture par canal, pour l'Inbox et les compteurs de la CLI.
create index r6b_inbound_messages_provider_received_idx
  on r6b_inbound_messages (provider, received_at desc);

-- ---------------------------------------------------------------------------
-- 2. ig_inbound_polls — un tour de relève, et un seul à la fois
-- ---------------------------------------------------------------------------
--
-- Cette table répond à trois questions que la mission pose séparément :
-- « quand a-t-on relevé ? » (§13), « deux collecteurs peuvent-ils tourner
-- ensemble ? » (§14), et « la lecture a-t-elle abouti ou s'est-elle arrêtée ? »
-- (§5 fail-closed).
--
-- Le verrou est un INDEX, pas un booléen applicatif : deux processus qui
-- démarrent dans la même milliseconde ne peuvent pas tous deux insérer une
-- ligne `RUNNING` pour le même compte. Le second reçoit une violation d'unicité
-- et s'arrête — c'est PostgreSQL qui tranche, pas un `select` suivi d'un
-- `insert` qui aurait une fenêtre entre les deux.
create table ig_inbound_polls (
  id                        uuid primary key default gen_random_uuid(),

  -- Le compte Instagram qui RELÈVE, c'est-à-dire le nôtre. Jamais celui d'un
  -- prospect : ce rail lit notre boîte, il ne visite personne.
  account_handle            text not null check (account_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  status                    text not null check (status in ('RUNNING', 'COMPLETED', 'FAILED')),

  started_at                timestamptz not null default now(),
  finished_at               timestamptz,
  -- Le bail. Un collecteur tué laisse une ligne `RUNNING` ; sans échéance elle
  -- bloquerait la relève pour toujours. Avec échéance, un tour ultérieur peut
  -- la déclarer `FAILED` et reprendre — sans jamais rejouer une écriture, parce
  -- qu'il n'y en a aucune à rejouer (voir §14 de la mission : la lecture est
  -- naturellement idempotente, l'ingestion l'est par index unique).
  lease_expires_at          timestamptz not null,
  polled_by                 text not null check (length(btrim(polled_by)) between 1 and 200),

  -- Ce que la session a rendu. Même vocabulaire fermé que le rail sortant.
  session_state             text check (session_state is null or session_state in (
                              'SESSION_READY', 'LOGIN_REQUIRED', 'SESSION_EXPIRED',
                              'CHALLENGE', 'CAPTCHA', 'BLOCKED', 'UNKNOWN')),
  -- « Je n'ai pas su lire » n'est pas « il n'y avait rien ». La distinction a
  -- coûté un faux `DELIVERY_FAILED` le 14 août (0038 / IG2.4) ; elle est ici
  -- dès le premier jour.
  inbox_readability         text check (inbox_readability is null or inbox_readability in (
                              'INBOX_READABLE', 'INBOX_UNREADABLE')),

  threads_seen              integer not null default 0 check (threads_seen >= 0),
  threads_read              integer not null default 0 check (threads_read >= 0),
  messages_observed         integer not null default 0 check (messages_observed >= 0),
  messages_ingested         integer not null default 0 check (messages_ingested >= 0),
  messages_already_known    integer not null default 0 check (messages_already_known >= 0),
  -- Requêtes d'écriture refusées par la garde réseau pendant la relève.
  -- Attendu : 0. Une valeur non nulle n'est pas une panne, c'est une garde qui
  -- a fait son travail — et elle doit être visible.
  blocked_write_requests    integer not null default 0 check (blocked_write_requests >= 0),

  detail                    text check (detail is null or length(detail) <= 2000),

  -- Un tour terminé porte sa fin, et lui seul.
  constraint ig_inbound_poll_terminal_has_finish check (
    (status in ('COMPLETED', 'FAILED')) = (finished_at is not null)
  ),
  -- On ne peut pas avoir lu plus de fils qu'on n'en a vus, ni ingéré plus de
  -- messages qu'on n'en a observés. Une arithmétique fausse dans un rapport
  -- d'observation est une observation fausse.
  constraint ig_inbound_poll_counts_are_coherent check (
    threads_read <= threads_seen
    and messages_ingested + messages_already_known <= messages_observed
  )
);

create unique index ig_inbound_polls_single_running_idx
  on ig_inbound_polls (account_handle)
  where status = 'RUNNING';

create index ig_inbound_polls_recent_idx on ig_inbound_polls (started_at desc);
create index ig_inbound_polls_expired_lease_idx
  on ig_inbound_polls (lease_expires_at asc)
  where status = 'RUNNING';

-- ---------------------------------------------------------------------------
-- 3. ig_inbound_thread_observations — ce que la boîte a montré
-- ---------------------------------------------------------------------------
--
-- Journal en AJOUT SEUL. Il existe pour que l'étape suivante ne puisse jamais
-- fabriquer une vérité : la corrélation lit des lignes écrites, pas une
-- variable en mémoire, et un fil illisible reste inscrit comme illisible
-- plutôt que d'être absent du journal — donc confondu avec un fil vide.
create table ig_inbound_thread_observations (
  id                        uuid primary key default gen_random_uuid(),
  poll_id                   uuid not null references ig_inbound_polls(id) on delete cascade,

  row_index                 integer not null check (row_index >= 0),
  -- L'identifiant du fil, quand la ligne en porte un. `null` est fréquent :
  -- l'interface actuelle ne met plus systématiquement de lien `/direct/t/<id>/`
  -- sur ses lignes (IG2.4). Un fil sans identifiant n'est pas ouvert — on ne
  -- devine pas une URL.
  thread_id                 text check (thread_id is null or thread_id ~ '^[0-9]{1,40}$'),

  -- Le texte VISIBLE de la ligne, borné. C'est ce qu'un humain voit déjà en
  -- ouvrant sa boîte ; rien de plus n'en est extrait, et aucune autre
  -- conversation n'est ouverte pour l'obtenir.
  row_text                  text not null check (length(row_text) <= 400),
  -- L'âge affiché, en millisecondes. `null` quand l'horodatage relatif n'a pas
  -- pu être lu — jamais 0, qui voudrait dire « à l'instant ».
  age_ms                    bigint check (age_ms is null or age_ms >= 0),
  -- Le handle, quand la LIGNE le nomme. Un nom d'affichage seul ne remplit pas
  -- cette colonne (§7 : « ne corrèle pas simplement sur un nom d'affichage »).
  counterparty_handle       text check (counterparty_handle is null
                                        or counterparty_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  outcome                   text not null check (outcome in (
                              'READ',              -- le fil a été ouvert et récolté
                              'NOT_OPENED',        -- pas d'identifiant navigable
                              'UNREADABLE',        -- ouvert, mais la récolte a échoué
                              'SKIPPED_LIMIT')),   -- borne de fils par tour atteinte
  detail                    text not null check (length(detail) between 1 and 1000),
  observed_at               timestamptz not null default now(),

  constraint ig_inbound_thread_obs_unique_row unique (poll_id, row_index),
  -- Un fil « lu » a forcément été atteint, donc il portait un identifiant.
  constraint ig_inbound_thread_obs_read_has_id check (outcome <> 'READ' or thread_id is not null)
);

create index ig_inbound_thread_obs_poll_idx on ig_inbound_thread_observations (poll_id, row_index);
create index ig_inbound_thread_obs_thread_idx
  on ig_inbound_thread_observations (thread_id, observed_at desc)
  where thread_id is not null;

-- ---------------------------------------------------------------------------
-- 4. ig_inbound_message_observations — ce que chaque bulle a laissé lire
-- ---------------------------------------------------------------------------
--
-- Le pont entre OBSERVATION et INGESTION, et la raison pour laquelle les deux
-- restent séparées : une bulle observée dont la direction n'a pas pu être
-- tranchée s'inscrit ici avec `direction = 'UNKNOWN'` et n'entre PAS dans
-- `r6b_inbound_messages`. Elle n'est ni perdue ni promue en réponse — elle est
-- consignée comme ce qu'elle est, et un humain peut la relire.
create table ig_inbound_message_observations (
  id                        uuid primary key default gen_random_uuid(),
  poll_id                   uuid not null references ig_inbound_polls(id) on delete cascade,

  thread_id                 text not null check (thread_id ~ '^[0-9]{1,40}$'),
  account_handle            text not null check (account_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  -- L'expéditeur, quand le FIL le nomme (lien de profil). `null` sinon.
  sender_handle             text check (sender_handle is null or sender_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  -- ENTRANT / SORTANT / INDÉCIDABLE. Le troisième existe parce que la
  -- géométrie d'une bulle peut être ambiguë (fil étroit, rendu partiel) et
  -- qu'un rail qui trancherait au hasard transformerait notre propre message
  -- en réponse de prospect.
  direction                 text not null check (direction in ('INCOMING', 'OUTGOING', 'UNKNOWN')),
  -- Comment la direction a été établie. `geometry` = position dans la largeur
  -- du fil, `accessible` = libellé « vous avez envoyé », `both` = les deux,
  -- `none` = aucune, donc `UNKNOWN`.
  direction_basis           text not null check (direction_basis in ('geometry', 'accessible', 'both', 'none')),

  -- Le rang de CETTE occurrence parmi les bulles identiques du même expéditeur
  -- dans la même récolte. Il entre dans l'empreinte : sans lui, quelqu'un qui
  -- écrit « ok » deux fois n'aurait qu'une seule réponse en base.
  occurrence_index          integer not null check (occurrence_index >= 0),

  text_sha256               text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  -- L'empreinte déterministe complète. Même compte, même fil, même expéditeur,
  -- même rang, même texte normalisé ⇒ même valeur, sur n'importe quelle
  -- machine et après n'importe quel redémarrage.
  fingerprint               text not null check (fingerprint ~ '^[0-9a-f]{64}$'),

  outcome                   text not null check (outcome in (
                              'INGESTED',                    -- première fois : une ligne inbound est née
                              'ALREADY_KNOWN',               -- déjà ingéré lors d'un tour précédent
                              'SKIPPED_OUTGOING',            -- c'est notre message
                              'SKIPPED_UNKNOWN_DIRECTION',   -- indécidable, fail-closed
                              'SKIPPED_UNIDENTIFIED_SENDER') -- le fil ne nomme personne
                            ),
  inbound_message_id        uuid references r6b_inbound_messages(id),
  observed_at               timestamptz not null default now(),

  -- Un même tour ne consigne pas deux fois la même bulle. Le rejeu d'un tour
  -- interrompu retombe donc sur cette contrainte plutôt que de gonfler le
  -- journal.
  constraint ig_inbound_msg_obs_unique unique (poll_id, fingerprint),

  -- Les deux seules issues qui pointent vers une réponse en pointent une, et
  -- les trois autres n'en pointent aucune.
  constraint ig_inbound_msg_obs_ingest_points_somewhere check (
    (outcome in ('INGESTED', 'ALREADY_KNOWN')) = (inbound_message_id is not null)
  ),
  -- Rien d'autre qu'un message ENTRANT ne devient une réponse. C'est la
  -- garantie structurelle demandée par §15 : « message sortant non confondu
  -- avec une reply ».
  constraint ig_inbound_msg_obs_ingest_is_incoming check (
    outcome not in ('INGESTED', 'ALREADY_KNOWN') or direction = 'INCOMING'
  ),
  -- Un expéditeur inconnu ne peut pas produire de réponse corrélable.
  constraint ig_inbound_msg_obs_ingest_has_sender check (
    outcome not in ('INGESTED', 'ALREADY_KNOWN') or sender_handle is not null
  ),
  -- `UNKNOWN` et `none` vont ensemble, dans les deux sens.
  constraint ig_inbound_msg_obs_direction_basis_coherent check (
    (direction = 'UNKNOWN') = (direction_basis = 'none')
  )
);

create index ig_inbound_msg_obs_poll_idx on ig_inbound_message_observations (poll_id, observed_at);
create index ig_inbound_msg_obs_thread_idx on ig_inbound_message_observations (thread_id, observed_at desc);
create index ig_inbound_msg_obs_fingerprint_idx on ig_inbound_message_observations (fingerprint);

-- ---------------------------------------------------------------------------
-- 5. ig_inbound_thread_bindings — « ce fil est celui de CE manifeste »
-- ---------------------------------------------------------------------------
--
-- L'équivalent Instagram de `In-Reply-To` : l'identifiant fort qui rattache une
-- conversation à un envoi précis. Il n'existe pas chez Instagram, donc il est
-- OBSERVÉ — et il l'est par la seule preuve que ce dépôt accepte déjà ailleurs
-- (`deliveryProof.findApprovedTextBubbles`) : le fil contient une bulle
-- SORTANTE dont le texte normalisé est exactement le texte approuvé d'un
-- manifeste verrouillé.
--
-- Pourquoi c'est fort : le texte approuvé est figé, long, et personne d'autre
-- ne l'a écrit. Le retrouver du côté sortant d'un fil prouve que c'est nous qui
-- l'y avons mis, pour ce manifeste-là.
--
-- Pourquoi ce n'est pas suffisant seul : deux manifestes du même prospect
-- peuvent porter le même texte après un reverrouillage. La table ne tranche pas
-- ce cas — elle laisse coexister les deux liens, et la corrélation rend
-- `REVIEW_REQUIRED` quand elle en voit plusieurs. Choisir « le plus récent »
-- serait exactement le geste que ce dépôt refuse ailleurs.
create table ig_inbound_thread_bindings (
  id                        uuid primary key default gen_random_uuid(),

  thread_id                 text not null check (thread_id ~ '^[0-9]{1,40}$'),
  manifest_id               uuid not null references r6b_dispatch_manifests(id),
  prospect_id               uuid not null references prospects(id),
  outreach_event_id         uuid not null references outreach_events(id),
  counterparty_handle       text not null check (counterparty_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  basis                     text not null check (basis in ('observed_outgoing_approved_text')),
  evidence                  jsonb not null default '{}'::jsonb,

  first_observed_poll_id    uuid not null references ig_inbound_polls(id),
  created_at                timestamptz not null default now(),

  -- Un lien, une fois. Le rejeu d'une observation ne crée pas un second lien.
  constraint ig_inbound_thread_binding_unique unique (thread_id, manifest_id)
);

create index ig_inbound_thread_bindings_thread_idx on ig_inbound_thread_bindings (thread_id);
create index ig_inbound_thread_bindings_manifest_idx on ig_inbound_thread_bindings (manifest_id);
