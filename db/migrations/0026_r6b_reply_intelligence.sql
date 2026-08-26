-- 0026_r6b_reply_intelligence.sql — R6B-D2, la couche de décision
-- « speed-to-lead » (mission « Hermes R6B-D2 — Reply Classification
-- + CRM Routing + Human-Ready Response »).
--
-- R6B-D1 a appris au dépôt à LIRE : une réponse existe, elle est rattachée à
-- un envoi, avec une force de corrélation nommée. Ce qu'il ne sait toujours
-- pas faire, c'est en TIRER UNE CONSÉQUENCE — dire ce que cette réponse veut,
-- geler ce qu'elle doit geler, réveiller un humain quand elle vaut de l'argent,
-- et lui poser une réponse prête sous les yeux.
--
-- Ce que cette migration ne fait pas, et ne peut pas faire :
--
--   * elle n'envoie rien et n'arme rien. `OUTBOUND_ALLOW_SENDING` reste à 0,
--     le gate des 20 prospects reste non validé, aucune garde de 0023/0024
--     n'est relâchée, et aucune table d'ici ne porte de statut « SENT » —
--     `r6b_reply_drafts` refuse structurellement d'en avoir un ;
--   * elle ne crée aucune ligne. Après elle comme avant elle : 1 envoi,
--     1 `outreach_event`, 0 message entrant, 0 analyse, 0 brouillon ;
--   * elle ne provisionne aucun CRM et aucun canal d'alerte. Les deux tables
--     correspondantes existent pour porter un état RETENTABLE et VISIBLE tant
--     qu'aucune destination n'est configurée — pas pour deviner laquelle.
--
-- ---------------------------------------------------------------------------
-- Pourquoi de nouvelles tables plutôt que celles de 0001/0019
-- ---------------------------------------------------------------------------
--
-- 0001 a posé `conversations` / `conversation_messages` / `reply_classifications`
-- / `do_not_contact` (« future outreach lifecycle, unused in V1 »), et 0019 a
-- ré-étiqueté la taxonomie de `reply_classifications` puis ajouté
-- `reply_drafts`. Ces tables restent vides en production. Trois d'entre elles
-- ne conviennent pas ici, et une convient parfaitement :
--
--   * `reply_classifications` est ancrée sur `conversation_messages`, c'est-à-
--     dire sur une COPIE du corps entrant. R6B-D1 a déjà persisté ce corps une
--     fois, avec son empreinte, dans `r6b_inbound_messages` ; le recopier pour
--     pouvoir le classer ferait exister deux vérités sur le même texte. Sa
--     taxonomie (0019) est par ailleurs une taxonomie d'APPRENTISSAGE
--     (`NO_REPLY`, `MEETING_INTENT`, `ALREADY_HAS_PROVIDER`…) : elle décrit
--     l'issue commerciale d'une conversation, pas la décision opérationnelle
--     qu'une réponse impose dans la minute. Il lui manque exactement ce dont
--     une décision a besoin — `AUTO_REPLY`, `BOUNCE`, `OBJECTION`, `NOT_NOW`,
--     `REVIEW_REQUIRED` — et elle contient `NO_REPLY`, qui n'est pas une
--     réponse. Les deux tables coexistent donc sans se contredire : celle-ci
--     décide, celle de 0019 restera pour mesurer.
--
--   * `reply_drafts` (0019) porte une colonne `sent_text`. Cette mission n'a
--     pas le droit d'avoir un endroit où écrire « ce qui a été envoyé » : une
--     colonne qui existe finit par être remplie. `r6b_reply_drafts` n'en a pas,
--     et son `status` ne connaît aucune valeur qui ressemble à un envoi.
--
--   * `do_not_contact` (0001), en revanche, est exactement la bonne table et
--     n'est PAS dupliquée ici. Elle existe depuis le premier jour, elle est
--     indexée par (match_kind, value) donc idempotente par construction, et un
--     désabonnement porte sur une ADRESSE, pas sur une ligne de CRM. La
--     suppression d'un `UNSUBSCRIBE` s'y écrit, et le chemin de dispatch la
--     relit avant tout envoi (`resolveDispatchTarget`).
--
-- ---------------------------------------------------------------------------
-- L'asymétrie qui gouverne toute cette migration
-- ---------------------------------------------------------------------------
--
-- Une corrélation `HIGH_CONFIDENCE` n'est pas une identité d'envoi : c'est
-- l'absence d'alternative (R6B-D1, `sole_outbound_recipient`). La mission (§14)
-- en tire une règle, et cette migration la rend structurelle :
--
--   * une action PROTECTRICE — cesser de contacter, supprimer, geler une
--     séquence — est sûre sous une preuve faible. Se tromper coûte un prospect
--     qu'on n'aurait pas dû arrêter ; ne pas la faire coûte un email envoyé à
--     quelqu'un qui a demandé qu'on arrête. Elle s'applique donc dès
--     `HIGH_CONFIDENCE` ;
--
--   * une action EXPANSIVE — écrire dans un CRM externe, créer un contact,
--     ouvrir une opportunité — ne l'est pas. Se tromper écrit le dossier d'un
--     prospect chez un autre, dans un système que ce dépôt ne contrôle pas et
--     ne sait pas défaire. Elle exige donc `EXACT`, et `HIGH_CONFIDENCE` la
--     laisse en `BLOCKED_POLICY` jusqu'à ce qu'un humain tranche.
--
-- `REVIEW_REQUIRED` et `UNMATCHED` ne sont, eux, jamais classés : on ne sait
-- pas de quel prospect il s'agit, donc il n'y a pas de dossier à faire avancer.

