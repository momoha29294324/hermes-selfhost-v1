/**
 * Les pièces partagées par plusieurs onglets de la fiche.
 *
 * Elles vivent ici plutôt que dans `@/app/crm/ui` parce qu'elles connaissent le
 * VOCABULAIRE d'un prospect (un canal, un signal de score, une action suivante)
 * là où les primitives du CRM ne connaissent qu'une teinte et une forme. La
 * frontière est celle-là : `ui.tsx` ne sait rien du métier, ce fichier ne sait
 * rien de la mise en page.
 *
 * Aucun de ces composants n'est un composant client : il n'y a rien à hydrater.
 */

import { Icon, type IconName } from '@/app/crm/icons';
import { Badge, CHANNEL_ICON, Card, Ring, TIMELINE_ICON } from '@/app/crm/ui';
import type { CrmProtection, CrmScore } from '@/lib/crm/queries';
import type { CrmNextAction, CrmNextActionKey } from '@/lib/crm/next-action';
import {
  CHANNEL_LABELS,
  CHANNEL_TONE,
  TIMELINE_TONE,
  bandTone,
  formatDate,
  formatTime,
  shortenUrl,
  splitEvidenceRefs,
  type CrmChannel,
  type CrmTimelineEntry,
  type CrmTimelineKind,
  type CrmTone,
} from '@/lib/crm/view';

export const NEXT_ACTION_ICON: Readonly<Record<CrmNextActionKey, IconName>> = Object.freeze({
  recommended: 'target',
  do_not_contact: 'ban',
  manifest_ready: 'lock',
  await_reply: 'clock',
  none: 'clock',
});

export const KIND_LABELS: Readonly<Record<CrmTimelineKind, string>> = Object.freeze({
  manifest_locked: 'manifeste',
  outbound_sent: 'envoi',
  outbound_event: 'outbound',
  send_failure: 'tentative',
  inbound_reply: 'réponse',
  reply_analysis: 'analyse',
  reply_draft: 'brouillon',
  conversation_plan: 'auto',
  state_transition: 'état',
  milestone: 'jalon',
  alert: 'alerte',
});

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

/**
 * Un texte du pipeline, avec ses références de preuve rendues lisibles.
 *
 * Les identifiants ne sont pas supprimés — c'est ce qui rend une affirmation
 * vérifiable — mais ils cessent de couper la phrase en deux.
 */
