/**
 * Les trois cartes de SYNTHÈSE de la recherche — observations, risque,
 * opportunité.
 *
 * Elles vivaient dans `overview.tsx`, qui portait à la fois la composition de
 * la vue et le rendu de six cartes. Les sortir ne change aucun rendu : c'est la
 * même règle que le reste de la fiche — un fichier par question, et aucun qui
 * dépasse la taille qu'on relit d'une traite.
 *
 * Aucune d'elles n'invente ni ne classe : le premier élément affiché est celui
 * que le pipeline a écrit en premier, et le renvoi mène à la liste complète.
 */

import { Card } from '@/app/crm/ui';
import { Prose } from './parts';
import { TabLink } from './tabs';
import type { CrmWorkspace } from '@/lib/crm/queries';

/**
 * Ce que la recherche a réellement OBSERVÉ — la preuve la plus forte.
 *
 * C'est la question « ce prospect vaut-il quelque chose ? » quand aucun score
 * n'existe : 197 prospects du corpus n'en ont pas, et la colonne se réduisait
 * alors à trois cartes courtes suivies de vide. Les observations sont des
 * phrases écrites par le pipeline et portant leurs références de preuve — pas
 * une synthèse fabriquée ici.
 *
 * Le résumé passe en premier parce qu'il est le seul texte qui répond en une
 * phrase ; les observations suivent, dans l'ordre du dossier.
 */
export function ObservationsCard({
  research,
  fill = false,
}: {
  research: CrmWorkspace['research'];
  fill?: boolean;
}) {
  if (research === null) {
    return (
      <Card
        icon="sparkle"
        title="Observations"
        tone="slate"
        {...(fill ? { className: 'crm-card-fill' } : {})}
      >
        <p className="crm-prose crm-note">
          Ce prospect n’a pas encore été étudié par le pipeline.
        </p>
      </Card>
    );
  }

  return (
    <Card
      icon="sparkle"
      title="Observations"
      tone="cyan"
      end={`${research.observations.length}`}
      {...(fill ? { className: 'crm-card-fill' } : {})}
    >
      <div className={fill ? 'crm-scroll crm-card-scroll' : undefined}>
        {research.summary.trim().length === 0 ? null : (
          <p className="crm-prose">
            <Prose value={research.summary} />
          </p>
        )}
        {research.observations.length === 0 ? null : (
          <ul className="crm-list plain tight clamp2" data-tone="cyan">
            {research.observations.map((entry) => (
              <li key={entry}>
                <span>
                  <Prose value={entry} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TabLink to="analysis">Voir l’analyse complète</TabLink>
    </Card>
  );
}

/**
 * Le risque PRINCIPAL — au singulier, et c'est délibéré.
 *
 * La vue d'ensemble répond à « quel est le doute le plus important, et combien
 * y en a-t-il ? ». La liste complète appartient à l'onglet d'analyse, où le
 * renvoi mène. Une carte qui déroulait dix inconnues poussait l'opportunité
 * hors de la colonne — et comme la colonne est bornée, « hors de la colonne »
 * voulait dire COUPÉE, donc invisible et non atteignable.
 *
 * Le premier élément est celui que le pipeline a écrit en premier : aucun
 * classement n'est inventé ici.
 */
export function RiskCard({ research }: { research: CrmWorkspace['research'] }) {
  if (research === null || research.unknowns.length === 0) return null;
  const [first] = research.unknowns;
  return (
    <Card
      icon="question"
      title="Risque principal"
      tone="orange"
      end={`${research.unknowns.length}`}
      className="crm-card-firm"
    >
      <ul className="crm-list plain tight clamp2" data-tone="orange">
        <li>
          <span>
            <Prose value={first ?? ''} />
          </span>
        </li>
      </ul>
      {research.unknowns.length > 1 ? (
        <TabLink to="analysis">
          Voir les {research.unknowns.length} risques et inconnues
        </TabLink>
      ) : null}
    </Card>
  );
}

/** Les opportunités — deux lignes, et le renvoi vers l'analyse complète. */
export function OpportunityCard({ research }: { research: CrmWorkspace['research'] }) {
  if (research === null) {
    return (
      <Card icon="sparkle" title="Analyse" tone="cyan">
        <p className="crm-prose crm-note">
          Ce prospect n’a pas encore été étudié par le pipeline.
        </p>
      </Card>
    );
  }
  if (research.opportunities.length === 0) {
    return (
      <Card icon="bulb" title="Opportunité principale" tone="slate" className="crm-card-firm">
        <p className="crm-prose crm-note">La recherche n’en a retenu aucune.</p>
      </Card>
    );
  }
  const [first] = research.opportunities;
  return (
    <Card
      icon="bulb"
      title="Opportunité principale"
      tone="green"
      end={`${research.opportunities.length}`}
      className="crm-card-firm"
    >
      <ul className="crm-list tight clamp2" data-tone="green">
        <li>
          <span>
            <Prose value={first ?? ''} />
          </span>
        </li>
      </ul>
      <TabLink to="analysis">Voir l’analyse complète</TabLink>
    </Card>
  );
}
