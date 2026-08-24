/**
 * L'onglet « Vue d'ensemble » — ce qu'on voit SANS FAIRE DÉFILER.
 *
 * ---------------------------------------------------------------------------
 * La contrainte, et pourquoi elle n'est pas cosmétique
 * ---------------------------------------------------------------------------
 *
 * Cette vue mesurait 1 033 px sur Northstar Studio et 1 784 px sur un prospect
 * sans activité — pour une fenêtre de portable qui en offre environ 650 une
 * fois l'en-tête et les onglets posés. Autrement dit : la réponse à « où en
 * est ce prospect ? » demandait de faire défiler, donc de MÉMORISER le haut de
 * l'écran pendant qu'on lisait le bas.
 *
 * Le paradoxe du prospect vide dit tout : avec zéro événement et aucun score,
 * la page était PLUS HAUTE qu'avec cent quarante-trois événements, parce que
 * chaque carte vide affichait une illustration et deux phrases d'explication.
 *
 * ---------------------------------------------------------------------------
 * Ce que la hauteur bornée n'autorise PAS
 * ---------------------------------------------------------------------------
 *
 * Elle n'autorise pas à supprimer une donnée. Trois moyens sont utilisés, dans
 * cet ordre, et aucun n'est une perte :
 *
 *   1. la DÉDUPLICATION — l'action, l'état, le canal et le dernier échange
 *      vivent dans le bandeau de l'en-tête et ne sont plus répétés ici. C'est
 *      ce qui a rendu le plus de hauteur, et cela n'a rien coûté ;
 *   2. le DÉFILEMENT INTERNE — la colonne d'activité défile dans sa carte, pas
 *      dans la page. Cent quarante-trois événements restent atteignables sans
 *      que la vue grandisse ;
 *   3. le RENVOI — ce qui est écourté le dit et pointe vers l'onglet qui le
 *      porte en entier. Chaque renvoi fonctionne.
 *
 * Un prospect pathologiquement riche RÉSUME donc, il ne s'étend pas.
 */

import Link from 'next/link';
import { Card, EmptyState } from '@/app/crm/ui';
import { ActivityEvent, ChannelLine, Row, ScoreCard } from './parts';
import { ObservationsCard, OpportunityCard, RiskCard } from './research';
import { TabLink } from './tabs';
import type { CrmProspect, CrmWorkspace } from '@/lib/crm/queries';
import {
  activeChannels,
  formatDate,
  groupTimelineByDay,
  shortenUrl,
  type CrmTimelineEntry,
} from '@/lib/crm/view';

/**
 * Ce que la colonne d'activité rend au serveur.
 *
 * Douze plutôt que cinq : la carte défile désormais dans sa propre boîte, donc
 * la limite ne sert plus à contenir la HAUTEUR de la page — elle borne le poids
 * du document. Douze événements couvrent une conversation récente entière sans
 * approcher le coût des cent quarante-trois d'un fil actif.
 */
const RECENT_LIMIT = 12;

