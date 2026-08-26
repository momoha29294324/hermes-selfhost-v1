-- 0040_channel_identity_human_confirmation.sql — IG4.2, la confirmation
-- humaine d'identité de canal (mission « IG4.2 — HUMAN CHANNEL IDENTITY
-- CONFIRMATION »).
--
-- ---------------------------------------------------------------------------
-- Le problème que cette migration résout
-- ---------------------------------------------------------------------------
--
-- Le gate Instagram (`src/lib/instagram/eligibility.ts`, porte
-- `identity_provenance`) lit `identity_review`, figé au verrouillage du
-- manifeste depuis `prospects.identity_review`. Ce champ répond à une question
-- précise, posée par le rail de découverte commerciale (0009) : « l'identité
-- LÉGALE de cette entreprise a-t-elle été établie automatiquement ? ». Ses
-- trois valeurs — `confirmed`, `manual_review`, `uncertain` — décrivent l'état
-- d'un rapprochement automatique entre une fiche et un registre.
--
-- Le 14 août 2026, un humain a pris une décision que ce champ ne sait pas
-- porter : le site officiel `example.com` publie lui-même un appel à
-- l'action vers `https://www.instagram.com/atelieratelier_/`, donc ce compte
-- Instagram est celui que l'entreprise présente. C'est une provenance de CANAL,
-- observée par un humain, et elle ne dit rien du SIREN, du SIRET, ni de
-- l'adresse légale.
--
-- Écrire `identity_review = 'confirmed'` pour faire passer la porte aurait
-- falsifié la sémantique du champ : le rail automatique aurait ensuite affirmé
-- une identité légale que personne n'a vérifiée, et l'historique de ce qu'il
-- avait réellement conclu (`manual_review`) aurait disparu. C'est exactement ce
-- que l'interdit n°2 de CLAUDE.md refuse — « jamais une supposition présentée
-- comme un fait ».
--
-- Cette table existe donc pour porter le SECOND fait, à côté du premier, sans
-- le toucher :
--
--   identité légale/business automatique   (prospects.identity_review — intacte)
-- + provenance automatique du destinataire (r6b_dispatch_manifests.recipient_evidence_ids)
-- + confirmation humaine explicite du canal (CETTE TABLE, facultative)
--   → éligibilité Instagram
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
--   * elle n'insère aucune ligne : la base qui vient de la subir ne porte
--     AUCUNE confirmation, et le comportement du gate y est donc identique à
--     celui d'avant ;
--   * elle ne modifie ni `prospects`, ni `r6b_dispatch_manifests`, ni
--     `prospect_evidence` : la vérité automatique n'est ni réécrite, ni
--     recalculée, ni promue ;
--   * elle n'ouvre aucun chemin d'envoi. Aucune colonne d'ici ne porte de
--     message, de destinataire d'envoi, de statut de remise ni d'autorisation.
--     Elle ne touche ni `ig_kill_switch` (qui reste armé), ni
--     `ig_live_canary_authorizations` (qui reste sans autorisation active), ni
--     `outreach_events` ;
--   * elle ne dispense d'AUCUNE autre porte : ICP, opt-out, suppression,
--     manifeste, payload, contact déjà établi, intention concurrente,
--     ordonnanceur, plafonds, cooldown, canari et arrêt global restent
--     exactement où ils étaient.
--
-- Additive au sens strict : aucune colonne supprimée, aucune valeur retirée
-- d'un `check` existant, aucune preuve effacée.

