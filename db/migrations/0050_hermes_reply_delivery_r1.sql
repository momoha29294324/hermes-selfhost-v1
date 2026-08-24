-- 0050_hermes_reply_delivery_r1.sql — HERMES-REPLY-DELIVERY-R1 : la trace d'un
-- effet de RÉPONSE, et la politique commerciale sous laquelle il est parti.
--
-- ---------------------------------------------------------------------------
-- Ce que 0049 laissait ouvert
-- ---------------------------------------------------------------------------
--
-- `hermes_conversation_plans` porte l'INTENTION : ce que la politique a décidé,
-- sur quel état, à partir de quel message, avec quel texte. Elle ne porte pas —
-- et ne doit pas porter — ce qui a été OBSERVÉ pendant l'exécution : le fil
-- réellement atteint, le handle relu dans son en-tête, la récolte d'après-clic,
-- le verdict de remise, la capture. Les deux ne vivent pas au même rythme : une
-- intention est écrite une fois et se relit six mois plus tard, une observation
-- est un instantané daté.
--
-- Les mélanger aurait produit une ligne qui change de sens selon la colonne
-- qu'on lit. Elles sont donc séparées, et liées par `plan_id`.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration N'OUVRE PAS
-- ---------------------------------------------------------------------------
--
--   * aucun envoi : une table ne clique pas. L'arrêt global reste armé, les
--     plafonds restent ceux de `config/instagram.json`, la fenêtre celle de
--     l'ordonnanceur, et le rail de réponse reste inaccessible sans un plan
--     `AUTO_REPLY_ELIGIBLE` réservé sous le verrou d'effet partagé ;
--   * aucun second compteur : `external_effect_attempted` est ici une COPIE de
--     l'observation, jamais la source des plafonds. Le compte qui borne le
--     débit reste celui de `reserveConversationEffectSlot`, qui additionne
--     `ig_dispatch_jobs`, `ig_controlled_tests` et `hermes_conversation_plans`
--     — pas cette table ;
--   * aucune approbation humaine simulée : `source` est contraint à l'unique
--     valeur `HERMES_AUTONOMOUS_REPLY`, si bien qu'une ligne d'ici ne peut pas
--     se relire « un humain a envoyé ce message » ni « c'est un premier
--     contact » ;
--   * aucune duplication du contenu entrant : le texte du prospect reste dans
--     `r6b_inbound_messages`, et le nôtre dans `hermes_conversation_plans.body`.
--     Cette table n'en porte que les empreintes et les identifiants.

-- ---------------------------------------------------------------------------
-- 1. La politique COMMERCIALE, inscrite sur l'intention
-- ---------------------------------------------------------------------------
--
-- Une colonne et non une reprise de `policy_version` : les deux répondent à
-- deux questions distinctes — « peut-on répondre seul ? » et « que peut-on
-- engager ? ». Un jour où l'une bougerait sans l'autre, une étiquette commune
-- ferait couvrir la seconde par les décisions rendues sous la première.
--
-- `not null` avec un défaut, puis le défaut retiré : la table est vide au
-- moment de cette migration, mais une migration ne doit pas dépendre de cet
-- état. Le défaut sert au backfill, et son retrait force chaque écriture
-- ultérieure à DIRE sous quelle politique elle a été rendue.
alter table hermes_conversation_plans
  add column commercial_policy_version text not null default 'hermes-commercial-r1'
    check (length(btrim(commercial_policy_version)) between 1 and 80);

alter table hermes_conversation_plans
  alter column commercial_policy_version drop default;

comment on column hermes_conversation_plans.commercial_policy_version is
  'HERMES-REPLY-DELIVERY-R1 — la politique commerciale (src/lib/conversation/commercialPolicy.ts) '
  'sous laquelle les demandes du prospect ont été relevées. Un plan rendu sous une autre '
  'version ne couvre pas les règles d''aujourd''hui : le crochet pré-effet le refuse.';

