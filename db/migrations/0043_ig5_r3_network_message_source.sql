-- 0043_ig5_r3_network_message_source.sql — IG5 R3, « NETWORK BUBBLE READER »
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration corrige, et ce qu'elle refuse d'élargir
-- ---------------------------------------------------------------------------
--
-- IG5.1 a écrit un journal d'observation qui ne savait décrire qu'UNE façon de
-- lire un message : la bulle du DOM. Sa colonne `direction_basis` n'accepte que
-- `geometry`, `accessible`, `both` et `none` — c'est-à-dire quatre manières de
-- DÉDUIRE qui parle d'un indice de mise en page.
--
-- R3 en apporte une cinquième, qui ne déduit rien : la réponse
-- `IGDThreadDetailQuery` NOMME l'expéditeur de chaque message
-- (`sender.user_dict.username`). Écrire `accessible` pour cela aurait été
-- commode et faux — aucun libellé accessible n'a été lu. La colonne gagne donc
-- la valeur qui dit la vérité, plutôt qu'une valeur existante détournée.
--
-- Ce qu'elle N'ÉLARGIT PAS, délibérément : les contraintes de canal de
-- `r6b_inbound_messages` (0042). Un message Instagram reste écrit avec
-- `message_identity_kind = 'observed_fingerprint'` et un `provider_message_id`
-- de 64 caractères hexadécimaux, alors même que R3 tient enfin un identifiant
-- natif (`mid.…`, 34 caractères). Deux raisons :
--
--   1. ce qui est écrit dans cette colonne reste une valeur que NOUS calculons
--      (un condensé déterministe de l'identifiant natif), et 0042 existe
--      exactement pour empêcher une valeur calculée de se faire passer pour une
--      valeur émise ;
--   2. relâcher la contrainte pour un canal l'aurait relâchée pour tous, sans
--      qu'aucun besoin ne l'exige : « même message Instagram ⇒ même identité
--      logique » est atteint par le condensé, sans toucher au contrat.
--
-- L'identifiant natif n'est pas perdu pour autant : il est consigné tel quel
-- dans le JOURNAL D'OBSERVATION ci-dessous, où il ne prétend à rien et où il
-- permet de prouver l'idempotence d'un relevé à l'autre.
--
-- ---------------------------------------------------------------------------
-- Ce qu'elle n'ouvre pas
-- ---------------------------------------------------------------------------
--
-- Aucune capacité d'envoi, aucune permission réseau, aucune table de la file
-- sortante Instagram (`ig_dispatch_jobs`, `ig_job_events`,
-- `ig_canary_authorizations`, `ig_kill_switch`) n'est lue ni altérée ici.
-- `r6b_reply_drafts` reste plafonnée à `PROPOSED`.

-- ---------------------------------------------------------------------------
-- 1. ig_inbound_message_observations — nommer la source, et l'identifiant natif
-- ---------------------------------------------------------------------------

-- D'OÙ le message a été lu. Le défaut vaut `dom_bubble` : les lignes déjà
-- écrites viennent toutes de là, et la colonne dit d'elles quelque chose de
-- vrai sans qu'on ait à les relire.
alter table ig_inbound_message_observations
  add column source text not null default 'dom_bubble'
    check (source in ('dom_bubble', 'thread_detail_network'));

-- L'identifiant qu'Instagram a RÉELLEMENT émis pour ce message, quand la source
-- en donne un. Consigné ici, et nulle part ailleurs : le journal d'observation
-- est le seul endroit du schéma où une valeur du fournisseur peut vivre sans
-- prétendre être notre clé de déduplication.
--
-- L'alphabet est celui observé (« mid.… », base64 URL-safe), et la borne est
-- large : la forme d'un identifiant tiers n'est pas un contrat qu'on peut
-- resserrer sans risquer de refuser un message réel un jour.
alter table ig_inbound_message_observations
  add column provider_message_id text
    check (provider_message_id is null
           or provider_message_id ~ '^[A-Za-z0-9._:=+/-]{8,120}$');

-- L'instant RÉEL du message, quand la source le donne. Distinct de
-- `observed_at`, qui est l'instant où NOUS avons regardé : le premier est un
-- fait chez Instagram, le second un fait chez nous. Les confondre, c'est ce que
-- l'âge relatif du DOM obligeait à faire.
alter table ig_inbound_message_observations
  add column message_sent_at timestamptz;

-- Une source réseau nomme son message ; une bulle du DOM n'en a aucun. Dans les
-- DEUX SENS, pour qu'une ligne DOM ne puisse pas se prétendre porteuse d'un
-- identifiant natif qu'elle n'a pas lu.
alter table ig_inbound_message_observations
  add constraint ig_inbound_msg_obs_native_id_matches_source check (
    (source = 'thread_detail_network') = (provider_message_id is not null)
  );

-- Idem pour l'horodatage : la réponse de détail en porte un, le DOM n'affiche
-- qu'un âge relatif et arrondi qui n'en est pas un.
alter table ig_inbound_message_observations
  add constraint ig_inbound_msg_obs_sent_at_matches_source check (
    (source = 'thread_detail_network') = (message_sent_at is not null)
  );

-- La base de direction et la source vont ensemble, dans les deux sens : lire
-- l'expéditeur n'est possible QUE sur la réponse réseau, et la réponse réseau
-- ne se sert de rien d'autre. Une ligne réseau qui prétendrait à `geometry`
-- décrirait une mesure qui n'a pas eu lieu.
alter table ig_inbound_message_observations
  drop constraint ig_inbound_msg_obs_direction_basis_coherent;

-- La liste fermée s'ouvre d'exactement une valeur, et reste une liste fermée :
-- une sixième manière de savoir qui parle demandera une migration, donc une
-- revue, plutôt qu'une chaîne libre glissée par un appelant.
alter table ig_inbound_message_observations
  drop constraint ig_inbound_message_observations_direction_basis_check;

alter table ig_inbound_message_observations
  add constraint ig_inbound_message_observations_direction_basis_check
    check (direction_basis in ('geometry', 'accessible', 'both', 'none', 'sender_identity'));

-- L'ÉQUIVALENCE d'origine — `UNKNOWN` si et seulement si `none` — est
-- remplacée par une IMPLICATION, et c'est un vrai changement de modèle plutôt
-- qu'un assouplissement de confort.
--
-- Elle était juste tant que la seule façon d'échouer à trancher la direction
-- était de n'avoir aucun indice : ni bord franc, ni libellé. `UNKNOWN` voulait
-- alors dire « je n'ai rien pour décider », donc `none`.
--
-- La réponse de détail crée un troisième cas, que le relevé du 20 août rend
-- concret : l'expéditeur EST nommé, et ce n'est ni nous ni la contrepartie
-- attendue — un fil de groupe, un compte renommé, un tiers. La direction reste
-- `UNKNOWN`, mais elle a été établie sur une identité LUE. Écrire `none` là
-- reviendrait à dire « aucun indice » alors qu'on en a eu un, décisif, et qu'il
-- dit précisément que ce message n'est attribuable à personne.
--
-- Ce qui reste vrai dans les deux sens : sans base (`none`), aucune direction
-- ne peut être affirmée.
alter table ig_inbound_message_observations
  add constraint ig_inbound_msg_obs_direction_basis_coherent check (
    (direction_basis <> 'none' or direction = 'UNKNOWN')
    and (source = 'thread_detail_network') = (direction_basis = 'sender_identity')
  );

-- Deux refus que le DOM ne savait pas prononcer, parce qu'il ne savait pas voir
-- ce qu'ils décrivent.
--
--   `SKIPPED_PRE_OUTREACH` — un message de la contrepartie ANTÉRIEUR à notre
--   DM. Le fil d'un prospect peut contenir une conversation vieille de deux
--   ans ; la ranger parmi les réponses à un message envoyé la semaine dernière
--   serait une invention, et déclencherait alerte, brouillon et arrêt de
--   séquence pour un échange sans rapport. Consigné, jamais ingéré.
--
--   `SKIPPED_NON_TEXT` — une photo, une note vocale, un partage. Le message
--   EXISTE (donc le fil n'est pas « sans réponse »), mais il n'a pas de corps à
--   écrire. Fabriquer un texte vide serait pire que de le compter comme ce
--   qu'il est.
alter table ig_inbound_message_observations
  drop constraint ig_inbound_message_observations_outcome_check;

alter table ig_inbound_message_observations
  add constraint ig_inbound_message_observations_outcome_check
  check (outcome in (
    'INGESTED',
    'ALREADY_KNOWN',
    'SKIPPED_OUTGOING',
    'SKIPPED_UNKNOWN_DIRECTION',
    'SKIPPED_UNIDENTIFIED_SENDER',
    'SKIPPED_PRE_OUTREACH',
    'SKIPPED_NON_TEXT'
  ));

-- Retrouver un message par son identifiant natif, d'un relevé à l'autre : c'est
-- la preuve d'idempotence de §14, et elle doit se lire sans parcourir la table.
create index ig_inbound_msg_obs_provider_id_idx
  on ig_inbound_message_observations (provider_message_id)
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 2. ig_inbound_thread_observations — « pas de réponse » n'est pas « je ne sais pas »
-- ---------------------------------------------------------------------------

-- D'où venaient les messages de CE fil, lors de CE tour. Rendue plutôt que
-- déduite, pour la même raison que `threadIdSource` en R2 : une bascule
-- silencieuse du réseau vers le DOM (ou l'inverse) doit se voir dans un
-- rapport, pas s'expliquer six semaines plus tard.
alter table ig_inbound_thread_observations
  add column message_source text
    check (message_source is null or message_source in ('dom_bubble', 'thread_detail_network'));

-- LA colonne de §8, et la raison d'être de cette moitié de migration.
--
-- Jusqu'ici, un fil sans réponse et un fil illisible se ressemblaient : zéro
-- ligne dans les réponses, dans les deux cas. C'est exactement la confusion qui
-- a coûté un faux verdict au canari du 14 août — « je n'ai pas su lire » rendu
-- comme « il n'y avait rien ». Quatre valeurs, parce qu'il y a quatre faits :
--
--   REPLY_OBSERVED     la contrepartie a écrit APRÈS notre DM. Lu, pas supposé.
--   NO_REPLY_OBSERVED  les messages du fil ont été LUS, notre DM y est, et rien
--                      de la contrepartie ne le suit. C'est une absence
--                      CONSTATÉE, et elle n'est prononçable qu'après lecture.
--   THREAD_UNREADABLE  le fil n'a pas pu être lu. Aucune absence n'en découle.
--   UNKNOWN            le fil a été lu mais aucun envoi connu ne s'y rattache :
--                      sans DM de référence, « pas de réponse à notre DM » n'a
--                      pas de sens. On ne le dit donc pas.
alter table ig_inbound_thread_observations
  add column reply_status text
    check (reply_status is null or reply_status in (
      'REPLY_OBSERVED', 'NO_REPLY_OBSERVED', 'THREAD_UNREADABLE', 'UNKNOWN'));

-- Un fil non lu ne peut prétendre ni à une source de messages, ni à autre chose
-- que `THREAD_UNREADABLE` / `UNKNOWN` : la certitude d'une absence se paie par
-- une lecture, et la contrainte le rend structurel plutôt que conventionnel.
alter table ig_inbound_thread_observations
  add constraint ig_inbound_thread_obs_reply_status_needs_read check (
    outcome = 'READ'
    or (message_source is null and (reply_status is null or reply_status in ('THREAD_UNREADABLE', 'UNKNOWN')))
  );
