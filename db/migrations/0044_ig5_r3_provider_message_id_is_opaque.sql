-- 0044_ig5_r3_provider_message_id_is_opaque.sql — IG5 R3, correctif mesuré
--
-- ---------------------------------------------------------------------------
-- Pourquoi une deuxième migration le même jour
-- ---------------------------------------------------------------------------
--
-- 0043 a contraint `provider_message_id` à l'alphabet cru observé lors du
-- relevé forensique : `^[A-Za-z0-9._:=+/-]{8,120}$`. Le premier relevé LIVE
-- écrit avec ce contrat a rendu, sur les huit fils, « fil lu, identité du fil
-- vérifiée, ZÉRO message » — chaque nœud rejeté.
--
-- La cause a été mesurée et non supposée : les identifiants de message
-- Instagram ont la forme `mid.$…`, et le `$` manquait à la liste. Le forensique
-- avait bien compté les caractères (34) sans en énumérer l'alphabet ; la
-- contrainte a donc encodé une observation incomplète comme si elle était
-- complète.
--
-- 0043 est déjà appliquée, donc elle n'est pas retouchée — le runner refuse une
-- migration dont l'empreinte change, et il a raison. La correction est une
-- migration à part, ce qui laisse la trace de l'erreur plutôt que de la
-- réécrire.
--
-- ---------------------------------------------------------------------------
-- Ce que la contrainte vérifie désormais, et pourquoi c'est le bon niveau
-- ---------------------------------------------------------------------------
--
-- La forme INTERNE d'un identifiant tiers n'est pas un contrat : Instagram peut
-- en changer demain sans prévenir. Une contrainte étroite ne protège alors de
-- rien — elle ne refuse pas une donnée douteuse, elle fait DISPARAÎTRE des
-- messages réels, en silence, et rend un « zéro » que rien ne distingue d'une
-- boîte vide. C'est précisément le faux verdict que tout ce rail existe pour
-- ne plus produire.
--
-- Ce qui est vérifié est donc ce qui compte pour l'usage réel de la colonne —
-- une clé de déduplication et une preuve : une chaîne OPAQUE, imprimable, sans
-- espace ni caractère de contrôle, et bornée. `[!-~]` est l'ASCII imprimable
-- privé de l'espace (0x21 à 0x7E), c'est-à-dire exactement cela.
--
-- Un identifiant exotique mais STABLE déduplique correctement ; un identifiant
-- refusé ne déduplique rien du tout.
--
-- Rien d'autre ne bouge : `r6b_inbound_messages` reste contrainte par 0042 à un
-- condensé de 64 caractères hexadécimaux, avec
-- `message_identity_kind = 'observed_fingerprint'`. Cette colonne-ci vit dans le
-- JOURNAL D'OBSERVATION, où une valeur du fournisseur ne prétend à rien.

alter table ig_inbound_message_observations
  drop constraint ig_inbound_message_observations_provider_message_id_check;

alter table ig_inbound_message_observations
  add constraint ig_inbound_message_observations_provider_message_id_check
    check (provider_message_id is null or provider_message_id ~ '^[!-~]{8,200}$');
