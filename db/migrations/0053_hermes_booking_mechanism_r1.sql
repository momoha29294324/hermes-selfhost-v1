-- 0053_hermes_booking_mechanism_r1.sql — HERMES-BOOKING-MECHANISM-R1.
--
-- Ce que cette migration fait, et ce qu'elle refuse de faire
-- ---------------------------------------------------------
-- Elle ajoute DEUX tables, toutes deux additives, et elle N'INSÈRE AUCUNE
-- LIGNE. Une base qui vient de la subir est exactement dans l'état où elle
-- était : `MISSING_BOOKING_MECHANISM`. C'est le point — l'audit du 22 août 2026
-- n'a trouvé AUCUN mécanisme de réservation Hermes (ni lien, ni agenda, ni
-- identifiant de calendrier, ni jeton), et une migration qui en fabriquerait un
-- inventerait précisément la donnée que CLAUDE.md §2 interdit.
--
-- Ce qu'elle ouvre est une PLACE, pas un droit : une place où un opérateur
-- nommé pourra déposer un mécanisme réel, et une place où la preuve d'un
-- rendez-vous réellement pris pourra être écrite. Les deux restent vides tant
-- que personne ne les remplit, et le code lit ce vide comme un refus.
--
-- Elle ne touche ni `ig_kill_switch` (qui reste tel quel), ni
-- `ig_dispatch_jobs`, ni `r6b_dispatch_manifests`, ni `outreach_events`, ni
-- `r6b_inbound_messages`, ni `prospects`. Elle ne crée aucun transport, aucun
-- destinataire, aucun message. Aucune table d'ici ne peut faire partir quoi que
-- ce soit.

-- ---------------------------------------------------------------------------
-- 1. booking_destinations — le mécanisme de réservation, confirmé par un humain
-- ---------------------------------------------------------------------------
--
-- Même forme que `r6b_crm_destinations` (0027), et pour la même raison exacte :
-- une variable d'environnement seule n'autorise rien. Un lien de réservation
-- mal copié enverrait des prospects dans l'agenda de quelqu'un d'autre, ce qui
-- est la version « rendez-vous » de l'écriture dans le mauvais sous-compte.
-- La barre est donc identique — une ligne CONFIRMED portant le nom de son
-- auteur — plutôt qu'un second mécanisme d'autorisation à inventer.
--
-- `provider` n'est pas contraint à une liste fermée. Le code (`bookingStore`)
-- décide quels noms savent réellement désigner quelque chose ; figer la liste
-- ici obligerait à une migration pour ajouter un fournisseur de test, ce qui
-- pousserait les tests à contourner cette table — c'est-à-dire à ne plus
-- tester la garde.
create table booking_destinations (
  id                uuid primary key default gen_random_uuid(),

  provider          text not null check (length(provider) between 1 and 64),

  -- L'URL de prise de rendez-vous, telle qu'un opérateur l'a fournie. Ce n'est
  -- PAS un secret (elle est destinée à être lue par des prospects), et elle
  -- doit rester lisible : c'est elle qu'un humain relit pour vérifier qu'il ne
  -- s'agit pas de l'agenda d'un autre projet.
  --
  -- `https://` obligatoire : un lien en clair dans un DM est une dégradation
  -- que rien ici ne justifie.
  --
  -- Le motif et la longueur sont deux contrôles séparés à dessein : la borne
  -- répétitive d'une expression POSIX est plafonnée à 255, si bien qu'un
  -- `{5,500}` inline ne compile pas du tout. Le dire en deux morceaux le rend
  -- à la fois valide et lisible.
  booking_url       text not null
                      check (booking_url ~ '^https://[^[:space:]]+$'
                             and length(booking_url) between 12 and 500),

  -- L'identifiant d'agenda CHEZ LE FOURNISSEUR, quand il en expose un. Sert à
  -- rapprocher une preuve de rendez-vous de la destination qui l'a produite.
  calendar_ref      text check (calendar_ref is null or length(calendar_ref) between 1 and 128),

  --   UNCONFIRMED — déposée, jamais autorisée à être proposée.
  --   CONFIRMED   — un humain a nommément confirmé qu'il s'agit de Hermes.
  --   REVOKED     — retirée. Ne redevient jamais CONFIRMED sans nouvelle ligne.
  status            text not null default 'UNCONFIRMED'
                      check (status in ('UNCONFIRMED', 'CONFIRMED', 'REVOKED')),
  confirmed_by      text check (confirmed_by is null or length(confirmed_by) between 1 and 120),
  confirmed_at      timestamptz,
  note              text,

  -- L'OBSERVATION d'accessibilité, en lecture seule : le lien a-t-il répondu,
  -- et avec quel code. Jamais une réservation soumise — lire une page et y
  -- prendre un créneau sont deux gestes différents, et seul le premier a lieu.
  reachable_status  integer check (reachable_status is null
                                   or (reachable_status between 100 and 599)),
  reachable_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Une confirmation sans confirmant est une confirmation que personne n'a
  -- faite. Le schéma refuse de la porter.
  constraint booking_destination_confirmed_has_author check (
    status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null)
  ),
  -- Une destination confirmée doit avoir été VUE répondre. Confirmer un lien
  -- que personne n'a jamais chargé, c'est confirmer une chaîne de caractères.
  constraint booking_destination_confirmed_was_reachable check (
    status <> 'CONFIRMED' or (reachable_status between 200 and 299 and reachable_at is not null)
  )
);

