-- 0045_ig5_r3_no_outreach_is_not_a_reply.sql — IG5 R3, second correctif mesuré
--
-- ---------------------------------------------------------------------------
-- Ce que le premier relevé LIVE réussi a montré
-- ---------------------------------------------------------------------------
--
-- Le lecteur réseau a fonctionné : huit fils lus, quatre-vingt-cinq messages
-- compris, les trois fils commerciaux rendus `NO_REPLY_OBSERVED` avec notre DM
-- retrouvé et l'horodatage de l'envoi concordant.
--
-- Il a aussi ingéré TRENTE-SIX messages venus de cinq conversations
-- personnelles — des gens à qui Hermes n'a jamais rien envoyé. Toutes sont
-- sorties `UNMATCHED`, donc rattachées à personne, et aucune n'a déclenché la
-- moindre action : zéro analyse, zéro brouillon, zéro alerte. La corrélation a
-- fait exactement son travail.
--
-- Le problème n'est pas le rattachement, c'est la COPIE. Le corps de ces
-- messages a été écrit dans `r6b_inbound_messages` : des conversations privées
-- sans aucun lien commercial, recopiées dans la base d'une campagne de
-- prospection. Rien ne le justifiait, et §7 disait déjà pourquoi — une réponse
-- exploitable se définit RELATIVEMENT à un `outreach_event`. Sans envoi connu
-- vers ce compte, il n'y a pas de réponse : il y a la conversation de
-- quelqu'un.
--
-- La règle avait été écrite pour l'antériorité seulement (`SKIPPED_PRE_OUTREACH`,
-- 0043), et le cas « aucun envoi du tout » était laissé au comportement d'IG5.1.
-- Ce comportement n'avait jamais tourné : IG5.1 ne lisait aucune bulle. Le
-- premier relevé qui en lit vraiment l'a rendu visible.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ajoute, et ce qu'elle NE cache pas
-- ---------------------------------------------------------------------------
--
-- Une valeur d'issue, `SKIPPED_NO_OUTREACH`, distincte de `SKIPPED_PRE_OUTREACH`
-- parce que les deux disent deux choses différentes : « ce message précède notre
-- DM » et « il n'y a aucun DM ». Les confondre reviendrait à inventer un envoi
-- pour pouvoir dire que le message le précède.
--
-- Ce qui reste OBSERVÉ, et donc visible : le message est consigné dans
-- `ig_inbound_message_observations` avec son expéditeur, son horodatage, son
-- identifiant natif et l'empreinte de son texte. Un humain voit qu'il existe,
-- quand il est arrivé et de qui — sans que son CONTENU soit recopié. C'est la
-- différence entre observer une boîte et l'archiver.
--
-- Aucune ligne existante n'est réécrite par cette migration : elle n'élargit
-- qu'une liste fermée.

alter table ig_inbound_message_observations
  drop constraint ig_inbound_message_observations_outcome_check;

alter table ig_inbound_message_observations
  add constraint ig_inbound_message_observations_outcome_check
  check (outcome in (
    'INGESTED',
    'ALREADY_KNOWN',
    'SKIPPED_OUTGOING',
    'SKIPPED_UNKNOWN_DIRECTION',
    'SKIPPED_UNIDENTIFIED_SENDER',
    'SKIPPED_PRE_OUTREACH',
    'SKIPPED_NON_TEXT',
    -- Aucun envoi connu vers ce compte : ce n'est pas une réponse, et son corps
    -- n'a rien à faire dans la base d'une campagne.
    'SKIPPED_NO_OUTREACH'
  ));
