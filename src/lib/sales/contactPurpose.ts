/**
 * HERMES-CONTACT-PURPOSE-R1 — POURQUOI Hermes écrit, dit une fois et opposable.
 *
 * ---------------------------------------------------------------------------
 * Le trou que ce fichier bouche
 * ---------------------------------------------------------------------------
 * Le 23 août 2026, un prospect a demandé « Pourquoi tu me demande ça ». D2 a
 * parfaitement compris (`QUESTION`, 0,99). La conversation s'est pourtant
 * arrêtée sur `HUMAN_ESCALATION:topic_not_covered`, et le motif était exact :
 * aucune donnée du dépôt ne couvrait la question.
 *
 * C'est un constat étonnant quand on le lit à froid. Ce dépôt sait dire ce
 * qu'il VEND (`sales/offer.ts`), à QUI il écrit (`pipeline/serviceScope.ts`),
 * ce qu'il VISE (`sales/objective.ts`) et ce qu'il ne peut PAS engager
 * (`conversation/commercialPolicy.ts`). Il ne savait pas dire pourquoi il
 * écrivait — c'est-à-dire la seule chose qu'un inconnu démarché a le droit de
 * demander en premier, et la question la plus prévisible de toute la
 * prospection à froid.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier N'EST PAS
 * ---------------------------------------------------------------------------
 * Ce n'est pas une réponse. Il n'y a pas une phrase ici que le modèle
 * recopierait : les entrées sont des FAITS, comme `TRIAL_FACTS`, et pour la
 * même raison (`sales-source-001-p007` : le cadre, jamais le script). Une
 * réponse toute faite se reconnaît au troisième prospect, et elle serait fausse
 * au premier — « pourquoi tu me demandes ça » après une question sur
 * l'acquisition n'appelle pas le même mot que « c'est pour quoi » sur un profil
 * ouvert par hasard.
 *
 * Ce n'est pas non plus une permission. Rien ici ne desserre une garde : les
 * limites ci-dessous sont plus strictes que le prompt général, jamais plus
 * larges, et `checkReplyDraft` continue de tout relire derrière — aucun
 * montant, aucun lien, aucune promesse, aucune preuve chiffrée.
 *
 * ---------------------------------------------------------------------------
 * D'où vient chaque fait
 * ---------------------------------------------------------------------------
 * Aucun n'est inventé pour l'occasion ; chacun est déjà vrai ailleurs dans le
 * dépôt, et deux d'entre eux sont littéralement COMPOSÉS depuis leur source
 * (`sales/objective.ts`) plutôt que recopiés — un texte recopié diverge de sa
 * source le jour où la source change, et personne ne s'en aperçoit.
 *
 * Le rang de vérité est le premier de `truth.ts` : `EXPLICIT_BUSINESS_POLICY`.
 * Ce n'est pas une heuristique de vente empruntée à une vidéo, c'est ce que
 * un opérateur fait et pourquoi il le fait.
 */

import {
  HERMES_PRIMARY_COMMERCIAL_OBJECTIVE,
  HERMES_OUT_OF_SCOPE,
} from '@/lib/sales/objective';
import type { TruthTier } from '@/lib/sales/truth';
import type { ConversationSignals } from '@/lib/conversation/signals';

/**
 * L'identifiant du MOTIF DE CONTACT.
 *
 * Une version de plus, distincte des quatre qui existaient — ciblage, réponse
 * autonome, engagement commercial, rendez-vous. Elle répond à une cinquième
 * question : « pourquoi cette conversation a-t-elle commencé ? ». Partager une
 * étiquette ferait couvrir l'une par les décisions rendues sous l'autre, et
 * c'est précisément ce que la discipline de versions de ce dépôt refuse.
 */
export const CONTACT_PURPOSE_VERSION = 'hermes-contact-purpose-r1';

/** Le rang d'autorité de ce qui suit. Le premier : une politique explicite. */
export const CONTACT_PURPOSE_TIER: TruthTier = 'EXPLICIT_BUSINESS_POLICY';

/**
 * Le motif de contact, en faits.
 *
 * Chaque entrée est vraie indépendamment des autres, et aucune n'est une
 * formulation. Elles sont dans l'ordre où une personne les dirait si on lui
 * demandait pourquoi elle a écrit : qui, pourquoi maintenant, ce que je fais,
 * ce que je ne fais pas, ce que je cherche.
 */
export const CONTACT_PURPOSE_FACTS: readonly string[] = Object.freeze([
  'j’écris à des entreprises dont le métier est le prestation standard, le prestation ou l’entretien automobile — ' +
    'c’est la seule activité que je démarche',
  'c’est moi qui prends contact, de ma propre initiative : personne ne m’a demandé d’écrire, et je le ' +
    'dis simplement si on me pose la question',
  'ce que je cherche d’abord, c’est comprendre comment l’entreprise obtient aujourd’hui ses nouvelles ' +
    'demandes — pas lui vendre quelque chose au premier message',
  'j’aide ce type d’entreprises sur leur acquisition de clients ; si le sujet paraît pertinent pour ' +
    'elles, je peux expliquer ce qu’on propose',
  'je ne cherche pas à conclure quoi que ce soit dans la conversation',
  `ce que je vise au bout, quand cela a du sens des deux côtés, est un échange de vive voix (${HERMES_PRIMARY_COMMERCIAL_OBJECTIVE})`,
]);

