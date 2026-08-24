-- 0036_instagram_controlled_test_own_profile.sql — IG2.2, « ce profil est-il le
-- nôtre ? »
--
-- Pourquoi cette colonne existe
-- ------------------------------
-- Le premier relevé de reconnaissance sur le compte de test a rendu les
-- compteurs du profil (`0 publications`, `163 followers`, `3 621 suivi(e)s`) et
-- le mot « chargement », mais AUCUN libellé d'action — ni « Suivre », ni
-- « Message », ni « Vous suit ». Deux causes possibles, et elles ne mènent pas
-- au même endroit :
--
--   * la page n'avait pas fini de peindre — la lecture repolle désormais ;
--   * le profil visité EST celui du compte émetteur, et un profil à soi n'offre
--     pas de bouton d'abonnement.
--
-- La seconde cause change la valeur du test entier. Un DM vers soi-même
-- prouverait que le composeur et le clic fonctionnent ; il ne prouverait PAS
-- que le rail sait remettre un message à un tiers, qui est exactement la
-- question laissée ouverte par le `DELIVERY_FAILED` du 14 août. Un `SENT`
-- obtenu ainsi, classé « le rail sait remettre », serait une conclusion plus
-- large que son observation.
--
-- Le fait mérite donc sa colonne, pas une phrase dans `detail` : ce qui décide
-- de la portée d'un résultat doit pouvoir être relu, filtré et contredit.
--
-- Trois valeurs, comme partout dans ce rail : `true` sur un marqueur positif
-- (« Modifier le profil » ne s'affiche que chez soi), `false` quand un témoin
-- de relation a été lu (on ne s'abonne pas à soi-même), `null` quand on n'a
-- pas pu lire. `null` n'est pas « non » — c'est « on ne sait pas ».
alter table ig_controlled_test_events
  add column relationship_is_own_profile boolean;

-- Le témoin de rendu, distinct du verdict qu'il autorise.
--
-- `false` ici veut dire « aucun libellé de relation n'a été lu », donc
-- `follows_viewer` et `followed_by_viewer` valent forcément `null` : sans
-- témoin, l'absence de « Vous suit » ne prouve rien. La contrainte plus bas
-- rend cette règle inviolable en base, et pas seulement respectée par le code
-- qui écrit aujourd'hui.
alter table ig_controlled_test_events
  add column relationship_ui_rendered boolean not null default false;

-- Une conclusion sur la relation exige le témoin qui l'autorise.
--
-- C'est l'interdit n°2 de CLAUDE.md — « jamais l'affirmation d'une absence non
-- vérifiée » — écrit là où il ne peut pas être oublié. Une ligne qui
-- prétendrait « ne suit pas » sans avoir lu la moindre interface de relation
-- serait refusée par la transaction.
alter table ig_controlled_test_events
  add constraint ig_ct_event_relation_needs_witness check (
    relationship_ui_rendered = true
    or (follows_viewer is null and followed_by_viewer is null)
  );

-- Un profil à soi et une relation d'abonnement s'excluent : on ne se suit pas
-- soi-même, et l'interface ne propose pas de le faire.
alter table ig_controlled_test_events
  add constraint ig_ct_event_own_profile_has_no_relation check (
    relationship_is_own_profile is distinct from true
    or (relationship_ui_rendered = false and follows_viewer is null and followed_by_viewer is null)
  );
