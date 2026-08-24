import Link from 'next/link';
import { loadCrmPipeline, type CrmPipeline, type CrmProspect } from '@/lib/crm/queries';
import {
  CHANNEL_SHORT,
  bandTone,
  boardLayout,
  formatAge,
  laneTone,
  type CrmLaneDefinition,
} from '@/lib/crm/view';
import { nextActionTerm } from '@/lib/crm/vocabulary';
import { CrmUnavailable } from '@/app/crm/unavailable';

export const dynamic = 'force-dynamic';

/**
 * Le pipeline commercial, en lecture.
 *
 * Aucun glisser-déposer, et c'est une décision, pas un manque : déplacer une
 * carte est une transition de `r6b_prospect_state_transitions`, un journal
 * append-only avec une contrainte d'idempotence par cause et un état terminal
 * (`SUPPRESSED`). L'écrire depuis une interface exigerait de porter
 * `cause_kind = 'human'` et de valider la transition par la machine à états —
 * une mission en soi. Un glisser-déposer qui ne persisterait pas serait pire :
 * il donnerait l'illusion d'avoir décidé quelque chose.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi dix colonnes ne pèsent pas le même poids
 * ---------------------------------------------------------------------------
 *
 * CRM1 rendait les dix colonnes à égalité. Sur l'état réel du dépôt — un envoi,
 * aucune réponse — cela donnait cinq colonnes terminales vides occupant près de
 * la moitié de la largeur, et un funnel actif comprimé sur l'autre moitié. La
 * lecture devenait celle d'un schéma de base de données plutôt que celle d'un
 * travail en cours.
 *
 * Les colonnes vides ne sont pas masquées pour autant : une sortie vide se
 * replie dans un bloc compact qui garde son libellé, son compteur et un lien
 * vers son filtre. Une sortie PEUPLÉE ne se replie jamais, quelle que soit sa
 * place dans le funnel — c'est la seule règle, et elle est dans `view.ts`.
 */
