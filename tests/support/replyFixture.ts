/**
 * Fixtures de réponse corrélée, partagées par les tests R6B-D2 et D2.1.
 *
 * Un seul endroit décrit à quoi ressemble « un prospect contacté dont une
 * réponse est arrivée ». Deux copies auraient fini par diverger, et les tests
 * auraient alors validé deux formes de données dont une seule existe.
 *
 * Le manifeste est construit par le VRAI chemin humain — vote, verrouillage,
 * complétion de l'objet — plutôt que par des `insert` directs : c'est ce qui
 * garantit que le traitement lit la forme réelle des données.
 *
 * Aucune entreprise, adresse ou texte réel n'apparaît ici.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '@/lib/db/sql';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { completeEmailSubject } from '@/lib/pipeline/r6bManifestCompletion';
import { hashTransportPayload } from '@/lib/pipeline/r6bTransportPayload';
import { makeProspectInstagramEligible } from './instagramEligibility';

export interface ContactedProspect {
  readonly manifest: DispatchManifest;
  readonly outreachEventId: string;
  readonly prospectId: string;
}

export interface ContactedProspectOptions {
  readonly withResearch?: boolean;
  readonly displayName?: string;
  readonly phone?: string | null;
  /**
   * Le transport du premier message. `email` par défaut, pour que les fixtures
   * écrites avant CONVERSATION-R1.1 décrivent exactement la même donnée.
   *
   * En `instagram_dm`, `recipient` est un handle et non une adresse : c'est ce
   * que le manifeste porte réellement, et le contexte de réponse en dépend
   * (canal de rédaction, type d'identifiant d'exclusion).
   */
  readonly transport?: 'email' | 'instagram_dm';
}

export interface InboundSpec {
  readonly manifest: DispatchManifest;
  /** Un DM n'a pas d'objet. `undefined` garde celui des fixtures e-mail. */
  readonly subject?: string | null;
  readonly outreachEventId: string;
  readonly prospectId: string;
  readonly body: string;
  readonly from?: string;
  readonly correlationStatus?: 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED' | 'UNMATCHED';
  readonly automationSignals?: readonly string[];
  /**
   * L'heure de réception, quand un test a besoin de plusieurs tours ORDONNÉS.
   *
   * Par défaut la valeur historique, pour que les tests écrits avant cette
   * option continuent de décrire exactement la même donnée.
   */
  readonly receivedAt?: string;
}

/**
 * HERMES-REPLY-DELIVERY-R1 §3 — un message entrant INSTAGRAM, avec son fil.
 *
 * Distinct d'`InboundSpec` parce que la donnée est réellement différente : un
 * DM n'a pas d'objet, son identifiant de message est une empreinte que NOUS
 * calculons, son expéditeur est un handle, et il porte un `provider_thread_id`
 * qu'aucun message e-mail n'a. Les fondre dans une seule fixture aurait produit
 * des lignes que la base accepte mais que le rail entrant n'écrit jamais.
 */
export interface InstagramInboundSpec {
  readonly manifest: DispatchManifest;
  readonly outreachEventId: string;
  readonly prospectId: string;
  readonly body: string;
  /** L'identifiant qu'Instagram a donné au fil. Chiffres seulement (0042). */
  readonly threadId: string;
  /** NOTRE compte, celui qui a reçu le message. */
  readonly accountHandle: string;
  /** Le handle de l'expéditeur. Par défaut, le destinataire du manifeste. */
  readonly from?: string;
  readonly receivedAt?: string;
  readonly correlationStatus?: 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED' | 'UNMATCHED';
}

export interface ReplyFixtures {
  contactedProspect(recipient: string, options?: ContactedProspectOptions): Promise<ContactedProspect>;
  inbound(spec: InboundSpec): Promise<string>;
  instagramInbound(spec: InstagramInboundSpec): Promise<string>;
}

export interface ReplyFixtureConfig {
  readonly campaignId: string;
  readonly mailbox: string;
  readonly firstTouch: string;
}