export function Prose({ value }: { value: string }) {
  return (
    <>
      {splitEvidenceRefs(value).map((segment, index) =>
        segment.isRef ? (
          <span className="crm-ref" key={index} title="prospect_evidence">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ---------------------------------------------------------------------------
// Lignes
// ---------------------------------------------------------------------------

/**
 * Une ligne clé/valeur.
 *
 * Le remplaçant par défaut est « non observé », jamais un tiret muet : la fiche
 * doit continuer à distinguer ce que le pipeline n'a pas vu de ce qui n'existe
 * pas.
 */
export function Row({
  label,
  value,
  mono = false,
  placeholder = 'non observé',
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="r">
      <dt>{label}</dt>
      {/* Le `title` porte la valeur ENTIÈRE. En grille — la carte « Identité &
          canaux » —, une cellule fait environ 170 px : une commune au nom long
          suivie de son code postal s'y termine en points de suspension, et sans
          ce titre la fin de la valeur ne serait plus atteignable nulle part sur
          la fiche. Il ne change rien quand la valeur tient. */}
      <dd className={mono && value !== null ? 'crm-mono' : ''} {...(value === null ? {} : { title: value })}>
        {value ?? <span className="crm-dim">{placeholder}</span>}
      </dd>
    </div>
  );
}

/**
 * Un canal, présent ou absent, avec le même poids visuel dans les deux cas.
 *
 * Un canal non observé n'est pas masqué : savoir qu'aucun email n'a été trouvé
 * est une information de travail, et la faire disparaître obligerait à
 * reconstituer la liste de mémoire.
 */
export function ChannelLine({
  channel,
  value,
  link = null,
  best,
  active,
  label,
  icon,
  tone: forcedTone,
}: {
  channel: CrmChannel;
  value: string | null;
  link?: string | null;
  best: boolean;
  active: boolean;
  label?: string;
  icon?: IconName;
  tone?: CrmTone;
}) {
  const tone: CrmTone = value === null ? 'slate' : (forcedTone ?? CHANNEL_TONE[channel]);
  return (
    <div className={`crm-channel${value === null ? ' absent' : ''}`} data-tone={tone}>
      <span className="crm-ic">
        <Icon name={icon ?? CHANNEL_ICON[channel]} size={14} />
      </span>
      <span className="t">
        <b>{label ?? CHANNEL_LABELS[channel]}</b>
        {value === null ? (
          <span className="crm-dim">non observé</span>
        ) : link === null ? (
          <span title={value}>{value}</span>
        ) : (
          <a href={link} target="_blank" rel="noreferrer noopener" title={value}>
            {value}
          </a>
        )}
      </span>
      {best ? (
        <span className="tag" data-tone="violet">
          retenu
        </span>
      ) : active ? (
        <span className="tag" data-tone="green">
          actif
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartes
// ---------------------------------------------------------------------------

export function ProtectionBanner({ protections }: { protections: readonly CrmProtection[] }) {
  return (
    <div className="crm-banner" data-tone="red">
      <Icon name="ban" size={17} />
      <div>
        <strong>Prospect protégé — ne pas contacter.</strong>
        {protections.length === 0 ? <div>état commercial SUPPRESSED</div> : null}
        {protections.map((protection) => (
          <div key={`${protection.matchKind}:${protection.value}`}>
            {protection.matchKind} · {protection.reason}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * La prochaine action — l'élément le plus en évidence de la fiche.
 *
 * Sa teinte vient de la NATURE de l'action, pas d'un choix graphique : rouge
 * quand il ne faut pas contacter, bleu quand un manifeste attend, violet quand
 * on attend une réponse. Rien n'y est daté, parce que rien dans ce dépôt ne
 * porte d'échéance.
 */
export function NextActionCard({
  action,
  children,
}: {
  action: CrmNextAction;
  children?: React.ReactNode;
}) {
  return (
    <section className="crm-next" data-tone={action.tone}>
      <div className="lb">
        <Icon name={NEXT_ACTION_ICON[action.key]} size={14} />
        Prochaine action
      </div>
      <div className="v">{action.label}</div>
      <div className="s">{action.basis}</div>
      {children}
    </section>
  );
}

/**
 * Le détail du score — le même calcul qu'ailleurs, seulement mieux lisible.
 *
 * Rien n'est recalculé ici : `points`, `max`, `band` et `total` viennent de
 * `prospect_scores`. Un signal non observé affiche une jauge VIDE et le dit,
 * plutôt que de dessiner un zéro qu'on lirait comme une mauvaise note.
 */
export function ScoreCard({
  score,
  compact = false,
  fill = false,
}: {
  score: CrmScore;
  compact?: boolean;
  /**
   * Dans la vue d'ensemble, la carte prend la place restante de sa colonne et
   * fait défiler SES signaux — onze jauges de 46 px poussaient sinon la page à
   * 1 299 px à elles seules. Le total, la bande et le nombre de signaux
   * observés restent hors du défilement : ce sont eux qu'on vient lire.
   */
  fill?: boolean;
}) {
  const observed = score.signals.filter((signal) => signal.observed).length;
  return (
    <Card
      icon="gauge"
      title="Score détaillé"
      tone={bandTone(score.band)}
      {...(fill ? { className: 'crm-card-fill' } : {})}
    >
      <div className="crm-score-head">
        <Ring value={score.total} tone={bandTone(score.band)} />
        <div>
          <div className="b">Bande {score.band}</div>
          <div className="s">
            {observed}/{score.signals.length} signaux observés
          </div>
        </div>
      </div>

      <div className={fill ? 'crm-scroll crm-card-scroll' : undefined}>
      {score.signals.map((signal) => {
        const pct = signal.max > 0 ? Math.round((signal.points / signal.max) * 100) : 0;
        return (
          <div
            className={`crm-signal${signal.observed ? '' : ' absent'}`}
            key={signal.key}
            data-tone={signal.observed ? bandTone(score.band) : 'slate'}
          >
            <div className="l">
              <span>{signal.label}</span>
              <span className="p">
                {signal.observed ? `${round1(signal.points)}/${signal.max}` : 'non obs.'}
              </span>
            </div>
            <div className="g">
              <i style={{ width: `${signal.observed ? pct : 0}%` }} />
            </div>
            {compact || signal.detail === null ? null : <div className="d">{signal.detail}</div>}
          </div>
        );
      })}
      </div>

      <p className="crm-prose crm-note">
        <span className="crm-mono">
          {score.profileKey} {score.profileVersion}
        </span>{' '}
        · {formatDate(score.createdAt)}
        {score.missing.length === 0 ? null : ` · non observés : ${score.missing.join(', ')}`}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Événement d'activité
// ---------------------------------------------------------------------------

/**
 * Un événement, marqué par son GENRE autant que par sa direction.
 *
 * La pastille, sa teinte et son icône viennent toutes de `kind` — jamais du
 * canal : `email` n'a aucune règle à lui, et un DM Instagram traversera ce
 * composant sans le modifier.
 */
export function ActivityEvent({
  entry,
  quiet = false,
}: {
  entry: CrmTimelineEntry;
  quiet?: boolean;
}) {
  const body = entry.body === null || entry.body.trim().length === 0 ? null : entry.body;
  return (
    <article className="crm-event" data-tone={TIMELINE_TONE[entry.kind]}>
      <span className="m">
        <Icon name={TIMELINE_ICON[entry.kind]} size={15} />
      </span>
      <div className="crm-event-body">
        <div className="crm-event-head">
          <div className="crm-event-title">{entry.title}</div>
          <span className="when">{formatTime(entry.occurredAt)}</span>
        </div>
        <div className="crm-event-facts">
          <Badge tone={TIMELINE_TONE[entry.kind]} variant="quiet">
            {KIND_LABELS[entry.kind]}
          </Badge>
          {entry.channel === null ? null : (
            <Badge tone={CHANNEL_TONE[entry.channel]} icon={CHANNEL_ICON[entry.channel]}>
              {CHANNEL_LABELS[entry.channel]}
            </Badge>
          )}
          {quiet
            ? null
            : entry.facts.map((fact) => (
                <span className="crm-fact" key={fact} title={fact}>
                  {fact}
                </span>
              ))}
        </div>
        {body === null ? null : quiet ? (
          <div className="crm-quote clamp">{truncate(body, 120)}</div>
        ) : body.length <= 220 ? (
          <div className="crm-quote">{body}</div>
        ) : (
          <details className="crm-details">
            <summary>
              <Icon name="file" size={14} />
              Texte intégral — {body.length} signes
            </summary>
            <div className="crm-quote">{body}</div>
          </details>
        )}
      </div>
    </article>
  );
}

export { shortenUrl };
