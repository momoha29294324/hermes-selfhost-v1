-- 0024_r6b_provider_payload_identity.sql — R6B-C.2B.1, identité de la requête
-- provider (mission « Ambiguous Retry Hardening + Final Live Preview »).
--
-- 0023 a posé le registre des envois LIVE : qui, par quel transport, avec
-- quelle clé d'idempotence, et dans quel état. Il lui manquait de quoi
-- répondre à la seule question qui compte devant une issue inconnue :
--
--     « rejouer cette requête enverrait-il le MÊME email, ou un autre ? »
--
-- Sans réponse, la seule règle sûre était « ne jamais rejouer un POST » — et
-- cette règle-là condamne toute tentative ambiguë à une vérification manuelle
-- dans le tableau de bord du provider, alors que Resend documente exactement
-- la primitive qui manquait.
--
-- ---------------------------------------------------------------------------
-- Ce que la documentation Resend garantit (vérifié le 2026-08-12, pas supposé)
-- ---------------------------------------------------------------------------
--
--   * « Idempotency keys are kept in the system for 24 hours. »
--   * Même clé + même payload : « our API will give the same response, without
--     actually sending the email again. »
--   * Même clé + payload différent : 409 `invalid_idempotent_request`.
--   * Requête concurrente sur la même clé : 409
--     `concurrent_idempotent_requests` — « it is safe to retry this request
--     later if needed ».
--   * Aucune primitive ne permet de retrouver un email PAR sa clé
--     d'idempotence. `GET /emails` ne filtre que par pagination (`limit`,
--     `after`, `before`) : ni destinataire, ni objet, ni clé.
--
-- La conséquence est celle qui justifie cette migration : rejouer à
-- l'identique (même clé, même payload, dans les 24 h) est la SEULE façon
-- autorisée par le provider d'apprendre l'identifiant d'un email dont on n'a
-- pas vu la réponse. Et elle est sûre dans les deux mondes possibles :
--
--   - la première requête était arrivée → le rejeu renvoie sa réponse, sans
--     réexpédier ;
--   - la première requête n'était jamais arrivée → le rejeu l'envoie, et c'est
--     le premier et unique envoi.
--
-- Dans les deux cas : exactement un email. Ce n'est donc pas une nouvelle
-- intention commerciale, c'est la même, poursuivie jusqu'à son issue connue.
--
-- Ce qui reste interdit et ne dépend pas de cette migration : rejouer avec une
-- clé neuve, un suffixe, un compteur ou un horodatage. Une telle clé fait de la
-- seconde requête un second email — c'est précisément la porte que
-- l'idempotence ferme. Resend suggère pourtant « Change your idempotency key
-- or payload » devant un `invalid_idempotent_request` ; ce conseil vaut pour
-- une API générique, pas pour un premier contact commercial, et il n'est pas
-- suivi ici.
--
-- Cette migration ne déclenche aucun envoi et ne crée aucune ligne. La table
-- est vide avant comme après (0 tentative LIVE, 0 outreach_event).

-- ---------------------------------------------------------------------------
-- 1. L'identité de la requête réellement partie
-- ---------------------------------------------------------------------------
--
-- `transport_payload_sha256` (0022) couvre ce que le manifeste fige : l'objet
-- de l'email. Il ne dit rien de l'expéditeur ni du reply-to, qui viennent de
-- la configuration et non du manifeste — deux requêtes au même destinataire
-- avec le même texte mais un `from` différent ont donc aujourd'hui la même
-- empreinte, alors que ce sont deux requêtes différentes pour le provider.
--
-- D'où une empreinte distincte, calculée sur les cinq champs EXACTS transmis
-- à Resend (`from`, `to`, `reply_to`, `subject`, `text`), dans la même
-- sérialisation canonique déterministe que le reste du dépôt (clés triées,
-- sans espace — voir `canonicalJson`). C'est elle qui permet d'affirmer, avant
-- de toucher au réseau, qu'un rejeu porte le même payload logique — plutôt que
-- de l'espérer.
--
-- La table est vide (0 ligne) : la colonne peut donc être NOT NULL dès sa
-- création. Une tentative LIVE sans identité de payload n'aurait de toute
-- façon aucun moyen d'être réconciliée.
alter table r6b_live_send_attempts
  add column provider_payload_sha256 text not null
    check (provider_payload_sha256 ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- 2. La fin de la fenêtre d'idempotence du provider
-- ---------------------------------------------------------------------------
--
-- Écrite au moment de la réservation, donc AVANT que Resend ne reçoive quoi
-- que ce soit. L'écart joue dans le bon sens : la fenêtre locale expire un peu
-- plus tôt que celle du provider, jamais plus tard. Le système cesse donc de
-- rejouer pendant que Resend honore encore la clé — et non l'inverse.
--
-- Passé cette date, plus aucun POST n'est rejoué automatiquement : la clé
-- n'étant plus connue du provider, un « rejeu » serait un envoi neuf. L'issue
-- devient alors une décision humaine explicite.
alter table r6b_live_send_attempts
  add column provider_idempotency_expires_at timestamptz not null;

-- Une fenêtre d'idempotence commence à la réservation : elle ne peut pas
-- expirer avant d'avoir commencé.
alter table r6b_live_send_attempts
  add constraint r6b_live_send_idempotency_window_is_forward
  check (provider_idempotency_expires_at > claimed_at);

comment on column r6b_live_send_attempts.provider_payload_sha256 is
  'sha256 de la forme canonique des cinq champs envoyés au provider (from, to, reply_to, subject, text). '
  'Sert à prouver, avant tout réseau, qu''un rejeu porte le même payload logique.';

comment on column r6b_live_send_attempts.provider_idempotency_expires_at is
  'Fin de la fenêtre d''idempotence Resend (24 h, documentée), calculée à la réservation. '
  'Au-delà : aucun rejeu automatique du POST, réconciliation humaine obligatoire.';

-- ---------------------------------------------------------------------------
-- 3. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'arme aucun manifeste, ne touche ni `OUTBOUND_ALLOW_SENDING` ni
-- `OUTBOUND_LIVE_MANIFEST_ID`, et ne relâche aucune garde de 0023 :
-- l'index unique partiel `r6b_live_send_attempts_one_open_per_manifest_idx`
-- reste en place, donc un manifeste SENT reste définitivement non renvoyable
-- — y compris après l'expiration de la fenêtre de 24 h du provider, qui ne
-- protège que le provider et n'a jamais protégé la base.
