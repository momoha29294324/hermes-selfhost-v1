-- ---------------------------------------------------------------------------
-- HERMES-AUTO-REPLY-PRODUCTION-R1 — la FRONTIÈRE d'activation, et la preuve
-- qu'un runtime est vivant.
-- ---------------------------------------------------------------------------
--
-- Ce que ces deux tables existent pour empêcher
-- ---------------------------------------------------------------------------
-- Le dépôt sait répondre. Il l'a fait neuf fois, à travers un runner nommé,
-- temporaire, borné à une coquille. Ce qu'il n'a jamais eu, c'est un runtime
-- DURABLE : un processus qui tourne, qui regarde toutes les conversations, et
-- qui décide seul.
--
-- Le danger d'un tel processus n'est pas celui qu'on croit. Ce n'est pas qu'il
-- réponde mal — quinze portes le tiennent, et elles ont été éprouvées. C'est
-- qu'au moment où on le démarre, il découvre l'HISTORIQUE : vingt-trois
-- messages corrélés, dont huit venus de deux entreprises réelles trois jours
-- plus tôt, et auxquelles personne n'a jamais répondu. Un runtime sans mémoire
-- de sa propre naissance les traiterait comme du travail en retard.
--
-- « Ces conversations sont closes, donc rien ne serait parti » n'est pas une
-- réponse. C'est vrai aujourd'hui, par accident, et cela ne le sera plus au
-- prochain lot. Ce qui doit être vrai par CONSTRUCTION, c'est qu'allumer un
-- runtime ne répond à rien de ce qui existait avant qu'on l'allume.
--
-- La frontière, et pourquoi elle ne se recule pas
-- ---------------------------------------------------------------------------
-- `frontier_at` est l'instant d'activation, et la contrainte
-- `hermes_autoreply_activation_frontier_not_backdated` interdit qu'il lui soit
-- ANTÉRIEUR. Il n'existe aucune option pour l'antidater : la commande
-- d'activation ne prend pas de date, et la base refuserait celle qu'on lui
-- passerait. Un message reçu avant cet instant ne peut donc jamais devenir le
-- déclencheur d'une réponse autonome — ni au démarrage, ni après un
-- redémarrage, ni après un crash, puisque la frontière est une LIGNE et non
-- une variable de processus.
--
-- Reculer la frontière demande donc de révoquer et de réactiver : deux gestes
-- nommés, et une nouvelle frontière qui sera, elle aussi, l'instant présent.
--
-- Le budget de déploiement
-- ---------------------------------------------------------------------------
-- `max_effects` borne le nombre de réponses autonomes que CETTE activation
-- couvre. Ce n'est pas un plafond d'envoi — les plafonds Instagram (10/jour,
-- 3/heure, 15 minutes d'espacement, la fenêtre ouvrée) restent entiers et
-- devant. C'est un plafond de DÉPLOIEMENT : il permet d'ouvrir le rail pour
-- trois réponses, de regarder ce qui est parti, et de décider ensuite. Une
-- valeur nulle veut dire « aucune borne de déploiement », et il faut l'écrire.
--
-- Ce que ces tables n'ouvrent PAS
-- ---------------------------------------------------------------------------
-- Aucun envoi : une ligne d'activation n'autorise rien par elle-même. Elle
-- retire une raison de refuser, et laisse les quinze autres en place — l'arrêt
-- global, les plafonds, la fenêtre, la cadence, le verrou d'effet, l'identité,
-- l'exclusion, l'état commercial, la fraîcheur, les trois versions, la
-- réservation atomique. Elle ne touche à aucune d'elles, et le code qui la lit
-- ne sait pas les lever.
--
-- Aucune exception nominative : ni prospect, ni compte, ni campagne, ni
-- coquille n'apparaît ici. La frontière est une DATE, la même pour tout le
-- monde.
--
-- Aucune réécriture de l'historique : rien n'est supprimé, rien n'est déplacé,
-- aucune ligne `r6b_inbound_messages` n'est touchée. Le retard reste lisible et
-- auditable ; il n'est simplement plus une file de travail.
-- ---------------------------------------------------------------------------

create table if not exists hermes_autoreply_activations (
  id uuid primary key default gen_random_uuid(),

  -- La FRONTIÈRE. Un message dont `received_at` est strictement antérieur ne
  -- peut jamais déclencher une réponse autonome sous cette activation.
  frontier_at timestamptz not null default now(),

  activated_at timestamptz not null default now(),
  activated_by text not null check (length(btrim(activated_by)) > 0),
  reason      text not null check (length(btrim(reason)) > 0),

  -- Sous quelles règles cette activation a été rendue. Une politique qui bouge
  -- ne referme pas l'activation — ce sont les PLANS qui sont refermés, par le
  -- crochet pré-effet — mais un audit doit pouvoir dire ce qui était en
  -- vigueur ce jour-là.
  policy_version            text not null,
  commercial_policy_version text not null,

  -- Le budget de déploiement. `null` = aucune borne de déploiement.
  max_effects integer check (max_effects is null or max_effects >= 0),

  revoked_at    timestamptz,
  revoked_by    text,
  revoke_reason text,

  -- La frontière ne précède JAMAIS l'activation.
  constraint hermes_autoreply_activation_frontier_not_backdated
    check (frontier_at >= activated_at),

  -- Une révocation est un geste complet, ou elle n'a pas eu lieu.
  constraint hermes_autoreply_activation_revocation_complete
    check (
      (revoked_at is null and revoked_by is null and revoke_reason is null)
      or (revoked_at is not null
          and revoked_by is not null and length(btrim(revoked_by)) > 0
          and revoke_reason is not null and length(btrim(revoke_reason)) > 0)
    ),

  constraint hermes_autoreply_activation_revoked_after_activation
    check (revoked_at is null or revoked_at >= activated_at)
);

-- UNE seule activation vivante, à tout instant, quelle que soit la course entre
-- deux commandes. Sans cet index, deux activations concurrentes donneraient
-- deux frontières, et le code lirait la plus récente — c'est-à-dire la plus
-- permissive des deux.
create unique index if not exists hermes_autoreply_activation_live_idx
  on hermes_autoreply_activations ((true)) where revoked_at is null;

create index if not exists hermes_autoreply_activation_history_idx
  on hermes_autoreply_activations (activated_at desc);

comment on table hermes_autoreply_activations is
  'HERMES-AUTO-REPLY-PRODUCTION-R1 — la frontière d''activation du runtime d''auto-réponse. Une ligne vivante au plus ; frontier_at ne peut pas être antidatée, donc allumer le runtime ne répond jamais au retard historique.';

-- ---------------------------------------------------------------------------
-- Le battement de cœur — « le processus est-il vivant ? », et rien d'autre
-- ---------------------------------------------------------------------------
--
-- Cette table ne DÉCIDE rien. Aucune porte ne la lit, aucun envoi n'en dépend,
-- et l'effacer n'empêcherait ni ne permettrait quoi que ce soit. Elle existe
-- parce qu'un opérateur doit pouvoir répondre à quatre questions distinctes
-- que rien ne distinguait :
--
--   * le rail est-il CONFIGURÉ pour répondre seul ?  → hermes_autoreply_activations
--   * le processus est-il VIVANT ?                   → ici
--   * l'envoi est-il PERMIS en ce moment ?           → ig_kill_switch + les plafonds
--   * un plafond bloque-t-il, ou le runtime est-il cassé ?
--
-- Confondre les deux dernières est le défaut que cette table referme : un
-- runtime en parfaite santé devant un plafond atteint n'est pas une panne, et
-- un runtime mort derrière un plafond levé n'est pas une attente.
-- ---------------------------------------------------------------------------

create table if not exists hermes_autoreply_heartbeats (
  worker_id text primary key,
  host      text not null,
  pid       integer not null,

  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  -- La révision du dépôt sous laquelle ce processus a été chargé. Node charge
  -- le code une fois : c'est la seule façon de dire, de l'extérieur, qu'un
  -- long-vivant tourne sous du code périmé.
  code_revision text,

  -- Ce que ce processus peut faire, pas ce qu'il fait.
  mode text not null check (mode in ('PLAN', 'PREVIEW', 'LIVE')),

  cycles integer not null default 0 check (cycles >= 0),
  effects integer not null default 0 check (effects >= 0),

  last_outcome text not null,
  last_detail  text,

  stopped_at timestamptz,
  stopped_by text,

  constraint hermes_autoreply_heartbeat_stop_complete
    check ((stopped_at is null and stopped_by is null)
        or (stopped_at is not null and stopped_by is not null))
);

create index if not exists hermes_autoreply_heartbeats_seen_idx
  on hermes_autoreply_heartbeats (last_seen_at desc);

comment on table hermes_autoreply_heartbeats is
  'HERMES-AUTO-REPLY-PRODUCTION-R1 — le battement de cœur du runtime d''auto-réponse. Observabilité seule : aucune porte ne la lit, aucun envoi n''en dépend.';