-- ---------------------------------------------------------------------------
-- 2. hermes_conversation_effects — ce que l'exécution a OBSERVÉ
-- ---------------------------------------------------------------------------
--
-- Une ligne par tentative d'exécution, y compris celles qui n'ont produit aucun
-- effet (aperçu, brouillon, refus avant le clic). C'est délibéré : un refus
-- avant effet est l'information la plus utile du lot, et une table qui ne
-- garderait que les envois ne dirait jamais pourquoi il n'y en a pas eu.
--
-- Le §8 de la mission — l'AMBIGU d'après-effet — ne reçoit pas de table à lui.
-- Il est un STATUT (`AMBIGUOUS`), déjà absorbant dans 0049, et une ligne d'ici
-- qui en porte les preuves. Deux mécanismes pour une seule vérité auraient fini
-- par se contredire, et c'est toujours le plus indulgent qui aurait gagné.
create table hermes_conversation_effects (
  id                        uuid primary key default gen_random_uuid(),

  plan_id                   uuid not null references hermes_conversation_plans(id) on delete cascade,
  prospect_id               uuid not null references prospects(id),
  channel                   text not null check (channel in ('instagram_dm')),

  -- §10 — la PROVENANCE, contrainte plutôt que conventionnelle.
  --
  -- Une seule valeur autorisée. Une réponse autonome ne peut donc pas se relire
  -- comme un premier contact, un geste humain, un brouillon hérité ou une
  -- action manuelle : les autres provenances n'ont pas de place dans cette
  -- table, et celle-ci n'a pas de place ailleurs.
  source                    text not null default 'HERMES_AUTONOMOUS_REPLY'
                              check (source = 'HERMES_AUTONOMOUS_REPLY'),
  policy_version            text not null check (length(btrim(policy_version)) between 1 and 80),
  commercial_policy_version text not null check (length(btrim(commercial_policy_version)) between 1 and 80),
  brain_version             text not null check (length(btrim(brain_version)) between 1 and 80),

  -- L'intention exacte, recopiée pour que la ligne se relise seule.
  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),
  trigger_inbound_message_id uuid not null references r6b_inbound_messages(id),
  conversation_watermark    timestamptz,
  body_sha256               text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),

  -- ---- La CIBLE, telle qu'elle a été résolue avant l'exécution ------------
  --
  -- `target_thread_id` vient de `r6b_inbound_messages.provider_thread_id` du
  -- message déclencheur : l'identifiant qu'Instagram a lui-même donné au fil.
  -- Même forme que partout ailleurs (0042).
  target_thread_id          text not null check (target_thread_id ~ '^[0-9]{1,40}$'),
  target_handle             text not null check (target_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  account_handle            text not null check (account_handle ~ '^[A-Za-z0-9._]{1,30}$'),

  -- Un fil avec soi-même n'est pas une conversation de prospection, et ne peut
  -- pas servir à prouver qu'on sait remettre à un tiers.
  constraint hermes_effect_target_is_not_self check (lower(target_handle) <> lower(account_handle)),

  -- ---- Le MODE, et ce qu'il autorise --------------------------------------
  mode                      text not null check (mode in ('PREVIEW', 'DRAFT', 'LIVE')),

  status                    text not null check (status in (
                              'PREVIEWED',          -- fil atteint et vérifié, aucune saisie
                              'DRAFT_READY',        -- saisi, constaté, effacé — aucun clic
                              'BLOCKED',            -- refusé avant tout geste
                              'FAILED',             -- panne avant tout geste
                              'SENT',               -- remise confirmée par une observation lisible
                              'DELIVERY_FAILED',    -- Instagram a AFFICHÉ un échec
                              'AMBIGUOUS')),        -- effet tenté, issue inconnue
  reason_code               text not null check (length(btrim(reason_code)) between 1 and 80),
  detail                    text check (detail is null or length(detail) <= 2000),

  -- ---- Ce qui a été OBSERVÉ dans la page ----------------------------------
  --
  -- §9 — trois niveaux de certitude, et trois colonnes qui ne se confondent
  -- pas. `effect_attempted` dit qu'un clic a eu lieu ; `effect_observed` dit
  -- que la récolte d'après-clic a pu S'EXÉCUTER ; `delivery_confirmed` dit que
  -- le code pur en a conclu une remise. Le 14 août, le dépôt n'avait que la
  -- première et l'a lue comme la troisième.
  observed_thread_id        text check (observed_thread_id is null or observed_thread_id ~ '^[0-9]{1,40}$'),
  observed_thread_url       text check (observed_thread_url is null or length(observed_thread_url) <= 500),
  observed_handle           text check (observed_handle is null or observed_handle ~ '^[A-Za-z0-9._]{1,30}$'),
  session_state             text check (session_state is null or session_state in (
                              'SESSION_READY', 'LOGIN_REQUIRED', 'SESSION_EXPIRED',
                              'CHALLENGE', 'CAPTCHA', 'BLOCKED', 'UNKNOWN')),

  -- La preuve d'HISTORIQUE : combien d'éléments porteurs de texte ont été
  -- comptés hors composeur avant toute saisie. Zéro n'autorise aucun envoi —
  -- c'est ce qui empêche cette primitive d'être un premier contact.
  prior_bubbles             integer check (prior_bubbles is null or prior_bubbles >= 0),

  matching_bubbles_before   integer check (matching_bubbles_before is null or matching_bubbles_before >= 0),
  matching_bubbles_after    integer check (matching_bubbles_after is null or matching_bubbles_after >= 0),
  harvest_readable_before   boolean,
  harvest_readable_after    boolean,
  composer_cleared          boolean,
  outgoing_bubble_confirmed boolean,
  delivery_failure_markers  jsonb not null default '[]'::jsonb,
  delivery_verdict          text check (delivery_verdict is null or delivery_verdict in (
                              'SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')),

  effect_attempted          boolean not null default false,
  effect_observed           boolean not null default false,
  delivery_confirmed        boolean not null default false,

  worker_id                 text not null check (length(btrim(worker_id)) between 1 and 200),
  duration_ms               integer check (duration_ms is null or duration_ms >= 0),
  screenshot_path           text check (screenshot_path is null or length(screenshot_path) <= 500),

  created_at                timestamptz not null default now(),

  -- ---- Les gardes structurelles, posées ici et pas dans une convention ----

  -- Un aperçu et un brouillon ne peuvent NI déclarer un effet, NI prendre un
  -- statut qui en suppose un. Le jour où un bug ferait cliquer un aperçu, la
  -- ligne d'audit serait REFUSÉE : la transaction échouerait plutôt que de
  -- consigner un mensonge. Même garde qu'`ig_controlled_test_events` (0035).
  constraint hermes_effect_dry_modes_have_no_effect check (
    mode = 'LIVE'
    or (effect_attempted = false
        and delivery_confirmed = false
        and status in ('PREVIEWED', 'DRAFT_READY', 'BLOCKED', 'FAILED'))
  ),

  -- « BLOCKED » veut dire refusé avant tout geste, et rien d'autre.
  constraint hermes_effect_blocked_is_pre_effect check (
    status <> 'BLOCKED' or effect_attempted = false
  ),

  -- Les trois issues qui SUPPOSENT un clic en supposent un.
  constraint hermes_effect_outcome_needs_attempt check (
    status not in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS') or effect_attempted = true
  ),

  -- §9 — l'escalier de la certitude, dans le bon sens. Une remise ne peut pas
  -- être confirmée sans avoir été observée, ni observée sans avoir été tentée.
  constraint hermes_effect_certainty_ladder check (
    (effect_observed = false or effect_attempted = true)
    and (delivery_confirmed = false or effect_observed = true)
  ),

  -- Et « confirmée » ne veut dire qu'une chose : le code pur a conclu SENT.
  constraint hermes_effect_confirmed_means_sent check (
    delivery_confirmed = false or (delivery_verdict = 'SENT' and status = 'SENT')
  ),

  -- Un statut SENT sans confirmation serait exactement le faux niveau de
  -- certitude que §9 interdit.
  constraint hermes_effect_sent_is_confirmed check (
    status <> 'SENT' or delivery_confirmed = true
  )
);