-- ---------------------------------------------------------------------------
-- channel_identity_decisions — append-only, une ligne par décision humaine
-- ---------------------------------------------------------------------------
--
-- Le patron est celui de `ig_enqueue_decisions` (0039) et de
-- `r6b_dispatch_attempts` (0021) : on n'écrit que des INSERT. Un journal qu'on
-- réécrit ne prouve rien — et ici, ce qu'il doit prouver est précisément
-- « qui a décidé quoi, quand, et sur quelle base ». Un changement d'avis
-- (CONFIRMED puis REJECTED) est donc une SECONDE ligne, pas un UPDATE : les
-- deux restent lisibles, et la plus récente fait foi.
--
-- La table n'est pas préfixée `ig_` alors que son unique lecteur est
-- aujourd'hui le gate Instagram, et c'est délibéré : la question qu'elle porte
-- (« ce destinataire est-il bien celui de ce prospect, sur ce canal ? ») est
-- posée par le vocabulaire `transport` de R6B, qui vaut pour sept canaux. La
-- borner à Instagram obligerait à la dupliquer au premier autre canal. En
-- revanche, RIEN d'autre que le gate Instagram ne la lit à ce jour : une ligne
-- `email` y serait inerte, et aucun chemin d'envoi e-mail ne la consulte.
create table channel_identity_decisions (
  id                        uuid primary key default gen_random_uuid(),

  -- Le prospect COMMERCIAL visé. Pas le manifeste : un manifeste se
  -- reverrouille, se supersede, se remplace — et une décision humaine sur
  -- « à qui appartient ce compte » survit à ces reverrouillages. La rattacher
  -- à un manifeste aurait obligé à la reprendre à chaque nouveau lock, c'est-à-dire
  -- à en faire une formalité plutôt qu'une décision.
  prospect_id               uuid not null references prospects(id) on delete cascade,

  -- Même liste fermée que `r6b_dispatch_manifests.transport` (0020). Une
  -- décision porte sur UN canal : confirmer un compte Instagram ne dit rien
  -- d'une adresse e-mail, et la colonne empêche qu'elle le dise.
  transport                 text not null
                              check (transport in ('email', 'instagram_dm', 'facebook_dm', 'web_form',
                                                   'sms', 'whatsapp', 'phone_call')),

  -- Le destinataire EXACT sur lequel porte la décision, tel que l'humain l'a
  -- désigné : un handle Instagram sans `@`, une adresse e-mail, un numéro.
  --
  -- C'est la clé de toute la garantie demandée par la mission : « une
  -- confirmation de @atelieratelier_ ne doit pas valider silencieusement un
  -- futur autre handle du prospect ». Le gate compare ce que le manifeste a
  -- figé à cette valeur ; si le destinataire change, plus rien ne correspond et
  -- la décision cesse de satisfaire la porte — sans qu'aucun code n'ait à
  -- « invalider » quoi que ce soit.
  recipient                 text not null check (length(btrim(recipient)) between 1 and 320),

  -- CONFIRMED / REJECTED, et rien d'autre. Pas un booléen : « personne n'a
  -- décidé » (absence de ligne) et « un humain a décidé que non » (REJECTED)
  -- sont deux faits distincts, et le second doit pouvoir s'écrire. Un booléen
  -- les aurait confondus sous `false`.
  decision                  text not null check (decision in ('CONFIRMED', 'REJECTED')),

  -- Sur quoi la décision se fonde, en toutes lettres. Obligatoire : une
  -- décision d'identité sans motif est une décision qu'on ne peut pas relire.
  reason                    text not null check (length(btrim(reason)) between 1 and 2000),
  -- L'empreinte du motif, pour l'index de rejeu ci-dessous. Un index qui
  -- porterait le motif entier dépasserait la taille maximale d'une clé btree
  -- dès qu'un opérateur écrit un paragraphe ; l'empreinte est bornée à 64
  -- octets par construction. Calculée par l'application (`sha256Hex`), comme
  -- `approved_text_sha256` et `transport_payload_sha256`.
  reason_sha256             text not null check (reason_sha256 ~ '^[0-9a-f]{64}$'),

  -- La preuve cliquable, quand il y en a une. Ici : la page du site officiel
  -- qui publie l'appel à l'action vers le compte. Facultative — toute
  -- provenance n'est pas une URL — mais contrainte de forme quand elle est là,
  -- pour qu'un audit six mois plus tard puisse l'ouvrir plutôt que de relire
  -- un paragraphe.
  evidence_url              text check (evidence_url is null or evidence_url ~ '^https?://[^[:space:]]+$'),

  -- CE QUE LE RAIL AUTOMATIQUE DISAIT AU MOMENT DE LA DÉCISION.
  --
  -- Cette colonne est la preuve, dans le schéma, que les deux vérités restent
  -- séparées : elle conserve `prospects.identity_review` tel qu'il était quand
  -- l'humain a tranché, et le rail automatique n'est pas touché pour autant. Un
  -- audit peut donc lire « le rail disait manual_review, l'humain a confirmé le
  -- canal » — deux affirmations qui coexistent sans que l'une écrase l'autre.
  --
  -- Nullable : un prospect dont l'identité n'a jamais été évaluée n'a pas de
  -- valeur à conserver, et inventer `uncertain` à sa place serait affirmer une
  -- absence non vérifiée.
  automatic_identity_review text check (automatic_identity_review is null
                              or automatic_identity_review in ('confirmed', 'manual_review', 'uncertain')),

  -- Qui a décidé. Nominatif et obligatoire, comme `r6b_crm_destinations.confirmed_by`
  -- (0027) et `ig_dispatch_jobs.enqueued_by` (0029) : une décision humaine que
  -- personne ne signe n'est pas une décision humaine. Aucune valeur système
  -- n'est prévue ici, et aucun chemin de code n'en écrit : ce champ ne doit
  -- jamais laisser croire que le rail automatique a conclu.
  decided_by                text not null check (length(btrim(decided_by)) between 1 and 120),
  decided_at                timestamptz not null default now(),

  created_at                timestamptz not null default now()
);

-- La lecture du gate : la décision EFFECTIVE pour un triplet
-- (prospect, transport, destinataire). `lower(recipient)` parce qu'un handle
-- Instagram est insensible à la casse — c'est déjà la comparaison que fait le
-- gate `opt_out` sur `do_not_contact`, et deux graphies du même compte ne sont
-- pas deux comptes.
create index channel_identity_decisions_lookup_idx
  on channel_identity_decisions (prospect_id, transport, lower(recipient), decided_at desc);

-- L'index de rejeu : la MÊME décision, avec le MÊME motif, sur le même
-- triplet, ne peut pas s'écrire deux fois. Rejouer la commande d'un opérateur
-- ne produit donc pas un second fait ; il n'en existe qu'un.
--
-- Ce qu'il n'interdit pas, volontairement : une décision CONTRAIRE (un
-- changement d'avis, qui doit pouvoir s'inscrire) et une même décision motivée
-- autrement (une preuve supplémentaire, qui enrichit l'audit). L'unicité porte
-- sur la répétition à l'identique, pas sur l'histoire.
create unique index channel_identity_decisions_replay_idx
  on channel_identity_decisions (prospect_id, transport, lower(recipient), decision, reason_sha256);

comment on table channel_identity_decisions is
  'IG4.2 — décision HUMAINE de provenance de canal : « ce destinataire est bien celui de ce '
  'prospect commercial, sur ce transport ». Append-only. Ne dit RIEN d''une identité légale '
  'SIREN/SIRET, ne modifie pas prospects.identity_review, et ne dispense d''aucune autre porte '
  '(ICP, opt-out, manifeste, payload, contact déjà établi, canari, arrêt global).';

comment on column channel_identity_decisions.automatic_identity_review is
  'prospects.identity_review tel qu''il était au moment de la décision humaine. Conservé pour '
  'prouver que les deux vérités coexistent : le rail automatique n''est jamais promu par une '
  'confirmation humaine.';
