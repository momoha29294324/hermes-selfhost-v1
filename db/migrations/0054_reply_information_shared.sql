-- ---------------------------------------------------------------------------
-- HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — l'étiquette qui manquait.
-- ---------------------------------------------------------------------------
--
-- Le classifieur R6B-D2 disposait de dix étiquettes et d'aucune qui décrive le
-- cas le PLUS FRÉQUENT d'une prospection qui fonctionne : le prospect répond à
-- la question qu'on vient de lui poser, en livrant un fait sur son entreprise.
--
-- Observé le 22 août 2026, message 265d790b-093d-4af6-b927-4213a55028ac :
--
--   NOUS : « … vous faites comment pour avoir régulièrement de nouvelles
--            demandes, plutôt grâce au bouche-à-oreille et aux réseaux ou avec
--            autre chose déjà en place ? »
--   EUX  : « Surtout via le bouche à oreille »
--
-- Le modèle avait parfaitement compris — son `reasoning_summary` conservé en
-- base dit mot pour mot « La personne répond factuellement à la question sur
-- son canal actuel d'acquisition » — puis a dû choisir entre huit étiquettes
-- dont aucune ne convenait. Il a pris la moins fausse (`QUESTION`) et a baissé
-- sa confiance à 0,55 pour le dire, ce qui a déclenché le rabattement de
-- `decideCategory` vers `REVIEW_REQUIRED`, puis `HUMAN_ESCALATION:unclassifiable`
-- côté autonomie. Le défaut n'était donc PAS un défaut de compréhension : c'est
-- la taxonomie qui n'avait pas de case pour ce qui avait été compris.
--
-- `INFORMATION_SHARED` est cette case. Ce qu'elle N'EST PAS :
--
--   * une baisse de seuil — `MIN_ACTIONABLE_CONFIDENCE` (0,60) et
--     `reply.minConfidence` (0,85) sont inchangés ;
--   * une exception — elle vaut pour toute conversation, la coquille du test
--     contrôlé comme un vrai prospect ;
--   * une catégorie « fourre-tout » — un doute reste `REVIEW_REQUIRED`, une
--     objection reste `OBJECTION`, un refus reste un refus, et une demande
--     d'arrêt continue de tout emporter (`detectUnsubscribeDemand`).
--
-- Sa conséquence est celle d'un tour de conversation vivant : `REPLIED` (et non
-- `INTERESTED` — répondre à une question n'établit aucun intérêt), un brouillon
-- a du sens, aucune alerte urgente, aucune suppression.
--
-- Aucune ligne existante n'est modifiée : la contrainte est ÉLARGIE, jamais
-- resserrée. Les analyses déjà rendues restent lisibles avec le prompt et le
-- modèle qui les ont produites, et la reclassification passe par le chemin
-- normal (`prompt_version` incrémenté → nouvelle ligne ACTIVE, l'ancienne
-- SUPERSEDED), sans qu'aucun `update` de contenu n'ait lieu ici.
-- ---------------------------------------------------------------------------

alter table r6b_reply_analyses
  drop constraint r6b_reply_analyses_classification_check;

alter table r6b_reply_analyses
  add constraint r6b_reply_analyses_classification_check
  check (classification in (
    'INTERESTED', 'QUESTION', 'INFORMATION_SHARED', 'OBJECTION', 'NOT_NOW',
    'NOT_INTERESTED', 'UNSUBSCRIBE', 'AUTO_REPLY', 'BOUNCE', 'OTHER',
    'REVIEW_REQUIRED'));
