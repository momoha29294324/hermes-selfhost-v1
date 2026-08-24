-- 0032_instagram_canary_retry_before_effect.sql — IG2, corriger la portée de
-- l'unicité d'une autorisation canari.
--
-- Ce que 0031 avait écrit, et pourquoi c'était trop strict
-- --------------------------------------------------------
-- `ig_live_canary_authorizations.manifest_id` était `unique` : un manifeste ne
-- pouvait porter qu'une autorisation dans toute son histoire. L'intention était
-- juste — empêcher qu'un refus se transforme en boucle « on réarme, on
-- réessaie » sans qu'aucun humain ne redécide.
--
-- Le premier canari réel a montré que la contrainte ne dit pas cela. Elle a
-- refusé un cas que la mission autorise explicitement : une tentative qui
-- s'arrête AVANT tout effet externe (ici, aucun contrôle d'envoi identifiable
-- dans le panneau vérifié) et qu'on veut reprendre après correction du rail.
-- Zéro octet n'était parti, zéro clic n'avait eu lieu, `external_effect_attempted`
-- valait `false` — et pourtant plus rien n'était possible sur ce manifeste,
-- pour toujours.
--
-- Ce qui remplace, et où vit désormais la vraie règle
-- ---------------------------------------------------
-- La règle qui compte n'a jamais été « une autorisation par manifeste » mais
-- « aucun rejeu APRÈS un effet externe » (mission §4). Elle est déjà tenue par
-- deux gardes, et elles ne bougent pas :
--
--   * `ig_dispatch_jobs.external_effect_attempted` — posé avant le clic, jamais
--     retiré ; le worker refuse tout job qui le porte
--     (`IG_LIVE_EFFECT_ALREADY_ATTEMPTED`), et `recoverExpiredLeases` fige un
--     tel job en `REVIEW_REQUIRED` ;
--   * `armCanaryAuthorization` refuse d'armer quand le job du manifeste porte
--     ce drapeau, ou qu'un envoi existe.
--
-- Ce qui NE bouge pas non plus : `ig_live_canary_one_armed_idx`. Une seule
-- autorisation armée à la fois dans toute la base, et chaque armement reste une
-- commande humaine nominative, motivée, à durée de vie courte. Réessayer coûte
-- donc toujours une décision d'humain — ce qui était le but — mais réessayer
-- redevient POSSIBLE quand rien n'a été envoyé.
--
-- Un manifeste peut ainsi porter plusieurs lignes : l'historique complet des
-- décisions d'armement, chacune avec son auteur, son motif et son issue. C'est
-- une meilleure trace que l'unique ligne d'avant.

alter table ig_live_canary_authorizations
  drop constraint ig_live_canary_authorizations_manifest_id_key;

-- La lecture applicative choisit désormais la ligne PERTINENTE (l'armée s'il y
-- en a une, sinon la plus récente) : cet index sert exactement cet ordre.
create index if not exists ig_live_canary_manifest_recent_idx
  on ig_live_canary_authorizations (manifest_id, armed_at desc);