create unique index booking_destinations_provider_url_idx
  on booking_destinations (provider, booking_url);

-- UNE seule destination confirmée, tous fournisseurs confondus. Deux agendas
-- confirmés en même temps rendraient la question « où ce prospect prend-il
-- rendez-vous ? » ambiguë, et une ambiguïté sur cette question-là envoie la
-- moitié des prospects dans un agenda que personne ne regarde.
create unique index booking_destinations_one_confirmed_idx
  on booking_destinations ((status))
  where status = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- 2. booking_intents — UNE piste de rendez-vous par prospect, et sa preuve
-- ---------------------------------------------------------------------------
--
-- Cette table répond à une seule question : « où en est CE prospect entre
-- "un appel a du sens" et "un rendez-vous existe" ? ». Elle n'est pas une
-- seconde file (l'ordonnancement reste `ig_dispatch_jobs`), pas un second CRM
-- (la projection reste `r6b_crm_projections`), et pas un agenda (aucune ligne
-- ici ne crée de créneau chez qui que ce soit).
--
-- Le point dur qu'elle tient : `APPOINTMENT_BOOKED` ne s'obtient PAS en ayant
-- envoyé un lien. Les colonnes de preuve sont exigées par contrainte, et elles
-- ne peuvent venir que d'une observation faite CHEZ le fournisseur ou d'une
-- attestation nominative. Un `state` ne peut donc pas devenir `APPOINTMENT_BOOKED`
-- au motif qu'un message est parti — le schéma le refuse avant le code.
create table booking_intents (
  id                    uuid primary key default gen_random_uuid(),

  prospect_id           uuid not null references prospects(id) on delete cascade,
  destination_id        uuid not null references booking_destinations(id),

  --   BOOKING_PROPOSED  — la proposition est autorisée et ouverte.
  --   BOOKING_PENDING   — la proposition est partie ; on attend une preuve.
  --   APPOINTMENT_BOOKED— une preuve suffisante a été observée.
  --   BOOKING_DECLINED  — la personne a refusé l'échange.
  state                 text not null
                          check (state in ('BOOKING_PROPOSED', 'BOOKING_PENDING',
                                           'APPOINTMENT_BOOKED', 'BOOKING_DECLINED')),

  -- La politique sous laquelle cette piste a été ouverte. Une piste ouverte
  -- sous d'autres règles ne couvre pas les règles actuelles : changer une porte
  -- impose d'incrémenter la version, ce qui referme les pistes d'avant.
  policy_version        text not null check (length(policy_version) between 1 and 64),

  proposed_at           timestamptz not null default now(),
  declined_at           timestamptz,

  -- ---- La PREUVE, et rien d'autre ----------------------------------------
  --
  -- `external_booking_ref` est émis PAR LE FOURNISSEUR. Nous ne le fabriquons
  -- pas : un identifiant que nous aurions inventé prouverait uniquement que
  -- nous savons écrire dans notre propre table.
  external_booking_ref  text check (external_booking_ref is null
                                    or length(external_booking_ref) between 1 and 200),
  scheduled_start_at    timestamptz,
  --   PROVIDER_RECORD   — lu chez le fournisseur.
  --   OPERATOR_ATTESTED — un humain nommé atteste avoir vu le rendez-vous.
  evidence_kind         text check (evidence_kind is null
                                    or evidence_kind in ('PROVIDER_RECORD', 'OPERATOR_ATTESTED')),
  observed_by           text check (observed_by is null or length(observed_by) between 1 and 120),
  observed_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Le cœur de la migration. `APPOINTMENT_BOOKED` exige les CINQ éléments de
  -- preuve ensemble ; il n'y a pas de rendez-vous « à moitié prouvé ».
  constraint booking_intent_booked_has_proof check (
    state <> 'APPOINTMENT_BOOKED' or (
      external_booking_ref is not null
      and scheduled_start_at is not null
      and evidence_kind is not null
      and observed_by is not null
      and observed_at is not null
    )
  ),
  -- Et la réciproque, qui compte tout autant : une preuve écrite sur une piste
  -- qui n'est pas `APPOINTMENT_BOOKED` serait une preuve orpheline, c'est-à-dire
  -- un rendez-vous que personne ne compte.
  constraint booking_intent_proof_implies_booked check (
    external_booking_ref is null or state = 'APPOINTMENT_BOOKED'
  ),
  constraint booking_intent_declined_has_time check (
    state <> 'BOOKING_DECLINED' or declined_at is not null
  )
);

-- UNE seule piste VIVANTE par prospect. C'est l'idempotence : deux tentatives,
-- deux rejeux, deux workers qui lisent la même conversation à la même seconde
-- ne peuvent pas produire deux rendez-vous logiques. Une piste refusée
-- (`BOOKING_DECLINED`) sort de l'index, ce qui laisse une reprise possible plus
-- tard sans jamais autoriser un doublon vivant.
create unique index booking_intents_one_live_per_prospect_idx
  on booking_intents (prospect_id)
  where state in ('BOOKING_PROPOSED', 'BOOKING_PENDING', 'APPOINTMENT_BOOKED');

-- Une référence de réservation appartient à un seul rendez-vous. Rejouer la
-- même preuve ne peut donc pas en écrire une seconde.
create unique index booking_intents_external_ref_idx
  on booking_intents (destination_id, external_booking_ref)
  where external_booking_ref is not null;
