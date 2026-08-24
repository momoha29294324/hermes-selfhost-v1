-- 0047_autonomous_approval_provenance.sql — HERMES-AUTONOMOUS-R2 : une
-- approbation machine ne se déguise jamais en décision humaine.
--
-- ---------------------------------------------------------------------------
-- Le problème que cette migration résout
-- ---------------------------------------------------------------------------
--
-- `r6b_batch_votes` est né (0018) comme le journal d'une REVIEW HUMAINE : un
-- humain lisait un message, votait SEND/EDIT/REJECT, et `approved_text`
-- devenait le texte qu'un futur envoi reprendrait mot pour mot. La table n'a
-- donc jamais eu besoin de dire QUI votait — la réponse était « un humain »,
-- toujours, et une colonne l'aurait seulement répétée.
--
-- Le produit a tranché le 21 août 2026 : plus personne ne relit les prospects
-- un par un, et la politique autonome (`autonomousPolicy.ts`) approuve à leur
-- place ceux dont aucune porte ne doute. Cette décision-là est légitime ; ce
-- qui ne le serait pas, c'est qu'elle s'inscrive dans une table dont chaque
-- ligne se relit « un humain a regardé ce prospect ».
--
-- Or `lockManifestForItem` exige un vote approuvé, et `r6b_dispatch_manifests`
-- porte `approval_vote_id not null`. Sans cette migration, faire approuver un
-- prospect par la machine demanderait d'écrire une ligne indistinguable d'un
-- vote humain — et six mois plus tard, personne, y compris nous, ne saurait
-- dire lesquels des messages partis avaient été lus par quelqu'un.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ajoute, et pourquoi si peu
-- ---------------------------------------------------------------------------
--
-- DEUX colonnes par table, pas une de plus :
--
--   * `actor_kind` / `armed_by_kind` — la seule question qui se pose vraiment,
--     dans un vocabulaire fermé de deux valeurs. C'est une COLONNE et pas une
--     convention de `note` : une note se lit, se copie, se laisse imiter, et
--     aucune contrainte ne peut la faire respecter. Une valeur contrainte, si ;
--   * `policy_version` — parce qu'« une machine a décidé » sans dire LAQUELLE
--     ne permet pas de rejouer la décision. Un refus qu'on ne peut pas
--     reconstituer n'est pas auditable, et la politique changera.
--
-- Aucune colonne d'auteur nominatif n'est ajoutée pour la machine. Un envoi
-- réel se fait toujours au nom de quelqu'un — mais ce quelqu'un a signé
-- l'ARRÊT GLOBAL et la politique, pas chaque message ; c'est `ig_kill_switch`
-- qui porte son nom, et il le porte déjà.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
--   * elle ne réécrit AUCUNE ligne existante : le défaut `HUMAN` les décrit
--     exactement — elles ont toutes été écrites par un humain, avant que la
--     moindre ligne de code machine n'existe ;
--   * elle ne change aucune sémantique existante : les deux `check` de 0018
--     (`verdict`/`approved`, `approved_text` présent) sont intacts, et un
--     appelant qui n'écrit pas les nouvelles colonnes produit exactement la
--     ligne qu'il produisait hier ;
--   * elle n'efface aucun vote, aucun manifeste, aucune autorisation ;
--   * elle n'ouvre AUCUN chemin d'envoi. Elle ne sait que NOMMER, et le
--     nommage resserre : les trois nouvelles contraintes ci-dessous refusent
--     des lignes que la base acceptait hier ;
--   * elle ne touche ni `ig_kill_switch`, ni les plafonds, ni l'ordonnanceur.
--
-- Additive au sens strict : aucune colonne supprimée, et les deux `check` de
-- motifs de report sont ÉLARGIS d'une valeur, jamais rétrécis.

-- ---------------------------------------------------------------------------
-- 1. Le vote — humain, ou politique nommée
-- ---------------------------------------------------------------------------

alter table r6b_batch_votes
  add column actor_kind text not null default 'HUMAN'
    check (actor_kind in ('HUMAN', 'AUTONOMOUS_POLICY')),
  add column policy_version text
    check (policy_version is null or length(btrim(policy_version)) between 1 and 80);

