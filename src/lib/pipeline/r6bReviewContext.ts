import type { Sql } from '@/lib/db/sql';
import { loadDispatchContext, resolveTransportOptions, type Transport } from '@/lib/pipeline/r6bDispatch';
import { loadConfiguredIcpProfile } from '@/lib/config/load';
import { loadIcpInputs } from '@/lib/pipeline/icpAssessment';
import { evaluateIcpEligibility } from '@/lib/pipeline/icpEligibility';
import { loadEffectiveChannelIdentityDecision } from '@/lib/pipeline/channelIdentity';
import {
  contactsOnChannel,
  contactsOnOtherChannels,
  describeLink,
  loadBusinessContactHistory,
  type BusinessContactHistory,
  type ContactRecord,
  type IdentityGroupMember,
} from '@/lib/pipeline/businessContactGuard';

/**
 * R7-PILOT §7 — ce qu'un humain doit avoir sous les yeux AVANT de voter SEND.
 *
 * L'écran `/pilot/r6b` montrait le nom, la ville, les canaux observés, le hook
 * et le texte. Il manquait trois choses, et leur absence n'était pas cosmétique :
 *
 *   1. **le destinataire réel.** « canaux observés : Instagram » ne dit pas
 *      VERS QUEL COMPTE le message partirait. Approuver un texte sans voir le
 *      handle, c'est approuver la moitié de la décision ;
 *   2. **l'historique du COMMERCE.** La carte affichait « jamais contacté
 *      (outreach_events vide) » pour une ligne fraîche appartenant à un
 *      commerce déjà joint sous un autre identifiant — vrai de la ligne, faux
 *      du commerce ;
 *   3. **ce qui bloquerait encore.** Voter SEND sur un candidat dont l'identité
 *      de canal n'est pas confirmée, c'est découvrir le refus deux étapes plus
 *      loin, quand il aura l'air d'un bug.
 *
 * Ce module ne DÉCIDE rien. Il lit, recoupe, et rend une photographie. Aucune
 * de ses fonctions n'écrit une ligne, et aucune ne produit un vote.
 */

export interface ReviewFact {
  readonly evidenceId: string;
  readonly field: string;
  readonly valueText: string | null;
  readonly provider: string;
  readonly method: string;
  readonly sourceUrl: string | null;
  readonly observedAt: string;
}

/** Un empêchement, et à qui il appartient de le lever. */
export type BlockerOwner =
  /** Seul un humain peut le lever, par une décision nommée. */
  | 'human'
  /** Un état de données ou de pipeline : il se répare sans arbitrage. */
  | 'technical';

export interface ReviewBlocker {
  readonly gate: string;
  readonly owner: BlockerOwner;
  readonly detail: string;
  /** La commande ou l'écran exact qui lève cet empêchement, quand il y en a un. */
  readonly remedy: string | null;
}

export interface ReviewDuplicateCheck {
  readonly verdict: BusinessContactHistory['verdict'];
  readonly duplicateIdentity: boolean;
  readonly siblings: readonly IdentityGroupMember[];
  readonly sameChannelContacts: readonly ContactRecord[];
  readonly otherChannelContacts: readonly ContactRecord[];
  readonly suppressions: BusinessContactHistory['suppressions'];
}

export interface ReviewCandidateContext {
  readonly itemId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly transport: Transport;
  /** Le destinataire exact qu'un futur envoi viserait, ou `null` si aucun n'est prouvé. */
  readonly recipient: string | null;
  readonly recipientReason: string;
  readonly facts: readonly ReviewFact[];
  readonly duplicate: ReviewDuplicateCheck;
  readonly blockers: readonly ReviewBlocker[];
  /** Aucun empêchement connu autre que le vote humain lui-même. */
  readonly clear: boolean;
}

/**
 * Tout ce qui pèse sur un candidat, calculé à l'instant de l'affichage.
 *
 * Rien n'est lu dans un cache ni dans une colonne dérivée : l'ICP est
 * RECALCULÉ sur les preuves courantes, le groupe d'identité est relu, le
 * transport est re-résolu. Un écran de review qui afficherait un état figé
 * mentirait le jour où l'état a changé sans que personne ne rafraîchisse.
 */
