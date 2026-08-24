import type { Page } from 'playwright';

/**
 * IG2.2 §2 — la relation d'abonnement entre le compte émetteur et la cible,
 * LUE sur la page de profil, jamais supposée.
 *
 * Pourquoi ce module existe
 * -------------------------
 * Le premier canari LIVE a produit `DELIVERY_FAILED` sur un compte
 * professionnel qui ne suivait pas l'émetteur. Un DM vers un compte qui ne vous
 * suit pas n'entre pas dans la boîte de réception : il devient une DEMANDE de
 * message, et Instagram y applique d'autres règles. C'est une des rares
 * différences observables entre ce cas et un test contrôlé, donc elle doit être
 * notée AVANT le clic — sinon le diagnostic d'après-coup n'aura rien à
 * comparer.
 *
 * Ce que ce module ne fait pas
 * ----------------------------
 * Il ne suit personne, ne se désabonne de personne, ne clique rien. Il LIT des
 * libellés de boutons. La mission l'exige en toutes lettres (« aucun
 * follow/like/comment », « aucun changement des paramètres du destinataire ») et
 * le contrat du rail le rend structurel : il n'existe aucune méthode d'action
 * dans `InstagramReadOnlyRail`.
 *
 * Pourquoi une égalité EXACTE de libellé, jamais un `includes`
 * ------------------------------------------------------------
 * Parce qu'une page de profil affiche « 1 234 abonnés » et « 567 abonnements »
 * à côté du bouton « Abonné ». Un `includes('abonné')` conclurait donc que
 * l'émetteur suit la cible sur n'importe quel profil du monde. La lecture ne
 * retient que des libellés de CONTRÔLES et de badges courts, et la décision les
 * compare par égalité après normalisation.
 */

export interface InstagramRelationshipObservation {
  /**
   * Le compte cible suit-il le compte émetteur ?
   *
   * `true` sur un marqueur positif (« Vous suit », « Suivre en retour »).
   * `false` seulement si l'en-tête a été LU et qu'il portait au moins un
   * libellé de relation sans porter ce marqueur — une absence constatée dans un
   * périmètre effectivement lu est une observation ; une absence supposée n'en
   * est pas une (CLAUDE.md, interdit n°2).
   * `null` sinon : non lu.
   */
  readonly followsViewer: boolean | null;
  /** Le compte émetteur suit-il le compte cible ? Mêmes règles. */
  readonly followedByViewer: boolean | null;
  /**
   * Le profil visité EST-IL celui du compte émetteur ?
   *
   * `true` sur un marqueur positif — « Modifier le profil » n'apparaît que chez
   * soi. `false` quand un témoin de relation a été lu, ce qui prouve le
   * contraire : on ne peut pas se suivre soi-même. `null` sinon.
   *
   * Cette question n'est pas cosmétique. Le premier relevé sur `operator_second_account` a
   * rendu les compteurs du profil mais AUCUN libellé d'action, ce qui a deux
   * causes possibles — une page pas finie de peindre, ou un profil qui n'offre
   * pas de bouton parce qu'il est le nôtre. Un DM vers soi-même prouverait que
   * le composeur fonctionne, pas que le rail sait REMETTRE à un tiers, qui est
   * exactement la question laissée ouverte par le canari du 14 août.
   */
  readonly isOwnProfile: boolean | null;
  /** L'en-tête a-t-il pu être lu du tout ? Distingue « rien vu » de « rien lu ». */
  readonly headerReadable: boolean;
  /** Un témoin de relation a-t-il été lu ? C'est lui qui autorise à conclure une absence. */
  readonly relationUiRendered: boolean;
  /** Les libellés normalisés réellement lus, bornés. Jamais du HTML, jamais un jeton. */
  readonly labels: readonly string[];
  readonly detail: string;
}

export const UNREAD_RELATIONSHIP: InstagramRelationshipObservation = Object.freeze({
  followsViewer: null,
  followedByViewer: null,
  isOwnProfile: null,
  headerReadable: false,
  relationUiRendered: false,
  labels: Object.freeze([]),
  detail: 'relation non lue — l’en-tête du profil n’a pas pu être inspecté',
});

/** Bornes de lecture. Un profil qui en demanderait plus n'est pas un profil. */
export const MAX_RELATIONSHIP_LABELS = 48;
export const MAX_RELATIONSHIP_LABEL_LENGTH = 40;

