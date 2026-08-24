-- 0038_instagram_adjudication_observation.sql — IG2.9 : une tentative, un état
-- canonique ; une relecture, une observation.
--
-- Ce que le 14 août a montré
-- --------------------------
-- Le controlled test vers `realg_972` a été remis : bulle portant le texte
-- exact, composeur vidé, aucun marqueur d'échec, boîte de réception remontée
-- avec l'aperçu « Vous: <payload> ». Verdict `SENT`, inscrit.
--
-- Une relecture lancée 35 secondes plus tard n'a pas pu ROUVRIR le fil — la
-- ligne d'inbox ne portait aucun identifiant navigable. Ses quatre preuves
-- internes sont donc revenues « illisibles », et le rail en a tiré un second
-- événement `LIVE AMBIGUOUS` à côté du `LIVE SENT`, avec une résolution
-- `CONTRADICTS`.
--
-- Deux défauts distincts, tous deux corrigés ici et dans le code
-- --------------------------------------------------------------
-- 1. Une lecture IMPOSSIBLE était comptée comme une lecture CONTRAIRE. Ne pas
--    savoir n'est pas savoir le contraire ; c'est l'invariant que le code pose
--    désormais (`resolveControlledTestOutcome`).
--
-- 2. Une relecture s'inscrivait au journal sous le mode `LIVE`, c'est-à-dire
--    sous le mode qui signifie « une tentative a eu lieu ». Deux verdicts
--    concurrents apparaissaient pour une seule tentative, et l'état métier
--    devenait ambigu à la lecture du journal.
--
-- Le mode `ADJUDICATION` répare le second. Il DÉCRIT une tentative antérieure
-- sans en déclarer une nouvelle : `external_effect_attempted` y vaut
-- obligatoirement `false`, et la base le refuserait autrement. La distinction
-- « tentative » / « observation » cesse d'être une convention de commentaire
-- pour devenir une contrainte.
--
-- Ce que cette migration ne change pas
-- -------------------------------------
-- L'historique append-only est intact : aucun événement n'est réécrit ni
-- supprimé, y compris le `LIVE AMBIGUOUS` du 14 août, qui reste la trace
-- fidèle de ce que le rail a fait ce jour-là. Les gardes existantes tiennent
-- mot pour mot : aucun effet sans intention, `BLOCKED` reste pré-effet, et un
-- mode sans effet ne peut toujours pas déclarer d'effet.

alter table ig_controlled_test_events drop constraint ig_controlled_test_events_mode_check;
alter table ig_controlled_test_events add constraint ig_controlled_test_events_mode_check
  check (mode in ('PREFLIGHT', 'PREVIEW', 'COMPOSE_CHECK', 'LIVE', 'ADJUDICATION'));

-- La garde des modes sans effet, réécrite pour accueillir l'observation — et
-- pour continuer de refuser tout le reste.
--
-- `ADJUDICATION` peut porter une issue de remise (`SENT`, `DELIVERY_FAILED`,
-- `AMBIGUOUS`) parce qu'elle RELIT un geste déjà produit ; elle ne peut jamais
-- porter d'effet, parce qu'elle n'en produit aucun. C'est exactement la
-- propriété qui manquait : le mode dit s'il s'agit d'une tentative ou d'un
-- constat, et la base l'impose.
alter table ig_controlled_test_events drop constraint ig_ct_event_dry_modes_have_no_effect;
alter table ig_controlled_test_events add constraint ig_ct_event_dry_modes_have_no_effect check (
  mode = 'LIVE'
  or (mode = 'ADJUDICATION'
      and external_effect_attempted = false
      and status in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS'))
  or (external_effect_attempted = false
      and status in ('PREFLIGHT_OK', 'PREVIEWED', 'COMPOSER_READY', 'BLOCKED', 'FAILED'))
);

-- Une observation porte toujours sur une tentative identifiée : relire « en
-- général » n'a pas de sens, et un événement d'adjudication sans `test_id`
-- serait un constat sans objet.
alter table ig_controlled_test_events add constraint ig_ct_event_adjudication_needs_test check (
  mode <> 'ADJUDICATION' or test_id is not null
);

-- La garde jumelle, vue depuis le STATUT plutôt que depuis le mode.
--
-- Elle disait : une issue de remise n'existe qu'en `LIVE`, avec effet. C'était
-- la formulation correcte tant que relire s'écrivait `LIVE` ; elle interdirait
-- désormais toute observation. Elle est rouverte à `ADJUDICATION` — sans effet,
-- et toujours rattachée à une tentative — et continue de refuser qu'une issue
-- de remise apparaisse sous un mode qui n'a ni agi ni relu.
alter table ig_controlled_test_events drop constraint ig_ct_event_effectful_outcome_is_live;
alter table ig_controlled_test_events add constraint ig_ct_event_effectful_outcome_is_live check (
  status not in ('SENT', 'DELIVERY_FAILED', 'AMBIGUOUS')
  or (mode = 'LIVE' and external_effect_attempted = true and test_id is not null)
  or (mode = 'ADJUDICATION' and external_effect_attempted = false and test_id is not null)
);