export async function loadReviewCandidateContext(
  sql: Sql,
  itemId: string,
  transport: Transport = 'instagram_dm',
): Promise<ReviewCandidateContext | null> {
  const context = await loadDispatchContext(sql, itemId);
  if (!context) return null;

  const prospectId = context.prospect.id;
  const blockers: ReviewBlocker[] = [];

  // ---- Le destinataire, tel qu'il serait résolu au lock ---------------------
  const options = resolveTransportOptions(context.observedChannels, context.prospect, context.evidence);
  const option = options.find((entry) => entry.transport === transport) ?? null;
  const recipient = option?.status === 'verified' ? option.recipient : null;
  if (option === null) {
    blockers.push({
      gate: 'transport',
      owner: 'technical',
      detail: `le canal de base de « ${transport} » n'a pas été observé à la génération de ce batch`,
      remedy: null,
    });
  } else if (option.status !== 'verified') {
    blockers.push({ gate: 'transport', owner: 'technical', detail: option.reason, remedy: null });
  }

  // ---- Les faits qui fondent l'accroche ------------------------------------
  const facts = await loadFacts(sql, context.hookEvidenceIds);

  // ---- Doublon et historique, à l'échelle du commerce ----------------------
  const history = await loadBusinessContactHistory(sql, prospectId);
  const sameChannelContacts = contactsOnChannel(history, transport);
  const otherChannelContacts = contactsOnOtherChannels(history, transport);

  for (const suppression of history.suppressions) {
    blockers.push({
      gate: 'opt_out',
      owner: 'human',
      detail:
        `« ${suppression.value} » (${suppression.matchKind}) figure dans do_not_contact : ${suppression.reason}` +
        (suppression.isSelf ? '' : ` — via une autre ligne du même commerce (${suppression.prospectId})`),
      remedy: null,
    });
  }
  const previous = sameChannelContacts[sameChannelContacts.length - 1];
  if (previous) {
    const member = history.group.members.find((m) => m.prospectId === previous.prospectId);
    blockers.push({
      gate: 'already_contacted',
      owner: 'human',
      detail: previous.isSelf
        ? `déjà joint en ${transport} le ${previous.occurredAt} (${previous.source} ${previous.reference}, « ${previous.status} »)`
        : `ce COMMERCE a déjà été joint en ${transport} le ${previous.occurredAt} sous une autre ligne : ` +
          `${member?.displayName ?? previous.prospectId} (campagne ${member?.campaignSlug ?? '—'}, ` +
          `liée par ${member?.linkedBy.map(describeLink).join(' + ') ?? 'identité partagée'})`,
      remedy: null,
    });
  }

  // ---- ICP, recalculé ------------------------------------------------------
  const profile = loadConfiguredIcpProfile();
  const inputs = await loadIcpInputs(sql, [prospectId]);
  const input = inputs[0];
  if (!input) {
    blockers.push({
      gate: 'icp',
      owner: 'technical',
      detail: `le prospect ${prospectId} n'est plus lisible pour l'évaluation ICP`,
      remedy: null,
    });
  } else {
    const assessment = evaluateIcpEligibility({ subject: input.subject, evidence: input.evidence, profile });
    if (assessment.verdict !== 'GOOD_ICP') {
      blockers.push({
        gate: 'icp',
        owner: 'human',
        detail: `verdict ICP « ${assessment.verdict} » : ${assessment.reason}`,
        remedy: `npm run icp:audit -- --decide ${prospectId} --verdict GOOD_ICP --as "<nom>" --reason "<motif>"`,
      });
    }
  }

  // ---- Provenance du canal -------------------------------------------------
  //
  // Deux chemins la satisfont, exactement comme dans `eligibility.ts` : une
  // identité légale rapprochée automatiquement (`confirmed`), ou une décision
  // humaine portant sur CE prospect, CE transport et CE destinataire. Aucun des
  // deux ne peut être produit par cet écran.
  if (recipient !== null) {
    const channelIdentity = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId,
      transport,
      recipient,
    });
    if (channelIdentity?.decision === 'REJECTED') {
      blockers.push({
        gate: 'identity_provenance',
        owner: 'human',
        detail: `${channelIdentity.decidedBy} a refusé le rapprochement avec @${recipient} le ${channelIdentity.decidedAt} : ${channelIdentity.reason}`,
        remedy: null,
      });
    } else if (context.prospect.identityReview !== 'confirmed' && channelIdentity === null) {
      blockers.push({
        gate: 'identity_provenance',
        owner: 'human',
        detail:
          `identité automatique « ${context.prospect.identityReview} » et aucune confirmation humaine de canal ` +
          `ne porte sur @${recipient}`,
        remedy:
          `npm run ig:identity -- --confirm --prospect ${prospectId} --handle ${recipient} ` +
          '--as "<nom>" --reason "<sur quoi vous vous fondez>" --evidence-url <https://…>',
      });
    }
  }

  return Object.freeze({
    itemId,
    prospectId,
    displayName: context.prospect.displayName,
    transport,
    recipient,
    recipientReason: option?.reason ?? 'transport non proposé pour cet item',
    facts: Object.freeze(facts),
    duplicate: Object.freeze({
      verdict: history.verdict,
      duplicateIdentity: history.duplicateIdentity,
      siblings: history.group.siblings,
      sameChannelContacts,
      otherChannelContacts,
      suppressions: history.suppressions,
    }),
    blockers: Object.freeze(blockers),
    clear: blockers.length === 0,
  });
}

async function loadFacts(sql: Sql, evidenceIds: readonly string[]): Promise<ReviewFact[]> {
  if (evidenceIds.length === 0) return [];
  return sql.query<ReviewFact>(
    `select id as "evidenceId", field, value_text as "valueText", provider, method,
            source_url as "sourceUrl", observed_at as "observedAt"
       from prospect_evidence
      where id = any($1::uuid[])
      order by observed_at asc`,
    [[...evidenceIds]],
  );
}