export function makeReplyFixtures(sql: Sql, config: ReplyFixtureConfig): ReplyFixtures {
  async function contactedProspect(
    recipient: string,
    options: ContactedProspectOptions = {},
  ): Promise<ContactedProspect> {
    const transport = options.transport ?? 'email';
    const isInstagram = transport === 'instagram_dm';
    // R7-PILOT §1 — le site est DÉRIVÉ du destinataire, il n'est plus une
    // constante. Tant que la déduplication était scopée par campagne, écrire
    // « https://acme-test.fr » sur chaque fixture était sans conséquence.
    // Depuis que le domaine lie deux lignes en un même commerce, une constante
    // ferait de tous ces prospects LA MÊME entreprise — et le second envoi de
    // chaque scénario serait refusé comme un double contact, à juste titre.
    // Ces fixtures modélisent des entreprises distinctes ; elles doivent donc
    // en porter les identités distinctes.
    const site = `https://${recipient.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.acme-test.fr`;
    const prospect = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, city, email, instagram_handle, phone, website_url, score, score_band)
       values ($1,$2,$3,'Lyon',$4,$5,$6,$7,74,'A') returning id`,
      [
        config.campaignId,
        `prospect-${randomUUID()}`,
        options.displayName ?? 'ACME ATELIER',
        isInstagram ? null : recipient,
        isInstagram ? recipient : null,
        options.phone ?? null,
        site,
      ],
    );
    const prospectId = prospect[0]!.id;

    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,$2,$3,'website','crawl',$4,1.0)`,
      [prospectId, isInstagram ? 'instagram_handle' : 'email', recipient, site],
    );

    if (options.withResearch !== false) {
      await sql.query(
        `insert into prospect_research (prospect_id, summary, observations, opportunities, unknowns, confidence)
         values ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,0.8)`,
        [
          prospectId,
          'Prestation standard intérieur à domicile, deux formules affichées.',
          JSON.stringify([
            { text: 'Deux formules affichées à 50 € et 80 €', evidenceIds: [], sourceUrl: null, provider: 'website' },
            { text: 'Intervention à domicile sur Lyon', evidenceIds: [], sourceUrl: null, provider: 'website' },
          ]),
          JSON.stringify(['Aucune page de réservation en ligne observée']),
          JSON.stringify(['budget publicitaire non observé']),
        ],
      );
      await sql.query(
        `insert into prospect_angles (prospect_id, pain_point, opportunity, approach, personalization, confidence)
         values ($1,'Acquisition dépendante du bouche-à-oreille','Formaliser un canal entrant',
                 'Partir de leurs formules affichées','Vos deux formules affichées à 50 € et 80 €',0.7)`,
        [prospectId],
      );
    }

    const batch = await sql.query<{ id: string }>(
      `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
      [`batch-${randomUUID()}`, config.campaignId],
    );
    const item = await sql.query<{ id: string }>(
      `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
       values ($1,$2,1,'brouillon',$3) returning id`,
      [batch[0]!.id, prospectId, JSON.stringify([isInstagram ? 'instagram' : 'email'])],
    );
    const itemId = item[0]!.id;

    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: config.firstTouch, note: null });

    // Un DM n'a ni objet ni complétion : le manifeste est verrouillé et prêt.
    // Le prospect doit en revanche franchir les portes d'éligibilité Instagram,
    // qui sont réelles — les contourner ferait valider une forme de donnée qui
    // n'existe pas en production.
    if (isInstagram) {
      await makeProspectInstagramEligible(sql, prospectId, { sourceUrl: site });
      const manifest = await lockManifestForItem(sql, { itemId, transport: 'instagram_dm' });
      const event = await sql.query<{ id: string }>(
        `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id, occurred_at)
         values ($1,'sent','instagram','{}'::jsonb,$2,'2026-08-12T22:11:32.505Z') returning id`,
        [prospectId, manifest.id],
      );
      return { manifest, outreachEventId: event[0]!.id, prospectId };
    }

    const locked = await lockManifestForItem(sql, { itemId, transport: 'email' });
    const completed = await completeEmailSubject(sql, {
      manifestId: locked.id,
      expected: {
        batchItemId: locked.batchItemId,
        transport: 'email',
        recipient: locked.recipient,
        recipientEvidenceIds: locked.recipientEvidenceIds,
        approvedTextSha256: locked.approvedTextSha256,
        identityReview: locked.identityReview,
        transportPayloadSha256: locked.transportPayloadSha256,
      },
      subject: 'Petite question',
      previewedTransportPayloadSha256: hashTransportPayload({ subject: 'Petite question' }),
    });
    const manifest = completed.locked;

    const event = await sql.query<{ id: string }>(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id, occurred_at)
       values ($1,'sent','email','{}'::jsonb,$2,'2026-08-12T22:11:32.505Z') returning id`,
      [prospectId, manifest.id],
    );

    return { manifest, outreachEventId: event[0]!.id, prospectId };
  }

  /** Écrit un message entrant déjà corrélé, comme R6B-D1 le ferait. */
  async function inbound(spec: InboundSpec): Promise<string> {
    const status = spec.correlationStatus ?? 'EXACT';
    const correlated = status === 'EXACT' || status === 'HIGH_CONFIDENCE';
    const rows = await sql.query<{ id: string }>(
      `insert into r6b_inbound_messages
         (provider, mailbox, provider_message_id, received_at, from_address, to_addresses,
          subject, normalized_subject, body_text, body_sha256, body_source, automation_signals,
          correlation_status, correlation_method, correlated_manifest_id,
          correlated_outreach_event_id, correlated_prospect_id)
       values ('gmail',$1,$2,$13,$3,$4::jsonb,$14,$15,
               $5,$6,'text/plain',$7::jsonb,$8,$9,$10,$11,$12)
       returning id`,
      [
        config.mailbox,
        `msg-${randomUUID()}`,
        spec.from ?? spec.manifest.recipient,
        JSON.stringify([config.mailbox]),
        spec.body,
        createHash('sha256').update(spec.body, 'utf8').digest('hex'),
        JSON.stringify(spec.automationSignals ?? []),
        status,
        status === 'UNMATCHED' ? null : status === 'EXACT' ? 'rfc_in_reply_to' : 'sole_outbound_recipient',
        correlated ? spec.manifest.id : null,
        correlated ? spec.outreachEventId : null,
        correlated ? spec.prospectId : null,
        spec.receivedAt ?? '2026-08-13T09:00:00Z',
        spec.subject === undefined ? 'Re: Petite question' : spec.subject,
        // `normalized_subject` est NOT NULL et vaut la chaîne vide pour un
        // message sans objet — c'est ce que `instagramIntake` écrit, et la
        // contrainte `0042` l'impose au provider `instagram`.
        spec.subject === undefined ? 'petite question' : '',
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Écrit un DM entrant déjà corrélé, exactement comme `persistInstagramInboundMessage`
   * le ferait — mêmes valeurs figées, mêmes contraintes de 0042.
   *
   * Les quatre colonnes que la base contraint pour le provider `instagram` sont
   * écrites explicitement (`counterparty_kind`, `message_identity_kind`,
   * `body_source`, objet nul) : une fixture qui s'en dispenserait décrirait une
   * ligne que le rail réel ne produit pas, et les tests vaudraient pour une
   * forme de donnée qui n'existe nulle part.
   */
  async function instagramInbound(spec: InstagramInboundSpec): Promise<string> {
    const status = spec.correlationStatus ?? 'HIGH_CONFIDENCE';
    const correlated = status === 'EXACT' || status === 'HIGH_CONFIDENCE';
    const sender = (spec.from ?? spec.manifest.recipient).toLowerCase();
    const account = spec.accountHandle.toLowerCase();
    const rows = await sql.query<{ id: string }>(
      `insert into r6b_inbound_messages
         (provider, mailbox, provider_message_id, provider_thread_id,
          received_at, from_address, from_display,
          subject, normalized_subject,
          body_text, body_sha256, body_source, body_truncated,
          correlation_status, correlation_method, correlated_manifest_id,
          correlated_outreach_event_id, correlated_prospect_id,
          counterparty_kind, message_identity_kind)
       values ('instagram',$1,$2,$3,
               $4,$5,null,
               null,'',
               $6,$7,'instagram_dm_text',false,
               $8,$9,$10,$11,$12,
               'instagram_handle','observed_fingerprint')
       returning id`,
      [
        account,
        createHash('sha256').update(`${account}|${spec.threadId}|${sender}|${spec.body}`, 'utf8').digest('hex'),
        spec.threadId,
        spec.receivedAt ?? '2026-08-21T13:00:00.000Z',
        sender,
        spec.body,
        createHash('sha256').update(spec.body, 'utf8').digest('hex'),
        status,
        status === 'UNMATCHED' ? null : 'observed_thread_binding',
        correlated ? spec.manifest.id : null,
        correlated ? spec.outreachEventId : null,
        correlated ? spec.prospectId : null,
      ],
    );
    return rows[0]!.id;
  }

  return { contactedProspect, inbound, instagramInbound };
}
