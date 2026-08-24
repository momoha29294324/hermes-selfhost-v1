/**
 * L'en-tête de la fiche — qui c'est, et quoi faire.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que CRM-UX-R1 corrige
 * ---------------------------------------------------------------------------
 *
 * CRM2 répondait aux mêmes questions DEUX fois. Sur la fiche de Northstar Studio,
 * « prochaine action » s'écrivait dans l'en-tête ET en gros dans la carte
 * centrale ; « état commercial » trois fois (bandeau, badge, carte) ; « dernier
 * envoi » deux fois. Chaque répétition coûtait de la hauteur, et l'ensemble
 * poussait la vue d'ensemble à 1 033 px — puis 1 784 px sur un prospect sans
 * activité, où les cartes vides prenaient plus de place que les pleines.
 *
 * La règle est désormais simple : ce qui est dit ICI n'est plus jamais répété
 * dans un panneau. L'en-tête porte les quatre réponses courtes, les onglets
 * portent le détail, et rien ne se chevauche.
 *
 * ---------------------------------------------------------------------------
 * Deux rangées, deux questions
 * ---------------------------------------------------------------------------
 *
 *   identité — QUI est-ce ? le nom, où, par quel compte, sous quelle campagne,
 *              et ce qu'il vaut. Des faits stables, qu'on lit une fois ;
 *   bandeau  — QUE FAIRE, et PUIS-JE ? l'action au palier 1, seule de son
 *              rang sur l'écran, puis l'état, le canal et le dernier échange
 *              au palier 3. C'est la seule rangée qu'on relit à chaque visite.
 *
 * Aucun bloc n'invente : quand la réponse n'existe pas, il l'écrit — « aucun
 * envoi », « non scoré » — plutôt qu'un tiret muet ou une valeur plausible.
 */

import Link from 'next/link';
import { Avatar, Badge, ScoreChip, StateBadge } from '@/app/crm/ui';
import { Icon, type IconName } from '@/app/crm/icons';
import { NEXT_ACTION_ICON } from './parts';
import type { CrmProspect, CrmScore } from '@/lib/crm/queries';
import type { CrmNextAction } from '@/lib/crm/next-action';
import { nextActionTerm } from '@/lib/crm/vocabulary';
import {
  CHANNEL_LABELS,
  bandTone,
  commercialShortLabel,
  formatAge,
  formatDateTime,
  prospectTone,
  shortenUrl,
  type CrmTone,
} from '@/lib/crm/view';