export function OverviewTab({
  workspace,
  now,
}: {
  workspace: CrmWorkspace;
  now: number;
}) {
  const { prospect, research, score, timeline } = workspace;
  // Groupé par jour même en version courte : « 14:29 » seul ne dit pas de quel
  // jour il parle, et douze événements peuvent enjamber trois semaines.
  const recent = groupTimelineByDay(timeline.slice(0, RECENT_LIMIT), now);
  const active = activeChannels(timeline);

  /*
   * Le VIDE de la colonne de gauche, et ce qui le remplit.
   *
   * Sur un prospect sans événement — 414 des 424 du corpus —, la colonne de
   * gauche portait une carte courte suivie de six cents pixels de fond nu.
   * Aucune règle CSS ne pouvait corriger cela : ce qui manquait n'était pas de
   * la hauteur, c'était du CONTENU.
   *
   * Les observations de la recherche sont exactement ce contenu, et elles ne
   * sont pas une invention d'affichage : ce sont les phrases écrites par le
   * pipeline, avec leurs références de preuve. Elles vivaient déjà dans cette
   * vue, mais UNIQUEMENT quand aucun score n'existait — c'est-à-dire jamais
   * pour les prospects qu'on ouvre le plus.
   *
   * Une seule des deux colonnes les porte, et jamais les deux : la colonne de
   * droite garde son cas historique (aucun score), la gauche prend le cas
   * nouveau (aucune activité, mais un score). Quand ni l'un ni l'autre n'a de
   * quoi remplir, c'est la carte d'activité qui s'étend, et son état vide se
   * centre dans une surface bordée — un objet délibéré, pas un trou.
   */
  const hasObservations =
    research !== null &&
    (research.summary.trim().length > 0 || research.observations.length > 0);
  const observationsGoRight = score === null;
  const observationsGoLeft = timeline.length === 0 && hasObservations && !observationsGoRight;
  const activityFills = timeline.length > 0 || !observationsGoLeft;

  return (
    <div className="crm-panes">
      {/* --------------------------------------------- gauche : QUE S'EST-IL PASSÉ */}
      <div className="crm-pane">
        {/* La carte ne prend la place restante que si elle a de quoi la
            remplir : un état vide étiré sur cinq cents pixels donne un écran
            qui a l'air en panne, alors qu'il dit simplement « rien n'est encore
            arrivé ». */}
        <Card
          icon="activity"
          title="Activité récente"
          tone="cyan"
          end={`${timeline.length}`}
          {...(activityFills ? { className: 'crm-card-fill' } : { className: 'crm-card-firm' })}
        >
          {timeline.length === 0 ? (
            <EmptyState icon="activity" title="Aucune activité">
              Manifeste, envoi, réponse : rien n’est encore arrivé.
            </EmptyState>
          ) : (
            <>
              <div className="crm-scroll crm-card-scroll">
                {recent.map((day) => (
                  <div key={day.key}>
                    <div className="crm-day">{day.label}</div>
                    <div className="crm-timeline compact">
                      {day.entries.map((entry: CrmTimelineEntry) => (
                        <ActivityEvent key={entry.id} entry={entry} quiet />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <TabLink to="conversation">
                Voir toute l’activité ({timeline.length} événement
                {timeline.length > 1 ? 's' : ''})
              </TabLink>
            </>
          )}
        </Card>

        {observationsGoLeft ? <ObservationsCard research={research} fill /> : null}
      </div>

      {/* ------------------------------------------------- centre : QUI, ET PAR OÙ */}
      {/* Une seule carte, et c'est délibéré.
       *
       * Le résumé « Preuves & sources » qui vivait ici comptait quatre nombres
       * puis renvoyait vers l'onglet du même nom, lequel porte les mêmes lignes
       * en entier — un renvoi vers un renvoi, sur une vue dont la hauteur est
       * bornée. Rien n'est perdu : l'onglet `evidence` est intact, et il reste
       * atteignable depuis les onglets.
       *
       * Sa place n'est PAS remplacée par une autre carte. Elle est rendue à
       * l'identité et aux canaux, qui devaient jusqu'ici faire tenir cinq canaux
       * dans une boîte qui en montrait trois et cachait les autres derrière un
       * défilement interne — sur la carte dont le rôle est précisément de dire
       * par où joindre quelqu'un. */}
      <div className="crm-pane">
        <IdentityChannelsCard prospect={prospect} active={active} />
      </div>

      {/* -------------------------------------------- droite : CE QUE ÇA VAUT */}
      <div className="crm-pane">
        {/* Exactement UNE carte remplit la colonne, et c'est celle qui peut
            défiler. Sans cette règle, la colonne de droite laissait cent
            cinquante pixels de vide sous la dernière carte sur un prospect non
            scoré — un écran qui a l'air cassé alors qu'il est simplement à
            court de données. */}
        {score === null ? (
          <>
            <Card icon="gauge" title="Score" tone="slate" className="crm-card-firm">
              <p className="crm-prose crm-note">
                Aucun score enregistré — ce prospect n’a pas encore été évalué.
              </p>
            </Card>
            <ObservationsCard research={research} fill />
          </>
        ) : (
          <ScoreCard score={score} compact fill />
        )}

        <RiskCard research={research} />
        <OpportunityCard research={research} />
      </div>
    </div>
  );
}

/**
 * L'identité et les canaux — qui c'est, et par où on peut l'atteindre.
 *
 * Les deux vont ensemble : un canal sans raison sociale n'est qu'une adresse, et
 * une raison sociale sans canal n'est pas actionnable.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette carte ne défile plus
 * ---------------------------------------------------------------------------
 *
 * Elle partageait sa colonne avec un résumé de preuves, donc ses cinq canaux
 * disposaient d'environ 190 px pour en demander 240 : trois lignes visibles,
 * deux derrière un défilement interne. Un canal caché est un canal qu'on croit
 * absent — exactement ce que « non observé » sert à ne pas laisser croire.
 *
 * La colonne entière lui revient. Les faits d'identité passent de trois à
 * quatre (la localisation rejoint la raison sociale, le département et la
 * niche) et la liste des canaux ABSORBE la hauteur restante au lieu d'être
 * comprimée : le vide rendu par la carte retirée devient de la respiration
 * entre les canaux, pas un blanc sous la dernière ligne.
 *
 * Aucune donnée n'est inventée pour remplir : `Row` et `ChannelLine` rendent
 * « non observé » exactement comme avant, et la localisation vaut `null` quand
 * ni la ville ni le code postal ne sont observés.
 */
export function IdentityChannelsCard({
  prospect,
  active,
}: {
  prospect: CrmProspect;
  active: readonly string[];
}) {
  const handle =
    prospect.instagramHandle === null ? null : prospect.instagramHandle.replace(/^@/, '');
  const site = shortenUrl(prospect.websiteUrl);
  // Jointes plutôt qu'empilées : « Marseille 13008 » se lit d'un coup d'œil, et
  // deux lignes pour deux mots coûteraient la place d'un canal. Une seule des
  // deux observée suffit ; aucune ne l'étant, la ligne dit « non observé ».
  const location =
    [prospect.city, prospect.postalCode].filter((part) => part !== null).join(' ') || null;

  return (
    <Card icon="users" title="Identité & canaux" tone="slate" className="crm-card-fill">
      <dl className="crm-kv facts">
        <Row label="Raison sociale" value={prospect.legalName} />
        <Row label="Localisation" value={location} />
        <Row label="Département" value={prospect.department} />
        <Row label="Niche" value={prospect.nicheVerdict} mono />
      </dl>

      <div className="crm-channels roomy">
        <ChannelLine
          channel="email"
          value={prospect.email}
          best={prospect.bestChannel === 'email'}
          active={active.includes('email')}
        />
        <ChannelLine
          channel="phone"
          value={prospect.phone}
          best={prospect.bestChannel === 'phone'}
          active={active.includes('phone')}
        />
        <ChannelLine
          channel="instagram_dm"
          value={handle === null ? null : `@${handle}`}
          link={handle === null ? null : `https://instagram.com/${handle}`}
          best={prospect.bestChannel === 'instagram_dm'}
          active={active.includes('instagram_dm')}
        />
        <ChannelLine
          channel="facebook_dm"
          value={shortenUrl(prospect.facebookUrl)}
          link={prospect.facebookUrl}
          best={prospect.bestChannel === 'facebook_dm'}
          active={active.includes('facebook_dm')}
        />
        <ChannelLine
          channel="web_form"
          icon="globe"
          tone="blue"
          value={site}
          link={prospect.websiteUrl}
          best={false}
          active={false}
          label="Site"
        />
      </div>

      <p className="crm-prose crm-note">
        « non observé » n’est pas « inexistant » : c’est l’absence de preuve dans
        <span className="crm-mono"> prospect_evidence</span>.
      </p>
    </Card>
  );
}

export { formatDate, Link };