-- §7 — AU PLUS UN effet réel par plan, imposé par la base et non par le code.
--
-- Partiel sur `effect_attempted` : les aperçus et les brouillons peuvent se
-- répéter autant qu'on veut (ils ne coûtent rien à personne), un clic ne le
-- peut pas. C'est le pendant, dans la table d'observation, de la réservation
-- atomique de `reserveConversationEffectSlot`.
create unique index hermes_effect_one_attempt_per_plan
  on hermes_conversation_effects (plan_id)
  where effect_attempted = true;

-- §7 — et au plus un effet réel par INTENTION LOGIQUE, ce qui n'est pas la même
-- chose : deux plans successifs pour le même message déclencheur porteraient la
-- même clé d'idempotence, et le second ne doit pas pouvoir cliquer parce que le
-- premier a été superseded.
create unique index hermes_effect_one_attempt_per_intent
  on hermes_conversation_effects (idempotency_key)
  where effect_attempted = true;

create index hermes_effect_plan_idx on hermes_conversation_effects (plan_id, created_at desc);
create index hermes_effect_prospect_idx on hermes_conversation_effects (prospect_id, created_at desc);
create index hermes_effect_thread_idx on hermes_conversation_effects (target_thread_id, created_at desc);

comment on table hermes_conversation_effects is
  'HERMES-REPLY-DELIVERY-R1 — ce qu''une exécution de réponse autonome a OBSERVÉ : fil atteint, '
  'identités relues, historique constaté, récolte d''après-clic, verdict de remise. '
  'Distingue « effet tenté », « effet observé » et « remise confirmée », qui ne sont pas '
  'la même chose. Ne compte aucun plafond : les plafonds vivent dans reserveConversationEffectSlot.';

comment on column hermes_conversation_effects.prior_bubbles is
  'Éléments porteurs de texte comptés HORS composeur avant toute saisie. C''est la preuve que '
  'ce fil a un passé, donc que ce message est une RÉPONSE et non un premier contact remis par '
  'une porte qui n''a pas les gardes du premier contact.';

comment on column hermes_conversation_effects.delivery_confirmed is
  'Vrai UNIQUEMENT quand deliveryProof a conclu SENT sur une observation lisible. Un clic '
  'réussi ne suffit pas : le 14 août, une UI qui avait accepté la saisie affichait une bulle '
  'que les serveurs d''Instagram n''avaient jamais acceptée.';
