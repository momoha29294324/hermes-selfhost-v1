/**
 * Les primitives visuelles de CRM2.
 *
 * Huit composants, et rien d'autre : carte, en-tête de section, métrique,
 * badge, pastille d'identité, chip de score, ligne de canal, état vide. Toutes
 * les pages du CRM les partagent, ce qui est la seule façon d'éviter la dérive
 * qu'on connaît — une classe ad hoc par écran, puis cinq nuances de gris pour
 * la même information selon la page où on la lit.
 *
 * Aucun composant ne connaît de couleur. Ils reçoivent une TEINTE
 * (`CrmTone`, dérivée dans `view.ts` à partir des faits) et la posent en
 * `data-tone` ; la feuille de style fait le reste. C'est ce qui garantit que
 * « vert » veut dire la même chose dans la table, dans le pipeline et dans la
 * fiche.
 *
 * Aucun d'eux n'est un client component : le CRM reste rendu par le serveur, et
 * il n'y a rien à hydrater.
 */

import { Icon, type IconName } from '@/app/crm/icons';
import {
  CHANNEL_LABELS,
  CHANNEL_TONE,
  bandTone,
  commercialShortLabel,
  prospectTone,
  type CrmChannel,
  type CrmCommercialState,
  type CrmTier,
  type CrmTimelineKind,
  type CrmTone,
} from '@/lib/crm/view';
import type { CrmTerm } from '@/lib/crm/vocabulary';
import type { PipelineStage } from '@/lib/repo/types';

// ---------------------------------------------------------------------------
// Correspondances d'icônes — au plus près du rendu, jamais dans `view.ts`
// ---------------------------------------------------------------------------

export const CHANNEL_ICON: Readonly<Record<CrmChannel, IconName>> = Object.freeze({
  email: 'mail',
  instagram_dm: 'instagram',
  facebook_dm: 'facebook',
  whatsapp: 'message',
  sms: 'message',
  phone: 'phone',
  web_form: 'form',
});

