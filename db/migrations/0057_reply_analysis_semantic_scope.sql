-- ---------------------------------------------------------------------------
-- HERMES-SEMANTIC-GROUNDING-R1 — ce que le message DEMANDE, et ce qu'il RACONTE.
-- ---------------------------------------------------------------------------
--
-- Ce qui s'est passé, exactement
-- ---------------------------------------------------------------------------
-- Le 23 août 2026 à 17:33, un prospect a écrit : « Surtout du prestation standard
-- intérieur, j'avais surtout des gens qui demandaient le prix puis répondait
-- plus ». Le modèle avait compris (`INFORMATION_SHARED`, 0,99), le brouillon
-- était juste, et la conversation a fini en
-- `HUMAN_ESCALATION:pricing_policy_missing` (plan 5c86c2b1, BLOCKED, aucun
-- effet tenté).
--
-- Personne ne nous demandait un prix. Le dépôt tenait « ce message CONTIENT
-- une demande » et « ce message ADRESSE une demande » pour une seule
-- proposition. La première était vraie, la seconde fausse.
--
-- Le correctif principal est du CODE — `src/lib/conversation/utteranceScope.ts`
-- lit le cadre d'énonciation de chaque portion de phrase, et
-- `firstEscalatingDemand` refuse d'escalader sur un cadre qui n'est pas
-- courant. Cette migration ne le remplace pas : elle ajoute la SECONDE
-- opinion, celle du modèle, pour qu'elle soit relisible sans lui.
--
-- Ce que ces deux colonnes ouvrent, et ce qu'elles n'ouvrent PAS
-- ---------------------------------------------------------------------------
-- `current_request` porte, dans un vocabulaire FERMÉ, ce que le modèle a
-- compris de la demande COURANTE — celle que la personne nous adresse, en son
-- nom propre, maintenant. `NONE` est une valeur à part entière, et c'est la
-- plus fréquente d'une prospection qui fonctionne.
--
-- Elle n'ouvre AUCUN envoi et ne peut RETIRER aucune escalade. Le seul usage
-- qu'en fait le code est d'en AJOUTER une : quand le modèle nomme une demande
-- qu'aucune vérité de ce dépôt ne couvre — le prix d'après l'essai, un
-- pourcentage, une garantie, un remboursement, un engagement, un résultat
-- promis — et que le lexique ne l'a pas vue, le tour escalade. C'est la
-- direction sûre, et c'est la seule ouverte.
--
-- `reported_content` est DESCRIPTIF : ce que la personne rapporte des autres,
-- de son passé, de ce qu'elle envisage. Aucune porte ne le lit. Il existe pour
-- qu'un opérateur relisant une escalade six mois plus tard puisse voir ce que
-- le modèle avait séparé.
--
-- Aucune ligne existante n'est modifiée. Les analyses déjà rendues portent
-- `null` et `'{}'`, ce qui se lit exactement comme « ce round n'existait pas
-- encore » — et non comme « aucune demande ». Le code traite `null` comme une
-- absence d'opinion, jamais comme une absence de demande.
-- ---------------------------------------------------------------------------

alter table r6b_reply_analyses
  add column current_request text
    check (current_request is null or current_request in (
      'NONE',
      'POST_TRIAL_PRICE',
      'TRIAL_COST',
      'AD_BUDGET',
      'PERCENTAGE_OR_FEE',
      'GUARANTEE',
      'REFUND',
      'COMMITMENT',
      'EXPECTED_RESULTS',
      'RESULT_TIMING',
      'SERVICE_EXPLANATION',
      'CONTACT_PURPOSE',
      'EXCLUSIVITY',
      'BOOKING',
      'OTHER')),
  add column reported_content text[] not null default '{}';

comment on column r6b_reply_analyses.current_request is
  'HERMES-SEMANTIC-GROUNDING-R1 — ce que la personne nous demande MAINTENANT, en son nom propre. Ne peut qu''AJOUTER une escalade, jamais en retirer une.';

comment on column r6b_reply_analyses.reported_content is
  'HERMES-SEMANTIC-GROUNDING-R1 — ce que la personne RAPPORTE (tiers, passé, hypothèse, citation). Descriptif : aucune porte ne le lit.';
