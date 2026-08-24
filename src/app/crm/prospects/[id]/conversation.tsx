/**
 * L'onglet « Activité & conversation ».
 *
 * Deux lectures du même passé, côte à côte :
 *
 *   à gauche, la CONVERSATION — ce qui a été dit, dans l'ordre où on l'a dit,
 *   présenté comme une discussion parce que c'en est une ;
 *   à droite, l'ACTIVITÉ — tout le reste : manifestes, transitions d'état,
 *   analyses. Des faits que personne n'a prononcés.
 *
 * Les deux panneaux défilent SÉPARÉMENT et à l'intérieur d'eux-mêmes. Un fil de
 * deux cents messages ne doit pas transformer la fiche en page de trois mètres
 * où l'en-tête et le score auraient disparu de l'écran : on lit une
 * conversation en gardant le prospect sous les yeux.
 *
 * ---------------------------------------------------------------------------
 * Ce que cet onglet n'a pas
 * ---------------------------------------------------------------------------
 *
 * Aucun champ de saisie, aucun bouton d'envoi, aucun formulaire, aucune action
 * serveur. La ressemblance avec une messagerie s'arrête à la lecture. Le rail
 * sortant n'a qu'un chemin — un manifeste verrouillé, validé par un humain — et
 * il ne passe pas par le CRM. Un pied de panneau le DIT plutôt que de laisser
 * croire à une zone désactivée qu'il suffirait d'activer.
 */

import { Avatar, Badge, CHANNEL_ICON, Card, EmptyState } from '@/app/crm/ui';
import { Icon } from '@/app/crm/icons';
import { ActivityEvent } from './parts';
import {
  groupConversationByDay,
  type CrmConversation,
  type CrmConversationEntry,
} from '@/lib/crm/conversation';
import {
  CHANNEL_LABELS,
  CHANNEL_TONE,
  formatTime,
  groupTimelineByDay,
  type CrmTimelineEntry,
  type CrmTone,
} from '@/lib/crm/view';

/** Le libellé du statut, tel qu'il s'affiche sous la bulle. */
const STATUS_LABEL: Readonly<Record<CrmConversationEntry['status'], string>> = Object.freeze({
  sent: 'envoyé',
  received: 'reçu',
  draft: 'brouillon — jamais envoyé',
  failed: 'non remis',
});

const STATUS_TONE: Readonly<Record<CrmConversationEntry['status'], CrmTone>> = Object.freeze({
  sent: 'violet',
  received: 'green',
  draft: 'orange',
  failed: 'red',
});

