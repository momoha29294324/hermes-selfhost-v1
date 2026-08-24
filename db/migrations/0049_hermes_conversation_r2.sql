-- 0049_hermes_conversation_r2.sql — HERMES-CONVERSATION-R2 : le registre des
-- intentions conversationnelles autonomes (réponse automatique et relance).
--
-- ---------------------------------------------------------------------------
-- Pourquoi une table, alors que la mission demande d'en créer le moins possible
-- ---------------------------------------------------------------------------
--
-- La question a été posée dans l'autre sens d'abord : `ig_dispatch_jobs`
-- peut-elle porter une réponse ou une relance ? Non, et pas pour une raison de
-- confort.
--
--   * `ig_dispatch_jobs.manifest_id` est `not null` et référence
--     `r6b_dispatch_manifests`, dont `approval_vote_id` est lui aussi
--     `not null` et référence un vote posé sur un `r6b_batch_items` — c'est-à-
--     dire un PREMIER MESSAGE d'un lot. Une réponse à un DM n'a pas d'item de
--     lot, n'en aura jamais, et n'a pas de texte figé à la génération du lot ;
--   * `ig_dispatch_jobs_one_per_intent unique (manifest_id, action)` dit
--     « une intention par manifeste ». Une conversation en produit plusieurs,
--     successives, dont chacune remplace la précédente.
--
-- Rendre `manifest_id` nullable aurait affaibli l'invariant qui protège le rail
-- de premier contact — celui qui, lui, sait envoyer. On ne desserre pas une
-- garde existante pour loger un besoin nouveau.
--
-- Ce que cette table N'EST PAS : une seconde file d'exécution. Elle n'a pas
-- d'ordonnanceur (c'est `evaluateSchedule` qui décide du moment), pas de
-- plafonds (ce sont ceux de `config/instagram.json`, comptés par
-- `loadSafetySnapshot`), pas d'arrêt à elle (c'est `ig_kill_switch`), pas de
-- primitive d'envoi et, dans ce round, aucun worker qui la draine. Elle est le
-- REGISTRE des intentions : ce que la politique a décidé, sur quel état, à
-- partir de quel message, avec quel texte, et ce qu'il en est advenu.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration n'ouvre pas
-- ---------------------------------------------------------------------------
--
--   * aucun chemin d'envoi : aucune colonne ne désigne un destinataire
--     exploitable comme cible, et le statut `SENT` reste inatteignable tant
--     qu'aucun code ne pose `external_effect_attempted` — aucun ne le fait ;
--   * aucun relâchement de l'arrêt global, d'un plafond ou d'une fenêtre ;
--   * aucune réponse entrante n'est dupliquée : le texte du prospect reste
--     dans `r6b_inbound_messages`, et cette table n'en porte que l'identifiant
--     et l'heure de réception ;
--   * aucune approbation humaine n'est simulée : `actor_kind` est contraint à
--     l'unique valeur `AUTONOMOUS_POLICY`, si bien qu'une ligne d'ici ne peut
--     pas se relire « un humain a validé ce message ».

