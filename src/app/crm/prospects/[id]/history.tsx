/**
 * L'onglet « Dossier & historique » — l'endroit où la densité est permise.
 *
 * C'est le seul écran de la fiche qui assume d'être touffu : identifiants
 * techniques, transitions d'état, timeline intégrale, manifestes datés. On y
 * vient pour vérifier un fait précis, pas pour se faire une idée — et une
 * vérification a besoin de tout, pas d'un résumé.
 *
 * C'est aussi ce qui permet à la vue d'ensemble de rester lisible : chaque
 * détail chassé de la première page a une adresse ici, et personne n'a besoin
 * de le garder en tête.
 */

import { Card, EmptyState } from '@/app/crm/ui';
import { ActivityEvent, Row } from './parts';
import type { CrmWorkspace } from '@/lib/crm/queries';
import { formatDateTime, groupTimelineByDay, shortenUrl } from '@/lib/crm/view';

export function HistoryTab({ workspace, now }: { workspace: CrmWorkspace; now: number }) {
  const { prospect, research, timeline, stateHistory, manifests } = workspace;
  const days = groupTimelineByDay(timeline, now);
  const handle =
    prospect.instagramHandle === null ? null : prospect.instagramHandle.replace(/^@/, '');

  return (
    <div className="crm-history">
      <div className="crm-pane">
        <Card icon="file" title="Dossier complet" tone="slate">
          <dl className="crm-kv wide">
            <Row label="Nom affiché" value={prospect.displayName} />
            <Row label="Raison sociale" value={prospect.legalName} />
            <Row label="Ville" value={prospect.city} />
            <Row label="Code postal" value={prospect.postalCode} mono />
            <Row label="Département" value={prospect.department} mono />
            <Row label="Site" value={shortenUrl(prospect.websiteUrl)} />
            <Row label="Domaine" value={prospect.domain} mono />
            <Row label="Instagram" value={handle === null ? null : `@${handle}`} mono />
            <Row label="Facebook" value={shortenUrl(prospect.facebookUrl)} />
            <Row label="Email" value={prospect.email} mono />
            <Row label="Téléphone" value={prospect.phone} mono />
            <Row label="Niche" value={prospect.nicheVerdict} mono />
            <Row label="Campagne" value={prospect.campaignSlug} mono />
            <Row label="Étape" value={prospect.stage} mono />
            <Row label="Machine à états" value={prospect.outreachState} placeholder="aucune transition" mono />
            <Row label="Transport figé" value={prospect.lockedTransport} placeholder="aucun" mono />
            <Row label="Envois" value={String(prospect.sentCount)} />
            <Row
              label="Dernier envoi"
              value={prospect.lastOutreachAt === null ? null : formatDateTime(prospect.lastOutreachAt)}
              placeholder="aucun envoi"
            />
            <Row
              label="Dernière réponse"
              value={prospect.lastReplyAt === null ? null : formatDateTime(prospect.lastReplyAt)}
              placeholder="aucune réponse"
            />
            <Row label="Classification" value={prospect.lastReplyClassification} mono />
            <Row label="Dédoublonnage" value={prospect.dedupeStatus} mono />
            <Row label="Client" value={prospect.isClient ? 'oui' : 'non'} />
            <Row label="Ne pas contacter" value={prospect.doNotContact ? 'oui' : 'non'} />
            <Row
              label="Recherche"
              value={research === null ? null : formatDateTime(research.createdAt)}
              placeholder="jamais étudié"
            />
            <Row label="Identifiant" value={prospect.id} mono />
          </dl>
        </Card>

        <Card icon="arrow-right" title="Historique des états" tone="blue" end={`${stateHistory.length}`}>
          {stateHistory.length === 0 ? (
            <EmptyState icon="arrow-right" title="Aucune transition">
              La machine à états n’a jamais bougé pour ce prospect.
            </EmptyState>
          ) : (
            <ol className="crm-states">
              {stateHistory.map((entry) => (
                <li key={`${entry.createdAt}:${entry.toState}`}>
                  <span className="when crm-mono">{formatDateTime(entry.createdAt)}</span>
                  <span className="tr">
                    <span className="from">{entry.fromState ?? '∅'}</span>
                    <span className="ar">→</span>
                    <span className="to">{entry.toState}</span>
                  </span>
                  <span className="why">
                    {entry.causeKind} · {entry.reason}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {manifests.length === 0 ? null : (
          <Card icon="lock" title="Manifestes" tone="blue" end={`${manifests.length}`}>
            <ul className="crm-list plain">
              {manifests.map((manifest) => (
                <li key={manifest.id}>
                  <span>
                    <span className="crm-mono">{manifest.status}</span>
                    {manifest.transport === null ? '' : ` · ${manifest.transport}`}
                    <span className="meta crm-mono">{manifest.recipient}</span>
                    <span className="meta">
                      {formatDateTime(manifest.lockedAt)} · identité {manifest.identityReview}
                      {manifest.supersededReason === null ? '' : ` · ${manifest.supersededReason}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="crm-pane">
        <Card
          icon="activity"
          title="Timeline complète"
          tone="violet"
          end={`${timeline.length} événement${timeline.length > 1 ? 's' : ''}`}
        >
          {timeline.length === 0 ? (
            <EmptyState icon="activity" title="Aucun événement">
              Rien n’a encore été enregistré pour ce prospect.
            </EmptyState>
          ) : (
            days.map((day) => (
              <div key={day.key}>
                <div className="crm-day">{day.label}</div>
                <div className="crm-timeline">
                  {day.entries.map((entry) => (
                    <ActivityEvent key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}
