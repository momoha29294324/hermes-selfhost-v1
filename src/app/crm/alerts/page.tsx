import { Fragment } from 'react';
import Link from 'next/link';
import { loadCrmAlerts, type CrmAlertRow } from '@/lib/crm/queries';
import { formatDateTime, formatDateTimeShort } from '@/lib/crm/view';
import { CrmUnavailable } from '@/app/crm/unavailable';
import { RowNav } from '@/app/crm/row-nav';
import { Avatar, EmptyState, TermBadge } from '@/app/crm/ui';
import { alertStatusTerm, severityTerm, type CrmTerm } from '@/lib/crm/vocabulary';

export const dynamic = 'force-dynamic';

/**
 * Les alertes speed-to-lead.
 *
 * `r6b_alerts` est une FILE, pas un canal : aucun fournisseur de notification
 * n'est configuré, donc une alerte levée reste `NO_PROVIDER` jusqu'à ce qu'un
 * humain la voie. Cette page est l'endroit où il la voit.
 */
export default async function CrmAlertsPage() {
  let rows: CrmAlertRow[];
  try {
    rows = await loadCrmAlerts();
  } catch (error) {
    return <CrmUnavailable error={error} />;
  }

  const open = rows.filter((row) => row.status !== 'DELIVERED');

  return (
    <>
      <div className="crm-head">
        <div className="crm-head-titles">
          <h1>Alertes</h1>
          <div className="sub">
            {open.length} ouverte(s) · {rows.length} au total
          </div>
        </div>
        <span className="crm-meta" style={{ marginLeft: 'auto' }}>
          lecture seule — une alerte se ferme quand un humain l’a traitée
        </span>
      </div>

      <div className="crm-body">
        {rows.length === 0 ? (
          <EmptyState icon="bell" title="Aucune alerte">
            Une alerte speed-to-lead est levée quand une réponse est classée intéressée ou
            demandeuse d’un rendez-vous. Aucune réponse n’a encore été reçue.
          </EmptyState>
        ) : (
          <>
            <RowNav />
            <div className="crm-panelcard">
              <table className="crm-table fixed">
                <colgroup>
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '43%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '15%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Levée</th>
                    <th>Ce qui s’est passé</th>
                    <th>Sévérité</th>
                    <th>Type</th>
                    <th>Remise</th>
                  </tr>
                </thead>
                <tbody>
                  {groupByProspect(rows).map((group) => (
                    <Fragment key={group.key}>
                      <AlertGroupHead group={group} />
                      {group.rows.map((row) => {
                        const severity = severityTerm(row.severity);
                        const status = alertStatusTerm(row.status);
                        return (
                          <tr
                            key={row.id}
                            data-sev={severityRail(severity)}
                            data-wait={row.status === 'DELIVERED' ? 'no' : 'yes'}
                            data-href={`/crm/prospects/${row.prospectId}`}
                          >
                            <td className="crm-mono crm-dim" title={formatDateTime(row.createdAt)}>
                              {formatDateTimeShort(row.createdAt)}
                            </td>
                            <td>
                              <span className="crm-quote-line" title={row.title}>
                                {row.title}
                              </span>
                              {row.lastError === null ? null : (
                                <span className="crm-raw" title={row.lastError}>
                                  {row.lastError}
                                </span>
                              )}
                            </td>
                            <td>
                              {severity === null ? (
                                <span className="crm-dim">—</span>
                              ) : (
                                <TermBadge term={severity} />
                              )}
                            </td>
                            {/* Le TYPE d'alerte reste l'identifiant de la base :
                                `SPEED_TO_LEAD` n'a pas de traduction dans ce dépôt, et
                                en inventer une ici ferait diverger l'écran de la
                                table. Palier 4, en chasse fixe — c'est une
                                provenance. */}
                            <td className="crm-mono crm-dim" title={row.kind}>
                              {row.kind}
                            </td>
                            <td>
                              {status === null ? (
                                <span className="crm-dim">—</span>
                              ) : (
                                <TermBadge term={status} />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * La file est groupée par ENTREPRISE, et la raison est dans les données : les
 * vingt-huit alertes de ce dépôt portent sur quatre commerces. La colonne
 * « Entreprise » réécrivait donc le même nom huit fois de suite, et le nombre
 * d'alertes ouvertes SUR UN MÊME commerce — la seule chose qui dise l'urgence
 * d'un rappel — ne se lisait nulle part.
 *
 * Aucun tri n'est introduit : les lignes gardent l'ordre de `loadCrmAlerts`,
 * et une rangée de titre s'insère quand le commerce change.
 */
interface AlertGroup {
  readonly key: string;
  readonly prospectId: string;
  readonly rows: CrmAlertRow[];
}

function groupByProspect(rows: readonly CrmAlertRow[]): AlertGroup[] {
  const groups: AlertGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.prospectId === row.prospectId) {
      last.rows.push(row);
      continue;
    }
    // La clé porte le RANG du groupe, pas seulement le prospect : les alertes
    // restent triées par date, donc un même commerce peut ouvrir deux groupes
    // séparés par un autre — et deux enfants de même clé sont un défaut de
    // rendu, pas une coquetterie.
    groups.push({ key: `${row.prospectId}#${groups.length}`, prospectId: row.prospectId, rows: [row] });
  }
  return groups;
}

/** Le titre d'un groupe : le nom une fois, et deux `length` — rien d'autre. */
function AlertGroupHead({ group }: { group: AlertGroup }) {
  const [first] = group.rows;
  if (first === undefined) return null;
  const open = group.rows.filter((row) => row.status !== 'DELIVERED').length;
  return (
    <tr className="crm-grouprow">
      <td colSpan={5}>
        <div className="crm-grouphead" data-tone={open === 0 ? 'slate' : 'red'}>
          <Avatar name={first.company} tone={open === 0 ? 'slate' : 'red'} />
          <Link className="nm" href={`/crm/prospects/${first.prospectId}`} prefetch={false}>
            {first.company}
          </Link>
          <span className="mt">
            {open === 0
              ? `${group.rows.length} alerte(s) — toutes remises`
              : `${open} en attente sur ${group.rows.length}`}
          </span>
          <span className="ct">
            {group.rows.length} alerte{group.rows.length > 1 ? 's' : ''}
          </span>
        </div>
      </td>
    </tr>
  );
}

/**
 * Le rail de couleur d'une ligne — et il ne DÉCIDE rien.
 *
 * Il ne relit PAS la valeur brute de `severity` : il lit la TEINTE que
 * `severityTerm` en a déjà tirée, dans `vocabulary.ts`. Refaire ici une table
 * de correspondance ferait exister deux jugements sur la même colonne, et le
 * jour où le vocabulaire changerait, le rail dirait l'inverse de la pastille
 * qu'il borde. Une teinte inattendue ne prend aucun rail.
 */
function severityRail(term: CrmTerm | null): 'high' | 'medium' | 'low' | undefined {
  if (term === null) return undefined;
  if (term.tone === 'red') return 'high';
  if (term.tone === 'orange') return 'medium';
  if (term.tone === 'slate' || term.tone === 'blue' || term.tone === 'cyan') return 'low';
  return undefined;
}