/**
 * Normalise un libellé pour la comparaison : minuscules, accents retirés,
 * blancs réduits, ponctuation de bord enlevée.
 *
 * Les accents sont retirés parce que la même interface écrit « Abonné » et
 * « Abonne » selon la police et la plateforme, et qu'une comparaison qui
 * dépendrait de cela serait un bug intermittent.
 */
export function normalizeRelationshipLabel(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .trim();
}

/** « La cible me suit. » */
const FOLLOWS_VIEWER_LABELS: readonly string[] = ['vous suit', 'follows you', 'te suit'];

/**
 * « La cible me suit ET je ne la suis pas. » Ce libellé porte les deux
 * informations à la fois, et c'est pour cela qu'il est listé à part.
 */
const FOLLOW_BACK_LABELS: readonly string[] = ['suivre en retour', 'follow back'];

/**
 * « Je suis la cible. »
 *
 * Attention au couple `suivre` / `suivi(e` : ils diffèrent d'une lettre et
 * disent l'inverse l'un de l'autre. « Suivre » est l'invitation à s'abonner,
 * donc un NON-abonnement ; « Suivi(e) » est l'état d'un abonnement en cours.
 * Les confondre inverserait la réponse tout en ayant l'air de marcher, ce qui
 * est la pire des deux façons de se tromper.
 *
 * Les formes tronquées (`suivi(e`, `abonne(e`) ne sont pas des coquilles : la
 * normalisation retire la ponctuation de BORD, si bien que « Suivi(e) » devient
 * « suivi(e ». Elles sont listées telles que la normalisation les produit,
 * parce que c'est à ces valeurs-là que la comparaison a lieu.
 *
 * Cette liste s'est allongée sur observation, pas sur supposition : le relevé
 * du 14 août sur le compte de test a rendu « Suivi(e) », que la première
 * version ne connaissait pas — elle n'avait que « Abonné ».
 */
const FOLLOWING_LABELS: readonly string[] = [
  'abonne',
  'abonnee',
  'abonne(e',
  'suivi',
  'suivie',
  'suivi(e',
  'following',
  'se desabonner',
  'ne plus suivre',
  'unfollow',
];

/** « Je ne suis pas la cible. » */
const NOT_FOLLOWING_LABELS: readonly string[] = ['suivre', 'follow'];

/** « J'ai demandé, ce n'est pas tranché. » Ni suivi, ni non-suivi. */
const PENDING_LABELS: readonly string[] = ['demande envoyee', 'requested', 'demande en attente'];

/**
 * Tous les libellés qui prouvent que l'interface de relation s'est affichée.
 *
 * C'est ce témoin, et lui seul, qui autorise à conclure une ABSENCE : sans un
 * libellé de relation lu, ne pas voir « Vous suit » ne dit rien — la page
 * n'avait peut-être pas fini de peindre.
 */
const RELATION_WITNESS_LABELS: readonly string[] = [
  ...FOLLOWS_VIEWER_LABELS,
  ...FOLLOW_BACK_LABELS,
  ...FOLLOWING_LABELS,
  ...NOT_FOLLOWING_LABELS,
  ...PENDING_LABELS,
];

/**
 * « Ce profil est le mien. » Ces libellés n'existent que chez soi.
 *
 * Volontairement restreints aux marqueurs FORTS : ni « Paramètres » ni
 * « Settings », qui peuvent apparaître dans une barre de navigation sur
 * n'importe quel profil. « Modifier le profil » ne s'affiche que sur le sien.
 */
const OWN_PROFILE_LABELS: readonly string[] = [
  'modifier le profil',
  'edit profile',
  'voir les archives',
  'view archive',
  'tableau de bord professionnel',
  'professional dashboard',
];

/**
 * Décide, à partir des seuls libellés lus. Pure : chaque combinaison — y
 * compris les contradictoires — est exerçable par un test sans ouvrir de
 * navigateur.
 *
 * Une contradiction (« Abonné » et « Suivre » présents ensemble, ce qui arrive
 * quand deux profils se chevauchent dans le DOM pendant une transition) rend
 * `null` et le dit. Trancher en faveur de l'un des deux serait inventer.
 */
