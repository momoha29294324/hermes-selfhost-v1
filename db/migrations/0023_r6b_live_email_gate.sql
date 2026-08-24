-- 0023_r6b_live_email_gate.sql — R6B-C.2B, registre des envois LIVE
-- (mission « Hermes R6B-C.2B — Single Manifest Live Email Gate »).
--
-- R6B-C.1 a posé un dispatcher qui n'accepte qu'un identifiant de manifeste
-- exact, R6B-C.2A a figé le payload transport (l'objet d'un email) et son
-- empreinte. Il manquait la seule chose qu'un envoi réel exige et qu'aucune
-- des deux missions n'a écrite : un état persistant qui empêche, à travers
-- deux processus et au-delà de la fenêtre d'idempotence du provider, qu'un
-- même manifeste parte deux fois.
--
-- Cette migration ne déclenche aucun envoi. `OUTBOUND_ALLOW_SENDING` reste à 0
-- et les tables restent vides : elle crée le registre qui rendra un envoi
-- vérifiable, pas l'envoi.
--
-- ---------------------------------------------------------------------------
-- Pourquoi une table distincte de `r6b_dispatch_attempts`
-- ---------------------------------------------------------------------------
--
-- `r6b_dispatch_attempts` (0021) est un journal append-only : une ligne y est
-- ajoutée, jamais mise à jour. C'est ce qui en fait une preuve — un journal
-- qu'on réécrit ne prouve rien.
--
-- Or un envoi réel a un cycle de vie, et ce cycle est précisément ce qui
-- protège : on réserve le droit d'envoyer AVANT de toucher le réseau, on note
-- qu'on va le toucher, puis on note ce qui en est revenu. Trois écritures
-- successives sur le même fait, donc des UPDATE, donc pas dans un journal
-- append-only.
--
-- D'où deux tables aux rôles opposés :
--
--   * `r6b_live_send_attempts` (ici) — l'état courant d'un envoi. Mutable par
--     construction, mais seulement dans le sens CLAIMED → terminal ; les
--     contraintes ci-dessous rendent un retour en arrière impossible.
--   * `r6b_dispatch_attempts` (0021) — le journal. Une ligne terminale y est
--     ajoutée quand l'issue est connue, jamais modifiée ensuite.
--
-- `outreach_events` garde son rôle inchangé : la preuve qu'un humain a été
-- contacté. Une seule ligne y est écrite, et seulement sur un succès provider
-- incontestable.

-- ---------------------------------------------------------------------------
-- 1. Le registre des envois LIVE
-- ---------------------------------------------------------------------------
--
-- Les quatre statuts, et pourquoi ils ne se confondent pas :
--
--   CLAIMED   — le droit d'envoyer est réservé, le réseau n'a pas encore
--               répondu. `network_attempted` passe à true juste AVANT l'appel
--               (et non après) : un processus tué pendant la requête laisse
--               donc une ligne CLAIMED + network_attempted, c'est-à-dire
--               exactement « on ne sait pas », qui est la vérité.
--   SENT      — le provider a répondu avec un identifiant de message. Le seul
--               statut qui autorise un `outreach_event`.
--   AMBIGUOUS — le réseau a été touché et l'issue est inconnue (timeout,
--               5xx, réponse illisible, conflit d'idempotence). Terminal et
--               bloquant : aucun renvoi automatique n'est possible ensuite.
--   FAILED    — le provider a refusé la requête de manière documentée et
--               définitive (payload invalide, clé absente ou invalide, quota).
--               Aucun email n'a été créé ; un nouvel essai reste possible,
--               mais seulement après un nouvel armement humain complet.
--
-- Ce que la table ne porte pas : ni clé d'API, ni en-tête d'autorisation, ni
-- corps de réponse brut du provider. `detail` est un message court destiné à
-- un humain (CLAUDE.md §6 : aucun secret, nulle part).
create table r6b_live_send_attempts (
  id                        uuid primary key default gen_random_uuid(),

  manifest_id               uuid not null references r6b_dispatch_manifests(id),

  -- Un seul provider est implémenté. En ajouter un demandera une migration —
  -- donc une revue — plutôt qu'une valeur libre glissée par un appelant.
  provider                  text not null check (provider in ('resend')),

  -- Dérivée déterministement du manifeste (voir `deriveIdempotencyKey`), donc
  -- identique d'un essai à l'autre : même si une garde applicative tombait,
  -- le provider refuserait de créer un second email dans sa fenêtre de 24 h.
  -- Stockée pour qu'une réconciliation humaine puisse la retrouver telle
  -- qu'elle a été envoyée, pas la recalculer et espérer.
  idempotency_key           text not null check (length(idempotency_key) between 1 and 256),

  -- Recopiés du manifeste au moment de la réservation. Ils ne servent pas à
  -- envoyer (l'envoi lit l'enveloppe, jamais cette table) : ils servent à
  -- prouver, plus tard, ce qui a été envoyé si la question se pose.
  transport                 text not null check (transport in ('email')),
  recipient                 text not null,
  approved_text_sha256      text not null check (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  transport_payload_sha256  text not null check (transport_payload_sha256 ~ '^[0-9a-f]{64}$'),

  status                    text not null check (status in ('CLAIMED', 'SENT', 'AMBIGUOUS', 'FAILED')),

  network_attempted         boolean not null default false,

  -- Le reçu provider. Nul tant que le provider n'a pas répondu un identifiant.
  provider_message_id       text,

  -- Classification de l'issue (`code` du provider ou catégorie locale), et un
  -- message court. Jamais la réponse brute.
  failure_code              text,
  detail                    text,

  claimed_at                timestamptz not null default now(),
  network_started_at        timestamptz,
  completed_at              timestamptz,

  -- Une réservation n'a rien reçu : ni identifiant, ni issue.
  constraint r6b_live_send_claimed_is_open check (
    status <> 'CLAIMED' or (provider_message_id is null and completed_at is null and failure_code is null)
  ),

  -- Un succès porte son reçu. Sans identifiant de message, « envoyé » ne
  -- serait qu'une affirmation.
  constraint r6b_live_send_sent_has_receipt check (
    status <> 'SENT'
    or (network_attempted = true and provider_message_id is not null
        and completed_at is not null and failure_code is null)
  ),

  -- Une issue inconnue n'existe qu'après avoir touché le réseau : avant, le
  -- refus est total et sans ambiguïté.
  constraint r6b_live_send_ambiguous_touched_network check (
    status <> 'AMBIGUOUS' or (network_attempted = true and completed_at is not null and failure_code is not null)
  ),

  -- Un échec définitif dit lequel, et n'a par définition aucun identifiant de
  -- message : si le provider en avait donné un, l'email existerait.
  constraint r6b_live_send_failed_is_definitive check (
    status <> 'FAILED'
    or (network_attempted = true and provider_message_id is null
        and failure_code is not null and completed_at is not null)
  ),

  -- L'horodatage réseau et le drapeau disent le même fait.
  constraint r6b_live_send_network_timestamp_pair check (
    (network_started_at is null) = (network_attempted = false)
  )
);

-- La garde de concurrence, et la seule qui tienne quand le code applicatif se
-- trompe : au plus UNE tentative non définitivement échouée par manifeste.
--
-- Conséquences, toutes voulues :
--   * deux processus qui réservent en même temps → un seul obtient la ligne,
--     l'autre est refusé AVANT tout appel réseau (violation d'unicité) ;
--   * un manifeste déjà SENT ne peut plus jamais être réservé — protection
--     locale, indépendante de la fenêtre d'idempotence de 24 h du provider ;
--   * un manifeste AMBIGUOUS reste bloqué jusqu'à ce qu'un humain tranche :
--     c'est exactement ce qu'on veut d'un « on ne sait pas si c'est parti ».
-- Seul un FAILED — refus documenté, aucun email créé — libère la place.
create unique index r6b_live_send_attempts_one_open_per_manifest_idx
  on r6b_live_send_attempts (manifest_id)
  where status <> 'FAILED';