/**
 * Ce que dire son motif n'autorise pas.
 *
 * Écrites comme des interdictions, et non comme des nuances, pour la raison
 * qu'on écrit partout ailleurs dans ce dépôt : « reste mesuré » ne se vérifie
 * pas, « n'affirme pas qu'ils ont un problème » si.
 *
 * Les deux premières sont celles qui coûtent quelque chose de réel. Un motif de
 * contact se raconte très facilement comme un diagnostic — « je vois que vous
 * ne faites pas de pub », « votre acquisition n'est pas structurée » — et c'est
 * l'interdit n°2 de CLAUDE.md, pas une maladresse de style : personne n'a
 * observé cela.
 */
export const CONTACT_PURPOSE_LIMITS: readonly string[] = Object.freeze([
  'n’affirme pas, et ne laisse pas entendre, que cette entreprise a un problème, un manque ou une ' +
    'faiblesse : rien ne l’a observé',
  'ne dis pas que tu as analysé, audité, étudié ou regardé leur entreprise si aucune recherche ne ' +
    't’a été donnée en faits observés',
  'ne déroule pas l’offre : on te demande POURQUOI tu écris, pas ce que tu vends',
  'aucun résultat promis, aucun chiffre, aucun montant, aucun délai, aucune référence client',
  'ne te justifie pas longuement et ne t’excuse pas : une ou deux phrases, dans tes mots du moment',
  'ne propose pas d’échange dans la foulée si rien ne le justifie encore',
]);

/**
 * Le motif peut-il être exposé à ce tour ?
 *
 *   * `ALLOWED` — on vient de te demander pourquoi tu écris ;
 *   * `NOT_ASKED` — personne ne l'a demandé ; le dire serait un pitch ;
 *   * `FORBIDDEN` — la conversation revient à un humain ou se referme.
 *
 * Trois valeurs et pas un booléen, exactement comme `trialDisclosure` : le cas
 * fréquent n'est ni oui ni non, c'est « on ne t'a rien demandé ». Un booléen
 * aurait forcé à trancher, et il aurait tranché du côté du oui — c'est toujours
 * ce qui arrive.
 */
export type ContactPurposeDisclosure = 'ALLOWED' | 'NOT_ASKED' | 'FORBIDDEN';

export interface ContactPurposeInput {
  /** Le sujet de la question, tel que `readSignals` l'a lu. Jamais deviné ici. */
  readonly questionTopic: ConversationSignals['questionTopic'];
  readonly humanNeeded: boolean;
}

/**
 * Décide si le motif entre dans le prompt de ce tour.
 *
 * Trois sujets l'ouvrent, et eux seuls : on demande pourquoi tu écris, qui tu
 * es, ou ce que tu fais. Les trois sont des variantes de la même question posée
 * par quelqu'un qui ne t'a rien demandé — et les trois méritent une réponse
 * honnête plutôt qu'une esquive.
 *
 * Ce qui ne l'ouvre PAS, et c'est le point : un prospect qui RÉPOND à ce qu'on
 * lui a demandé (`INFORMATION_SHARED`, `questionTopic` à `NONE`) ne reçoit rien
 * de tout cela. Lui expliquer spontanément pourquoi on l'a contacté serait un
 * pitch déclenché par sa politesse, c'est-à-dire exactement le réflexe que
 * `CONVERSATION_FRAME` interdit par ailleurs.
 */
export function contactPurposeDisclosure(input: ContactPurposeInput): ContactPurposeDisclosure {
  if (input.humanNeeded) return 'FORBIDDEN';
  if (
    input.questionTopic === 'CONTACT_PURPOSE' ||
    input.questionTopic === 'WHO_ARE_YOU' ||
    input.questionTopic === 'WHAT_YOU_DO'
  ) {
    return 'ALLOWED';
  }
  return 'NOT_ASKED';
}

/**
 * Le motif, rendu pour un prompt.
 *
 * Une seule source : si les faits changent, le prompt change avec eux. Les
 * deux dernières lignes sont COMPOSÉES depuis `HERMES_OUT_OF_SCOPE` plutôt que
 * réécrites — le périmètre de Hermes n'a pas à être raconté deux fois.
 */
export function renderContactPurposeBlock(): string {
  const lines: string[] = [
    `POURQUOI TU AS ÉCRIT (${CONTACT_PURPOSE_VERSION}) — ON VIENT DE TE LE DEMANDER`,
    '',
    'Réponds-y directement, à la première personne, avec ce qui est vrai :',
  ];
  for (const fact of CONTACT_PURPOSE_FACTS) lines.push(`- ${fact}`);
  lines.push('', 'EN LE DISANT, TU NE FAIS PAS :');
  for (const limit of CONTACT_PURPOSE_LIMITS) lines.push(`- ${limit}`);
  lines.push('', 'Et tu ne fais toujours pas, ici comme ailleurs :');
  for (const entry of HERMES_OUT_OF_SCOPE) lines.push(`- ${entry}`);
  lines.push(
    '',
    'Une réponse juste est COURTE : pourquoi tu as écrit, et ce que tu cherchais à savoir. Rien de',
    'plus. Si une question courte tombe naturellement ensuite, une seule — sinon aucune.',
  );
  return lines.join('\n');
}
