-- 0037_instagram_controlled_test_compose_check.sql — IG2.5, le brouillon
-- constaté sans clic.
--
-- Pourquoi un mode de plus
-- -------------------------
-- Le controlled test du 14 août a cliqué, la bulle s'est affichée, et le
-- message n'a pas été remis. Depuis, un fait décisif a été établi à la main :
-- le même compte émetteur, vers le même destinataire contrôlé, remet
-- parfaitement un message depuis l'application ET depuis Instagram Web. Seul le
-- chemin automatisé échoue.
--
-- Diagnostiquer ce chemin demandait de pouvoir l'exercer JUSQU'AU dernier point
-- observable — texte saisi, contrôle d'envoi trouvé, état du composeur lu — sans
-- produire d'effet. Les deux modes existants ne le permettaient pas : `PREVIEW`
-- s'arrête avant la saisie, `LIVE` clique.
--
-- `COMPOSE_CHECK` occupe exactement cet intervalle. Il exécute le MÊME code que
-- l'envoi, s'arrête avant le clic, et efface le brouillon derrière lui. Ce
-- qu'il rend n'est donc pas une simulation de la saisie : c'est la saisie, avec
-- son résultat réel.
--
-- Ce que cette migration ne change pas
-- -------------------------------------
-- Les trois gardes structurelles du journal restent mot pour mot : un mode sans
-- effet ne peut pas déclarer d'effet, un `BLOCKED` reste pré-effet, et les
-- issues qui supposent un geste chez Instagram (`SENT`, `DELIVERY_FAILED`,
-- `AMBIGUOUS`) n'existent qu'en `LIVE` avec effet. `COMPOSER_READY` rejoint
-- `PREFLIGHT_OK` et `PREVIEWED` du côté des issues sans effet — et la base le
-- refuserait si un jour un diff tentait d'en écrire une avec un effet attaché.

alter table ig_controlled_test_events drop constraint ig_controlled_test_events_mode_check;
alter table ig_controlled_test_events add constraint ig_controlled_test_events_mode_check
  check (mode in ('PREFLIGHT', 'PREVIEW', 'COMPOSE_CHECK', 'LIVE'));

alter table ig_controlled_test_events drop constraint ig_controlled_test_events_status_check;
alter table ig_controlled_test_events add constraint ig_controlled_test_events_status_check
  check (status in (
    'PREFLIGHT_OK', 'PREVIEWED', 'COMPOSER_READY', 'BLOCKED', 'FAILED',
    'SENT', 'DELIVERY_FAILED', 'AMBIGUOUS'));

-- La garde des modes sans effet, réécrite pour inclure le nouveau — et pour
-- continuer de refuser tout le reste.
alter table ig_controlled_test_events drop constraint ig_ct_event_dry_modes_have_no_effect;
alter table ig_controlled_test_events add constraint ig_ct_event_dry_modes_have_no_effect check (
  mode = 'LIVE'
  or (external_effect_attempted = false
      and status in ('PREFLIGHT_OK', 'PREVIEWED', 'COMPOSER_READY', 'BLOCKED', 'FAILED'))
);