export function decideRelationship(
  rawLabels: readonly string[],
  headerReadable: boolean,
): InstagramRelationshipObservation {
  if (!headerReadable) return UNREAD_RELATIONSHIP;

  const labels: string[] = [];
  for (const raw of rawLabels) {
    const normalized = normalizeRelationshipLabel(raw);
    if (normalized.length === 0 || normalized.length > MAX_RELATIONSHIP_LABEL_LENGTH) continue;
    if (!labels.includes(normalized)) labels.push(normalized);
    if (labels.length >= MAX_RELATIONSHIP_LABELS) break;
  }

  const has = (set: readonly string[]): boolean => labels.some((label) => set.includes(label));

  const witnessed = has(RELATION_WITNESS_LABELS);
  const ownMarker = has(OWN_PROFILE_LABELS);

  // Un témoin de relation prouve que le profil n'est PAS le nôtre — on ne
  // s'abonne pas à soi-même. L'inverse se lit sur les marqueurs propres. Sans
  // ni l'un ni l'autre, on ne sait pas, et on le dit.
  const isOwnProfile = ownMarker ? true : witnessed ? false : null;

  // Chez soi, il n'y a aucune relation à établir : la question ne se pose pas,
  // et y répondre « ne suit pas » serait absurde autant que faux.
  if (isOwnProfile === true) {
    return Object.freeze({
      followsViewer: null,
      followedByViewer: null,
      isOwnProfile: true,
      headerReadable: true,
      relationUiRendered: false,
      labels: Object.freeze([...labels]),
      detail:
        'le profil visité est celui du compte émetteur (« modifier le profil » lu) — ' +
        'il n’y a aucune relation d’abonnement à observer entre un compte et lui-même',
    });
  }

  // ---- La cible me suit-elle ? --------------------------------------------
  const followsMarker = has(FOLLOWS_VIEWER_LABELS) || has(FOLLOW_BACK_LABELS);
  const followsViewer = followsMarker ? true : witnessed ? false : null;

  // ---- Est-ce que je suis la cible ? --------------------------------------
  const followingMarker = has(FOLLOWING_LABELS);
  const notFollowingMarker = has(NOT_FOLLOWING_LABELS) || has(FOLLOW_BACK_LABELS);
  const pendingMarker = has(PENDING_LABELS);

  let followedByViewer: boolean | null;
  let followedDetail: string;
  if (followingMarker && notFollowingMarker) {
    followedByViewer = null;
    followedDetail = 'libellés contradictoires sur l’abonnement de l’émetteur — aucun verdict';
  } else if (followingMarker) {
    followedByViewer = true;
    followedDetail = 'l’émetteur suit la cible';
  } else if (pendingMarker && !notFollowingMarker) {
    followedByViewer = null;
    followedDetail = 'demande d’abonnement en attente — ni suivi ni non-suivi';
  } else if (notFollowingMarker) {
    followedByViewer = false;
    followedDetail = 'l’émetteur ne suit pas la cible';
  } else {
    followedByViewer = null;
    followedDetail = 'aucun libellé d’abonnement lisible';
  }

  const followsDetail = followsMarker
    ? 'la cible suit l’émetteur'
    : witnessed
      ? 'aucun marqueur « vous suit » dans un en-tête pourtant lu — la cible ne suit pas l’émetteur'
      : 'aucun libellé de relation lu — la cible peut suivre ou non, on ne sait pas';

  return Object.freeze({
    followsViewer,
    followedByViewer,
    isOwnProfile,
    headerReadable: true,
    relationUiRendered: witnessed,
    labels: Object.freeze([...labels]),
    detail: `${followsDetail} ; ${followedDetail}`,
  });
}

/**
 * Le corps évalué dans la page, exporté pour être inspectable par un test.
 *
 * Écrit comme une expression de fonction anonyme, et pas comme une fonction
 * nommée ni une flèche : le 14 août, une fonction nommée dans un corps évalué a
 * levé `ReferenceError: __name is not defined` (l'instrumentation `keepNames`
 * du bundler n'existe pas dans la page), et l'échec s'est déguisé en mesure
 * vide. Même convention que `HARVEST_THREAD_IN_PAGE`.
 *
 * Ce qui en sort : des libellés courts, et rien d'autre. Ni `href`, ni `src`,
 * ni `class`, ni HTML.
 */