-- ---------------------------------------------------------------------------
-- 1. r6b_reply_analyses — ce qu'une réponse veut dire
-- ---------------------------------------------------------------------------
--
-- Une analyse est ancrée sur un message entrant (`r6b_inbound_messages`), pas
-- sur une copie de son texte : le corps et son empreinte vivent déjà là-bas,
-- immuables depuis l'ingestion.
--
-- `prospect_id` et `manifest_id` sont NOT NULL, et c'est une garde, pas une
-- commodité : une analyse ne peut exister que pour un message dont la
-- corrélation a désigné les trois (manifeste, envoi, prospect). Un
-- `REVIEW_REQUIRED` ou un `UNMATCHED` ne peut donc pas obtenir de ligne ici,
-- même par un `insert` maladroit — il n'a rien à mettre dans ces colonnes.
create table r6b_reply_analyses (
  id                      uuid primary key default gen_random_uuid(),

  inbound_message_id      uuid not null references r6b_inbound_messages(id) on delete cascade,
  manifest_id             uuid not null references r6b_dispatch_manifests(id),
  prospect_id             uuid not null references prospects(id),

  -- La force de corrélation TELLE QU'ELLE ÉTAIT au moment de l'analyse.
  -- Recopiée plutôt que jointe : c'est elle qui a autorisé (ou refusé) les
  -- actions qui suivent, et une décision doit rester relisible avec l'état qui
  -- l'a produite, pas avec l'état d'aujourd'hui.
  correlation_status      text not null check (correlation_status in ('EXACT', 'HIGH_CONFIDENCE')),

  -- -------------------------------------------------------------------------
  -- La taxonomie commerciale (§2 de la mission)
  -- -------------------------------------------------------------------------
  --
  --   INTERESTED      — intérêt exprimé pour la proposition.
  --   QUESTION        — demande d'information, sans refus ni engagement.
  --   OBJECTION       — objection explicite (prix, délai, prestataire en place)
  --                     qui reste une conversation ouverte.
  --   NOT_NOW         — report explicite dans le temps.
  --   NOT_INTERESTED  — refus, sans demande d'arrêt des contacts.
  --   UNSUBSCRIBE     — demande explicite d'arrêter de contacter.
  --   AUTO_REPLY      — réponse automatique (absence, accusé de réception).
  --   BOUNCE          — rapport de non-remise émis par un serveur.
  --   OTHER           — une réponse humaine réelle, hors des cas ci-dessus.
  --   REVIEW_REQUIRED — le classifieur n'a pas tranché, ou sa confiance est
  --                     trop basse pour qu'une machine agisse dessus.
  --
  -- `REVIEW_REQUIRED` est une CONCLUSION à part entière, pas un échec : un
  -- classifieur qui doit choisir entre neuf étiquettes sans avoir le droit de
  -- dire « je ne sais pas » finit par en choisir une au hasard.
  classification          text not null
                            check (classification in (
                              'INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_NOW', 'NOT_INTERESTED',
                              'UNSUBSCRIBE', 'AUTO_REPLY', 'BOUNCE', 'OTHER', 'REVIEW_REQUIRED')),
  confidence              numeric(3, 2) not null check (confidence >= 0 and confidence <= 1),

  -- Résumé auditable, court, destiné à un humain. Ce n'est PAS un raisonnement
  -- privé : le prompt demande explicitement une justification publiable, et
  -- rien de ce que le modèle « pense » en chemin n'est persisté ici (§2).
  reasoning_summary       text not null check (length(reasoning_summary) between 1 and 600),

  -- Extraits VERBATIM du corps entrant sur lesquels la conclusion s'appuie.
  -- [{quote, why}] — une conclusion sans sa citation n'est pas vérifiable, et
  -- une citation absente du corps est détectable (le corps est en base).
  evidence_excerpts       jsonb not null default '[]'::jsonb,

  requires_human_review   boolean not null,

  --   HUMAN_REPLY_NOW        — candidat speed-to-lead : un humain répond vite.
  --   HUMAN_REVIEW           — file de revue, aucune transition commerciale.
  --   NURTURE_LATER          — candidat nurture futur. R6B-D2 ne PLANIFIE rien.
  --   STOP_COLD_FOLLOW_UP    — plus de relance à froid automatique.
  --   SUPPRESS_PERMANENTLY   — suppression outbound permanente.
  --   MARK_CHANNEL_UNUSABLE  — l'adresse ne délivre pas.
  --   NO_ACTION              — rien à faire (réponse automatique, bruit).
  recommended_next_action text not null
                            check (recommended_next_action in (
                              'HUMAN_REPLY_NOW', 'HUMAN_REVIEW', 'NURTURE_LATER',
                              'STOP_COLD_FOLLOW_UP', 'SUPPRESS_PERMANENTLY',
                              'MARK_CHANNEL_UNUSABLE', 'NO_ACTION')),

  -- Vrai quand une règle déterministe a tranché sans appeler de modèle
  -- (rapport de non-remise, en-tête d'auto-réponse). Ces cas-là ne sont pas
  -- des jugements : ce sont des faits d'en-tête, et les faire passer par un
  -- LLM ajouterait du coût, de la latence et une chance de se tromper.
  decided_deterministically boolean not null default false,

  -- -------------------------------------------------------------------------
  -- Provenance de la décision
  -- -------------------------------------------------------------------------
  model                   text not null,
  effort                  text,
  prompt_version          text not null check (length(prompt_version) between 1 and 64),
  -- Empreinte du contexte EXACT soumis au classifieur. Deux analyses de même
  -- empreinte ont reçu la même question ; une empreinte différente sur le même
  -- message signale que le contexte a bougé (recherche mise à jour, angle
  -- recalculé) — ce qui est une raison légitime de reclasser.
  input_sha256            text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  model_run_id            uuid,

  -- -------------------------------------------------------------------------
  -- Cycle de vie
  -- -------------------------------------------------------------------------
  --
  -- Même patron que `r6b_dispatch_manifests` (0019) : append-only, une seule
  -- ligne ACTIVE à la fois par message. Reclasser après un changement de prompt
  -- ne détruit donc pas ce qui a été décidé avant — la décision précédente
  -- reste lisible avec le modèle et le prompt qui l'ont produite.
  status                  text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED')),
  superseded_by           uuid references r6b_reply_analyses(id) deferrable initially deferred,
  superseded_at           timestamptz,

  created_at              timestamptz not null default now(),

  constraint r6b_reply_analysis_superseded_fields check (
    (status = 'ACTIVE' and superseded_by is null and superseded_at is null)
    or (status = 'SUPERSEDED' and superseded_by is not null and superseded_at is not null)
  ),

  -- Une classification qui demande une revue humaine ne peut pas recommander
  -- une action que la machine prendrait seule. La contrainte vit en base parce
  -- que c'est exactement le genre d'incohérence qu'un prompt produit un jour
  -- sur mille et qu'aucun test ne rattrape.
  constraint r6b_reply_analysis_review_action check (
    requires_human_review = false or recommended_next_action in ('HUMAN_REPLY_NOW', 'HUMAN_REVIEW')
  ),
  constraint r6b_reply_analysis_review_required_is_reviewed check (
    classification <> 'REVIEW_REQUIRED' or requires_human_review = true
  ),
  -- Un désabonnement et une non-remise sont des faits, pas des nuances : leur
  -- conséquence est fixée ici et ne dépend pas de ce que le modèle a proposé.
  constraint r6b_reply_analysis_unsubscribe_action check (
    classification <> 'UNSUBSCRIBE' or recommended_next_action = 'SUPPRESS_PERMANENTLY'
  ),
  constraint r6b_reply_analysis_bounce_action check (
    classification <> 'BOUNCE' or recommended_next_action = 'MARK_CHANNEL_UNUSABLE'
  )
);

-- LA garde d'idempotence n°1 : une seule analyse vivante par message entrant.
-- Un downstream qui demande « l'analyse de cette réponse » ne peut jamais
-- trouver deux réponses possibles.
create unique index r6b_reply_analyses_one_active_idx
  on r6b_reply_analyses (inbound_message_id)
  where status = 'ACTIVE';

-- LA garde d'idempotence n°2 : rejouer le même traitement, avec le même prompt,
-- le même modèle et le même contexte, ne peut pas produire une seconde ligne —
-- même si deux processus le font en même temps. Ce n'est pas le code qui le
-- garantit, c'est Postgres.
create unique index r6b_reply_analyses_identity_idx
  on r6b_reply_analyses (inbound_message_id, prompt_version, model, input_sha256);

create index r6b_reply_analyses_prospect_idx on r6b_reply_analyses (prospect_id, created_at desc);
create index r6b_reply_analyses_class_idx on r6b_reply_analyses (classification, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. r6b_reply_drafts — une réponse prête pour un humain, jamais pour un câble
-- ---------------------------------------------------------------------------
--
-- Séparée du contenu entrant (§10) : le brouillon est ce que NOUS écririons, le
-- message entrant est ce que le prospect a écrit. Les mélanger dans une même
-- table ferait perdre cette frontière au premier `select *`.
--
-- Il n'existe AUCUN statut d'envoi. Ce n'est pas un oubli à combler plus tard :
-- une mission qui voudra envoyer devra écrire une migration, donc passer par
-- une revue. `APPROVED` signifie « un humain valide ce texte », et rien
-- d'autre — l'email reste à envoyer à la main.
create table r6b_reply_drafts (
  id                  uuid primary key default gen_random_uuid(),

  inbound_message_id  uuid not null references r6b_inbound_messages(id) on delete cascade,
  analysis_id         uuid not null references r6b_reply_analyses(id) on delete cascade,
  prospect_id         uuid not null references prospects(id),
  manifest_id         uuid not null references r6b_dispatch_manifests(id),

  body                text not null check (length(body) between 1 and 4000),
  body_sha256         text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),

  -- Les mêmes garde-fous déterministes que le premier message sortant
  -- (`src/lib/pipeline/guardrails.ts`) : fausse urgence, promesse garantie,
  -- montant non sourcé, variable de gabarit non remplie. Un brouillon marqué
  -- bloquant est conservé — pour qu'on voie ce que le modèle a tenté — mais il
  -- ne se présente jamais comme prêt.
  guardrail_flags     jsonb not null default '[]'::jsonb,
  blocked             boolean not null default false,

  model               text not null,
  effort              text,
  prompt_version      text not null check (length(prompt_version) between 1 and 64),
  model_run_id        uuid,

  --   PROPOSED  — écrit par la machine, attend un humain.
  --   APPROVED  — un humain valide le texte. TOUJOURS PAS ENVOYÉ.
  --   EDITED    — un humain a réécrit ; `human_text` porte sa version.
  --   REJECTED  — un humain écarte ce brouillon.
  status              text not null default 'PROPOSED'
                        check (status in ('PROPOSED', 'APPROVED', 'EDITED', 'REJECTED')),
  human_text          text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  review_note         text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Un `EDITED` sans texte humain serait un statut qui ment sur son contenu.
  constraint r6b_reply_draft_edited_has_text check (
    status <> 'EDITED' or (human_text is not null and length(human_text) > 0)
  ),
  constraint r6b_reply_draft_reviewed_has_stamp check (
    status = 'PROPOSED' or (reviewed_at is not null and reviewed_by is not null)
  ),
  -- Un brouillon que les garde-fous bloquent ne peut pas être approuvé tel
  -- quel : il faut le réécrire (`EDITED`) ou l'écarter.
  constraint r6b_reply_draft_blocked_not_approved check (blocked = false or status <> 'APPROVED')
);

comment on table r6b_reply_drafts is
  'Brouillon de réponse commerciale, proposé à un humain. Aucun statut d''envoi n''existe et aucune '
  'colonne ne porte « ce qui a été envoyé » : R6B-D2 ne dispose d''aucun chemin de code vers un provider '
  'd''envoi, et APPROVED ne veut dire que « texte validé », jamais « parti ».';

-- Un brouillon par analyse : rejouer le traitement ne réécrit rien et n'en
-- ajoute pas un second.
create unique index r6b_reply_drafts_analysis_idx on r6b_reply_drafts (analysis_id);
create index r6b_reply_drafts_status_idx on r6b_reply_drafts (status, created_at desc);
create index r6b_reply_drafts_prospect_idx on r6b_reply_drafts (prospect_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. L'état commercial d'un prospect, et son journal
-- ---------------------------------------------------------------------------
--
-- Deux tables plutôt qu'une colonne sur `prospects` :
--
--   * `prospects.stage` (0001) décrit le cycle de PRODUCTION d'un prospect —
--     `discovered → enriched → qualified → researched → message_ready →
--     approved`. C'est l'état de la fabrication du message, pas celui de la
--     relation commerciale. Y ajouter `REPLIED` mélangerait deux axes qui
--     n'avancent pas ensemble, et changerait le sens d'une colonne que tout le
--     pipeline de découverte lit déjà ;
--
--   * le journal existe parce qu'un état courant sans historique ne se relit
--     pas. « Pourquoi ce prospect est-il SUPPRESSED ? » doit avoir une réponse
--     qui nomme le message entrant et l'analyse responsables.
--
-- Les états ne couvrent QUE l'après-contact — avant, c'est `prospects.stage`
-- qui fait foi et il n'y a rien à dupliquer :
--
--   CONTACTED       — un `outreach_event` « sent » existe.
--   REPLIED         — une réponse corrélée est arrivée. État de passage.
--   INTERESTED      — intérêt, question ou objection : une conversation vit.
--   NOT_NOW         — report explicite. Candidat nurture ; R6B-D2 ne planifie rien.
--   NOT_INTERESTED  — refus. Plus de relance à froid automatique.
--   BOUNCED         — l'adresse ne délivre pas.
--   SUPPRESSED      — demande explicite d'arrêt. TERMINAL pour la machine.
--   REVIEW_REQUIRED — le système ne tranche pas et le dit.
create table r6b_prospect_outreach_states (
  prospect_id        uuid primary key references prospects(id) on delete cascade,
  state              text not null
                       check (state in ('CONTACTED', 'REPLIED', 'INTERESTED', 'NOT_NOW',
                                        'NOT_INTERESTED', 'BOUNCED', 'SUPPRESSED', 'REVIEW_REQUIRED')),
  entered_at         timestamptz not null default now(),
  -- La dernière transition qui a produit cet état. Rend l'état courant
  -- traçable sans avoir à deviner quelle ligne du journal le justifie.
  last_transition_id uuid,
  updated_at         timestamptz not null default now()
);

create index r6b_prospect_outreach_states_state_idx on r6b_prospect_outreach_states (state, updated_at desc);

-- Journal append-only. Une ligne y est ajoutée, jamais modifiée ni supprimée.
create table r6b_prospect_state_transitions (
  id                 uuid primary key default gen_random_uuid(),
  prospect_id        uuid not null references prospects(id) on delete cascade,

  -- Nul uniquement pour la toute première transition d'un prospect.
  from_state         text check (from_state in ('CONTACTED', 'REPLIED', 'INTERESTED', 'NOT_NOW',
                                                'NOT_INTERESTED', 'BOUNCED', 'SUPPRESSED', 'REVIEW_REQUIRED')),
  to_state           text not null
                       check (to_state in ('CONTACTED', 'REPLIED', 'INTERESTED', 'NOT_NOW',
                                           'NOT_INTERESTED', 'BOUNCED', 'SUPPRESSED', 'REVIEW_REQUIRED')),

  -- CE QUI a causé la transition. `cause_id` n'est pas une FK : il désigne
  -- selon le cas un `outreach_events.id`, un `r6b_inbound_messages.id` ou une
  -- décision humaine sans ligne propre. Une FK polymorphe n'existe pas en SQL,
  -- et en inventer une par colonne nullable rendrait la table illisible pour
  -- un gain nul — `cause_kind` dit déjà dans quelle table regarder.
  cause_kind         text not null check (cause_kind in ('outreach_sent', 'inbound_reply', 'human')),
  cause_id           uuid,
  analysis_id        uuid references r6b_reply_analyses(id) on delete set null,

  reason             text not null check (length(reason) between 1 and 500),
  created_at         timestamptz not null default now(),

  constraint r6b_state_transition_moves check (from_state is null or from_state <> to_state),
  constraint r6b_state_transition_cause_id check (cause_kind = 'human' or cause_id is not null)
);

-- L'idempotence du journal : la même cause ne peut pas produire deux fois la
-- même transition. Retraiter un message entrant est donc sans effet, quelle que
-- soit la course entre deux processus.
create unique index r6b_prospect_state_transitions_cause_idx
  on r6b_prospect_state_transitions (prospect_id, cause_kind, cause_id, to_state)
  where cause_id is not null;

create index r6b_prospect_state_transitions_prospect_idx
  on r6b_prospect_state_transitions (prospect_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. r6b_crm_projections — la projection vers un CRM qui n'existe pas encore
-- ---------------------------------------------------------------------------
--
-- Le dépôt n'a AUCUNE intégration CRM : ni code, ni identifiant, ni variable
-- d'environnement, ni sous-compte nommé. Le seul CRM que la machine d'un opérateur
-- connaît appartient à un projet isole, et la documentation d’installation interdit d'y toucher —
-- y projeter des prospects Hermes serait exactement le genre de « ça a l'air
-- de marcher » qui pollue une base de production tierce de façon irréversible.
--
-- Cette table est donc la FRONTIÈRE : elle porte l'état d'une projection, sa
-- charge utile exacte, et la raison pour laquelle elle n'est pas partie.
-- Configurer une destination sera une décision humaine, dans une autre mission.
--
--   PENDING                  — à projeter dès qu'une destination existe.
--   SKIPPED_NOT_CONFIGURED   — aucune destination configurée. Ce n'est ni une
--                              erreur ni un succès : c'est un fait.
--   BLOCKED_POLICY           — corrélation `HIGH_CONFIDENCE` : la politique
--                              refuse une écriture externe sans identité forte.
--   APPLIED                  — écrite chez le fournisseur, avec ses identifiants.
--   FAILED                   — tentative en échec, retentable telle quelle.
create table r6b_crm_projections (
  id                      uuid primary key default gen_random_uuid(),

  prospect_id             uuid not null references prospects(id) on delete cascade,
  provider                text not null check (length(provider) between 1 and 64),

  -- Ce qui a déclenché la dernière mise à jour de cette projection.
  inbound_message_id      uuid references r6b_inbound_messages(id) on delete set null,
  analysis_id             uuid references r6b_reply_analyses(id) on delete set null,
  manifest_id             uuid references r6b_dispatch_manifests(id),

  status                  text not null
                            check (status in ('PENDING', 'SKIPPED_NOT_CONFIGURED', 'BLOCKED_POLICY',
                                              'APPLIED', 'FAILED')),

  -- La charge utile EXACTE qu'un fournisseur recevrait — construite ici, figée,
  -- auditable avant qu'aucun octet ne parte. Son empreinte permet de savoir si
  -- une projection déjà appliquée mérite d'être rejouée, sans comparer des
  -- objets JSON à la main.
  payload                 jsonb not null,
  payload_sha256          text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- Identifiants rendus par le fournisseur. Nuls tant que rien n'est parti —
  -- ce sont eux qui, plus tard, feront de la projection un UPDATE plutôt qu'un
  -- CREATE, et donc ce qui empêche un prospect de devenir deux contacts.
  external_contact_id     text,
  external_opportunity_id text,
  external_stage          text,

  attempts                integer not null default 0 check (attempts >= 0),
  last_error              text,
  last_attempt_at         timestamptz,
  applied_at              timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint r6b_crm_projection_applied_has_contact check (
    status <> 'APPLIED' or (external_contact_id is not null and applied_at is not null)
  ),
  constraint r6b_crm_projection_failed_has_error check (status <> 'FAILED' or last_error is not null)
);

-- L'idempotence côté CRM : un prospect, un fournisseur, UNE ligne. Une
-- nouvelle réponse met à jour cette ligne ; elle n'en ajoute pas une seconde,
-- donc ne peut pas produire un second contact chez le fournisseur.
create unique index r6b_crm_projections_prospect_provider_idx
  on r6b_crm_projections (prospect_id, provider);

create index r6b_crm_projections_status_idx on r6b_crm_projections (status, updated_at desc);

-- ---------------------------------------------------------------------------
-- 5. r6b_alerts — réveiller un humain, sans supposer par quel canal
-- ---------------------------------------------------------------------------
--
-- Le dépôt n'a aucun fournisseur d'alerte configuré. Telegram existe sur cette
-- machine mais appartient à un projet isole : le réutiliser
-- serait une violation d'isolation déguisée en commodité. Choisir Slack, SMS ou
-- un webhook « parce qu'il en faut un » serait pire — une intégration que
-- personne n'a demandée et que personne ne surveille.
--
-- Une alerte est donc d'abord une LIGNE. Elle est visible en CLI immédiatement,
-- elle survit à l'absence de canal, et le jour où un canal existera, la
-- livraison lira cette file au lieu d'être recâblée dans le pipeline.
create table r6b_alerts (
  id                 uuid primary key default gen_random_uuid(),

  kind               text not null check (kind in ('SPEED_TO_LEAD')),
  severity           text not null check (severity in ('URGENT', 'NORMAL')),

  prospect_id        uuid not null references prospects(id) on delete cascade,
  inbound_message_id uuid not null references r6b_inbound_messages(id) on delete cascade,
  analysis_id        uuid not null references r6b_reply_analyses(id) on delete cascade,
  manifest_id        uuid references r6b_dispatch_manifests(id),

  title              text not null check (length(title) between 1 and 200),
  -- Tout ce qu'un humain doit voir sans ouvrir un autre écran : entreprise,
  -- catégorie, extrait de la réponse, message d'origine, action recommandée,
  -- état du brouillon.
  body               jsonb not null,

  --   PENDING       — en file. L'état normal tant qu'aucun canal n'existe.
  --   NO_PROVIDER   — constaté : aucun canal configuré. Reste visible en CLI.
  --   DELIVERED     — remise confirmée par un canal.
  --   FAILED        — remise tentée et échouée. Retentable.
  status             text not null default 'PENDING'
                       check (status in ('PENDING', 'NO_PROVIDER', 'DELIVERED', 'FAILED')),
  provider           text,
  attempts           integer not null default 0 check (attempts >= 0),
  last_error         text,
  delivered_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint r6b_alert_delivered_has_provider check (
    status <> 'DELIVERED' or (provider is not null and delivered_at is not null)
  ),
  constraint r6b_alert_failed_has_error check (status <> 'FAILED' or last_error is not null)
);

-- Une alerte par analyse et par type : retraiter la même réponse ne réveille
-- pas un opérateur deux fois.
create unique index r6b_alerts_analysis_kind_idx on r6b_alerts (analysis_id, kind);
create index r6b_alerts_status_idx on r6b_alerts (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle ne planifie aucune relance : `NOT_NOW` marque un candidat nurture et
-- s'arrête là (§3). Elle ne crée aucun pipeline CRM et n'en configure aucun.
-- Elle n'ouvre aucune portée Gmail supplémentaire — R6B-D1 lit en
-- `gmail.readonly` et rien d'autre. Elle ne touche ni `r6b_dispatch_manifests`,
-- ni `r6b_live_send_attempts`, ni `outreach_events` : l'unique envoi du
-- 2026-08-12 reste le seul, et le restera.