-- Une décision machine SANS politique nommée serait une décision que personne
-- ne peut rejouer ; une décision humaine AVEC une version de politique
-- laisserait croire qu'un programme a tranché. Les deux sont refusées.
alter table r6b_batch_votes
  add constraint r6b_vote_policy_version_matches_actor check (
    (actor_kind = 'HUMAN' and policy_version is null)
    or (actor_kind = 'AUTONOMOUS_POLICY' and policy_version is not null)
  );

-- La politique autonome n'a que deux issues : elle approuve, ou elle ÉCARTE
-- sans rien écrire (`AUTO_SKIP`). Elle ne vote donc jamais REJECT — un REJECT
-- est une décision humaine, et c'est ce qui lui permet de rester TERMINAL et
-- de n'être renversée par personne. Elle ne vote pas EDIT non plus : EDIT
-- signifie « un humain a réécrit ce texte », et la machine n'en réécrit aucun.
alter table r6b_batch_votes
  add constraint r6b_vote_machine_only_sends check (
    actor_kind <> 'AUTONOMOUS_POLICY' or verdict = 'SEND'
  );

-- ---------------------------------------------------------------------------
-- 2. L'autorisation d'effet — même question, même vocabulaire
-- ---------------------------------------------------------------------------
--
-- `ig_live_canary_authorizations` (0031) réserve, consomme et compte l'unique
-- tentative externe d'un manifeste. Ce mécanisme n'est PAS dupliqué pour le
-- mode autonome : dupliquer une réservation atomique, c'est se donner deux
-- compteurs et un jour deux clics. La ligne reste la même ; seul change qui
-- l'arme.
--
-- `armed_by` reste `not null` et garde son exigence : personne n'y écrira
-- « system » ni « agent ». Pour une autorisation machine, il porte le nom du
-- rail qui l'a armée, et c'est `armed_by_kind` — pas la chaîne — qui établit
-- qu'aucun humain n'a relu CE message.

alter table ig_live_canary_authorizations
  add column armed_by_kind text not null default 'HUMAN'
    check (armed_by_kind in ('HUMAN', 'AUTONOMOUS_POLICY')),
  add column policy_version text
    check (policy_version is null or length(btrim(policy_version)) between 1 and 80);

alter table ig_live_canary_authorizations
  add constraint ig_canary_policy_version_matches_kind check (
    (armed_by_kind = 'HUMAN' and policy_version is null)
    or (armed_by_kind = 'AUTONOMOUS_POLICY' and policy_version is not null)
  );

-- ---------------------------------------------------------------------------
-- 3. Le vocabulaire de refus, élargi d'un motif
-- ---------------------------------------------------------------------------
--
-- `audience_borderline` — 8 000 ≤ abonnés attribués < 10 000.
--
-- Ce n'est PAS un changement d'ICP. Le seuil canonique reste 10 000
-- (`config/commercial-intelligence/example-shadow-v1.json`), `audienceIsOutOfScope`
-- est inchangé, et un compte à 9 000 abonnés reste dans le créneau que nous
-- savons servir : un humain qui le relit peut décider de l'écrire.
--
-- C'est une marge de CONFIANCE propre à l'envoi automatique, et elle existe
-- parce que les deux modes ne risquent pas la même chose. Tant qu'un humain
-- relisait, un compte proche du seuil arrivait devant quelqu'un qui pouvait
-- ouvrir le profil et trancher. Sans lui, l'erreur de mesure — un compteur lu
-- il y a trois semaines, un profil qui grossit, un `og:description` arrondi —
-- n'est plus rattrapée par personne, et elle se paie en messages envoyés à des
-- entreprises hors créneau.
--
-- TEMPORARY, et c'est le point : le prospect n'est pas refusé, il attend. Une
-- mesure plus récente le rouvre dans un sens comme dans l'autre — au-dessus de
-- 10 000 il devient `audience_out_of_scope` (terminal), en dessous de 8 000 il
-- redevient éligible. Un skip temporaire est une question ouverte.
--
-- Aucune valeur n'est retirée : les deux `check` sont reconstruits à
-- l'identique, plus le nouveau motif.

alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_last_skip_reason_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_last_skip_reason_check
  check (last_skip_reason is null or last_skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline'
  ));

alter table ig_job_events drop constraint ig_job_events_skip_reason_check;
alter table ig_job_events add constraint ig_job_events_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline'
  ));
