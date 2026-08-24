/**
 * L'onglet « Preuves & sources » — d'où vient ce que la fiche affirme.
 *
 * Tout y est replié par défaut. Quarante-six lignes de preuve dépliées ne se
 * lisent pas : elles se font défiler jusqu'à ce qu'on renonce. Chaque accordéon
 * annonce donc son COMPTE avant son contenu, et le compte est déjà une réponse
 * — « il y a huit observations » suffit souvent, sans lire les huit.
 *
 * Une ligne de preuve n'est jamais résumée : elle porte son fournisseur, sa
 * méthode, sa confiance et son URL de source. C'est ce qui la rend
 * vérifiable, donc c'est ce qui ne peut pas être coupé.
 */

import Link from 'next/link';
import { Badge, Card, EmptyState } from '@/app/crm/ui';
import { Icon } from '@/app/crm/icons';
import { Prose, Row, truncate } from './parts';
import type { CrmWorkspace } from '@/lib/crm/queries';
import { formatDate, formatDateTime, shortenUrl } from '@/lib/crm/view';

export function EvidenceTab({
  workspace,
  evidenceLabel,
  capped,
}: {
  workspace: CrmWorkspace;
  evidenceLabel: string;
  capped: boolean;
}) {
  const { prospect, research, evidence, manifests, stateHistory } = workspace;
  const observations = research === null ? [] : research.observations;

  return (
    /*
     * DEUX colonnes, et non une pile bornée à 1 080 px.
     *
     * En pile, cet onglet laissait deux cent trente pixels de fond nu à
     * droite sur toute sa hauteur — le prix payé pour garder une longueur
     * de ligne lisible. Les deux besoins ne sont pas en conflit : la
     * PREUVE (observations, lignes) est du texte long et garde sa mesure
     * dans la colonne de gauche ; le DOSSIER (manifestes, couches) est
     * fait de listes clé/valeur, qui se lisent aussi bien étroites.
     *
     * Aucun contenu n’est retiré ni replié : les mêmes quatre cartes,
     * dans le même ordre de lecture.
     */
    <div className="crm-evidence">
      <div className="crm-evidence-col">
        <Card
          icon="check"
          title="Observations"
          tone="green"
          end={`${observations.length}`}
        >
          {observations.length === 0 ? (
            <EmptyState icon="question" title="Aucune observation">
              Le pipeline n’a rien consigné pour ce prospect.
            </EmptyState>
          ) : (
            <details className="crm-details" open>
              <summary>
                <Icon name="check" size={14} />
                Observations — {observations.length}
              </summary>
              <ul className="crm-list plain">
                {observations.map((entry) => (
                  <li key={entry}>
                    <span>
                      <Prose value={entry} />
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>


      </div>

      <div className="crm-evidence-col">
        <Card icon="layers" title="Lignes de preuve" tone="slate" end={evidenceLabel}>
          {evidence.length === 0 ? (
            <EmptyState icon="layers" title="Aucune ligne de preuve">
              Rien n’a été observé et enregistré dans <span className="crm-mono">prospect_evidence</span>.
            </EmptyState>
          ) : (
            <details className="crm-details">
              <summary>
                <Icon name="layers" size={14} />
                Lignes de preuve — {evidenceLabel}
              </summary>
              <ul className="crm-list plain">
                {evidence.map((entry, index) => (
                  <li key={`${entry.field}:${entry.observedAt}:${index}`}>
                    <span>
                      <span className="crm-mono">{entry.field}</span>
                      {entry.value === null ? null : <> — {truncate(entry.value, 120)}</>}
                      <span className="meta">
                        {entry.provider} · {entry.method} · conf. {entry.confidence.toFixed(2)} ·{' '}
                        {formatDate(entry.observedAt)}
                        {entry.sourceUrl === null ? null : (
                          <>
                            {' · '}
                            <a href={entry.sourceUrl} target="_blank" rel="noreferrer noopener">
                              {shortenUrl(entry.sourceUrl)}
                            </a>
                          </>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {capped ? (
                <p className="crm-prose" style={{ fontSize: 11 }}>
                  La lecture s’arrête au plafond de {evidence.length} lignes. Le compte réel peut être
                  plus élevé — <Link href={`/prospects/${prospect.id}`} prefetch={false}>
                      dossier complet
                    </Link>.
                </p>
              ) : null}
            </details>
          )}
        </Card>

        <Card icon="lock" title="Manifestes" tone="blue" end={`${manifests.length}`}>
          {manifests.length === 0 ? (
            <EmptyState icon="lock" title="Aucun manifeste">
              Aucun texte n’a été verrouillé pour ce prospect.
            </EmptyState>
          ) : (
            manifests.map((manifest) => (
              <details className="crm-details" key={manifest.id}>
                <summary>
                  <Icon name="lock" size={14} />
                  {manifest.status} · {manifest.transport ?? 'transport non observé'} ·{' '}
                  {formatDate(manifest.lockedAt)}
                </summary>
                <dl className="crm-kv">
                  <Row label="Statut" value={manifest.status} mono />
                  <Row label="Transport" value={manifest.transport} mono />
                  <Row label="Destinataire" value={manifest.recipient} mono />
                  <Row label="Entreprise" value={manifest.businessName} />
                  <Row label="Verrouillé" value={formatDateTime(manifest.lockedAt)} />
                  <Row label="Revue d’identité" value={manifest.identityReview} mono />
                  <Row
                    label="Remplacé"
                    value={manifest.supersededReason}
                    placeholder="non remplacé"
                  />
                  <Row label="Identifiant" value={manifest.id} mono />
                </dl>
                <div className="crm-quote">{manifest.approvedText}</div>
              </details>
            ))
          )}
        </Card>

        <Card icon="board" title="Couches sous-jacentes" tone="slate">
          <details className="crm-details">
            <summary>
              <Icon name="board" size={14} />
              État interne du pipeline
            </summary>
            <dl className="crm-kv">
              <Row label="Fabrication" value={prospect.stage} mono />
              <Row
                label="Machine"
                value={prospect.outreachState}
                placeholder="aucune transition"
                mono
              />
              <Row label="Envois" value={String(prospect.sentCount)} />
              <Row label="Classification" value={prospect.lastReplyClassification} mono />
              <Row label="Dédoublonnage" value={prospect.dedupeStatus} mono />
              <Row
                label="Copie externe"
                value={
                  workspace.externalProjection === null
                    ? null
                    : `${workspace.externalProjection.status} · ${workspace.externalProjection.provider}`
                }
                placeholder="aucune — dossier local canonique"
                mono
              />
            </dl>
          </details>

          <details className="crm-details">
            <summary>
              <Icon name="arrow-right" size={14} />
              Transitions d’état — {stateHistory.length}
            </summary>
            {stateHistory.length === 0 ? (
              <p className="crm-prose">Aucune transition enregistrée.</p>
            ) : (
              <ul className="crm-list plain">
                {stateHistory.map((entry) => (
                  <li key={`${entry.createdAt}:${entry.toState}`}>
                    <span>
                      <span className="crm-mono">{formatDateTime(entry.createdAt)}</span>{' '}
                      {entry.fromState ?? '∅'} → {entry.toState}
                      <span className="meta">
                        {entry.causeKind} · {entry.reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </details>

          {research === null ? null : (
            <div className="crm-chips" style={{ marginTop: 10 }}>
              <Badge tone="violet" icon="gauge">
                confiance de recherche {research.confidence.toFixed(2)}
              </Badge>
              <Badge tone="slate" icon="calendar">
                {formatDate(research.createdAt)}
              </Badge>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
