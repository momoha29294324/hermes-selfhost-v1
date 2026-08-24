-- ---------------------------------------------------------------------------
-- HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — retirer une analyse rendue par
-- un runtime périmé, sans effacer une ligne.
-- ---------------------------------------------------------------------------
--
-- Ce qui s'est passé, exactement
-- ---------------------------------------------------------------------------
-- Le 23 août 2026, un `ig:inbound:run --loop` démarré à 07:00:42Z — donc AVANT
-- le commit 6d1bf8a de 07:30:51Z — a continué de classifier avec le code chargé
-- en mémoire à son démarrage. À 08:43:26Z il a écrit, pour le message
-- f56eab97-3306-4018-90b8-773c00d85f16, une analyse portant
-- `prompt_version = 'r6b-d2-classify-1'` — une version qu'aucun code du HEAD ne
-- produit plus — et, ce faisant, il a fait passer en `SUPERSEDED` l'analyse
-- CANONIQUE rendue à 08:36:15Z sous `r6b-d2-classify-2`.
--
-- Le dépôt n'a pas failli : `persistAnalysis` a fait ce qu'on lui demandait —
-- une conclusion nouvelle remplace la vivante. La question était mal posée. Un
-- processus long n'est pas une autorité sur ce qui est canonique aujourd'hui.
--
-- Pourquoi une reclassification ne suffisait PAS
-- ---------------------------------------------------------------------------
-- `r6b_reply_analyses_identity_idx` est unique sur TOUTE l'histoire, pas
-- seulement sur les lignes vivantes : le quadruplet (message, prompt, modèle,
-- empreinte du contexte) ne peut apparaître qu'une fois. La conclusion
-- canonique existe déjà en base ; rejouer le traitement ne peut donc pas la
-- réécrire, et `persistAnalysis` lève `AnalysisHistoryConflict` — exactement ce
-- qu'il doit faire, puisque revenir en arrière demande une décision humaine.
--
-- Il ne restait donc que deux issues : effacer (refusé — c'est de
-- l'historique), ou nommer un opérateur. C'est la seconde.
--
-- Ce que cette migration ouvre, et ce qu'elle N'ouvre PAS
-- ---------------------------------------------------------------------------
-- Elle ouvre un TROISIÈME statut, `RETIRED`, et lui seul : une analyse écartée
-- par une personne nommée parce que la VERSION qui l'a produite n'est plus
-- canonique. Ce n'est pas un jugement sur son contenu — `RETIRED` ne dit rien
-- de juste ou de faux, il dit « rendue par un runtime périmé ».
--
-- `RETIRED` ne porte pas de successeur : `superseded_by` reste nul, parce que
-- rien ne l'a remplacée au moment où on l'écarte. C'est précisément ce qui la
-- distingue d'un `SUPERSEDED`, où une conclusion neuve a pris la place.
--
-- Elle N'ouvre AUCUNE résolution automatique. Aucun chemin de production
-- n'écrit `RETIRED` : ni `persistAnalysis`, ni `processReply`, ni le rail
-- entrant. La seule porte est une commande opérateur qui exige un nom, un
-- motif, et un `--apply` explicite (elle est en simulation par défaut).
--
-- Elle N'efface RIEN, et c'est le point : la ligne périmée reste lisible, avec
-- son modèle, son prompt, sa confiance et son résumé de raisonnement. Ce qui
-- change est son statut, plus un journal qui dit qui l'a écartée et pourquoi.
--
-- Le journal, et pourquoi il est une table
-- ---------------------------------------------------------------------------
-- Réinstaller la ligne canonique impose de remettre `superseded_by` à nul — la
-- contrainte `..._superseded_fields` l'exige d'une ligne ACTIVE. Cette valeur
-- est un FAIT (« e3a32457 l'avait remplacée »), et l'écraser sans le consigner
-- ailleurs serait un effacement d'historique déguisé en réparation.
--
-- `r6b_reply_analysis_retirements` conserve donc, pour chaque geste : la ligne
-- écartée, son statut d'avant, sa version d'exécution, la version canonique du
-- moment, la ligne réinstallée s'il y en a une, le lien de supersession qui a
-- été dénoué, l'opérateur et le motif. La chaîne reste reconstituable.
-- ---------------------------------------------------------------------------

alter table r6b_reply_analyses
  drop constraint r6b_reply_analyses_status_check;

alter table r6b_reply_analyses
  add constraint r6b_reply_analyses_status_check
  check (status in ('ACTIVE', 'SUPERSEDED', 'RETIRED'));

alter table r6b_reply_analyses
  drop constraint r6b_reply_analysis_superseded_fields;

alter table r6b_reply_analyses
  add constraint r6b_reply_analysis_superseded_fields check (
    (status = 'ACTIVE' and superseded_by is null and superseded_at is null)
    or (status = 'SUPERSEDED' and superseded_by is not null and superseded_at is not null)
    -- Une analyse RETIRÉE n'a PAS de successeur : personne n'a pris sa place,
    -- on l'a écartée. Confondre les deux ferait mentir la chaîne de
    -- supersession sur ce qui a réellement remplacé quoi.
    or (status = 'RETIRED' and superseded_by is null and superseded_at is null)
  );

comment on column r6b_reply_analyses.status is
  'ACTIVE — la conclusion vivante. SUPERSEDED — remplacée par une conclusion neuve (superseded_by). '
  'RETIRED — écartée par un opérateur nommé parce que la version qui l''a produite n''est plus '
  'canonique ; sans successeur, journalisée dans r6b_reply_analysis_retirements.';

-- ---------------------------------------------------------------------------
-- Le journal des gestes d'opérateur
-- ---------------------------------------------------------------------------
create table r6b_reply_analysis_retirements (
  id                      uuid primary key default gen_random_uuid(),

  -- La ligne écartée. `on delete cascade` suit le message entrant : si le
  -- message disparaît, le geste qui portait sur son analyse n'a plus d'objet.
  analysis_id             uuid not null references r6b_reply_analyses(id) on delete cascade,
  inbound_message_id      uuid not null references r6b_inbound_messages(id) on delete cascade,

  -- L'état d'AVANT, recopié : une décision doit rester relisible avec l'état
  -- qui l'a produite, pas avec l'état d'aujourd'hui.
  previous_status         text not null check (previous_status in ('ACTIVE', 'SUPERSEDED')),

  -- La version d'exécution jugée périmée, et celle qui faisait autorité au
  -- moment du geste. Les deux, parce que la seconde bougera encore.
  retired_prompt_version  text not null check (length(retired_prompt_version) between 1 and 64),
  canonical_prompt_version text not null check (length(canonical_prompt_version) between 1 and 64),

  -- La ligne remise en vie, s'il y en avait une à remettre. Nul est un cas
  -- normal : aucune analyse canonique n'existait, le retraitement en écrira une.
  reinstated_analysis_id  uuid references r6b_reply_analyses(id),
  -- Le lien de supersession dénoué pour pouvoir la réinstaller. Sans cette
  -- colonne, remettre `superseded_by` à nul effacerait un fait.
  unlinked_superseded_by  uuid references r6b_reply_analyses(id),

  operator                text not null check (length(trim(operator)) between 2 and 120),
  reason                  text not null check (length(trim(reason)) between 8 and 600),

  created_at              timestamptz not null default now(),

  -- Réinstaller sans rien dénouer est possible (une ligne déjà sans lien) ;
  -- dénouer sans réinstaller ne l'est pas — le lien n'aurait été défait que
  -- pour rien.
  constraint r6b_analysis_retirement_unlink_implies_reinstate check (
    unlinked_superseded_by is null or reinstated_analysis_id is not null
  ),
  -- Une analyse ne s'écarte pas elle-même au profit d'elle-même.
  constraint r6b_analysis_retirement_distinct check (
    reinstated_analysis_id is null or reinstated_analysis_id <> analysis_id
  )
);

-- Un même geste ne s'inscrit qu'une fois : une analyse ne peut être écartée
-- qu'une seule fois dans toute l'histoire. Rejouer la commande ne journalise
-- rien de neuf — elle refusera bien avant, puisque la ligne n'est plus ACTIVE.
create unique index r6b_reply_analysis_retirements_once_idx
  on r6b_reply_analysis_retirements (analysis_id);

create index r6b_reply_analysis_retirements_message_idx
  on r6b_reply_analysis_retirements (inbound_message_id, created_at desc);

comment on table r6b_reply_analysis_retirements is
  'Journal des analyses écartées par un opérateur nommé pour cause de version d''exécution périmée. '
  'Aucun chemin de production n''y écrit : la seule porte est npm run replies:analysis:retire, en '
  '--apply explicite. Rien n''est effacé — ce journal existe pour que ce qui a été dénoué reste su.';