create table hermes_conversation_plans (
  id                        uuid primary key default gen_random_uuid(),

  prospect_id               uuid not null references prospects(id),
  channel                   text not null check (channel in ('instagram_dm', 'email')),

  -- Le vocabulaire des intentions. Fermé : en ajouter une demandera une
  -- migration, donc une revue — jamais une chaîne libre glissée par un appelant.
  kind                      text not null check (kind in ('AUTO_REPLY', 'FOLLOW_UP_1', 'FOLLOW_UP_2')),

  -- Ce qui a DÉCLENCHÉ l'intention. Une réponse part d'un message entrant ; une
  -- relance part de notre propre manifeste resté sans réponse. Exactement l'un
  -- des deux, jamais les deux, jamais aucun.
  trigger_inbound_message_id uuid references r6b_inbound_messages(id),
  trigger_manifest_id        uuid references r6b_dispatch_manifests(id),

  -- Déterministe et sans horloge (`deriveConversationPlanKey`) : le même
  -- déclencheur produit la même clé sur une autre machine, après n'importe quel
  -- redémarrage. C'est ce qui donne son sens à l'unicité ci-dessous.
  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),

  -- ---- Provenance (mission §25) -------------------------------------------
  -- `actor_kind` porte la provenance et lui seul : une note se lit, se copie et
  -- s'imite, une valeur contrainte non. La contrainte n'admet qu'une valeur —
  -- il n'existe pas de plan « humain », parce qu'un humain qui répond ne passe
  -- pas par ici.
  actor_kind                text not null default 'AUTONOMOUS_POLICY'
                              check (actor_kind = 'AUTONOMOUS_POLICY'),
  policy_version            text not null check (length(btrim(policy_version)) between 1 and 80),
  brain_version             text not null check (length(btrim(brain_version)) between 1 and 80),

  decision                  text not null check (decision in (
                              'AUTO_REPLY_ELIGIBLE', 'AUTO_REPLY_SKIP', 'HUMAN_ESCALATION',
                              'TERMINAL_STOP', 'FOLLOW_UP_DUE', 'FOLLOW_UP_SCHEDULED',
                              'FOLLOW_UP_SKIP', 'FOLLOW_UP_STOP')),
  decision_gate             text not null check (length(btrim(decision_gate)) between 1 and 80),
  decision_reason           text check (decision_reason is null or length(btrim(decision_reason)) between 1 and 80),
  decision_detail           text check (decision_detail is null or length(decision_detail) <= 1000),

  -- ---- Fraîcheur (mission §24) --------------------------------------------
  -- L'heure de RÉCEPTION du message entrant le plus récent connu au moment du
  -- calcul. Même grandeur que `r6b_prospect_outreach_states.last_reply_received_at`
  -- (0048), et pour la même raison : l'ordre qui compte est celui de la boîte de
  -- réception, jamais celui de la file de traitement. Nulle quand le prospect
  -- n'a jamais répondu — le cas d'une relance sans réponse.
  conversation_watermark    timestamptz,

  -- ---- Le texte proposé ----------------------------------------------------
  -- NOTRE texte, jamais celui du prospect. Nul quand la décision est de ne pas
  -- écrire : un arrêt ou une escalade ne doit pas laisser sous les yeux d'un
  -- humain pressé un message prêt à être copié-collé.
  body                      text check (body is null or length(body) between 1 and 2000),
  body_sha256               text check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),

  naturalness_verdict       text check (naturalness_verdict is null or naturalness_verdict in
                              ('NATURAL', 'ACCEPTABLE', 'UNNATURAL')),
  grounding_gaps            text[] not null default '{}',
  offer_readiness           text not null check (offer_readiness in ('LOW', 'MEDIUM', 'HIGH')),
  call_readiness            text not null check (call_readiness in ('LOW', 'MEDIUM', 'HIGH')),

  -- ---- Le sort de l'intention ----------------------------------------------
  --
  --   PLANNED     — vivante : elle attend son heure et son autorisation ;
  --   CLAIMED     — un worker tient le bail ;
  --   SKIPPED     — reportée : une porte a refusé MAINTENANT, `not_before` dit
  --                 quand réessayer. Elle reste dans le registre, vivante ;
  --   SUPERSEDED  — un message plus récent l'a remplacée avant tout effet ;
  --   CANCELLED   — une garde l'a annulée (arrêt, opt-out, état changé) ;
  --   BLOCKED     — une porte a refusé au moment d'agir. Zéro effet ;
  --   FAILED      — panne technique avant tout effet ;
  --   SENT        — un effet a eu lieu ET il est prouvé ;
  --   AMBIGUOUS   — un effet a eu lieu, la preuve manque. Jamais rejoué.
  status                    text not null check (status in (
                              'PLANNED', 'CLAIMED', 'SKIPPED', 'SUPERSEDED', 'CANCELLED',
                              'BLOCKED', 'FAILED', 'SENT', 'AMBIGUOUS')),

  -- Pas réclamable avant. Porte le délai humain de §22 et la date de relance de
  -- §15/§16 — une seule colonne, parce qu'il n'y a qu'une seule question :
  -- « à partir de quand cette intention peut-elle agir ? ».
  not_before                timestamptz not null default now(),

  attempts                  int not null default 0 check (attempts >= 0),

  -- Le bail. Ces quatre colonnes vivent et meurent ensemble, comme celles de
  -- `ig_dispatch_jobs` : un `claim_token` neuf à chaque prise est ce qui
  -- empêche un worker au bail expiré d'écrire le résultat d'un travail qui ne
  -- lui appartient plus.
  claimed_by                text check (claimed_by is null or length(btrim(claimed_by)) between 1 and 200),
  claim_token               uuid,
  claimed_at                timestamptz,
  lease_expires_at          timestamptz,

  -- Posé AVANT le premier geste ayant un effet, jamais après : un processus tué
  -- à cet instant laisse « on a essayé, on ne sait pas » plutôt que « rien n'a
  -- été fait ». Aucun code de ce dépôt ne le met à `true` aujourd'hui.
  external_effect_attempted boolean not null default false,
  external_effect_started_at timestamptz,

  last_reason_code          text check (last_reason_code is null or length(last_reason_code) <= 80),
  last_detail               text check (last_detail is null or length(last_detail) <= 1000),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  terminated_at             timestamptz,

  -- Le même déclencheur ne produit qu'une intention. C'est l'idempotence de
  -- §26, tenue par Postgres et non par un `select` préalable que deux workers
  -- liraient en même temps.
  constraint hermes_plan_idempotency_unique unique (idempotency_key),

  -- Exactement un déclencheur.
  constraint hermes_plan_one_trigger check (
    (trigger_inbound_message_id is not null) <> (trigger_manifest_id is not null)
  ),

  -- Une réponse part d'un message reçu ; une relance part de notre manifeste.
  constraint hermes_plan_trigger_matches_kind check (
    (kind = 'AUTO_REPLY' and trigger_inbound_message_id is not null)
    or (kind <> 'AUTO_REPLY' and trigger_manifest_id is not null)
  ),

  constraint hermes_plan_claim_lease_coherent check (
    (status = 'CLAIMED') = (claim_token is not null)
    and (claim_token is null) = (claimed_by is null)
    and (claim_token is null) = (claimed_at is null)
    and (claim_token is null) = (lease_expires_at is null)
  ),

  -- « Envoyé » exige d'avoir touché Instagram, et « ambigu » aussi : les deux
  -- décrivent un effet qui a eu lieu. Sans effet, ces mots ne veulent rien dire.
  constraint hermes_plan_effect_precedes_outcome check (
    status not in ('SENT', 'AMBIGUOUS') or external_effect_attempted = true
  ),

  -- Le drapeau et sa date vont ensemble : un effet sans heure ne se compare à
  -- rien, une heure sans effet décrit un geste qui n'a pas eu lieu.
  constraint hermes_plan_effect_dated check (
    external_effect_attempted = (external_effect_started_at is not null)
  ),

  -- Un texte sans empreinte ne se confronte pas ; une empreinte sans texte ne
  -- dit rien. Et une intention ÉLIGIBLE sans texte n'a rien à envoyer.
  constraint hermes_plan_body_hash_coherent check ((body is null) = (body_sha256 is null)),
  constraint hermes_plan_eligible_has_body check (
    decision not in ('AUTO_REPLY_ELIGIBLE', 'FOLLOW_UP_DUE') or body is not null
  ),

  -- Une intention close porte sa date de clôture, et une intention vivante n'en
  -- porte pas : le contraire ferait dire au registre qu'un travail est fini
  -- alors qu'il attend, ou l'inverse.
  constraint hermes_plan_terminated_when_closed check (
    (status in ('PLANNED', 'CLAIMED', 'SKIPPED')) = (terminated_at is null)
  )
);