export function ConversationTab({
  conversation,
  timeline,
  prospectName,
  now,
}: {
  conversation: CrmConversation;
  timeline: readonly CrmTimelineEntry[];
  prospectName: string;
  now: number;
}) {
  const days = groupTimelineByDay(timeline, now);

  return (
    <div className="crm-convo-layout">
      <ConversationThread conversation={conversation} prospectName={prospectName} now={now} />

      <Card
        icon="activity"
        title="Activité"
        tone="slate"
        className="crm-activity-card"
        end={`${timeline.length} événement${timeline.length > 1 ? 's' : ''}`}
      >
        {timeline.length === 0 ? (
          <EmptyState icon="activity" title="Aucune activité pour le moment">
            Les événements apparaîtront ici : manifeste verrouillé, envoi, réponse.
          </EmptyState>
        ) : (
          <div className="crm-scroll">
            {days.map((day) => (
              <div key={day.key}>
                <div className="crm-day">{day.label}</div>
                <div className="crm-timeline">
                  {day.entries.map((entry) => (
                    <ActivityEvent key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Le fil lui-même.
 *
 * L'en-tête compte ce qui est parti et ce qui est revenu — deux chiffres réels,
 * pris sur les entrées du fil, jamais estimés.
 */
export function ConversationThread({
  conversation,
  prospectName,
  now,
}: {
  conversation: CrmConversation;
  prospectName: string;
  now: number;
}) {
  const days = groupConversationByDay(conversation.entries, now);

  return (
    <section className="crm-card crm-convo" data-tone="violet">
      <div className="crm-card-head">
        <Icon name="message" size={15} />
        <h2>Conversation</h2>
        <div className="end">
          {conversation.entries.length === 0 ? null : (
            <span className="crm-convo-counts">
              <span>{conversation.sent} envoyé{conversation.sent > 1 ? 's' : ''}</span>
              <span>·</span>
              <span>{conversation.received} reçu{conversation.received > 1 ? 's' : ''}</span>
              {conversation.channels.map((channel) => (
                <Badge key={channel} tone={CHANNEL_TONE[channel]} icon={CHANNEL_ICON[channel]}>
                  {CHANNEL_LABELS[channel]}
                </Badge>
              ))}
            </span>
          )}
        </div>
      </div>

      {conversation.entries.length === 0 ? (
        <EmptyState icon="message" title="Aucun message pour le moment">
          Ni envoi ni réponse n’a encore été enregistré pour ce prospect. Ce panneau lit les
          événements réels — il n’en fabrique aucun.
        </EmptyState>
      ) : (
        <div
          className="crm-thread crm-scroll"
          role="log"
          aria-label={`Conversation avec ${prospectName}`}
        >
          {days.map((day) => (
            <div key={day.key}>
              <div className="crm-day">{day.label}</div>
              {day.entries.map((entry) => (
                <MessageBubble key={entry.id} entry={entry} prospectName={prospectName} />
              ))}
            </div>
          ))}
        </div>
      )}

      <ReadOnlyFooter />
    </section>
  );
}

/**
 * Une bulle, et de qui elle vient.
 *
 * Trois façons de distinguer les interlocuteurs plutôt qu'une : le NOM écrit en
 * toutes lettres, la TEINTE de la bulle, et la PASTILLE d'identité. La couleur
 * seule ne suffirait pas — elle ne dit rien à qui ne la voit pas, et deux
 * violets voisins se confondent au balayage.
 *
 * Un brouillon porte la même bulle qu'un envoi, mais bordée de pointillés et
 * étiquetée « jamais envoyé » : c'est un texte que Hermes a écrit, pas un
 * texte que le prospect a lu, et l'écran ne doit jamais laisser confondre les
 * deux.
 */
export function MessageBubble({
  entry,
  prospectName,
}: {
  entry: CrmConversationEntry;
  prospectName: string;
}) {
  const mine = entry.side === 'hermes';

  if (entry.side === 'system') {
    return (
      <div className="crm-msg-note" data-tone={STATUS_TONE[entry.status]}>
        <Icon name="alert" size={13} />
        <span>
          <b>{STATUS_LABEL[entry.status]}</b>
          {entry.body.length === 0 ? null : <> — {entry.body}</>}
          {entry.facts.length === 0 ? null : (
            <span className="meta">{entry.facts.join(' · ')}</span>
          )}
        </span>
        <span className="when">{formatTime(entry.occurredAt)}</span>
      </div>
    );
  }

  return (
    <article className="crm-msg" data-side={entry.side} data-status={entry.status}>
      {mine ? (
        <span className="crm-avatar sm" data-tone="violet" aria-hidden="true">
          <Icon name="spark-mark" size={15} />
        </span>
      ) : (
        <Avatar name={prospectName} tone="slate" />
      )}

      <div className="b">
        <div className="crm-msg-head">
          <b>{mine ? (entry.origin === 'machine' ? 'Hermes (auto)' : 'Hermes (vous)') : prospectName}</b>
          <span className="when">{formatTime(entry.occurredAt)}</span>
        </div>

        <div className="crm-msg-body">{entry.body}</div>

        <div className="crm-msg-meta">
          {entry.channel === null ? (
            <span>canal non observé</span>
          ) : (
            <span className="ch" data-tone={CHANNEL_TONE[entry.channel]}>
              <Icon name={CHANNEL_ICON[entry.channel]} size={12} />
              {CHANNEL_LABELS[entry.channel]}
            </span>
          )}
          <span className="st" data-tone={STATUS_TONE[entry.status]}>
            {STATUS_LABEL[entry.status]}
          </span>
          {entry.facts.map((fact) => (
            <span className="crm-fact" key={fact} title={fact}>
              {fact}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

/**
 * Le pied du fil.
 *
 * Il occupe la place où une messagerie mettrait sa zone de saisie, et il dit
 * pourquoi il n'y en a pas. Une zone grisée aurait suggéré un interrupteur ;
 * une phrase ne suggère rien.
 */
function ReadOnlyFooter() {
  return (
    <div className="crm-readonly" data-tone="slate">
      <Icon name="lock" size={14} />
      <span>
        <b>Lecture seule.</b> Aucune réponse ne part d’ici : un envoi passe par un manifeste
        verrouillé et validé par un humain.
      </span>
    </div>
  );
}