create index r6b_live_send_attempts_manifest_idx on r6b_live_send_attempts (manifest_id, claimed_at desc);

-- ---------------------------------------------------------------------------
-- 2. Le journal apprend à décrire une issue LIVE
-- ---------------------------------------------------------------------------
--
-- 0021 n'admettait que trois statuts, faute d'envoi possible à l'époque. Les
-- deux nouveaux ne sont pas des variantes d'échec : ils disent si le réseau a
-- été touché, ce qui est la seule question qui compte après coup.
alter table r6b_dispatch_attempts drop constraint r6b_dispatch_attempts_status_check;
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempts_status_check
  check (status in ('DRY_RUN_OK', 'BLOCKED', 'SENT', 'AMBIGUOUS', 'FAILED'));

alter table r6b_dispatch_attempts
  add column provider            text check (provider is null or provider in ('resend')),
  add column provider_message_id text,
  add column live_attempt_id     uuid references r6b_live_send_attempts(id);

-- « BLOCKED » veut dire refusé avant le réseau, et rien d'autre. Sans cette
-- contrainte, un refus survenu après un appel pourrait se journaliser comme un
-- refus préventif — et le compteur « aucun réseau touché » mentirait.
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_blocked_is_pre_network
  check (status <> 'BLOCKED' or network_attempted = false);

-- Les deux issues LIVE n'existent qu'en LIVE, rattachées à un manifeste, après
-- un appel réseau réel, et disent pourquoi.
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_live_outcome_is_live
  check (
    status not in ('AMBIGUOUS', 'FAILED')
    or (mode = 'LIVE' and manifest_id is not null and network_attempted = true
        and error_code is not null and live_attempt_id is not null)
  );

-- Un succès porte son reçu provider, dans le journal aussi : les deux tables
-- doivent pouvoir être confrontées sans dépendre l'une de l'autre.
alter table r6b_dispatch_attempts add constraint r6b_dispatch_attempt_sent_has_receipt
  check (
    status <> 'SENT'
    or (provider is not null and provider_message_id is not null and live_attempt_id is not null
        and transport is not null and recipient is not null and approved_text_sha256 is not null
        and transport_payload_sha256 is not null)
  );

-- ---------------------------------------------------------------------------
-- 3. « exactement 1 outreach_event » cesse d'être une intention
-- ---------------------------------------------------------------------------
--
-- Le contrat de la mission est « 1 succès provider incontestable → exactement
-- un outreach_event lié au manifeste ». Le code l'écrit dans la transaction
-- terminale ; cet index le garantit même si un jour un autre chemin y écrit.
create unique index outreach_events_one_sent_per_manifest_idx
  on outreach_events (manifest_id)
  where manifest_id is not null and kind = 'sent';

-- ---------------------------------------------------------------------------
-- 4. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'inscrit aucun manifeste comme « armé ». Quel manifeste unique peut
-- être envoyé en LIVE est une constante du code (`R6B_LIVE_ARMED_MANIFEST_ID`),
-- lue et vérifiée par la triple garde, pas une donnée modifiable en base :
-- une garde qu'un UPDATE peut déplacer n'est pas une garde.
--
-- Elle ne crée aucune ligne, dans aucune table. Après elle comme avant elle :
-- 0 envoi, 0 outreach_event, 0 tentative LIVE.
