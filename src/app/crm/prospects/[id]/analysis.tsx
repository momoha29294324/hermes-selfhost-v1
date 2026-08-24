/**
 * L'onglet « Analyse & opportunités » — ce que le pipeline a COMPRIS.
 *
 * La règle qui a décidé de cet écran : n'afficher aucune métrique par ligne.
 *
 * Les opportunités et les inconnues sont, en base, des PHRASES
 * (`prospect_research.opportunities`, `unknowns`) — pas des objets scorés. Leur
 * accoler une confiance, un impact ou une priorité produirait des chiffres que
 * rien n'a calculés : exactement le genre de donnée inventée que ce dépôt
 * interdit. La seule confiance affichée est celle de la recherche entière,
 * parce que c'est la seule qui existe.
 *
 * La hiérarchie passe donc par la PLACE et la FORME, pas par des chiffres
 * décoratifs : les opportunités occupent la colonne large et une carte chacune,
 * les inconnues une colonne étroite et une liste.
 */

import { nextActionTerm } from '@/lib/crm/vocabulary';
import { Badge, Card, EmptyState } from '@/app/crm/ui';
import { Prose } from './parts';
import type { CrmWorkspace } from '@/lib/crm/queries';
import type { CrmNextAction } from '@/lib/crm/next-action';
import { NEXT_ACTION_ICON } from './parts';
import { Icon } from '@/app/crm/icons';
import { formatDate, formatDateTime, type CrmTimelineEntry } from '@/lib/crm/view';

