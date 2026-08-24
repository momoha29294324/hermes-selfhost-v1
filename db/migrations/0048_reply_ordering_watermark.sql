-- 0048_reply_ordering_watermark.sql — HERMES-REPLY-ORDERING-R1 : une réponse
-- ancienne ne peut plus décider de l'état présent.
--
-- ---------------------------------------------------------------------------
-- Le défaut que cette migration ferme
-- ---------------------------------------------------------------------------
--
-- Le 21 août 2026, « Atelier Auto 33 » affichait « À arbitrer » alors que sa
-- dernière phrase, reçue à 13:35:31, était un refus poli. Rien n'était cassé :
-- la corrélation avait trouvé le bon prospect, le classifieur avait conclu
-- juste sur CHAQUE message, et chaque transition était journalisée. Le journal
-- lui-même le dit — ses `created_at` montent pendant que l'heure de réception
-- des causes descend :
--
--     12:35:31 → REPLIED puis INTERESTED   (traité à 16:44)
--     13:35:31 → NOT_INTERESTED            (traité à 16:45:34)
--     13:26:13 → INTERESTED                (traité à 16:46:13)
--     13:13:23 → REVIEW_REQUIRED           (traité à 16:46:45)  ← l'état retenu
--
-- L'état courant n'était donc pas « ce que le prospect a dit en dernier »,
-- c'était « ce que le worker a fini de traiter en dernier ». Deux ordres
-- existaient — celui de la boîte de réception et celui de la file de
-- traitement — et c'est le second qui gagnait, alors que seul le premier a un
-- sens commercial.
--
-- ---------------------------------------------------------------------------
-- Pourquoi une COLONNE et pas un `order by`
-- ---------------------------------------------------------------------------
--
-- Trier la requête de sélection par `received_at` — ce que la sélection fait
-- déjà, d'ailleurs — n'aurait amélioré que le chemin heureux. Il ne protège
-- rien dès qu'un message arrive en retard, qu'un `--resume` repasse sur un
-- backlog, qu'un worker redémarre au milieu d'un lot, ou que deux workers
-- tournent en même temps : dans tous ces cas l'ordre de traitement n'est PAS
-- l'ordre de réception, et aucun tri en amont ne peut le garantir.
--
-- La protection doit donc vivre là où l'état courant est écrit, et être
-- imposée par la base plutôt que par une lecture préalable que deux processus
-- concurrents feraient en même temps. C'est exactement le mécanisme que la
-- garde `SUPPRESSED` de 0026 utilise déjà : une clause `where` sur le
-- `on conflict do update`, donc une condition que Postgres réévalue sur la
-- version À JOUR de la ligne après avoir attendu la transaction concurrente.
--
-- D'où cette colonne : la MARQUE D'EAU des réponses. Elle porte l'heure de
-- réception de la réponse la plus récente dont l'état courant tient déjà
-- compte. Une transition causée par une réponse plus ANCIENNE que cette marque
-- est refusée par la base, quel que soit l'ordre dans lequel on l'a traitée.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
--   * elle ne change AUCUN état commercial. La colonne est ajoutée et
--     renseignée ; `state`, `entered_at` et `last_transition_id` sont intacts.
--     La réparation des états déjà faussés est un geste séparé, humain, borné,
--     et il passe par `npm run r6b:replies:state-audit -- --repair-order` ;
--   * elle n'efface, ne réécrit et ne désactive aucune ligne du journal
--     `r6b_prospect_state_transitions`, aucune analyse, aucun message entrant.
--     Une réponse dont l'effet sera désormais ignoré reste analysée, reste
--     lisible, et reste visible du Learning Loop ;
--   * elle ne touche pas à la taxonomie D2 : le problème n'a jamais été la
--     classification, seulement l'ordre d'application de ses effets ;
--   * elle n'ouvre aucun chemin d'envoi et ne relâche aucun arrêt.

alter table r6b_prospect_outreach_states
  add column last_reply_received_at timestamptz;

comment on column r6b_prospect_outreach_states.last_reply_received_at is
  'HERMES-REPLY-ORDERING-R1 — heure de RÉCEPTION (r6b_inbound_messages.received_at) '
  'de la réponse la plus récente dont cet état tient déjà compte. Monotone : elle ne '
  'redescend jamais. Une transition causée par une réponse strictement plus ancienne '
  'est refusée par la clause where de applyTransition. Nulle tant qu''aucune réponse '
  'n''a été prise en compte — un prospect seulement contacté, par exemple.';

-- ---------------------------------------------------------------------------
-- Reprise de l'existant
-- ---------------------------------------------------------------------------
--
-- La marque d'eau se DÉDUIT du journal : pour chaque prospect, l'heure de
-- réception la plus tardive parmi les messages entrants qui ont réellement
-- causé une transition. C'est mot pour mot la définition de la colonne, donc
-- rien n'est inventé — aucune règle métier n'est rejouée ici, aucune catégorie
-- n'est interprétée, seule une jointure est faite.
--
-- Les messages qui ont été ANALYSÉS sans produire de transition (parce que le
-- prospect était déjà dans l'état visé, par exemple) ne remontent pas la marque.
-- C'est volontairement conservateur : une marque trop BASSE laisse au pire
-- passer une réponse qu'on aurait pu ignorer, une marque trop HAUTE bloquerait
-- une réponse légitime. Entre les deux, on préfère l'erreur qui se rattrape.
update r6b_prospect_outreach_states s
   set last_reply_received_at = w.received_at
  from (
    select t.prospect_id, max(i.received_at) as received_at
      from r6b_prospect_state_transitions t
      join r6b_inbound_messages i on i.id = t.cause_id
     where t.cause_kind = 'inbound_reply'
     group by t.prospect_id
  ) w
 where w.prospect_id = s.prospect_id;
