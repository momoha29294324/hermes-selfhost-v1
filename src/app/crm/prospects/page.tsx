import Link from 'next/link';
import { listCrmProspects, parseSort, type CrmProspect, type CrmProspectSort } from '@/lib/crm/queries';
import { paginate, parsePage, type CrmPage } from '@/lib/crm/paginate';
import {
  CHANNEL_LABELS,
  CHANNEL_TONE,
  CRM_CHANNELS,
  CRM_LANES,
  bandTone,
  channelFromTransport,
  formatAge,
  laneTone,
  prospectTone,
  shortenUrl,
  type CrmChannel,
  type CrmLane,
  type CrmTone,
} from '@/lib/crm/view';
import { CrmUnavailable } from '@/app/crm/unavailable';
import { RowNav } from '@/app/crm/row-nav';
import { Icon, type IconName } from '@/app/crm/icons';
import {
  Avatar,
  Badge,
  CHANNEL_ICON,
  ChannelBadge,
  EmptyState,
  ScoreChip,
  StateBadge,
  TermBadge,
} from '@/app/crm/ui';
import { nextActionTerm } from '@/lib/crm/vocabulary';

export const dynamic = 'force-dynamic';

interface Params {
  q?: string;
  lane?: string;
  channel?: string;
  band?: string;
  sort?: string;
  page?: string;
}

const BANDS: readonly string[] = ['A', 'B', 'C', 'D'];

const SORT_COLUMNS: readonly { readonly key: CrmProspectSort; readonly label: string }[] = [
  { key: 'name', label: 'Entreprise' },
  { key: 'city', label: 'Localisation' },
  { key: 'score', label: 'Score' },
  { key: 'outreach', label: 'Dernier envoi' },
  { key: 'reply', label: 'Réponse' },
];

/**
 * Les cinq cartes du haut de page.
 *
 * Chacune est un FILTRE, pas un ornement : le nombre affiché est celui de la
 * colonne du pipeline correspondante, et cliquer la carte applique exactement
 * ce filtre. Les colonnes restantes (sorties, arbitrages) descendent dans la
 * rangée de pills en dessous — elles existent, elles sont atteignables, mais
 * elles ne prennent pas la place du travail en cours.
 *
 * Aucune de ces valeurs n'est estimée : ce sont des `length` de tableaux déjà
 * dérivés par `resolveLane`.
 */
const METRICS: readonly {
  readonly lane: CrmLane | null;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { lane: null, label: 'Tous les prospects', icon: 'users' },
  { lane: 'QUALIFIED', label: 'Qualifiés', icon: 'check' },
  { lane: 'READY_TO_CONTACT', label: 'Prêts à contacter', icon: 'lock' },
  { lane: 'CONTACTED', label: 'Contactés', icon: 'send' },
  { lane: 'REPLIED', label: 'Ont répondu', icon: 'reply' },
];

const METRIC_LANES: readonly CrmLane[] = METRICS.map((metric) => metric.lane).filter(
  (lane): lane is CrmLane => lane !== null,
);

/**
 * Un lien qui porte l'état complet de la liste.
 *
 * Toute modification qui n'est PAS un changement de page ramène à la premiere :
 * changer de filtre depuis la page 7 pour atterrir sur la page 7 d'un lot plus
 * petit n'a jamais ete ce que quelqu'un voulait. `paginate` borne de toute
 * facon, mais l'URL doit dire la meme chose que l'ecran.
 */
function href(params: Params, patch: Partial<Params>): string {
  const merged: Params = { ...params, ...patch, ...(patch.page === undefined ? { page: '' } : {}) };
  const search = new URLSearchParams();
  if (merged.q) search.set('q', merged.q);
  if (merged.lane) search.set('lane', merged.lane);
  if (merged.channel) search.set('channel', merged.channel);
  if (merged.band) search.set('band', merged.band);
  if (merged.sort && merged.sort !== 'score') search.set('sort', merged.sort);
  if (merged.page && merged.page !== '1') search.set('page', merged.page);
  const query = search.toString();
  return query.length === 0 ? '/crm/prospects' : `/crm/prospects?${query}`;
}