export default async function CrmPipelinePage() {
  let pipeline: CrmPipeline;
  try {
    pipeline = await loadCrmPipeline();
  } catch (error) {
    return <CrmUnavailable error={error} />;
  }

  const now = Date.now();
  const inPipeline = pipeline.total - pipeline.upstream;
  const counts = countLanes(pipeline);
  const layout = boardLayout(counts);

  return (
    <>
      <div className="crm-head">
        <div className="crm-head-titles">
          <h1>Pipeline</h1>
          <div className="sub">
            {inPipeline} dans le pipeline · {pipeline.upstream} en amont · {pipeline.total} au total
          </div>
        </div>
        <span className="crm-meta" style={{ marginLeft: 'auto' }}>
          lecture seule — une transition d’état passe par la machine à états
        </span>
      </div>

      <div className="crm-body">
        <Distribution pipeline={pipeline} counts={counts} lanes={[...layout.primary, ...layout.terminal]} />

        <div className="crm-board">
          {[...layout.primary, ...layout.terminal].map((lane) => (
            <Lane key={lane.key} lane={lane} rows={pipeline.lanes[lane.key]} now={now} />
          ))}

        </div>

        {/*
          Les sorties vides passent SOUS le tableau, en bande.
          En colonne, elles occupaient 150 px de la largeur utile et — six
          colonnes peuplées plus tard — se faisaient couper au bord droit : un
          bloc dont le rôle est de dire « ces états existent et sont
          atteignables » était précisément celui qu'on ne voyait pas. En bande,
          il ne coûte plus de largeur à personne et reste entièrement lisible.
        */}
        {layout.collapsed.length === 0 ? null : (
          <section className="crm-lane-fold" aria-label="États terminaux sans prospect">
            <span className="crm-lane-fold-head">Sorties — aucun prospect</span>
            <ul>
              {layout.collapsed.map((lane) => (
                <li key={lane.key}>
                  {/* Un lien, pas un libellé mort : chaque état reste
                      atteignable, et sa page dit elle-même qu'elle est vide. */}
                  <Link href={`/crm/prospects?lane=${lane.key}`} title={lane.rule} prefetch={false}>
                    <span>{lane.label}</span>
                    <span className="n">{counts[lane.key]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

/**
 * La zone de distribution — ce que le tableau ne peut PAS dire.
 *
 * Un tableau de colonnes répond à « qui est où ». Il ne répond pas à « comment
 * ce lot se répartit », parce que la hauteur d'une colonne est bornée par
 * l'écran : « Qualifiés » et « Contactés » avaient l'air d'être du même ordre
 * alors qu'ils sont dans un rapport de dix-huit à un.
 *
 * Rien ici n'est estimé. Chaque segment est un `length` de tableau déjà dérivé
 * par `resolveLane`, chaque part est ce `length` divisé par le total du lot et
 * arrondi à l'entier, et chaque légende est un LIEN vers le filtre exact de la
 * liste — donc vérifiable d'un clic. Une colonne vide n'apparaît pas : un
 * segment de zéro pixel avec une étiquette serait un mensonge de mise en page.
 */
function Distribution({
  pipeline,
  counts,
  lanes,
}: {
  pipeline: CrmPipeline;
  counts: Record<keyof CrmPipeline['lanes'], number>;
  lanes: readonly CrmLaneDefinition[];
}) {
  const inPipeline = pipeline.total - pipeline.upstream;
  const shown = lanes.filter((lane) => (counts[lane.key] ?? 0) > 0);
  const sum = shown.reduce((total, lane) => total + (counts[lane.key] ?? 0), 0);

  return (
    <section className="crm-funnel" aria-label="Répartition du pipeline">
      <div className="crm-funnel-stats">
        <div className="crm-funnel-stat" data-tone="violet">
          <span className="n">{inPipeline}</span>
          <span className="l">dans le pipeline</span>
        </div>
        <div className="crm-funnel-stat" data-tone="slate">
          <span className="n">{pipeline.upstream}</span>
          <span className="l">en amont</span>
        </div>
        <div className="crm-funnel-stat" data-tone="cyan">
          <span className="n">{pipeline.total}</span>
          <span className="l">au total</span>
        </div>
      </div>

      <div className="crm-funnel-right">
        {sum === 0 ? null : (
          <div className="crm-funnel-bar" aria-hidden="true">
            {shown.map((lane) => (
              <i
                key={lane.key}
                data-tone={laneTone(lane.key)}
                style={{ flex: `${counts[lane.key] ?? 0} 0 0` }}
              />
            ))}
          </div>
        )}

        <div className="crm-funnel-legend">
          {shown.map((lane) => (
            <Link
              key={lane.key}
              data-tone={laneTone(lane.key)}
              href={`/crm/prospects?lane=${lane.key}`}
              title={lane.rule}
              prefetch={false}
            >
              <i />
              {lane.label}
              <b>{counts[lane.key] ?? 0}</b>
              <span className="p">{share(counts[lane.key] ?? 0, sum)}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Une part réellement calculée, arrondie à l'entier — jamais une estimation. */
function share(count: number, total: number): string {
  if (total === 0) return '0 %';
  return `${Math.round((count / total) * 100)} %`;
}

function Lane({
  lane,
  rows,
  now,
}: {
  lane: CrmLaneDefinition;
  rows: readonly CrmProspect[];
  now: number;
}) {
  const empty = rows.length === 0;
  return (
    <section
      className={`crm-lane${empty ? ' is-empty' : ''}`}
      data-tone={laneTone(lane.key)}
      /* Une colonne PEUPLÉE qui demande une décision porte un filet de teinte
         en tête. C'est la seule différence de poids du tableau, et elle suit un
         fait : `laneTone` rend « orange » exactement pour les colonnes où
         quelqu'un attend — a répondu, a reporté, doit être arbitré. Peindre
         aussi les colonnes vides ferait clignoter un tableau au repos. */
      data-waiting={!empty && laneTone(lane.key) === 'orange' ? 'yes' : 'no'}
    >
      <div className="crm-lane-head">
        <div className="t">
          <span>{lane.label}</span>
          <span className="n">{rows.length}</span>
        </div>
        {/* La règle explique ce que la colonne AFFIRME. Elle n'a rien
            à dire d'une colonne vide, et n'y tiendrait pas. */}
        {empty ? null : <div className="rule">{lane.rule}</div>}
      </div>
      <div className="crm-lane-body">
        {rows.map((row) => (
          <Card key={row.id} row={row} now={now} />
        ))}
      </div>
    </section>
  );
}

/**
 * La carte d'un prospect dans sa colonne.
 *
 * ---------------------------------------------------------------------------
 * Le score n'est pas peint par la couleur de sa colonne
 * ---------------------------------------------------------------------------
 *
 * `--tone` valait la teinte de la COLONNE, si bien qu'un score de 72 s'affichait
 * en rouge dans « Pas intéressés » et en vert dans « Qualifiés ». Le même
 * nombre, deux jugements opposés, et aucun des deux n'était le sien. Le score
 * porte désormais la teinte de sa BANDE — celle que `bandTone` dérive du
 * barème — et il dit donc la même chose partout.
 *
 * Une action recommandée est signalée par une puce, jamais par un repeint de la
 * carte : c'est un fait sur UN prospect, pas sur sa colonne.
 */
function Card({ row, now }: { row: CrmProspect; now: number }) {
  const stamp = row.lastReplyAt ?? row.lastOutreachAt;
  const action = nextActionTerm(row.recommendedNextAction);
  return (
    <Link
      className="crm-pcard"
      data-tone={row.doNotContact ? 'red' : laneTone(row.lane)}
      href={`/crm/prospects/${row.id}`}
      prefetch={false}
    >
      <div className="name">
        {action === null ? null : (
          <i className="crm-pcard-flag" data-tone={action.tone} title={action.label} />
        )}
        {/* Le nom dans un span à lui : `text-overflow` ne s'applique pas au
            texte nu d'un conteneur flex, et sans lui un nom long était coupé
            net, sans l'ellipse qui dit qu'il continue. */}
        <span className="n" title={row.displayName}>
          {row.displayName}
        </span>
      </div>
      <div className="meta">
        <span>
          {[row.city, row.bestChannel === null ? null : CHANNEL_SHORT[row.bestChannel]]
            .filter((part): part is string => part !== null)
            .join(' · ') || '—'}
        </span>
        <span className="s" data-tone={bandTone(row.scoreBand)}>
          {row.score === null ? '—' : row.score}
          {stamp === null ? '' : ` · ${formatAge(stamp, now)}`}
        </span>
      </div>
    </Link>
  );
}

function countLanes(pipeline: CrmPipeline): Record<keyof CrmPipeline['lanes'], number> {
  return Object.fromEntries(
    Object.entries(pipeline.lanes).map(([lane, rows]) => [lane, rows.length]),
  ) as Record<keyof CrmPipeline['lanes'], number>;
}