-- Une seule intention VIVANTE par prospect et par genre.
--
-- C'est §24 imposé par la base plutôt que par une discipline d'appelant : quand
-- un nouveau message arrive, l'intention précédente doit passer `SUPERSEDED`
-- AVANT que la nouvelle puisse s'inscrire. Deux réponses en vol pour le même
-- prospect ne sont pas rattrapables après coup ; l'index les rend impossibles.
create unique index hermes_plan_one_live_per_prospect_kind
  on hermes_conversation_plans (prospect_id, kind)
  where status in ('PLANNED', 'CLAIMED', 'SKIPPED');

create index hermes_plan_due_idx
  on hermes_conversation_plans (not_before, created_at)
  where status in ('PLANNED', 'SKIPPED');

create index hermes_plan_prospect_idx
  on hermes_conversation_plans (prospect_id, created_at desc);

comment on table hermes_conversation_plans is
  'HERMES-CONVERSATION-R2 — registre des intentions conversationnelles autonomes '
  '(réponse automatique, relance). Décide QUOI et QUAND ; ne sait pas envoyer. '
  'L''arrêt global, les plafonds, l''espacement et la fenêtre restent ceux du rail '
  'Instagram (ig_kill_switch, config/instagram.json) — cette table n''en a aucun.';

comment on column hermes_conversation_plans.conversation_watermark is
  'Heure de réception du message entrant le plus récent connu au calcul. Un plan '
  'dont la marque est antérieure au dernier entrant du prospect est PÉRIMÉ : le '
  'crochet pré-effet le refuse, quel que soit son statut.';

comment on column hermes_conversation_plans.actor_kind is
  'AUTONOMOUS_POLICY, et rien d''autre : une ligne de cette table ne peut pas se '
  'relire « un humain a validé ce message ». Les décisions humaines vivent dans '
  'r6b_batch_votes (actor_kind = HUMAN) et r6b_reply_drafts.';
