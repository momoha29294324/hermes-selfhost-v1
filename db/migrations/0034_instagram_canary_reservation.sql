-- 0034_instagram_canary_reservation.sql — IG2.1 §7, séparer « réservée » de
-- « dépensée ».
--
-- Le fait à corriger
-- -------------------
-- Le 14 août, QUATRE autorisations ont été consommées pour UN effet réel. Les
-- trois autres se sont éteintes sur des arrêts strictement antérieurs au clic :
-- deux « aucun bouton Message sur le profil », une « aucun contrôle d'envoi
-- identifiable dans le panneau ». Zéro octet n'était parti, `external_effect_attempted`
-- valait `false` — et pourtant chaque tentative avait dépensé le droit d'essayer.
--
-- Ce n'était pas un bug : 0031 le disait en toutes lettres (« La consommation
-- EST la réservation »), et le worker l'assumait (« Elle vaut le droit
-- d'ESSAYER une fois, pas le droit de réussir »). Le raisonnement était le bon
-- garde-fou contre la mauvaise chose. Ce qu'il visait — qu'un enchaînement de
-- renoncements ne rouvre pas indéfiniment la porte — reste tenu par trois
-- gardes qui ne bougent pas : l'échéance courte, l'unicité de l'autorisation
-- vivante, et la révocation systématique en fin de commande. Ce qu'il coûtait,
-- en revanche, était une donnée FAUSSE : `external_attempts_used = 1` sur des
-- lignes qui n'avaient rien tenté. Un compteur d'effets externes qui compte
-- autre chose que des effets externes ne protège plus rien — il ne se lit même
-- plus.
--
-- Ce que cette migration change
-- ------------------------------
-- Un état de plus, `RESERVED`, et une frontière nette :
--
--   * ARMED → RESERVED : atomique, exclusive, posée AVANT les dernières gardes.
--     Elle dit « ce worker a la main ». Elle ne compte aucune tentative ;
--   * RESERVED → CONSUMED : atomique, posée à l'instant EXACT où un effet
--     externe va être tenté, dans la même séquence que
--     `external_effect_attempted`. C'est là, et seulement là, que le compteur
--     passe à 1 ;
--   * RESERVED → ARMED : le relâchement, réservé aux arrêts STRICTEMENT
--     pré-effet. Il est impossible après une consommation, parce que l'état
--     n'est alors plus `RESERVED` — ce n'est pas une discipline d'appelant,
--     c'est le `where` de l'instruction.
--
-- Pourquoi cela ne peut pas produire deux envois
-- -----------------------------------------------
-- Trois verrous indépendants, chacun suffisant :
--
--   1. `RESERVED → CONSUMED` est un `update … where state = 'RESERVED'`. Deux
--      workers qui l'exécutent à la microseconde près obtiennent l'un une
--      ligne, l'autre rien — et celui qui n'a rien ne clique pas ;
--   2. `ig_dispatch_jobs.external_effect_attempted` est posé dans la même
--      séquence, sous `where external_effect_attempted = false`. Un second
--      passage lève avant le clic ;
--   3. l'index unique partiel ci-dessous n'admet qu'UNE autorisation vivante
--      (armée OU réservée) dans toute la base. Deux prospects « pour aller plus
--      vite » restent impossibles.
--
-- Ce que cette migration n'autorise pas : rien. Elle n'insère aucune ligne,
-- n'arme rien, ne lève pas l'arrêt global, ne touche ni `outreach_events`, ni
-- `prospects`, ni `ig_dispatch_jobs.status`.

-- ---------------------------------------------------------------------------
-- 1. Les colonnes de la réservation
-- ---------------------------------------------------------------------------

alter table ig_live_canary_authorizations
  add column reserved_at     timestamptz,
  add column reserved_by     text check (reserved_by is null or length(btrim(reserved_by)) between 1 and 200),
  add column reserved_job_id uuid references ig_dispatch_jobs(id);

-- ---------------------------------------------------------------------------
-- 2. L'historique, relu dans le nouveau vocabulaire
-- ---------------------------------------------------------------------------
--
-- Les lignes déjà consommées n'avaient pas de réservation distincte : sous la
-- sémantique de 0031, la consommation ÉTAIT la réservation. Les recopier ici
-- ne réécrit donc pas l'histoire, cela la traduit — même instant, même worker,
-- même job.
--
-- Ce qui n'est PAS retouché : `external_attempts_used`. Trois de ces quatre
-- lignes portent `1/1` sans avoir rien tenté, et c'est faux ; mais un journal
-- d'audit qu'on corrige après coup ne prouve plus rien. Elles restent telles
-- quelles, et le commentaire de cette migration est ce qui explique l'écart.
update ig_live_canary_authorizations
   set reserved_at = consumed_at,
       reserved_by = consumed_by,
       reserved_job_id = consumed_job_id
 where state = 'CONSUMED' and consumed_at is not null and reserved_at is null;

-- ---------------------------------------------------------------------------
-- 3. Le nouvel état et ses invariants
-- ---------------------------------------------------------------------------

alter table ig_live_canary_authorizations drop constraint ig_live_canary_authorizations_state_check;
alter table ig_live_canary_authorizations add constraint ig_live_canary_authorizations_state_check check (
  state in ('ARMED', 'RESERVED', 'CONSUMED', 'EXPIRED', 'REVOKED')
);

-- La réservation est entière ou absente. Une ligne qui porterait une date sans
-- auteur serait une main que personne ne tient.
alter table ig_live_canary_authorizations add constraint ig_canary_reservation_is_whole check (
  (reserved_at is null) = (reserved_by is null)
);

-- « Réservée » veut dire : quelqu'un a la main, et rien n'a encore été tenté.
-- C'est toute la différence avec « consommée », et elle est vérifiée en base.
alter table ig_live_canary_authorizations add constraint ig_canary_reserved_is_untouched check (
  state <> 'RESERVED'
  or (external_attempts_used = 0 and consumed_at is null and closed_at is null and reserved_at is not null)
);

-- Et l'inverse : on ne consomme que ce qu'on a réservé. Sans cela, un `update`
-- écrit à la main pourrait sauter la réservation, c'est-à-dire sauter le seul
-- moment où deux workers sont départagés.
alter table ig_live_canary_authorizations add constraint ig_canary_consumed_follows_reservation check (
  state <> 'CONSUMED' or reserved_at is not null
);

-- ---------------------------------------------------------------------------
-- 4. UNE autorisation VIVANTE à la fois — armée ou réservée
-- ---------------------------------------------------------------------------
--
-- L'index de 0031 ne couvrait que `ARMED`. Tel quel, une autorisation passée en
-- `RESERVED` aurait libéré la place, et un humain aurait pu en armer une
-- seconde pendant qu'un worker tenait la première — deux autorisations vivantes,
-- donc deux clics possibles. L'élargir est la contrepartie obligatoire du
-- nouvel état, pas un raffinement.
drop index ig_live_canary_one_armed_idx;

create unique index ig_live_canary_one_live_idx
  on ig_live_canary_authorizations ((true))
  where state in ('ARMED', 'RESERVED');

-- La reprise a besoin de retrouver vite une réservation abandonnée par un
-- worker mort : c'est l'échéance qui la clôt, et cet index qui la trouve.
create index ig_live_canary_reserved_idx
  on ig_live_canary_authorizations (expires_at asc)
  where state = 'RESERVED';