export function AnalysisTab({
  workspace,
  action,
}: {
  workspace: CrmWorkspace;
  action: CrmNextAction;
}) {
  const { prospect, research, score, timeline } = workspace;
  const term = nextActionTerm(prospect.recommendedNextAction);
  const analyses = timeline.filter(
    (entry: CrmTimelineEntry) => entry.kind === 'reply_analysis',
  );

  if (research === null && analyses.length === 0) {
    return (
      <Card icon="sparkle" title="Analyse" tone="violet">
        <EmptyState icon="question" title="Aucune analyse">
          Ce prospect n’a pas encore été étudié par le pipeline, et aucune réponse n’a été
          analysée.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="crm-analysis">
      {/* ------------------------------------------------------------ large */}
      <div className="crm-pane">
        {research === null ? null : (
          <Card icon="sparkle" title="Résumé" tone="violet" end={formatDate(research.createdAt)}>
            <p className="crm-prose lead">
              <Prose value={research.summary} />
            </p>
            <div className="crm-chips">
              <Badge tone="violet" icon="gauge">
                confiance {research.confidence.toFixed(2)}
              </Badge>
              {prospect.nicheVerdict === null ? null : (
                <Badge tone={prospect.nicheVerdict === 'in_niche' ? 'green' : 'orange'} dot>
                  {prospect.nicheVerdict}
                </Badge>
              )}
              <Badge tone="slate" icon="check">
                {research.observations.length} observation
                {research.observations.length > 1 ? 's' : ''}
              </Badge>
            </div>
          </Card>
        )}

        <Card
          icon="bulb"
          title="Opportunités"
          tone="green"
          end={research === null ? '0' : `${research.opportunities.length}`}
        >
          {research === null || research.opportunities.length === 0 ? (
            <EmptyState icon="bulb" title="Aucune opportunité identifiée">
              La recherche n’a retenu aucune opportunité. Ce n’est pas la preuve qu’il n’y en a
              pas — c’est l’absence d’une hypothèse observée.
            </EmptyState>
          ) : (
            <div className="crm-opps">
              {research.opportunities.map((entry, index) => (
                <article className="crm-opp" key={entry} data-tone="green">
                  <span className="n">{index + 1}</span>
                  <p>
                    <Prose value={entry} />
                  </p>
                </article>
              ))}
            </div>
          )}
        </Card>

        {analyses.length === 0 ? null : (
          <Card
            icon="reply"
            title="Analyse des réponses"
            tone="blue"
            end={`${analyses.length}`}
          >
            {analyses.map((entry) => (
              <article className="crm-reply-analysis" key={entry.id} data-tone="blue">
                <div className="h">
                  <strong>{entry.title}</strong>
                  <span className="when">{formatDateTime(entry.occurredAt)}</span>
                </div>
                {entry.body === null ? null : <p className="crm-prose">{entry.body}</p>}
                <div className="crm-event-facts">
                  {entry.facts.map((fact) => (
                    <span className="crm-fact" key={fact} title={fact}>
                      {fact}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </Card>
        )}
      </div>

      {/* ----------------------------------------------------------- étroit */}
      <div className="crm-pane">
        <Card icon="target" title="Signal commercial" tone={term === null ? action.tone : term.tone}>
          {/* Même règle que partout : la PHRASE pour l'opérateur, l'identifiant
              canonique conservé juste dessous. C'est l'onglet où l'on vient
              vérifier ce que la machine a conclu — le mot exact de la base y a
              donc sa place, mais sous la traduction, pas à la place. */}
          <div className="crm-signal-line" data-tone={term === null ? action.tone : term.tone}>
            <span className="crm-ic">
              <Icon name={NEXT_ACTION_ICON[action.key]} size={15} />
            </span>
            <span>
              <b>{term === null ? action.label : term.label}</b>
              <span className="s">
                {action.basis}
                {term === null ? null : <span className="crm-raw"> · {term.raw}</span>}
              </span>
            </span>
          </div>
          <dl className="crm-kv">
            <RowText label="État" value={prospect.commercial.label} />
            <RowText
              label="Classification"
              value={prospect.lastReplyClassification}
              placeholder="aucune réponse analysée"
            />
            <RowText
              label="Dernière réponse"
              value={prospect.lastReplyAt === null ? null : formatDateTime(prospect.lastReplyAt)}
              placeholder="aucune réponse reçue"
            />
            <RowText
              label="Score"
              value={score === null ? null : `${score.total} · bande ${score.band}`}
              placeholder="non scoré"
            />
          </dl>
        </Card>

        <Card
          icon="question"
          title="Risques & inconnues"
          tone="orange"
          end={research === null ? '0' : `${research.unknowns.length}`}
        >
          {research === null || research.unknowns.length === 0 ? (
            <EmptyState icon="question" title="Aucun risque identifié">
              La recherche n’a signalé aucune inconnue.
            </EmptyState>
          ) : (
            <>
              <div className="crm-risks">
                {research.unknowns.map((entry) => (
                  <article className="crm-risk" key={entry} data-tone="orange">
                    <Icon name="alert" size={14} />
                    <p>
                      <Prose value={entry} />
                    </p>
                  </article>
                ))}
              </div>
              <p className="crm-prose" style={{ fontSize: 11, marginTop: 10 }}>
                Chaque ligne est un risque NON LEVÉ — le pipeline ne l’a pas observé. Ce n’est pas
                l’affirmation d’une absence.
              </p>
            </>
          )}
        </Card>

        {score === null || score.missing.length === 0 ? null : (
          <Card icon="gauge" title="Non observés au scoring" tone="slate">
            <ul className="crm-list plain">
              {score.missing.map((key) => (
                <li key={key}>
                  <span className="crm-mono">{key}</span>
                </li>
              ))}
            </ul>
            <p className="crm-prose" style={{ fontSize: 11 }}>
              Ces signaux n’ont pas été observés : ils ne comptent ni pour ni contre.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function RowText({
  label,
  value,
  placeholder = 'non observé',
}: {
  label: string;
  value: string | null;
  placeholder?: string;
}) {
  return (
    <div className="r">
      <dt>{label}</dt>
      <dd>{value ?? <span className="crm-dim">{placeholder}</span>}</dd>
    </div>
  );
}
