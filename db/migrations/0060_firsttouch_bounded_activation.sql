-- HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — un budget de premier contact qui
-- survit au processus.
--
-- Ce que cette table répare, et pourquoi elle ressemble tant à 0060.
--
-- Le rail de premier contact avait bien un plafond, `--max-effects`, mais il
-- comptait PAR CYCLE : `--loop --max-effects 3` autorisait trois effets, puis
-- trois de plus au cycle suivant, indéfiniment. Un opérateur qui lisait
-- « max-effects 3 » croyait borner un déploiement ; il bornait une itération.
-- La seule forme réellement bornée était `--once`, c'est-à-dire un processus au
-- premier plan qu'un humain relance à la main — donc pas un runtime.
--
-- Un compteur en mémoire ne pouvait pas répondre : il repart à zéro à chaque
-- redémarrage, et un worker qui redémarre est le cas NORMAL (crash, sentinelle
-- de révision, reboot). Le budget devait donc vivre en base, exactement comme
-- la frontière d'auto-réponse de 0060 — dont cette table reprend la forme
-- volontairement, pour qu'un lecteur qui connaît l'une connaisse l'autre.
--
-- Ce qu'elle n'est PAS : un plafond de volume. 10/jour, 3/heure, l'espacement
-- de quinze minutes et la fenêtre restent intégralement devant et ne sont pas
-- touchés ici. Une activation ne dit pas COMBIEN on peut envoyer par jour ;
-- elle dit combien ce DÉPLOIEMENT-ci a le droit de produire, tous cycles et
-- tous redémarrages confondus, avant de s'arrêter tout seul.

create table if not exists hermes_firsttouch_activations (
  id uuid primary key default gen_random_uuid(),

  -- La frontière, écrite par la BASE et jamais par l'appelant. Un effet
  -- antérieur ne consomme pas ce budget et ne le débloque pas non plus : le
  -- déploiement compte ce qu'il a produit LUI, pas l'histoire du dépôt.
  frontier_at  timestamptz not null default now(),
  activated_at timestamptz not null default now(),
  activated_by text not null check (length(btrim(activated_by)) > 0),
  reason       text not null check (length(btrim(reason)) > 0),

  -- La politique sous laquelle ce déploiement a été armé. Monter la version de
  -- politique referme donc l'activation par construction, comme partout.
  policy_version text not null,

  -- `null` = sans borne. La colonne l'autorise parce que la table décrit un
  -- fait ; c'est la COMMANDE qui exige `--unbounded` en toutes lettres, de
  -- sorte qu'aucun oubli d'option ne produise un rail illimité.
  max_effects integer check (max_effects is null or max_effects >= 0),

  revoked_at    timestamptz,
  revoked_by    text,
  revoke_reason text,

  constraint hermes_firsttouch_activation_frontier_not_backdated
    check (frontier_at >= activated_at),
  constraint hermes_firsttouch_activation_revocation_complete
    check (
      (revoked_at is null and revoked_by is null and revoke_reason is null)
      or (revoked_at is not null
          and revoked_by is not null and length(btrim(revoked_by)) > 0
          and revoke_reason is not null and length(btrim(revoke_reason)) > 0)
    ),
  constraint hermes_firsttouch_activation_revoked_after_activation
    check (revoked_at is null or revoked_at >= activated_at)
);

-- Une seule activation vivante à la fois, pour tout le dépôt. Deux budgets
-- ouverts en parallèle seraient deux déploiements qui s'ignorent, et la somme
-- des deux ne serait bornée par personne.
create unique index if not exists hermes_firsttouch_activation_live_idx
  on hermes_firsttouch_activations ((true)) where revoked_at is null;

create index if not exists hermes_firsttouch_activation_history_idx
  on hermes_firsttouch_activations (activated_at desc);

comment on table hermes_firsttouch_activations is
  'HERMES-FIRST-TOUCH-BOUNDED-ACTIVATION-R1 — le budget DURABLE du rail de premier contact. Une ligne vivante au plus ; frontier_at ne peut pas être antidatée. Le budget se compte en base (ig_dispatch_jobs.external_effect_attempted depuis la frontière), donc il survit aux cycles et aux redémarrages là où --max-effects ne bornait qu''une itération.';
