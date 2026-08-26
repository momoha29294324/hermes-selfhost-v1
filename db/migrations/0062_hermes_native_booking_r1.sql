-- 0061_hermes_native_booking_r1.sql — HERMES-NATIVE-BOOKING-R1.
--
-- Ce que cette migration fait, et ce qu'elle refuse de faire
-- ---------------------------------------------------------
-- Elle ajoute TROIS tables, toutes additives, et elle N'INSÈRE AUCUNE LIGNE.
-- Une base qui vient de la subir n'a aucun rendez-vous, aucune proposition et
-- aucun journal : elle a seulement de quoi en porter.
--
-- Elle ne touche à RIEN de ce qui existe. Ni `booking_destinations` ni
-- `booking_intents` (0053) ne sont modifiées, supprimées ou vidées : le
-- mécanisme EXTERNE — celui où un prospect ouvre un lien et prend un créneau
-- chez un fournisseur — reste exactement ce qu'il était, c'est-à-dire ABSENT
-- (aucune destination confirmée n'existe). Le rendez-vous NATIF est un
-- mécanisme de plus, pas un remplacement, et les deux ne partagent aucune
-- colonne. La raison est celle qui a séparé les fichiers de configuration :
-- « ce prospect a réservé chez un fournisseur » et « Hermes a inscrit un
-- créneau dans l'agenda de l'opérateur » sont deux faits différents, dont l'un
-- se PROUVE ailleurs et dont l'autre se DÉCIDE ici.
--
-- Elle ne crée aucun transport, aucun destinataire, aucun message, aucune file
-- et aucun ordonnanceur. Aucune table d'ici ne peut faire partir quoi que ce
-- soit : `hermes_appointments` ne porte ni texte, ni handle, ni adresse.

-- ---------------------------------------------------------------------------
-- 1. hermes_appointments — le rendez-vous, et l'invariant qui le tient
-- ---------------------------------------------------------------------------
--
-- La table répond à une seule question : « quels créneaux de l'agenda de
-- l'opérateur sont pris, par qui, et depuis quand ? ».
--
-- Le cœur de la migration est la contrainte d'EXCLUSION. Elle est ce que §5 de
-- la mission demande, et elle est la seule chose du dépôt capable de le tenir :
-- deux conversations qui lisent « 15 h est libre » à la même microseconde et
-- qui insèrent toutes les deux ne peuvent pas toutes les deux réussir, parce
-- que c'est PostgreSQL qui refuse, à l'intérieur de la transaction, sur un
-- index GiST. Aucun `select` suivi d'un `insert` ne donne cette propriété, quel
-- que soit le soin apporté au code entre les deux.
--
-- `span` est une colonne GÉNÉRÉE plutôt qu'un champ écrit par l'application.
-- Un champ écrit peut mentir — il suffit d'un appelant qui oublie de le mettre
-- à jour après avoir décalé `starts_at`, et l'index protège alors un intervalle
-- qui n'existe plus. Une colonne générée ne peut pas diverger de ses sources.
create table hermes_appointments (
  id                    uuid primary key default gen_random_uuid(),

  prospect_id           uuid not null references prospects(id) on delete cascade,

  -- L'agenda visé. UNE valeur en R1 — l'opérateur est seul.
  --
  -- La contrainte d'exclusion ci-dessous ne le lit PAS : elle refuse tout
  -- chevauchement TOUS AGENDAS CONFONDUS. C'est délibéré et c'est plus strict
  -- que nécessaire. Une exclusion par agenda demanderait `btree_gist`, qui
  -- n'est pas disponible dans le moteur embarqué sur lequel tourne la suite de
  -- tests ; entre « refuser un peu trop » et « ne pas tester la garde du tout »,
  -- le dépôt choisit le refus. Le jour où un second agenda existera, la
  -- migration qui l'ouvrira devra activer `btree_gist` et reformuler cette
  -- contrainte — délibérément, dans un diff relu.
  calendar_key          text not null check (length(calendar_key) between 1 and 64),

  -- L'identité de la CONVERSATION d'où vient ce rendez-vous, au format
  -- `<canal>:<prospect>`. Elle n'est pas dérivable de `prospect_id` seul : un
  -- même commerce peut être joint en DM et par email, et savoir laquelle des
  -- deux a produit le rendez-vous est ce qui rend un incident relisible.
  conversation_key      text not null check (length(conversation_key) between 1 and 200),

  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  -- Fermé à gauche, ouvert à droite : deux rendez-vous qui se touchent
  -- (10 h 00 – 10 h 30 puis 10 h 30 – 11 h 00) ne se chevauchent pas.
  span                  tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  -- Le fuseau dans lequel le créneau a été NÉGOCIÉ. `starts_at` est un instant
  -- absolu et se suffit ; ce champ dit ce que la personne a lu à l'écran, ce
  -- qui est la seule manière de relire « mercredi à 15 h » six mois plus tard
  -- sans refaire le calcul d'heure d'été à la main.
  timezone              text not null check (length(timezone) between 3 and 60),

  --   CONFIRMED — le créneau est pris. Il occupe l'agenda.
  --   CANCELLED — il ne l'occupe plus. Le créneau redevient disponible.
  --
  -- Deux états, et pas sept. Un `PENDING` n'aurait aucun sens ici : une
  -- proposition ne bloque RIEN (§11), et un rendez-vous dont on ne sait pas
  -- s'il est pris serait précisément la donnée qu'on refuse d'avoir.
  status                text not null check (status in ('CONFIRMED', 'CANCELLED')),

  --   instagram_hermes — décidé par Hermes dans une conversation Instagram.
  --   operator         — inscrit à la main par un humain nommé.
  source                text not null check (source in ('instagram_hermes', 'operator')),

  -- Le message reçu qui a déclenché ce rendez-vous. `null` pour une inscription
  -- d'opérateur, qui ne vient d'aucun message.
  --
  -- `on delete set null`, et le sens compte : le RENDEZ-VOUS est le fait
  -- durable, le message n'en est que la cause. Un `restrict` — le défaut —
  -- ferait qu'effacer une ligne d'ingestion deviendrait impossible dès qu'un
  -- rendez-vous en découle, c'est-à-dire qu'une table d'agenda prendrait en
  -- otage la table d'entrée. On perd un pointeur, jamais le créneau.
  trigger_inbound_message_id uuid references r6b_inbound_messages(id) on delete set null,

  -- §13 — l'IDEMPOTENCE. Dérivée du déclencheur et du créneau résolu, jamais
  -- d'un compteur ni d'une horloge : rejouer exactement le même message logique
  -- bute sur l'unicité et rend le rendez-vous déjà écrit, au lieu d'en créer un
  -- second. C'est ce qui rend un redémarrage, un rejeu et un crash sans
  -- conséquence.
  idempotency_key       text not null check (length(idempotency_key) between 1 and 400),

  -- Les règles sous lesquelles ce rendez-vous a été pris.
  policy_version        text not null check (length(policy_version) between 1 and 64),

  -- §14 — le REPORT. Le rendez-vous qu'il remplace, annulé dans la MÊME
  -- transaction. La chaîne se relit dans les deux sens et aucune ligne n'est
  -- réécrite : un report laisse deux lignes, dont une seule est CONFIRMED.
  supersedes_id         uuid references hermes_appointments(id),

  -- §12 — la CONFIRMATION envoyée au prospect, qui est un fait DISTINCT de la
  -- réservation.
  --
  --   PENDING              — réservé, le DM de confirmation n'est pas parti.
  --   DELIVERED            — le DM est parti.
  --   DELIVERY_UNCONFIRMED — on a essayé et on ne sait pas. Le rendez-vous
  --                          reste PRIS : supprimer un créneau réellement
  --                          réservé parce qu'un navigateur a échoué serait
  --                          détruire le fait au motif qu'on doute du message.
  confirmation_state    text not null default 'PENDING'
                          check (confirmation_state in ('PENDING', 'DELIVERED', 'DELIVERY_UNCONFIRMED')),
  confirmed_at          timestamptz,

  cancelled_at          timestamptz,
  cancelled_reason      text check (cancelled_reason is null or length(cancelled_reason) between 1 and 200),

  created_by            text not null check (length(created_by) between 1 and 120),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint hermes_appointment_interval_forward check (ends_at > starts_at),
  constraint hermes_appointment_cancelled_has_time check (
    status <> 'CANCELLED' or cancelled_at is not null
  ),
  constraint hermes_appointment_delivered_has_time check (
    confirmation_state <> 'DELIVERED' or confirmed_at is not null
  ),
  -- Un rendez-vous ne se remplace pas lui-même.
  constraint hermes_appointment_supersedes_is_other check (
    supersedes_id is null or supersedes_id <> id
  ),

  -- L'INVARIANT. Deux rendez-vous confirmés ne peuvent pas se chevaucher, quels
  -- que soient les prospects, les processus et l'ordre d'arrivée.
  constraint hermes_appointments_no_overlap
    exclude using gist (span with &&) where (status = 'CONFIRMED')
);

-- §13 — rejouer le même message logique ne crée pas un second rendez-vous.
-- L'unicité porte sur TOUTE l'histoire, annulations comprises : un rendez-vous
-- annulé puis redemandé à l'identique doit passer par une intention neuve, pas
-- par une réécriture silencieuse de la précédente.
create unique index hermes_appointments_idempotency_idx
  on hermes_appointments (idempotency_key);

-- §14 — UNE seule intention de rendez-vous vivante par prospect. Un report
-- annule avant d'insérer, dans la même transaction ; l'index rend l'ordre
-- inverse impossible plutôt que de laisser du code décider quoi faire de
-- l'échec.
create unique index hermes_appointments_one_live_per_prospect_idx
  on hermes_appointments (prospect_id)
  where status = 'CONFIRMED';

create index hermes_appointments_prospect_recent_idx
  on hermes_appointments (prospect_id, starts_at desc);

-- La lecture que le moteur de disponibilité fait à chaque tour : « quels
-- créneaux confirmés touchent la fenêtre que je regarde ? ».
create index hermes_appointments_live_span_idx
  on hermes_appointments (starts_at)
  where status = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- 2. hermes_booking_proposals — ce qui a été PROPOSÉ, et qui ne bloque rien
-- ---------------------------------------------------------------------------
--
-- §11 : proposer n'est pas réserver. Cette table est un ENREGISTREMENT, pas une
-- réservation temporaire : aucune ligne ici n'entre dans la contrainte
-- d'exclusion, aucun créneau n'est retiré de la disponibilité parce qu'il a été
-- proposé, et deux prospects peuvent parfaitement se voir proposer 15 h.
--
-- Elle existe pour deux raisons, toutes deux nécessaires :
--
--   * « mercredi » tout seul, en réponse à « mercredi 15 h ou jeudi 11 h »,
--     n'est PAS ambigu — un seul créneau proposé tombe ce jour-là. Sans cette
--     table, il faudrait redemander une heure que la personne vient de donner ;
--   * un « ok » qui arrive trois heures plus tard doit être re-vérifié contre
--     la disponibilité RÉELLE, et savoir ce qui avait été proposé est ce qui
--     permet de dire « celui-là n'est plus libre » plutôt que « je n'ai pas
--     compris ».
create table hermes_booking_proposals (
  id                    uuid primary key default gen_random_uuid(),
  prospect_id           uuid not null references prospects(id) on delete cascade,
  conversation_key      text not null check (length(conversation_key) between 1 and 200),
  -- Le message reçu à l'issue duquel ces créneaux ont été proposés.
  trigger_inbound_message_id uuid references r6b_inbound_messages(id) on delete set null,
  calendar_key          text not null check (length(calendar_key) between 1 and 64),
  timezone              text not null check (length(timezone) between 3 and 60),

  -- `[{"startsAt": "...", "endsAt": "..."}]`, en instants absolus ISO 8601.
  -- Bornée à quatre : au-delà, une proposition n'est plus une question, c'est
  -- un formulaire.
  slots                 jsonb not null
                          check (jsonb_typeof(slots) = 'array'
                                 and jsonb_array_length(slots) between 1 and 4),

  policy_version        text not null check (length(policy_version) between 1 and 64),
  proposed_at           timestamptz not null default now()
);

-- Le même tour ne propose pas deux fois. Rejouer un message déjà traité
-- retrouve sa proposition au lieu d'en empiler une seconde.
create unique index hermes_booking_proposals_trigger_idx
  on hermes_booking_proposals (prospect_id, trigger_inbound_message_id)
  where trigger_inbound_message_id is not null;

create index hermes_booking_proposals_recent_idx
  on hermes_booking_proposals (prospect_id, proposed_at desc);

-- ---------------------------------------------------------------------------
-- 3. hermes_booking_events — §21, de quoi reconstruire une décision
-- ---------------------------------------------------------------------------
--
-- Une ligne par ACTION de réservation, réussie ou non. Elle ne décide rien et
-- rien ne la lit pour décider : elle existe pour qu'un opérateur puisse
-- répondre à « pourquoi ce prospect n'a-t-il pas de rendez-vous ? » sans relire
-- des journaux de processus.
--
-- `requested_excerpt` est borné à 200 caractères et porte les MOTS DE LA
-- PERSONNE qui expriment le temps demandé — jamais le message entier. C'est la
-- seule manière de vérifier a posteriori que « mercredi 18 h » a bien été
-- compris comme mercredi 18 h ; sans lui, le journal dit ce qu'on a conclu sans
-- dire de quoi. Le texte est déjà durablement stocké dans
-- `r6b_inbound_messages` : ce champ n'expose rien de neuf.
create table hermes_booking_events (
  id                        uuid primary key default gen_random_uuid(),
  prospect_id               uuid not null references prospects(id) on delete cascade,
  conversation_key          text not null check (length(conversation_key) between 1 and 200),
  trigger_inbound_message_id uuid references r6b_inbound_messages(id) on delete set null,

  appointment_id            uuid references hermes_appointments(id) on delete set null,
  previous_appointment_id   uuid references hermes_appointments(id) on delete set null,

  -- Ce que le tour a été compris comme demandant.
  intent                    text not null check (length(intent) between 1 and 40),
  -- Ce qui s'est réellement passé.
  outcome                   text not null check (length(outcome) between 1 and 40),

  requested_excerpt         text check (requested_excerpt is null or length(requested_excerpt) <= 200),
  requested_timezone        text not null check (length(requested_timezone) between 3 and 60),
  resolved_starts_at        timestamptz,
  resolved_ends_at          timestamptz,
  -- Le verdict du moteur de disponibilité, mot pour mot son code.
  availability_verdict      text check (availability_verdict is null or length(availability_verdict) <= 40),
  -- Le code d'ambiguïté, quand c'est lui qui a arrêté la décision.
  ambiguity_reason          text check (ambiguity_reason is null or length(ambiguity_reason) <= 40),
  -- Le refus d'écriture, quand c'est la base qui a arrêté la décision.
  error_code                text check (error_code is null or length(error_code) <= 60),

  policy_version            text not null check (length(policy_version) between 1 and 64),
  observed_at               timestamptz not null default now()
);

create index hermes_booking_events_prospect_idx
  on hermes_booking_events (prospect_id, observed_at desc);

create index hermes_booking_events_appointment_idx
  on hermes_booking_events (appointment_id)
  where appointment_id is not null;