export default async function CrmProspectsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const lane = CRM_LANES.find((entry) => entry.key === params.lane)?.key ?? null;
  const channel = CRM_CHANNELS.find((entry) => entry === params.channel) ?? null;
  const band = BANDS.find((entry) => entry === params.band) ?? null;
  const query = (params.q ?? '').trim();

  let all: CrmProspect[];
  try {
    // Chargé une seule fois, non filtré : les compteurs des filtres doivent
    // dire « combien il y en aurait », pas « combien il en reste après ce que
    // je viens de cliquer ». Un compteur qui tombe à zéro sur son propre
    // filtre n'apprend rien.
    all = await listCrmProspects({ q: query, sort });
  } catch (error) {
    return <CrmUnavailable error={error} />;
  }

  const rows = all.filter(
    (row) =>
      (lane === null || row.lane === lane) &&
      (channel === null || row.bestChannel === channel || row.channels.includes(channel)) &&
      (band === null || row.scoreBand === band),
  );

  const laneCounts = countBy(all, (row) => row.lane);
  const channelCounts = new Map<CrmChannel, number>();
  for (const row of all) {
    for (const entry of new Set<CrmChannel>([...(row.bestChannel ? [row.bestChannel] : []), ...row.channels])) {
      channelCounts.set(entry, (channelCounts.get(entry) ?? 0) + 1);
    }
  }
  const bandCounts = countBy(all, (row) => row.scoreBand);
  const upstream = all.filter((row) => row.lane === null).length;

  const now = Date.now();
  const filtered = lane !== null || channel !== null || band !== null || query.length > 0;
  // Les compteurs ci-dessus lisent `all` et `rows` — le lot ENTIER. Seule la
  // table est decoupee : un compteur qui suivrait la page n'apprendrait rien.
  const slice = paginate(rows, parsePage(params.page));

  // Les colonnes qui n'ont pas de carte : rendues en pills, et seulement quand
  // elles portent quelque chose (ou qu'on les regarde).
  const secondaryLanes = CRM_LANES.filter(
    (entry) =>
      !METRIC_LANES.includes(entry.key) && ((laneCounts.get(entry.key) ?? 0) > 0 || lane === entry.key),
  );

  return (
    <>
      <div className="crm-head">
        <div className="crm-head-titles">
          <h1>Prospects</h1>
          <div className="sub">
            {filtered ? `${rows.length} sur ${all.length} entreprises` : `${all.length} entreprises`}
            {upstream === 0 ? '' : ` · ${upstream} en amont du pipeline`}
          </div>
        </div>

        <form action="/crm/prospects" method="get">
          {lane === null ? null : <input type="hidden" name="lane" value={lane} />}
          {channel === null ? null : <input type="hidden" name="channel" value={channel} />}
          {band === null ? null : <input type="hidden" name="band" value={band} />}
          {sort === 'score' ? null : <input type="hidden" name="sort" value={sort} />}
          <label className="crm-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Rechercher une entreprise, une ville, un domaine…"
              data-crm-search
              aria-label="Rechercher un prospect"
            />
            <span className="crm-kbd">/</span>
          </label>
        </form>

        <Link className="crm-btn primary" href="/crm/pipeline" prefetch={false}>
          <Icon name="board" size={15} />
          Pipeline
        </Link>
      </div>

      <div className="crm-body">
        <div className="crm-metrics">
          {METRICS.map((metric) => {
            const count = metric.lane === null ? all.length : (laneCounts.get(metric.lane) ?? 0);
            const active = metric.lane === lane;
            const tone: CrmTone = metric.lane === null ? 'violet' : laneTone(metric.lane);
            return (
              <Link
                key={metric.label}
                className={`crm-metric${active ? ' active' : ''}`}
                data-tone={tone}
                href={href(params, { lane: active ? '' : (metric.lane ?? '') })}
                prefetch={false}
              >
                <div className="top">
                  <span className="crm-ic">
                    <Icon name={metric.icon} size={15} />
                  </span>
                  <span className="lb">{metric.label}</span>
                </div>
                <div className="v">{count}</div>
                <div className="s">
                  {metric.lane === null
                    ? `${upstream} en amont du pipeline`
                    : count === 0
                      ? 'aucun pour l’instant'
                      : `${share(count, all.length)} du total`}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="crm-toolbar">
          {secondaryLanes.length === 0 ? null : (
            <div className="crm-filters">
              <span className="crm-filter-label">Étape</span>
              {secondaryLanes.map((entry) => (
                <Link
                  key={entry.key}
                  className={`crm-chip${lane === entry.key ? ' active' : ''}`}
                  data-tone={laneTone(entry.key)}
                  href={href(params, { lane: lane === entry.key ? '' : entry.key })}
                  prefetch={false}
                  title={entry.rule}
                >
                  <i className="dot" />
                  {entry.label}
                  <span className="n">{laneCounts.get(entry.key) ?? 0}</span>
                </Link>
              ))}
            </div>
          )}

          <div className="crm-filters">
            <span className="crm-filter-label">Canal</span>
            {CRM_CHANNELS.map((entry) => {
              const count = channelCounts.get(entry) ?? 0;
              if (count === 0 && channel !== entry) return null;
              return (
                <Link
                  key={entry}
                  className={`crm-chip${channel === entry ? ' active' : ''}`}
                  data-tone={CHANNEL_TONE[entry]}
                  href={href(params, { channel: channel === entry ? '' : entry })}
                  prefetch={false}
                >
                  <Icon name={CHANNEL_ICON[entry]} size={14} />
                  {CHANNEL_LABELS[entry]}
                  <span className="n">{count}</span>
                </Link>
              );
            })}

            <span className="crm-filter-label" style={{ marginLeft: 10 }}>
              Bande
            </span>
            {BANDS.map((entry) => {
              const count = bandCounts.get(entry) ?? 0;
              if (count === 0 && band !== entry) return null;
              return (
                <Link
                  key={entry}
                  className={`crm-chip${band === entry ? ' active' : ''}`}
                  data-tone={bandTone(entry)}
                  href={href(params, { band: band === entry ? '' : entry })}
                  prefetch={false}
                >
                  <i className="dot" />
                  {entry}
                  <span className="n">{count}</span>
                </Link>
              );
            })}

            {filtered ? (
              <Link className="crm-chip" href="/crm/prospects" prefetch={false} style={{ marginLeft: 'auto' }}>
                <Icon name="ban" size={13} />
                Réinitialiser
              </Link>
            ) : null}
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon="search" title="Aucun prospect pour ce filtre">
            {all.length} entreprises existent en base. Retirez un filtre, ou élargissez la recherche.
          </EmptyState>
        ) : (
          <>
            <RowNav />
            <div className="crm-panelcard">
              <table className="crm-table fixed">
                {/*
                  Largeurs déclarées plutôt que déduites du contenu. En
                  `table-layout: auto`, un nom de domaine long élargit la table
                  au-delà de la fenêtre et la dernière colonne sort de l'écran —
                  `max-width` sur un `td` n'y change rien. En `fixed`, la table
                  tient dans sa largeur et chaque cellule tronque proprement.
                */}
                <colgroup>
                  <col style={{ width: '21%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '5.5%' }} />
                  <col style={{ width: '9.5%' }} />
                  <col style={{ width: '8.5%' }} />
                  <col style={{ width: '16.5%' }} />
                </colgroup>
                <thead>
                  <tr>
                    {SORT_COLUMNS.slice(0, 3).map((column) => (
                      <th key={column.key}>
                        <Link
                          href={href(params, { sort: column.key })}
                          className={sort === column.key ? 'on' : ''}
                          prefetch={false}
                        >
                          {column.label}
                          {sort === column.key ? ' ↓' : ''}
                        </Link>
                      </th>
                    ))}
                    <th>Étape</th>
                    <th>Canal</th>
                    <th>Liens</th>
                    {SORT_COLUMNS.slice(3).map((column) => (
                      <th key={column.key}>
                        <Link
                          href={href(params, { sort: column.key })}
                          className={sort === column.key ? 'on' : ''}
                          prefetch={false}
                        >
                          {column.label}
                          {sort === column.key ? ' ↓' : ''}
                        </Link>
                      </th>
                    ))}
                    <th>Prochaine action</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.rows.map((row) => (
                    <ProspectRow key={row.id} row={row} now={now} />
                  ))}
                </tbody>
              </table>
              <Pager slice={slice} params={params} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ProspectRow({ row, now }: { row: CrmProspect; now: number }) {
  const target = `/crm/prospects/${row.id}`;
  const site = shortenUrl(row.websiteUrl);
  const handle = row.instagramHandle === null ? null : row.instagramHandle.replace(/^@/, '');
  const outreachChannel = channelFromTransport(row.lastOutreachTransport);
  const tone = prospectTone(row);

  return (
    <tr data-href={target}>
      <td>
        <div className="crm-ident">
          <Avatar name={row.displayName} tone={tone} />
          <div className="txt">
            <Link className="name" href={target} prefetch={false}>
              {row.displayName}
            </Link>
            <span className="sub">
              {row.dedupeStatus === 'needs_review' ? 'doublon à arbitrer · ' : ''}
              {row.email ?? row.domain ?? row.legalName ?? '—'}
            </span>
          </div>
        </div>
      </td>

      <td>
        <span className="crm-cell">
          {row.city === null && row.postalCode === null ? null : <Icon name="pin" size={13} />}
          <span>
            {row.city ?? (row.postalCode === null ? '—' : row.postalCode)}
            {row.city !== null && row.postalCode !== null ? ` ${row.postalCode}` : ''}
          </span>
        </span>
      </td>

      <td>
        <ScoreChip score={row.score} band={row.scoreBand} />
      </td>

      <td>
        <StateBadge state={row.commercial} stage={row.stage} />
      </td>

      <td>
        <ChannelBadge channel={row.bestChannel} locked={row.lockedTransport !== null} />
      </td>

      <td>
        {site === null && handle === null ? (
          <span className="crm-dim">—</span>
        ) : (
          <span className="crm-links">
            {site === null ? null : (
              <a
                href={row.websiteUrl ?? '#'}
                target="_blank"
                rel="noreferrer noopener"
                title={site}
                data-tone="blue"
              >
                <Icon name="globe" size={14} />
              </a>
            )}
            {handle === null ? null : (
              <a
                href={`https://instagram.com/${handle}`}
                target="_blank"
                rel="noreferrer noopener"
                title={`@${handle}`}
                data-tone="rose"
              >
                <Icon name="instagram" size={14} />
              </a>
            )}
          </span>
        )}
      </td>

      <td>
        {row.lastOutreachAt === null ? (
          <span className="crm-dim">—</span>
        ) : (
          <span className="crm-stack">
            <span className="a">{formatAge(row.lastOutreachAt, now)}</span>
            {outreachChannel === null ? null : (
              <span className="b">{CHANNEL_LABELS[outreachChannel]}</span>
            )}
          </span>
        )}
      </td>

      <td>
        {row.lastReplyAt === null ? (
          <span className="crm-dim">—</span>
        ) : (
          <span className="crm-stack">
            <span className="a">{formatAge(row.lastReplyAt, now)}</span>
            {row.lastReplyClassification === null ? null : (
              <span className="b">{row.lastReplyClassification}</span>
            )}
          </span>
        )}
      </td>

      <td>
        <NextAction row={row} />
      </td>
    </tr>
  );
}

/**
 * Ce que le système SAIT qu'il faudrait faire ensuite, jamais un conseil
 * inventé — et rien du tout quand il ne sait pas.
 *
 * L'analyse de réponse a le dernier mot quand elle existe : c'est la seule
 * source qui ait vu un message entrant. Sinon, la colonne du pipeline dit ce
 * qu'elle affirme déjà, sans le répéter pour les 73 lignes qualifiées — « choisir
 * un canal » sur toute une colonne n'apprend rien et fait baisser l'attention
 * sur les quatre lignes qui, elles, demandent une décision.
 *
 * ---------------------------------------------------------------------------
 * Le palier vient de l'action, pas de la colonne
 * ---------------------------------------------------------------------------
 *
 * C'est ici que la hiérarchie de la liste se joue. `HUMAN_REPLY_NOW` porte le
 * palier 1 et devient la seule chose visible en balayant la page ; « attendre
 * la réponse » porte le palier 4 et disparaît presque, ce qui est exactement
 * son importance. Les deux étaient auparavant deux pastilles de même taille.
 *
 * `nextActionTerm` traduit l'identifiant et CONSERVE sa valeur en infobulle :
 * l'opérateur lit du français, la base garde le dernier mot.
 */
function NextAction({ row }: { row: CrmProspect }) {
  const term = nextActionTerm(row.recommendedNextAction);
  if (term !== null) {
    return <TermBadge term={term} icon="target" />;
  }
  if (row.doNotContact) {
    return (
      <Badge tone="red" tier={1} icon="ban">
        Ne pas contacter
      </Badge>
    );
  }
  if (row.lane === 'READY_TO_CONTACT') {
    return (
      <Badge tone="blue" tier={2} icon="lock">
        Manifeste prêt
      </Badge>
    );
  }
  if (row.lane === 'CONTACTED') {
    return (
      <Badge tone="cyan" tier={4} icon="clock">
        Attendre la réponse
      </Badge>
    );
  }
  return <span className="crm-dim">—</span>;
}

/**
 * La pagination — un rang lisible, deux boutons, rien de plus.
 *
 * Elle dit le RANG des lignes affichées (« 1–50 sur 424 »), jamais seulement le
 * numéro de page : « page 3 sur 9 » oblige à faire une multiplication de tête
 * pour savoir où l'on en est dans le tri.
 *
 * Elle disparaît quand il n'y a qu'une page. Une pagination inerte sous une
 * liste de douze lignes est un contrôle qui ment sur la taille du lot.
 */
function Pager({ slice, params }: { slice: CrmPage<CrmProspect>; params: Params }) {
  if (slice.pages <= 1) return null;
  const previous = slice.page > 1 ? href(params, { page: String(slice.page - 1) }) : null;
  const next = slice.page < slice.pages ? href(params, { page: String(slice.page + 1) }) : null;

  return (
    <nav className="crm-pager" aria-label="Pagination des prospects">
      <span className="range">
        <b>
          {slice.from}–{slice.to}
        </b>{' '}
        sur {slice.total}
        <span className="crm-dim"> · page {slice.page} sur {slice.pages}</span>
      </span>
      <span className="nav">
        {previous === null ? (
          <span className="crm-pager-btn is-off" aria-hidden="true">
            <Icon name="arrow-left" size={14} />
            Précédent
          </span>
        ) : (
          <Link className="crm-pager-btn" href={previous} rel="prev" prefetch={false}>
            <Icon name="arrow-left" size={14} />
            Précédent
          </Link>
        )}
        {next === null ? (
          <span className="crm-pager-btn is-off" aria-hidden="true">
            Suivant
            <Icon name="arrow-right" size={14} />
          </span>
        ) : (
          <Link className="crm-pager-btn" href={next} rel="next" prefetch={false}>
            Suivant
            <Icon name="arrow-right" size={14} />
          </Link>
        )}
      </span>
    </nav>
  );
}

/** Une part réellement calculée, arrondie à l'entier — jamais une estimation. */
function share(count: number, total: number): string {
  if (total === 0) return '0 %';
  return `${Math.round((count / total) * 100)} %`;
}

function countBy<T, K>(rows: readonly T[], key: (row: T) => K | null): Map<K, number> {
  const counts = new Map<K, number>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
