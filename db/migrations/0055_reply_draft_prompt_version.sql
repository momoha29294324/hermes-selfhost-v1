-- ---------------------------------------------------------------------------
-- HERMES-CONTACT-PURPOSE-R1 — un brouillon par analyse ET PAR PROMPT.
-- ---------------------------------------------------------------------------
--
-- `r6b_reply_drafts_analysis_idx` disait : « une analyse, un brouillon, pour
-- toujours ». C'était la bonne règle tant qu'un seul rédacteur existait, et
-- elle protégeait quelque chose de réel — un brouillon approuvé, réécrit ou
-- rejeté par un humain ne doit jamais être écrasé par une seconde génération.
--
-- Elle empêchait aussi, sans le dire, la seule chose qu'on veut ici : corriger
-- la SOURCE du texte et régénérer. Le 23 août 2026, un tour a produit un
-- brouillon que le contrôle de naturalité a refusé (TOO_LONG,
-- ADDRESS_MODE_MISMATCH). La cause n'était pas dans le texte : elle était dans
-- le rédacteur, qui ne recevait ni le registre observé, ni le budget de
-- longueur, ni le motif de contact. Corriger le rédacteur ne servait à rien
-- tant que la base refusait d'écrire le résultat.
--
-- L'unicité porte donc désormais sur (analyse, version de prompt). Ce que cela
-- veut dire, dans les deux sens :
--
--   * un MÊME prompt ne peut toujours pas produire deux brouillons pour la même
--     analyse. Rejouer le traitement ne double rien, exactement comme avant ;
--
--   * un prompt DIFFÉRENT — donc une consigne différente, donc une revue
--     humaine dans un diff — peut en produire un neuf, à côté. L'ancien n'est
--     ni modifié ni supprimé : son texte, son modèle, sa version et la décision
--     humaine qui le porte restent lisibles.
--
-- Ce que cette migration N'OUVRE PAS :
--
--   * aucun envoi. `r6b_reply_drafts` ne connaît aucun statut d'envoi, et rien
--     ici n'en ajoute un ;
--   * aucune écriture sur une ligne existante. C'est un `drop index` suivi d'un
--     `create unique index` : aucune donnée n'est touchée ;
--   * aucun contournement de la parole d'un humain. `loadDraftForAnalysis` fait
--     désormais gagner un brouillon APPROVED ou EDITED sur un brouillon plus
--     récent mais seulement PROPOSED — un texte qu'un opérateur a corrigé reste le
--     texte qui compte.
-- ---------------------------------------------------------------------------

drop index r6b_reply_drafts_analysis_idx;

create unique index r6b_reply_drafts_analysis_prompt_idx
  on r6b_reply_drafts (analysis_id, prompt_version);