export function ProspectHeader({
  prospect,
  score,
  action,
  now,
}: {
  prospect: CrmProspect;
  score: CrmScore | null;
  action: CrmNextAction;
  now: number;
}) {
  const tone = prospectTone(prospect);
  const handle =
    prospect.instagramHandle === null ? null : prospect.instagramHandle.replace(/^@/, '');
  const site = shortenUrl(prospect.websiteUrl);

  return (
    <header className="crm-phead">
      <div className="crm-phead-id">
        <Avatar name={prospect.displayName} tone={tone} size="lg" />
        <div className="t">
          <Link className="crm-crumb" href="/crm/prospects" prefetch={false}>
            <Icon name="arrow-left" size={12} />
            Prospects
          </Link>
          <h1 title={prospect.displayName}>{prospect.displayName}</h1>
          <div className="facts">
            {prospect.city === null && prospect.postalCode === null ? null : (
              <span className="i">
                <Icon name="pin" size={12} />
                {[prospect.city, prospect.postalCode].filter((part) => part !== null).join(' ')}
              </span>
            )}
            {site === null ? null : (
              <a
                className="i"
                href={prospect.websiteUrl ?? '#'}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Icon name="globe" size={12} />
                {site}
              </a>
            )}
            {handle === null ? null : (
              <a
                className="i"
                href={`https://instagram.com/${handle}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Icon name="instagram" size={12} />@{handle}
              </a>
            )}
            <span className="i crm-dim">
              <Icon name="layers" size={12} />
              {prospect.campaignSlug}
            </span>
          </div>
        </div>

        <div className="crm-phead-right">
          {/* Le score est un fait d'IDENTITÉ — combien vaut ce prospect — et non
              une consigne. Il reste donc dans la rangée du haut, en chip, et le
              détail signal par signal appartient à la colonne de droite. */}
          {score === null ? (
            <span className="crm-badge" data-tone="slate" data-tier="4" title="aucun score enregistré">
              <Icon name="gauge" size={13} />
              <span>non scoré</span>
            </span>
          ) : (
            <span className="crm-scorebox" data-tone={bandTone(score.band)} title={`bande ${score.band}`}>
              <ScoreChip score={score.total} band={score.band} />
            </span>
          )}
          <StateBadge state={prospect.commercial} stage={prospect.stage} long />
          <Link className="crm-btn" href={`/prospects/${prospect.id}`} prefetch={false}>
            <Icon name="file" size={14} />
            Dossier complet
          </Link>
        </div>
      </div>

      <ActionStrip prospect={prospect} action={action} now={now} />
    </header>
  );
}

/**
 * Le bandeau de décision — la seule chose de palier 1 de l'écran.
 *
 * L'action occupe la largeur restante et porte la bande de teinte ; les trois
 * cellules qui la suivent sont des CONDITIONS de cette action, pas des
 * informations concurrentes : où en est la relation, par quel canal on peut
 * agir, et quand on s'est parlé pour la dernière fois. Elles sont au palier 3.
 *
 * L'identifiant canonique de l'action reste lisible sous sa traduction : c'est
 * lui qu'on retrouvera dans `r6b_reply_analyses`.
 */
function ActionStrip({
  prospect,
  action,
  now,
}: {
  prospect: CrmProspect;
  action: CrmNextAction;
  now: number;
}) {
  const term = nextActionTerm(prospect.recommendedNextAction);
  const label = term === null ? action.label : term.label;
  const tone = term === null ? action.tone : term.tone;
  const lastExchange = prospect.lastReplyAt ?? prospect.lastOutreachAt;

  return (
    <div className="crm-strip">
      <div className="crm-lead" data-tone={tone} data-tier="1">
        <span className="crm-ic">
          <Icon name={NEXT_ACTION_ICON[action.key]} size={16} />
        </span>
        <div className="tx">
          <span className="k">Prochaine action</span>
          <span className="v">{label}</span>
          {/* La ligne tronque sur les fenêtres étroites ; l'infobulle porte la
              phrase entière ET l'identifiant, donc rien n'y devient
              irrécupérable. */}
          <span
            className="s"
            title={term === null ? action.basis : `${action.basis} · ${term.raw}`}
          >
            {action.basis}
            {term === null ? null : <span className="crm-raw"> · {term.raw}</span>}
          </span>
        </div>
      </div>

      <StripCell
        tone={prospectTone(prospect)}
        icon="target"
        label="État commercial"
        value={commercialShortLabel({
          lane: prospect.lane,
          stage: prospect.stage,
          short: prospect.commercial.short,
        })}
        sub={
          prospect.commercial.source === 'state_machine'
            ? 'tenu par la machine à états'
            : 'déduit des faits'
        }
      />

      <StripCell
        tone={prospect.bestChannel === null ? 'slate' : 'blue'}
        icon="send"
        label="Canal"
        value={prospect.bestChannel === null ? 'non observé' : CHANNEL_LABELS[prospect.bestChannel]}
        sub={
          prospect.lockedTransport !== null
            ? 'figé par un manifeste'
            : prospect.channels.length === 0
              ? 'aucun canal observé'
              : `${prospect.channels.length} canaux observés`
        }
      />

      <StripCell
        tone={lastExchange === null ? 'slate' : prospect.lastReplyAt !== null ? 'green' : 'cyan'}
        icon="clock"
        label="Dernier échange"
        value={lastExchange === null ? 'aucun' : formatAge(lastExchange, now)}
        sub={
          lastExchange === null
            ? 'rien n’est parti vers ce prospect'
            : prospect.lastReplyAt !== null
              ? `réponse reçue · ${formatDateTime(prospect.lastReplyAt)}`
              : `envoi · ${formatDateTime(prospect.lastOutreachAt)}`
        }
      />
    </div>
  );
}

/** Une condition de l'action : palier 3, jamais concurrente de la décision. */
function StripCell({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: CrmTone;
  icon: IconName;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="crm-strip-cell" data-tone={tone} title={sub}>
      <span className="k">
        <Icon name={icon} size={11} />
        {label}
      </span>
      <span className="v">{value}</span>
      <span className="s">{sub}</span>
    </div>
  );
}

export { Badge };
