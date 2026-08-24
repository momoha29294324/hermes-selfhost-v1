-- ---------------------------------------------------------------------------
-- HERMES-MULTI-TURN-BURSTS-R1 — une prise de parole, un raisonnement.
-- ---------------------------------------------------------------------------
--
-- Ce que cette table enregistre
-- ---------------------------------------------------------------------------
-- Un humain sur Instagram n'écrit pas un paragraphe : il écrit « ouais »,
-- puis « j'avais essayé », puis « mais ça marchait pas », puis « et ils
-- disparaissaient au prix ». Quatre lignes en base, une seule phrase dans sa
-- tête.
--
-- Le dépôt savait déjà les GROUPER pour décider QUAND répondre (`burstSettled`,
-- `closesBurst`, depuis HERMES-CONVERSATION-R2). Il ne savait pas les grouper
-- pour décider SUR QUOI raisonner : chaque bulle recevait son propre appel de
-- modèle, sa propre analyse, sa propre lecture — quatre lectures d'une phrase
-- qui n'en formait qu'une, dont trois étaient périmées avant d'être écrites.
--
-- Désormais, une seule bulle par salve est raisonnée : la DERNIÈRE, celle qui
-- clôt la prise de parole, et son tour logique porte le texte de toutes.
-- Les autres sont ABSORBÉES, et c'est ce que cette table écrit.
--
-- Ce que « absorbée » veut dire, et ce que ça ne veut PAS dire
-- ---------------------------------------------------------------------------
-- Cela veut dire : « cette bulle a été LUE, à l'intérieur du tour logique qui
-- se termine par `burst_closing_message_id` ». Son texte est entré dans le
-- raisonnement ; c'est sa lecture SÉPARÉE qui n'a pas eu lieu, parce qu'elle
-- n'aurait décrit qu'un fragment de phrase.
--
-- Cela ne veut PAS dire « ignorée », et surtout pas « supprimée ». La ligne
-- `r6b_inbound_messages` reste intacte, avec son horodatage, son identifiant
-- de fournisseur et son texte : rien n'est fusionné, rien n'est réécrit,
-- aucune ligne historique n'est touchée. C'est une table de TRAÇABILITÉ posée
-- à côté, et le tour logique reste reconstructible message par message.
--
-- Pourquoi une table plutôt qu'un simple saut
-- ---------------------------------------------------------------------------
-- Parce que `loadUnprocessedCorrelatedInbound` sélectionne « les messages sans
-- analyse ACTIVE », `order by received_at asc limit 50`. Une bulle absorbée
-- n'a pas d'analyse : sans trace, elle serait resélectionnée à chaque tour,
-- pour toujours. Ce n'est pas seulement du bruit — au bout de cinquante bulles
-- absorbées, les PLUS ANCIENNES rempliraient la fenêtre et affameraient les
-- messages neufs. Le rail cesserait de répondre, silencieusement.
--
-- L'autre voie aurait été d'écrire une analyse « déterministe » pour la bulle
-- absorbée. Elle est refusée : une analyse porte une catégorie, une catégorie
-- est une affirmation sur ce que la personne a voulu dire, et affirmer cela
-- d'un fragment que personne n'a lu séparément serait inventer une donnée
-- (interdit n°2). Une absorption n'affirme rien — elle dit où la lecture a eu
-- lieu.
--
-- Ce que cette table n'ouvre PAS
-- ---------------------------------------------------------------------------
-- Aucun envoi : elle ne porte ni texte sortant, ni décision, ni autorisation.
-- Aucune suppression : une demande d'arrêt éclatée sur plusieurs bulles est lue
-- sur le tour logique ENTIER (`detectUnsubscribeDemand` reçoit la salve, pas la
-- dernière bulle), donc absorber une bulle ne peut pas faire perdre un
-- « me recontacte pas ». Aucune exception nominative : ni prospect, ni compte,
-- ni campagne n'apparaît ici.
-- ---------------------------------------------------------------------------

create table if not exists r6b_inbound_burst_absorptions (
  id uuid primary key default gen_random_uuid(),

  -- La bulle absorbée. UNIQUE : une bulle n'est absorbée qu'une fois, et le
  -- rejeu d'un tour retombe sur la ligne existante plutôt que d'en écrire une
  -- seconde.
  inbound_message_id uuid not null unique
    references r6b_inbound_messages(id) on delete cascade,

  -- La bulle qui CLÔT la prise de parole — celle qui a été raisonnée, et dont
  -- le tour logique porte le texte de celle-ci.
  burst_closing_message_id uuid not null
    references r6b_inbound_messages(id) on delete cascade,

  -- Le prospect, recopié pour qu'un audit n'ait pas à rejoindre deux tables.
  prospect_id uuid not null references prospects(id) on delete cascade,

  -- Combien de bulles composaient le tour logique, et combien de caractères il
  -- portait. Deux mesures, pour qu'on puisse constater qu'une borne a mordu
  -- sans relire le fil.
  burst_message_count integer not null check (burst_message_count >= 2),

  -- La politique sous laquelle l'absorption a été décidée. Une borne qui change
  -- change le découpage : sans cette colonne, une absorption d'hier se lirait
  -- comme une absorption d'aujourd'hui.
  policy_version text not null,

  absorbed_at timestamptz not null default now(),

  -- Une bulle ne s'absorbe pas dans elle-même.
  constraint inbound_burst_absorption_distinct
    check (inbound_message_id <> burst_closing_message_id)
);

create index if not exists r6b_inbound_burst_absorptions_closing_idx
  on r6b_inbound_burst_absorptions (burst_closing_message_id);

create index if not exists r6b_inbound_burst_absorptions_prospect_idx
  on r6b_inbound_burst_absorptions (prospect_id, absorbed_at desc);

comment on table r6b_inbound_burst_absorptions is
  'HERMES-MULTI-TURN-BURSTS-R1 — les bulles LUES à l''intérieur d''un tour logique, et donc non raisonnées séparément. Traçabilité seule : aucune ligne inbound n''est fusionnée, réécrite ni supprimée.';
