-- 0022_r6b_transport_payload.sql — R6B-C.2A, payload transport immuable
-- (mission « Hermes R6B-C.2A — Transport Payload Completion »).
--
-- R6B-C.1 a prouvé qu'un manifeste LOCKED suffit à décrire un dispatch :
-- transport, destinataire, texte approuvé, sha256 du texte. Il manque une
-- chose pour qu'un futur envoi réel n'ait rien à inventer : les propriétés
-- que le transport lui-même exige et que le corps du message ne porte pas.
-- Un email a besoin d'un objet ; aucun objet n'a jamais été approuvé, donc un
-- sender LIVE devrait aujourd'hui soit en fabriquer un (interdit n°2 de
-- CLAUDE.md : jamais une donnée inventée), soit refuser d'envoyer.
--
-- Cette migration ne crée ni sender, ni provider, ni credential, ni adapter
-- LIVE. `OUTBOUND_ALLOW_SENDING` reste à 0, `outreach_events` reste vide.
--
-- ---------------------------------------------------------------------------
-- Pourquoi un seul jsonb plutôt qu'une colonne par transport
-- ---------------------------------------------------------------------------
--
-- Sept transports existent (0020) et chacun aura, à terme, ses propres
-- exigences : un objet pour l'email, un mapping de champs pour un formulaire,
-- peut-être un identifiant de template pour WhatsApp. Une colonne par
-- propriété ferait de chaque nouveau transport une migration de schéma, et
-- laisserait sur chaque ligne six colonnes nulles qui ne veulent rien dire
-- pour son transport. Un `jsonb` unique garde la ligne honnête : elle porte
-- exactement les propriétés que SON transport exige, et rien d'autre.
--
-- Ce que le jsonb ne relâche pas : la liste des clés autorisées par transport
-- reste du code testé (`TRANSPORT_LIVE_REQUIREMENTS` dans
-- `r6bTransportPayload.ts`), jamais un champ libre. Le dispatcher refuse une
-- clé hors taxonomie avant de construire son enveloppe.

-- ---------------------------------------------------------------------------
-- 1. Le payload transport-spécifique et son empreinte propre
-- ---------------------------------------------------------------------------
--
-- Empreinte distincte de `approved_text_sha256` volontairement : le corps du
-- message a été approuvé lors du vote R6B-A, le payload transport l'est plus
-- tard et par un geste différent. Deux décisions humaines séparées → deux
-- preuves séparées. Un futur sender peut ainsi vérifier « le texte est bien
-- celui qui a été voté » et « le payload est bien celui qui a été complété »
-- sans que l'une des deux réponses masque l'autre.
--
-- L'empreinte est calculée sur une sérialisation canonique déterministe
-- (`canonicalJson`, voir `r6bTransportPayload.ts`) : clés triées, aucun
-- espace, `undefined` omis, `null` interdit. Deux payloads logiquement
-- identiques ont donc la même empreinte quel que soit l'ordre d'écriture des
-- clés ou le formatage JSON qui les a transportés.
alter table r6b_dispatch_manifests
  add column transport_payload jsonb not null default '{}'::jsonb,
  add column transport_payload_sha256 text;

-- Les lignes antérieures à cette migration ne portent, par construction,
-- aucune propriété transport : leur payload est l'objet vide. Renseigner leur
-- empreinte n'est donc pas une modification de contenu — aucune colonne de
-- décision (transport, destinataire, texte, statut) n'est touchée — c'est
-- l'enregistrement du fait déjà vrai. La constante est le sha256 de la
-- sérialisation canonique de `{}`, vérifiée par un test
-- (`canonicalJson({}) === '{}'`), jamais recopiée à la main ailleurs.
update r6b_dispatch_manifests
   set transport_payload_sha256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
 where transport_payload_sha256 is null;

alter table r6b_dispatch_manifests alter column transport_payload_sha256 set not null;

-- Le défaut a servi au backfill ; il disparaît maintenant. Toute écriture
-- future doit énoncer les deux valeurs ensemble — un INSERT qui oublierait le
-- payload mais fournirait une empreinte (ou l'inverse) échoue immédiatement,
-- plutôt que de produire une ligne dont l'empreinte ne décrit pas le contenu.
alter table r6b_dispatch_manifests alter column transport_payload drop default;

alter table r6b_dispatch_manifests add constraint r6b_manifest_transport_payload_is_object
  check (jsonb_typeof(transport_payload) = 'object');

alter table r6b_dispatch_manifests add constraint r6b_manifest_transport_payload_sha_shape
  check (transport_payload_sha256 ~ '^[0-9a-f]{64}$');

-- La correspondance empreinte ↔ contenu, elle, ne peut pas être vérifiée ici :
-- Postgres ne sait pas exécuter la sérialisation canonique du domaine. Elle
-- est recalculée à chaque dispatch (`buildDispatchEnvelope`), exactement comme
-- `approved_text_sha256` depuis 0019 — une empreinte qui ne serait pas
-- revérifiée à l'usage ne prouverait rien.

-- ---------------------------------------------------------------------------
-- 2. Journal de dispatch : ce que le DRY_RUN a constaté sur le payload
-- ---------------------------------------------------------------------------
--
-- §11 de la mission. `r6b_dispatch_attempts` (0021) reste append-only et
-- reste distinct d'`outreach_events`, qui demeure la preuve que personne n'a
-- été contacté : compléter un payload n'est pas un outreach event, et un
-- DRY_RUN non plus.
--
-- Colonnes nullables, sans contrainte les liant au statut : les six lignes
-- déjà journalisées par R6B-C.1 précèdent le modèle de payload et ne doivent
-- pas être réécrites pour lui plaire (append-only vaut aussi pour l'audit).
-- Elles restent donc nulles, ce qui se lit correctement : « cette tentative
-- date d'avant le modèle de payload », et non « payload absent ».
alter table r6b_dispatch_attempts
  add column transport_payload_sha256 text,
  add column live_ready boolean,
  add column missing_for_live jsonb;

alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_payload_sha_shape
  check (transport_payload_sha256 is null or transport_payload_sha256 ~ '^[0-9a-f]{64}$');

alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_missing_for_live_shape
  check (missing_for_live is null or jsonb_typeof(missing_for_live) = 'array');

-- « prêt » et « ce qui manque » sont deux faces du même constat : ils sont
-- écrits ensemble ou pas du tout.
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_live_readiness_pair
  check ((live_ready is null) = (missing_for_live is null));

-- Un manifeste déclaré prêt pour un LIVE ne peut pas, dans la même ligne,
-- déclarer qu'il lui manque quelque chose.
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_ready_has_nothing_missing
  check (live_ready is not true or jsonb_array_length(missing_for_live) = 0);

-- ---------------------------------------------------------------------------
-- 3. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle ne complète aucun manifeste. Le manifeste email de Cleanyourcar69
-- (5a8e5969-5436-4007-9b43-60e879e83698) reste LOCKED, sans objet, donc
-- explicitement non prêt pour un LIVE (`missingForLive = ['subject']`). Son
-- objet doit être saisi par un opérateur dans `/pilot/r6b-dispatch` ; le
-- remplacement passe alors par un supersede append-only
-- (`superseded_reason = 'live_transport_payload_completion'`) et un nouveau
-- manifeste LOCKED. Aucun objet par défaut, aucun objet généré : un sujet
-- inventé ici serait exactement la donnée non approuvée que tout ce mécanisme
-- existe pour empêcher.