export const TIMELINE_ICON: Readonly<Record<CrmTimelineKind, IconName>> = Object.freeze({
  manifest_locked: 'lock',
  outbound_sent: 'send',
  outbound_event: 'activity',
  send_failure: 'alert',
  inbound_reply: 'reply',
  reply_analysis: 'sparkle',
  reply_draft: 'pencil',
  conversation_plan: 'spark-mark',
  state_transition: 'arrow-right',
  milestone: 'flag',
  alert: 'bell',
});

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function Card({
  tone = 'slate',
  icon,
  title,
  end,
  children,
  className,
}: {
  tone?: CrmTone;
  icon?: IconName;
  title?: string;
  end?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`crm-card${className === undefined ? '' : ` ${className}`}`} data-tone={tone}>
      {title === undefined ? null : (
        <div className="crm-card-head">
          {icon === undefined ? null : <Icon name={icon} size={15} />}
          <h2>{title}</h2>
          {end === undefined ? null : <div className="end">{end}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Une pastille — et son POIDS.
 *
 * `tier` est ce que CRM2 n'avait pas : deux pastilles pouvaient dire des choses
 * d'importance très différente et se ressembler exactement. Le palier ne
 * change ni le texte ni la teinte, seulement la surface et le contraste, si
 * bien qu'une information peut reculer sans être retirée.
 *
 * Le défaut est 2 — l'état —, qui est ce qu'une pastille dit le plus souvent.
 */
export function Badge({
  tone = 'slate',
  tier = 2,
  icon,
  dot = false,
  variant,
  children,
  title,
}: {
  tone?: CrmTone;
  tier?: CrmTier;
  icon?: IconName;
  dot?: boolean;
  variant?: 'quiet' | 'solid';
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      className={`crm-badge${variant === undefined ? '' : ` ${variant}`}`}
      data-tone={tone}
      data-tier={tier}
      {...(title === undefined ? {} : { title })}
    >
      {dot ? <i className="dot" /> : null}
      {icon === undefined ? null : <Icon name={icon} size={13} />}
      <span>{children}</span>
    </span>
  );
}

/**
 * Un terme de la machine, dit à un opérateur — et son identifiant conservé.
 *
 * L'infobulle porte TOUJOURS l'identifiant canonique, y compris quand la
 * traduction est parfaitement claire : c'est ce qui permet de retrouver la
 * ligne en base sans quitter l'écran. Un terme inconnu s'affiche brut, en
 * palier 4, plutôt que d'être deviné ou masqué.
 */
export function TermBadge({
  term,
  icon,
  dot = true,
  tier,
}: {
  term: CrmTerm;
  icon?: IconName;
  dot?: boolean;
  tier?: CrmTier;
}) {
  return (
    <Badge
      tone={term.tone}
      tier={tier ?? term.tier}
      dot={dot && icon === undefined}
      {...(icon === undefined ? {} : { icon })}
      title={term.known ? term.raw : `${term.raw} — valeur inconnue de l’interface`}
    >
      {term.label}
    </Badge>
  );
}

/**
 * L'état commercial — la même phrase et la même couleur partout.
 *
 * L'étape de fabrication est nécessaire parce qu'un prospect hors pipeline n'a
 * pas d'état commercial : ce qu'on affiche alors est son étape, traduite. Sans
 * elle, la ligne dirait `rejected` en anglais au milieu d'une interface
 * française.
 */
export function StateBadge({
  state,
  stage,
  long = false,
}: {
  state: CrmCommercialState;
  stage: PipelineStage;
  long?: boolean;
}) {
  return (
    <Badge tone={prospectTone({ lane: state.lane, stage })} dot title={state.label}>
      {long && state.lane !== null
        ? state.label
        : commercialShortLabel({ lane: state.lane, stage, short: state.short })}
    </Badge>
  );
}

export function ScoreChip({ score, band }: { score: number | null; band: string | null }) {
  if (score === null) {
    return <span className="crm-dim crm-mono">—</span>;
  }
  return (
    <span className="crm-cell" data-tone={bandTone(band)}>
      <span className="crm-score">{score}</span>
      {band === null ? null : <span className="crm-band">{band}</span>}
    </span>
  );
}

/**
 * Le canal retenu. Le cadenas remplace le mot « verrouillé » : dans une cellule
 * de tableau, le mot poussait le nom du canal hors de la vue, alors que
 * l'information tient dans un glyphe (et dans l'infobulle).
 *
 * Palier 3 : par où l'on peut joindre quelqu'un est une PREUVE, pas un état.
 * En palier 2, chaque ligne portait une pastille pleine « Email » qui pesait
 * autant que l'état commercial et autant que l'action à mener.
 */
export function ChannelBadge({
  channel,
  locked = false,
}: {
  channel: CrmChannel | null;
  locked?: boolean;
}) {
  if (channel === null) return <span className="crm-dim">—</span>;
  return (
    <span
      className="crm-badge"
      data-tone={CHANNEL_TONE[channel]}
      data-tier="3"
      title={locked ? 'canal figé par un manifeste verrouillé' : CHANNEL_LABELS[channel]}
    >
      <Icon name={CHANNEL_ICON[channel]} size={13} />
      <span>{CHANNEL_LABELS[channel]}</span>
      {locked ? <Icon name="lock" size={12} /> : null}
    </span>
  );
}

/** La pastille d'identité d'une entreprise, teintée par son état commercial. */
export function Avatar({
  name,
  tone = 'slate',
  size,
}: {
  name: string;
  tone?: CrmTone;
  size?: 'lg';
}) {
  return (
    <span className={`crm-avatar${size === undefined ? '' : ` ${size}`}`} data-tone={tone} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

export function initial(name: string): string {
  const letters = Array.from(name.trim());
  return (letters[0] ?? '?').toUpperCase();
}

/** Un anneau qui dessine un nombre RÉEL, borné à 0–100. */
export function Ring({ value, tone = 'slate' }: { value: number; tone?: CrmTone }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className="crm-ring" data-tone={tone} style={{ '--pct': pct } as React.CSSProperties}>
      <b>{Math.round(value)}</b>
    </span>
  );
}

/**
 * Un état vide : une pastille, une phrase, une ligne. Jamais trois paragraphes
 * pour expliquer qu'il n'y a rien.
 */
export function EmptyState({
  icon,
  tone = 'slate',
  title,
  children,
}: {
  icon: IconName;
  tone?: CrmTone;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="crm-empty" data-tone={tone}>
      <span className="crm-ic lg">
        <Icon name={icon} size={18} />
      </span>
      <b>{title}</b>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}
