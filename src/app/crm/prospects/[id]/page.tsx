import { notFound } from 'next/navigation';
import {
  CRM_EVIDENCE_LIMIT,
  loadCrmWorkspace,
  type CrmWorkspace,
} from '@/lib/crm/queries';
import { buildConversation } from '@/lib/crm/conversation';
import { resolveNextAction } from '@/lib/crm/next-action';
import { CrmUnavailable } from '@/app/crm/unavailable';
import { ProspectHeader } from './header';
import { ProspectTabs } from './tabs';
import { ProtectionBanner } from './parts';
import { OverviewTab } from './overview';
import { ConversationTab } from './conversation';
import { EvidenceTab } from './evidence';
import { AnalysisTab } from './analysis';
import { HistoryTab } from './history';

export const dynamic = 'force-dynamic';

/**
 * La fiche d'un prospect — un en-tête, cinq onglets.
 *
 * Cette page ne DESSINE rien. Elle charge le dossier une fois, en dérive deux
 * vues (le fil de conversation, l'action suivante), et distribue le tout aux
 * cinq panneaux. Tout le rendu vit dans les composants voisins : une fiche de
 * huit cents lignes finissait par cacher sa propre hiérarchie.
 *
 *   en-tête       — qui c'est, ce qu'il vaut, où il en est, quoi faire ;
 *   vue d'ensemble— les réponses courtes, en trois colonnes ;
 *   conversation  — ce qui a été dit, dans l'ordre où on l'a dit ;
 *   preuves       — d'où vient chaque affirmation ;
 *   analyse       — ce que le pipeline en a compris ;
 *   dossier       — tout le reste, dense et daté.
 *
 * ---------------------------------------------------------------------------
 * Ce que cette page ne fait pas
 * ---------------------------------------------------------------------------
 *
 * Elle n'écrit rien, n'envoie rien, ne recalcule rien. Le score vient de
 * `prospect_scores`, l'état de la machine à états, les messages des tables
 * canoniques. Un chiffre affiché ici a toujours une ligne en base derrière lui —
 * et quand il n'y en a pas, l'écran dit « non observé » plutôt que de combler
 * le trou.
 */
export default async function CrmProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let workspace: CrmWorkspace | null;
  try {
    workspace = await loadCrmWorkspace(id);
  } catch (error) {
    return <CrmUnavailable error={error} />;
  }
  if (workspace === null) notFound();

  const { prospect, evidence, score, timeline, protections } = workspace;
  const now = Date.now();

  const conversation = buildConversation(timeline);
  const action = resolveNextAction({
    recommendedNextAction: prospect.recommendedNextAction,
    doNotContact: prospect.doNotContact,
    lane: prospect.lane,
  });

  // `loadEvidence` s'arrête au plafond. Afficher « 60 preuves » quand il y en a
  // 317 en base serait un chiffre faux — la fiche dit donc « 60+ ».
  const capped = evidence.length >= CRM_EVIDENCE_LIMIT;
  const evidenceLabel = capped ? `${CRM_EVIDENCE_LIMIT}+` : `${evidence.length}`;

  return (
    <div className="crm-fiche">
      <ProspectHeader prospect={prospect} score={score} action={action} now={now} />

      {protections.length > 0 || prospect.outreachState === 'SUPPRESSED' ? (
        <ProtectionBanner protections={protections} />
      ) : null}

      <ProspectTabs
        panels={{
          overview: <OverviewTab workspace={workspace} now={now} />,
          conversation: (
            <ConversationTab
              conversation={conversation}
              timeline={timeline}
              prospectName={prospect.displayName}
              now={now}
            />
          ),
          evidence: (
            <EvidenceTab workspace={workspace} evidenceLabel={evidenceLabel} capped={capped} />
          ),
          analysis: <AnalysisTab workspace={workspace} action={action} />,
          history: <HistoryTab workspace={workspace} now={now} />,
        }}
      />
    </div>
  );
}
