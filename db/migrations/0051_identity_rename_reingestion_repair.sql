-- HERMES-IDENTITY-CANONICALIZATION-R1 §6/§26 — réparer la RÉINGESTION causée
-- par le changement de nom du compte, sans toucher aux lignes historiques.
--
-- ---------------------------------------------------------------------------
-- Ce qui s'est passé, exactement
-- ---------------------------------------------------------------------------
-- Le 22 août 2026, `config/instagram.json → inbound.accountHandle` est passé de
-- `hermesagency_` à `hermes__` : le compte avait été renommé, et le rail de
-- réponse refusait à sa première porte parce qu'il confrontait un nom périmé à
-- la session courante.
--
-- L'identité d'un message entrant dépendait de ce nom à DEUX endroits :
-- `mailbox` est le handle du moment, et `provider_message_id` est une empreinte
-- calculée à partir de lui. Renommer changeait donc la clé d'unicité
-- `(provider, mailbox, provider_message_id)` toute entière, et la première
-- relève sous le nouveau nom a réingéré les huit messages déjà lus — avec, en
-- aval, huit analyses, trois brouillons et trois alertes en double.
--
-- La base n'a pas failli : elle a fait exactement ce qu'on lui demandait. La
-- question était mal posée — « ai-je déjà vu ce message sous CE nom ? » au lieu
-- de « l'ai-je déjà vu ? ». Le code le pose correctement depuis
-- `PersistInstagramInboundInput.priorKeys`, et un test l'établit.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration fait, et ce qu'elle ne fait PAS
-- ---------------------------------------------------------------------------
-- Elle NE réécrit AUCUNE ligne historique. `mailbox = 'hermesagency_'` reste
-- `hermesagency_` : c'est le nom sous lequel ces messages ont réellement été
-- lus le 21 août, et c'est un fait daté. Le nom d'aujourd'hui vit en
-- configuration (`inbound.accountHandle`), pas dans les lignes d'hier.
--
-- Elle retire le DOUBLON — la copie écrite sous `hermes__` — et seulement
-- lorsqu'un jumeau EXACT existe sous l'ancien nom : même fil, même instant de
-- réception, même empreinte de corps, même expéditeur. Sans jumeau exact, rien
-- n'est supprimé : un message qui n'existerait que sous le nouveau nom est un
-- vrai message.
--
-- Le journal d'observation est CONSERVÉ, pas effacé. Ses lignes disent quelles
-- relèves ont vu quoi ; les effacer supprimerait la trace de l'incident. Elles
-- sont repointées vers la ligne qui porte réellement le message, et leur issue
-- passe à `ALREADY_KNOWN` — ce que le code corrigé écrit désormais, et ce qui
-- était vrai : le message ÉTAIT déjà connu, le collecteur ne savait pas le voir.
--
-- Sur une base neuve — un test, une installation — aucune ligne ne satisfait le
-- prédicat et cette migration ne fait rien. Elle est bornée par les faits
-- qu'elle répare, pas par une date ou un compteur.
--
-- Ce qui disparaît avec les doublons, par CASCADE déclarée en 0025/0026 :
-- `r6b_reply_analyses`, `r6b_reply_drafts`, `r6b_alerts`. Vérifié avant
-- application : aucun `hermes_conversation_plans`, aucun
-- `hermes_conversation_effects`, aucune `r6b_crm_projections` ne s'y rattache —
-- l'arrêt global était armé, rien n'est jamais parti.

-- 1. Le journal d'observation, repointé vers la ligne qui porte le message.
--    AVANT la suppression : la clé étrangère est en `no action`, donc supprimer
--    d'abord échouerait — et c'est bien ainsi qu'on veut qu'elle se comporte.
with duplicate as (
  select n.id as duplicate_id,
         (select o.id
            from r6b_inbound_messages o
           where o.provider = 'instagram'
             and o.mailbox = 'hermesagency_'
             and o.provider_thread_id = n.provider_thread_id
             and o.received_at = n.received_at
             and o.body_sha256 = n.body_sha256
             and o.from_address = n.from_address
           order by o.received_at asc, o.id asc
           limit 1) as keep_id
    from r6b_inbound_messages n
   where n.provider = 'instagram'
     and n.mailbox = 'hermes__'
)
update ig_inbound_message_observations obs
   set inbound_message_id = duplicate.keep_id,
       outcome = 'ALREADY_KNOWN'
  from duplicate
 where duplicate.keep_id is not null
   and obs.inbound_message_id = duplicate.duplicate_id;

-- 2. Le doublon lui-même. `using` plutôt qu'un `in (select …)` pour que le
--    prédicat de jumelage soit le MÊME que ci-dessus, mot pour mot.
with duplicate as (
  select n.id as duplicate_id,
         (select o.id
            from r6b_inbound_messages o
           where o.provider = 'instagram'
             and o.mailbox = 'hermesagency_'
             and o.provider_thread_id = n.provider_thread_id
             and o.received_at = n.received_at
             and o.body_sha256 = n.body_sha256
             and o.from_address = n.from_address
           order by o.received_at asc, o.id asc
           limit 1) as keep_id
    from r6b_inbound_messages n
   where n.provider = 'instagram'
     and n.mailbox = 'hermes__'
)
delete from r6b_inbound_messages m
 using duplicate
 where duplicate.keep_id is not null
   and m.id = duplicate.duplicate_id;
