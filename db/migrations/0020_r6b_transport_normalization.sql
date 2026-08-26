-- 0020_r6b_transport_normalization.sql — R6B-B.1, transport normalization
-- (mission « Hermes R6B-B.1 — Transport Normalization »).
--
-- R6B-B a prouvé le mécanisme de manifeste avec deux canaux génériques
-- (`site`, `téléphone`) trop ambigus pour qu'un futur sender sache quoi
-- faire : un `site` peut être un formulaire, un simple point de contact, ou
-- rien d'exploitable ; un `téléphone` peut être un appel, un SMS ou un
-- WhatsApp, trois actions différentes qu'un numéro seul ne prouve pas. Cette
-- migration ajoute un transport explicite (§2 de la mission — email,
-- instagram_dm, facebook_dm, web_form, sms, whatsapp, phone_call) sans
-- perdre l'historique : les anciennes lignes gardent `channel`, les
-- nouvelles portent `transport` + la preuve exacte qui l'a vérifié.
--
-- §3/§4 de la mission : jamais d'inférence. Un numéro de téléphone observé ne
-- prouve, par construction, qu'un appel (`phone_call`) — un SMS ou un
-- WhatsApp exigent chacun une preuve distincte (voir
-- `resolveTransportOptions` dans r6bDispatch.ts, qui n'accepte que des liens
-- WhatsApp réellement observés, jamais le numéro seul). De même un site
-- observé ne prouve `web_form` que si un formulaire de contact a réellement
-- été lu par le crawler (`funnel_observed` contient un jeton `form_contact`),
-- jamais parce qu'un site existe.

-- ---------------------------------------------------------------------------
-- 1. `channel` devient un champ historique, plus une exigence pour un nouveau
--    lock : les manifestes créés à partir de cette migration portent
--    `transport` à la place, jamais les deux à la fois.
-- ---------------------------------------------------------------------------
alter table r6b_dispatch_manifests alter column channel drop not null;

-- ---------------------------------------------------------------------------
-- 2. Taxonomie de transport explicite (§2) + lien vers la preuve exacte qui
--    l'a vérifié (§11 : `recipient_evidence_ids`). `recipient_provenance`
--    (0019) reste la copie figée lisible par un humain ; ceci est la
--    référence exploitable par du code (jointure vers `prospect_evidence`).
-- ---------------------------------------------------------------------------
alter table r6b_dispatch_manifests
  add column transport text
    check (transport in ('email', 'instagram_dm', 'facebook_dm', 'web_form', 'sms', 'whatsapp', 'phone_call'));

alter table r6b_dispatch_manifests
  add column recipient_evidence_ids jsonb not null default '[]'::jsonb;

-- §12 : une invalidation (relock, ou — comme ci-dessous — une normalisation
-- de taxonomie) doit porter une raison explicite, jamais une modification
-- silencieuse. Un relock normal continue de ne renseigner que
-- `superseded_by` (la nouvelle ligne parle d'elle-même) ; ce champ sert aux
-- supersedes qui n'ont, par construction, aucun remplaçant immédiat — un opérateur
-- reverrouillera lui-même plus tard (§9 : ne pas choisir à sa place).
alter table r6b_dispatch_manifests
  add column superseded_reason text;

-- ---------------------------------------------------------------------------
-- 3. Assouplir la contrainte de supersede (0019) : elle exigeait jusqu'ici
--    `superseded_by` non nul dans tous les cas, ce qui suppose qu'un
--    remplaçant existe toujours immédiatement. Ce n'est plus vrai pour une
--    normalisation de taxonomie (§7) : l'ancien lock est invalidé, aucun
--    nouveau lock n'est créé à sa place tant que un opérateur n'a pas choisi.
-- ---------------------------------------------------------------------------
alter table r6b_dispatch_manifests drop constraint r6b_manifest_superseded_fields;
alter table r6b_dispatch_manifests add constraint r6b_manifest_superseded_fields check (
  (status = 'LOCKED' and superseded_by is null and superseded_at is null and superseded_reason is null)
  or (status = 'SUPERSEDED' and superseded_at is not null
      and (superseded_by is not null or superseded_reason is not null))
);

-- ---------------------------------------------------------------------------
-- 4. Supersede des deux locks de démonstration R6B-B (§7) : DEMO PROSPECT A →
--    `site`, VTC LYONNAIS → `téléphone`. Ciblés explicitement par batch +
--    nom d'entreprise plutôt que par id figé, pour que la migration reste
--    lisible et vérifiable en revue. Append-only : UPDATE de statut
--    uniquement, aucune ligne supprimée, aucun texte/canal/destinataire
--    touché sur la ligne existante.
-- ---------------------------------------------------------------------------
update r6b_dispatch_manifests m
   set status = 'SUPERSEDED',
       superseded_at = now(),
       superseded_reason = 'transport_taxonomy_normalization'
  from r6b_batch_items bi
  join r6b_batches b on b.id = bi.batch_id
  join prospects p on p.id = bi.prospect_id
 where m.batch_item_id = bi.id
   and b.slug = 'r6b-assisted-pilot-001'
   and m.status = 'LOCKED'
   and p.display_name in ('DEMO PROSPECT A', 'VTC LYONNAIS 69800');

-- ---------------------------------------------------------------------------
-- 5. À partir de maintenant, un manifeste LOCKED doit porter un transport
--    résolu et au moins une preuve de destinataire — jamais un canal générique
--    deviné. Validée immédiatement : après l'étape 4, aucune ligne LOCKED ne
--    subsiste (les deux seules qui existaient viennent d'être supersedées).
-- ---------------------------------------------------------------------------
alter table r6b_dispatch_manifests add constraint r6b_manifest_locked_has_transport check (
  status <> 'LOCKED' or (transport is not null and jsonb_array_length(recipient_evidence_ids) > 0)
);
