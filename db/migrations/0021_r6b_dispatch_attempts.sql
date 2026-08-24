-- 0021_r6b_dispatch_attempts.sql — R6B-C.1, journal des tentatives de dispatch
-- (mission « Hermes R6B-C.1 — Exact Manifest Dispatcher / DRY-RUN Gate »).
--
-- R6B-B.2 a figé cinq manifestes LOCKED : un transport et un destinataire
-- choisis par un opérateur, un texte approuvé mot pour mot, un sha256 pour le
-- prouver. R6B-C.1 ajoute la seule chose qui manquait pour qu'un futur envoi
-- soit vérifiable : un chemin d'exécution qui n'accepte QUE l'identifiant
-- exact d'un manifeste, et qui, dans cette mission, s'arrête au DRY_RUN.
--
-- Cette migration ne crée ni sender, ni provider, ni credential.
-- `OUTBOUND_ALLOW_SENDING` reste à 0 et aucun code de ce dépôt ne peut
-- produire un envoi réseau vers un prospect.
--
-- ---------------------------------------------------------------------------
-- Pourquoi une table dédiée plutôt que `outreach_events` (§10)
-- ---------------------------------------------------------------------------
--
-- `outreach_events` (0001, + `manifest_id` en 0019) décrit le cycle de vie
-- d'un outreach *réel* : `sent`, `delivered`, `bounced`, `replied`. C'est la
-- table que le gate produit interroge pour affirmer « personne n'a été
-- contacté » (`gate:report`, critère 9) et que R6B-A/B testent à zéro. Y
-- écrire une ligne pour un DRY_RUN — un calcul local qui ne touche aucun
-- réseau — rendrait cette affirmation invérifiable : il faudrait désormais
-- filtrer sur un `kind` pour distinguer « on a contacté quelqu'un » de « on a
-- simulé une enveloppe ». Un compteur de sécurité qui a besoin d'un filtre
-- n'est plus un compteur de sécurité.
--
-- Aucune autre table existante ne décrit une tentative d'exécution :
-- `model_runs` couvre les appels LLM, `r6b_batch_votes` les décisions
-- humaines, `r6b_dispatch_manifests` la décision figée. D'où cette table,
-- append-only comme les précédentes : une tentative n'est jamais mise à jour
-- ni supprimée, elle est ajoutée.

create table r6b_dispatch_attempts (
  id                    uuid primary key default gen_random_uuid(),

  -- Ce que l'appelant a demandé, verbatim — y compris une valeur qui ne
  -- correspond à aucun manifeste. Une tentative refusée doit rester lisible :
  -- sans cette colonne, « quelqu'un a demandé à dispatcher un id inconnu »
  -- ne laisserait aucune trace.
  requested_manifest_id text not null,

  -- Nul uniquement quand `requested_manifest_id` ne résout aucune ligne.
  manifest_id           uuid references r6b_dispatch_manifests(id),

  mode                  text not null check (mode in ('DRY_RUN', 'LIVE')),

  -- Copiés depuis le manifeste au moment de la tentative, jamais recalculés
  -- depuis le prospect. Nuls quand la tentative a été refusée avant d'avoir
  -- pu les lire.
  transport             text
                          check (transport in ('email', 'instagram_dm', 'facebook_dm', 'web_form',
                                               'sms', 'whatsapp', 'phone_call')),
  recipient             text,
  approved_text_sha256  text,

  -- 'SENT' est déclaré dès maintenant pour que l'index d'idempotence
  -- ci-dessous existe avant qu'un envoi soit possible (§11). Aucun chemin de
  -- code de R6B-C.1 ne peut produire cette valeur : il n'existe aucun adapter
  -- LIVE, et les contraintes ci-dessous exigent `network_attempted` pour
  -- l'atteindre — ce qu'aucun code de ce dépôt ne sait faire.
  status                text not null check (status in ('DRY_RUN_OK', 'BLOCKED', 'SENT')),

  network_attempted     boolean not null default false,
  sent                  boolean not null default false,

  error_code            text,

  created_at            timestamptz not null default now(),

  -- Un DRY_RUN est, par définition, un calcul local : il ne touche pas le
  -- réseau et n'envoie rien. La base le garantit plutôt que de faire
  -- confiance à l'appelant.
  constraint r6b_dispatch_attempt_dry_run_is_local check (
    mode <> 'DRY_RUN' or (network_attempted = false and sent = false and status <> 'SENT')
  ),

  -- `sent` et `status = 'SENT'` disent la même chose : ils ne peuvent pas
  -- diverger. Interdit d'inventer un faux succès en cochant l'un sans l'autre.
  constraint r6b_dispatch_attempt_sent_is_status check ((status = 'SENT') = (sent = true)),

  -- Un succès n'existe qu'attaché à un manifeste résolu, en mode LIVE, avec
  -- une tentative réseau réelle. Impossible à atteindre en R6B-C.1.
  constraint r6b_dispatch_attempt_sent_requires_live check (
    status <> 'SENT' or (mode = 'LIVE' and manifest_id is not null and network_attempted = true)
  ),

  -- Un refus dit toujours pourquoi.
  constraint r6b_dispatch_attempt_blocked_has_code check (
    status <> 'BLOCKED' or error_code is not null
  ),

  -- Un DRY_RUN réussi a nécessairement lu le manifeste jusqu'au bout.
  constraint r6b_dispatch_attempt_ok_is_complete check (
    status <> 'DRY_RUN_OK'
    or (manifest_id is not null and transport is not null and recipient is not null
        and approved_text_sha256 is not null and error_code is null)
  )
);

create index r6b_dispatch_attempts_manifest_idx on r6b_dispatch_attempts (manifest_id, created_at desc);
create index r6b_dispatch_attempts_created_idx on r6b_dispatch_attempts (created_at desc);

-- ---------------------------------------------------------------------------
-- §11 — la frontière d'idempotence du futur LIVE, posée avant qu'un envoi
-- existe.
-- ---------------------------------------------------------------------------
--
-- Plusieurs DRY_RUN du même manifeste sont autorisés : ils ne produisent rien
-- et servent justement à revérifier. Un envoi réussi, lui, ne peut arriver
-- qu'une fois — c'est la base qui le refuse, pas une garde applicative qu'un
-- futur appelant pourrait contourner. L'index existe dès maintenant pour que
-- R6B-C.2 n'ait pas à se souvenir de le créer au moment où il compterait.
create unique index r6b_dispatch_attempts_one_live_success_idx
  on r6b_dispatch_attempts (manifest_id)
  where status = 'SENT';