export const READ_RELATIONSHIP_IN_PAGE = function (maxLabels: number): string[] {
  const header = document.querySelector('main header') ?? document.querySelector('header');
  if (header === null) return [];

  const out: string[] = [];

  // Deux passes, et l'ordre compte.
  //
  // Le premier relevé sur `operator_second_account` a rendu neuf libellés — tous des
  // compteurs de profil — et aucun bouton. La borne de sortie est atteignable :
  // un en-tête contient des dizaines de `span` et de `div` imbriqués, si bien
  // qu'une passe unique en ordre du document peut épuiser son quota sur les
  // compteurs avant d'atteindre la rangée d'actions.
  //
  // Les CONTRÔLES passent donc en premier, avec leur propre quota. C'est là que
  // vivent « Suivre », « Vous suit » et « Modifier le profil » — c'est-à-dire
  // tout ce dont la décision a besoin. Le reste de l'en-tête suit, et sert
  // seulement à diagnostiquer une lecture qui n'aurait rien trouvé.
  const controls = header.querySelectorAll('button, [role="button"], a[role="link"], [aria-label]');
  for (const node of Array.from(controls)) {
    if (out.length >= maxLabels) break;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    // Seuls les libellés COURTS nous intéressent : un bouton porte deux mots,
    // une biographie en porte cinquante. La borne évite d'aspirer le contenu du
    // profil sous prétexte de lire une relation.
    const text = ((node as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length <= 40) out.push(text);

    const label = (node.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
    if (label.length > 0 && label.length <= 40) out.push(label);
  }

  const rest = header.querySelectorAll('span, div');
  for (const node of Array.from(rest)) {
    if (out.length >= maxLabels) break;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = ((node as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length <= 40) out.push(text);
  }

  return out;
};

/**
 * Combien de temps attendre que les boutons d'action apparaissent, et à quel
 * rythme regarder.
 *
 * Ces deux constantes existent à cause du premier relevé sur `operator_second_account` : la
 * lecture, tirée une seule fois juste après les indices d'identité, a rendu les
 * compteurs du profil et le mot « chargement » — donc une page à moitié peinte.
 * Une mesure prise trop tôt ne rend pas « non lu », elle rend « lu, et rien
 * dedans », ce qui est précisément la confusion que tout ce module existe pour
 * éviter.
 *
 * La boucle ATTEND, elle ne provoque rien : aucun clic, aucun rechargement,
 * aucune navigation. Elle sort dès qu'un témoin apparaît — donc en général au
 * premier tour — et la borne haute reste courte pour ne pas ralentir le rail
 * DRY-RUN, qui ouvre le même chemin.
 */
export const RELATIONSHIP_SETTLE_TIMEOUT_MS = 6_000;
export const RELATIONSHIP_POLL_MS = 400;

/**
 * Lit la relation sur la page de profil déjà ouverte. Une panne rend
 * `UNREAD_RELATIONSHIP` — « je n'ai pas pu lire », jamais « il n'y a rien ».
 *
 * Une lecture qui n'a rien trouvé de concluant est retentée jusqu'à l'échéance,
 * puis rendue telle quelle : au bout du compte, « je n'ai pas vu de libellé de
 * relation » reste une réponse honnête, et c'est celle qu'on garde plutôt que
 * d'en fabriquer une.
 */
export async function readRelationship(page: Page): Promise<InstagramRelationshipObservation> {
  const deadline = Date.now() + RELATIONSHIP_SETTLE_TIMEOUT_MS;
  let last: InstagramRelationshipObservation = UNREAD_RELATIONSHIP;

  for (;;) {
    const labels = await page.evaluate(READ_RELATIONSHIP_IN_PAGE, MAX_RELATIONSHIP_LABELS).catch(() => null);
    if (labels === null) return UNREAD_RELATIONSHIP;
    last = decideRelationship(labels, true);

    // Concluant dans un sens OU dans l'autre : un témoin de relation, ou la
    // preuve qu'on est chez soi. Attendre davantage n'améliorerait ni l'un ni
    // l'autre.
    if (last.relationUiRendered || last.isOwnProfile === true) return last;
    if (Date.now() >= deadline) return last;
    await page.waitForTimeout(RELATIONSHIP_POLL_MS);
  }
}
