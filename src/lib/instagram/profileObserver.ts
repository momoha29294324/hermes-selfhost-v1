import type { ProfileObservation } from '@/lib/pipeline/instagramObservation';

/**
 * R7.3C §4 — le contrat de l'observateur : structurellement incapable d'agir.
 *
 * ---------------------------------------------------------------------------
 * Ce que « read-only » veut dire ici
 * ---------------------------------------------------------------------------
 * Pas « le rail ne le fait pas », mais « le rail ne sait pas le faire ». Il n'y
 * a pas de méthode `send`, pas de méthode `follow`, pas de méthode `like` : un
 * appelant qui voudrait envoyer un message n'a rien à appeler, et un diff qui
 * ajouterait cette capacité devrait AJOUTER une méthode — ce qui se voit, se
 * relit, et fait échouer `assertNoActionPrimitives`.
 *
 * Trois couches indépendantes, et c'est voulu :
 *
 *   1. **le type** — la surface n'expose que `observe` et `close` ;
 *   2. **le test** — `assertNoActionPrimitives` énumère les méthodes RÉELLES de
 *      la classe (prototype compris) et refuse tout nom portant un verbe
 *      d'action, y compris privé, y compris ajouté par une sous-classe ;
 *   3. **la garde réseau** — `classifyObserverRequest` empêche la requête de
 *      sortir, même émise par du code que personne n'a écrit.
 *
 * Chacune suffirait à un raisonnement ; aucune ne suffit à une garantie. La
 * première tombe devant un `as any`, la deuxième devant un nom bien choisi, la
 * troisième devant un chemin qu'Instagram inventerait demain. Ensemble, elles
 * demandent trois erreurs simultanées.
 */

/**
 * Les verbes qu'un observateur n'a aucune raison de porter.
 *
 * La liste est celle de la mission, mot pour mot, augmentée des formes qu'un
 * nom de méthode prend en pratique (`dm`, `react`, `subscribe`). Elle est
 * comparée sur le nom NORMALISÉ (minuscules, sans séparateur), pour que
 * `mark_read`, `markRead` et `MarkRead` soient le même refus.
 */
export const FORBIDDEN_OBSERVER_PRIMITIVES: readonly string[] = [
  'send',
  'message',
  'dm',
  'follow',
  'unfollow',
  'like',
  'unlike',
  'comment',
  'reply',
  'save',
  'share',
  'story',
  'stories',
  'markread',
  'react',
  'subscribe',
  'block',
  'report',
  'post',
  'upload',
  'delete',
];

/**
 * Les noms qui contiennent un verbe interdit sans en être un.
 *
 * `postCount` et `postsSource` parlent des publications d'AUTRUI, lues ; ils ne
 * publient rien. Les nommer ici est plus honnête que d'affaiblir la liste des
 * verbes : l'exception est nommée une fois, visible, et elle ne couvre que des
 * lectures.
 */
const READ_ONLY_EXEMPTIONS: readonly string[] = ['postcount', 'postssource', 'readposts', 'collectposts', 'parseposts'];

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Toutes les méthodes d'un objet, prototype compris — y compris celles héritées. */
function methodNames(target: object): string[] {
  const names = new Set<string>();
  let current: object | null = target;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor') continue;
      names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

export class ObserverContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObserverContractError';
  }
}

/**
 * Refuse une classe d'observation qui porterait une primitive d'action.
 *
 * Appelée par un test, et par le constructeur du rail réel : une garantie qui
 * ne vit que dans un test disparaît le jour où quelqu'un écrit une seconde
 * implémentation sans écrire son test.
 */
export function assertNoActionPrimitives(instance: object, label: string): void {
  const offending = methodNames(instance)
    .map((name) => ({ name, normalized: normalize(name) }))
    .filter((entry) => !READ_ONLY_EXEMPTIONS.includes(entry.normalized))
    .filter((entry) => FORBIDDEN_OBSERVER_PRIMITIVES.some((verb) => entry.normalized.includes(verb)))
    .map((entry) => entry.name);

  if (offending.length > 0) {
    throw new ObserverContractError(
      `${label} porte ${offending.length} primitive(s) d’action : ${offending.join(', ')}. ` +
        'Un observateur lit ; il n’envoie pas, ne suit pas, n’aime pas, ne commente pas. ' +
        'Si une de ces méthodes est une LECTURE mal nommée, renommez-la — ' +
        'l’exemption se demande explicitement dans READ_ONLY_EXEMPTIONS.',
    );
  }
}

/** Ce qu'on demande à l'observateur d'ouvrir. Un prospect, un handle attendu. */
export interface ObserveTarget {
  readonly prospectId: string;
  readonly prospectName: string;
  /** Le handle normalisé attendu. L'identité est vérifiée contre lui (§10). */
  readonly expectedHandle: string;
  /** Les preuves déjà en base qui corroborent ce handle. Lues, jamais recalculées. */
  readonly corroboration: readonly string[];
  /**
   * Les identités connues du prospect — nom, enseigne, raison sociale, domaine.
   *
   * Sert à répondre à la question que la comparaison de handles ne pose pas :
   * le compte ouvert appartient-il bien à CETTE entreprise ? Un handle recopié
   * depuis le pied de page d'un gabarit de site passe la première question et
   * échoue à celle-ci.
   */
  readonly prospectIdentities: readonly (string | null)[];
}

/**
 * La surface entière du rail. Deux méthodes.
 *
 * `observe` ne rend jamais d'exception pour un profil privé, introuvable ou
 * illisible : ce sont des OBSERVATIONS, elles se rendent. Une exception ne
 * signale qu'une panne du rail lui-même.
 */
export interface InstagramProfileObserver {
  observe(target: ObserveTarget): Promise<ProfileObservation>;
  close(): Promise<void>;
}
