/**
 * IG2.4 — la boîte de réception de l'expéditeur, lue sans confondre « je ne
 * sais pas lire » et « ce n'est pas là ».
 *
 * Ce que la version précédente affirmait, et pourquoi c'était faux
 * -----------------------------------------------------------------
 * Le 14 août, l'adjudication du controlled test a conclu « aucune conversation
 * avec `operator_second_account` dans la boîte », et en a tiré `DELIVERY_FAILED`. La
 * capture montre l'inverse : la conversation est là, en tête des Messages.
 *
 * Trois erreurs cumulées, toutes de la même famille :
 *
 *   1. les lignes étaient cherchées comme `a[href^="/direct/t/"]`. L'interface
 *      actuelle n'en met plus : `threadLinkCount` valait 0, donc AUCUNE ligne
 *      n'était examinée ;
 *   2. la lecture était néanmoins déclarée fiable, parce que le témoin de
 *      rendu comptait des vignettes et des caractères — deux mesures qui
 *      restent vraies quand on n'a rien su lire de la liste ;
 *   3. la cible était cherchée par son HANDLE, alors que la ligne affiche le
 *      NOM D'AFFICHAGE (« Moha », pas « operator_second_account »).
 *
 * Une absence déduite d'un scanner illisible n'est pas une absence. C'est
 * l'interdit n°2 de CLAUDE.md, et c'est le troisième endroit de ce rail où il
 * se manifeste — après le comptage de bulles et la relation d'abonnement.
 *
 * Ce que ce module rend maintenant
 * ---------------------------------
 * Quatre états, nommés séparément parce qu'ils ne se déduisent pas l'un de
 * l'autre :
 *
 *   * `INBOX_READABLE` / `INBOX_UNREADABLE` — la liste a-t-elle été lue ?
 *   * `THREAD_PRESENT` / `THREAD_NOT_FOUND` / `THREAD_UNKNOWN` — la
 *     conversation y est-elle ? `THREAD_NOT_FOUND` n'est jamais rendu sur une
 *     boîte illisible ; c'est `THREAD_UNKNOWN` qui l'est.
 *
 * Et, quand la ligne est trouvée, ce qu'elle dit d'elle-même : son aperçu et sa
 * FRAÎCHEUR. C'est là que se joue la preuve de remise — un message remis
 * remonte sa conversation en tête et en devient l'aperçu. Une conversation
 * présente mais vieille de onze semaines dit quelque chose de précis, et le dit
 * mieux qu'une absence inventée.
 *
 * La page MESURE, le code pur DÉCIDE — même partage que `threadHarvest` →
 * `deliveryProof` et que `threadIdentity`.
 */

import type { ObservedRect } from '@/lib/instagram/threadObservation';

// ---------------------------------------------------------------------------
// Ce que la page mesure
// ---------------------------------------------------------------------------

/** Une ligne de la liste, mesurée. Aucune interprétation. */
export interface InboxRowMeasure {
  readonly index: number;
  /** L'identifiant du fil, s'il existe encore un lien qui le porte. Souvent `null`. */
  readonly threadId: string | null;
  /** Le texte visible de la ligne : nom, aperçu, horodatage. Borné. */
  readonly text: string;
  /**
   * Le texte du NŒUD D'HORODATAGE de la ligne, et de lui seul. `null` quand
   * l'interface n'en expose aucun.
   *
   * Séparé du reste depuis IG5 R2, parce que confondre les deux a produit une
   * fausse fraîcheur en conditions réelles : `text` est tronqué à
   * `maxTextLength`, si bien qu'une ligne bavarde perd son horodatage final —
   * et le dernier jeton temporel restant se trouve alors dans le CORPS du
   * message. Un « ça fait 11 ans que… » écrit par un correspondant devenait
   * l'âge du fil.
   *
   * Ce champ ne porte jamais d'aperçu : c'est ce qu'Instagram affiche comme
   * date, tel qu'il l'affiche.
   */
  readonly timeLabel: string | null;
  /** Les descriptions accessibles des images — Instagram y écrit parfois le handle. */
  readonly imageAlts: readonly string[];
  readonly ariaLabels: readonly string[];
  readonly rect: ObservedRect;
}

export interface RawInboxRead {
  /** Une liste de conversations a-t-elle été localisée du tout ? */
  readonly listFound: boolean;
  readonly rows: readonly InboxRowMeasure[];
  readonly avatarCount: number;
  readonly visibleTextLength: number;
  /** Le compte connecté, tel que la page le nomme. Diagnostic seulement. */
  readonly viewerLabel: string | null;
}

export const UNREADABLE_INBOX_READ: RawInboxRead = Object.freeze({
  listFound: false,
  rows: Object.freeze([]),
  avatarCount: 0,
  visibleTextLength: 0,
  viewerLabel: null,
});

// ---------------------------------------------------------------------------
// La fraîcheur
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * L'âge affiché par une ligne, en millisecondes, ou `null`.
 *
 * Les unités ambiguës sont refusées plutôt que devinées : « 5 m » vaut cinq
 * minutes en anglais et cinq mois nulle part, mais « 5 mois » existe en
 * français — un parseur qui tranche au hasard entre les deux se tromperait d'un
 * facteur quatre mille. Rendre `null` laisse l'appelant conclure « je ne sais
 * pas », ce qui est la seule réponse honnête.
 *
 * Le dernier jeton temporel de la ligne est retenu : l'horodatage suit l'aperçu,
 * et l'aperçu peut contenir des chiffres.
 */
export function parseRelativeAgeMs(text: string): number | null {
  const normalized = text.normalize('NFC').toLowerCase();
  if (/(^|[^a-z])(maintenant|à l'instant|a l'instant|just now|now)([^a-z]|$)/.test(normalized)) return 0;

  const pattern = /(\d{1,4})\s*(minutes?|mins?|mn|heures?|h|jours?|j|semaines?|sem\.?|mois|ans?|w|d|y)(?![a-z])/g;
  let last: { value: number; unit: string } | null = null;
  for (;;) {
    const match = pattern.exec(normalized);
    if (match === null) break;
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || unit === undefined) continue;
    last = { value, unit };
  }
  if (last === null) return null;

  const { value, unit } = last;
  if (/^(minutes?|mins?|mn)$/.test(unit)) return value * MINUTE;
  if (/^(heures?|h)$/.test(unit)) return value * HOUR;
  if (/^(jours?|j|d)$/.test(unit)) return value * DAY;
  if (/^(semaines?|sem\.?|w)$/.test(unit)) return value * WEEK;
  if (unit === 'mois') return value * 30 * DAY;
  if (/^(ans?|y)$/.test(unit)) return value * 365 * DAY;
  return null;
}

/**
 * IG5 R2 — l'âge d'une ligne, lu sur son horodatage et NULLE PART AILLEURS.
 *
 * Le relevé LIVE du 20 août a montré la faute de l'ancienne lecture : elle
 * appliquait `parseRelativeAgeMs` au texte ENTIER de la ligne. Ce texte est
 * borné à `maxTextLength`, donc une ligne bavarde perd son horodatage par la
 * troncature ; le dernier jeton temporel survivant appartenait alors à l'aperçu
 * du message, et « 11 ans » écrit par un correspondant est devenu l'âge du fil.
 *
 * Le correctif ne touche pas au parseur — il était juste, on le nourrissait mal.
 * Il change ce qu'on lui donne : le nœud que l'interface DÉSIGNE comme la date,
 * et rien d'autre. Pas de repli sur le corps de l'aperçu : quand ce nœud
 * n'existe pas, l'âge est inconnu, et une inconnue reste une inconnue.
 */
export function readRowAgeMs(row: Pick<InboxRowMeasure, 'timeLabel'>): number | null {
  if (row.timeLabel === null) return null;
  return parseRelativeAgeMs(row.timeLabel);
}

// ---------------------------------------------------------------------------
// La classification
// ---------------------------------------------------------------------------

export type InboxReadability = 'INBOX_READABLE' | 'INBOX_UNREADABLE';
export type ThreadPresence = 'THREAD_PRESENT' | 'THREAD_NOT_FOUND' | 'THREAD_UNKNOWN';

/** Comment la ligne a été reconnue. Le nom d'affichage seul ne suffit jamais. */
export type InboxMatchBasis = 'handle_token' | 'image_alt_handle' | 'corroborated_display_name';

export interface MatchedInboxRow {
  readonly index: number;
  readonly threadId: string | null;
  readonly basis: InboxMatchBasis;
  readonly text: string;
  /** L'âge affiché, en ms. `null` quand l'horodatage n'a pas pu être lu. */
  readonly ageMs: number | null;
  /** L'aperçu de la ligne porte-t-il le début du message approuvé ? */
  readonly previewMatchesApproved: boolean;
}

export interface InboxWitness {
  readonly readability: InboxReadability;
  readonly presence: ThreadPresence;
  readonly row: MatchedInboxRow | null;
  /** Plusieurs lignes correspondent : on n'en choisit aucune. */
  readonly ambiguous: boolean;
  readonly rowsSeen: number;
  readonly avatarCount: number;
  readonly visibleTextLength: number;
  readonly viewerLabel: string | null;
  readonly detail: string;
}

export const UNKNOWN_INBOX_WITNESS: InboxWitness = Object.freeze({
  readability: 'INBOX_UNREADABLE',
  presence: 'THREAD_UNKNOWN',
  row: null,
  ambiguous: false,
  rowsSeen: 0,
  avatarCount: 0,
  visibleTextLength: 0,
  viewerLabel: null,
  detail: 'boîte de réception non lue',
});

/**
 * Combien de lignes il faut avoir LUES pour dire qu'on a lu la liste.
 *
 * Trois : assez pour qu'une liste rendue se distingue d'un rendu partiel, assez
 * peu pour qu'une boîte réellement peu fournie reste lisible. Ce seuil porte
 * désormais sur des LIGNES — pas sur des vignettes ni sur un nombre de
 * caractères, qui restaient vrais quand aucune ligne n'avait été comprise.
 */
export const MIN_INBOX_ROWS = 3;

/**
 * Marge accordée à l'arrondi d'Instagram quand on demande « ce fil a-t-il
 * bougé depuis l'envoi ? ».
 *
 * L'interface arrondit : un message d'il y a trois minutes peut s'afficher
 * « 1 h ». Une heure de marge absorbe cet arrondi sans absorber onze semaines.
 */
export const BUMP_SLACK_MS = HOUR;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function loosen(value: string): string {
  return normalize(value).normalize('NFC').replace(/[‘’‛′ʼ`´]/g, "'");
}

function mentionsHandle(text: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._])${escaped}([^a-z0-9._]|$)`, 'i').test(text);
}

export interface InboxClassifyInput {
  readonly read: RawInboxRead;
  readonly expectedHandle: string;
  /**
   * Le nom d'affichage CORROBORÉ du handle attendu — celui que la page
   * canonique de ce handle a déclaré (`Moha (@operator_second_account)`).
   *
   * `null` quand il n'a pas pu être établi, et le nom d'affichage ne sert alors
   * à rien : reconnaître « Moha » sans savoir que « Moha » EST `operator_second_account`
   * reviendrait à ouvrir la conversation de n'importe quel homonyme.
   */
  readonly expectedDisplayName: string | null;
  /** Le début du message approuvé, tel qu'il apparaîtrait dans un aperçu. */
  readonly approvedPrefix: string;
}

/**
 * Range ce que la page a mesuré. Pure — donc chaque combinaison, y compris
 * celles qu'une vraie boîte mettrait des semaines à produire, est exerçable.
 */
export function classifyInbox(input: InboxClassifyInput): InboxWitness {
  const { read, expectedHandle } = input;
  const base = {
    rowsSeen: read.rows.length,
    avatarCount: read.avatarCount,
    visibleTextLength: read.visibleTextLength,
    viewerLabel: read.viewerLabel,
  };

  // ---- La lisibilité, mesurée sur des LIGNES -------------------------------
  const readable = read.listFound && read.rows.length >= MIN_INBOX_ROWS;
  if (!readable) {
    return Object.freeze({
      ...base,
      readability: 'INBOX_UNREADABLE' as const,
      presence: 'THREAD_UNKNOWN' as const,
      row: null,
      ambiguous: false,
      detail:
        `liste non lue (${read.rows.length} ligne(s) comprise(s), seuil ${MIN_INBOX_ROWS} ; ` +
        `${read.avatarCount} vignette(s), ${read.visibleTextLength} caractère(s)) — ` +
        'aucune absence ne peut en être déduite',
    });
  }

  // ---- La reconnaissance de la cible --------------------------------------
  const displayName = input.expectedDisplayName === null ? '' : normalize(input.expectedDisplayName);
  const loosePrefix = loosen(input.approvedPrefix);

  const matches: MatchedInboxRow[] = [];
  for (const row of read.rows) {
    const text = normalize(row.text);
    const alts = row.imageAlts.map(normalize).join(' ');
    const labels = row.ariaLabels.map(normalize).join(' ');

    let basis: InboxMatchBasis | null = null;
    if (mentionsHandle(text, expectedHandle) || mentionsHandle(labels, expectedHandle)) {
      basis = 'handle_token';
    } else if (mentionsHandle(alts, expectedHandle)) {
      basis = 'image_alt_handle';
    } else if (displayName.length > 0 && mentionsHandle(text, displayName)) {
      // Le nom d'affichage, et seulement CORROBORÉ : `expectedDisplayName` vient
      // du titre de la page canonique du handle attendu, pas d'une supposition.
      basis = 'corroborated_display_name';
    }
    if (basis === null) continue;

    matches.push(
      Object.freeze({
        index: row.index,
        threadId: row.threadId,
        basis,
        text: row.text.slice(0, 200),
        ageMs: readRowAgeMs(row),
        previewMatchesApproved: loosePrefix.length > 0 && loosen(row.text).includes(loosePrefix),
      }),
    );
  }

  if (matches.length === 0) {
    return Object.freeze({
      ...base,
      readability: 'INBOX_READABLE' as const,
      presence: 'THREAD_NOT_FOUND' as const,
      row: null,
      ambiguous: false,
      detail:
        `${read.rows.length} ligne(s) lues, aucune ne porte « ${expectedHandle} »` +
        (displayName.length > 0 ? ` ni « ${input.expectedDisplayName ?? ''} »` : '') +
        (displayName.length === 0
          ? ' (nom d’affichage non corroboré : la reconnaissance par nom n’a pas été tentée)'
          : ''),
    });
  }

  if (matches.length > 1) {
    return Object.freeze({
      ...base,
      readability: 'INBOX_READABLE' as const,
      presence: 'THREAD_PRESENT' as const,
      row: null,
      ambiguous: true,
      detail: `${matches.length} lignes portent la cible — aucune n’est retenue, l’ambiguïté se tranche à la main`,
    });
  }

  const row = matches[0];
  if (row === undefined) throw new Error('état incohérent : correspondance perdue');
  return Object.freeze({
    ...base,
    readability: 'INBOX_READABLE' as const,
    presence: 'THREAD_PRESENT' as const,
    row,
    ambiguous: false,
    detail:
      `conversation trouvée (reconnue par ${row.basis}), ` +
      `âge affiché ${row.ageMs === null ? 'illisible' : `${Math.round(row.ageMs / MINUTE)} min`}, ` +
      `aperçu du message approuvé ${row.previewMatchesApproved ? 'présent' : 'absent'}`,
  });
}

/**
 * Le fil a-t-il été REMONTÉ par l'envoi ?
 *
 * Un message remis devient le dernier message de sa conversation : la ligne
 * remonte en tête et son horodatage devient celui de l'envoi. Comparer l'âge
 * affiché à l'âge de la tentative répond donc directement à « ce message
 * est-il arrivé ? », et le fait sans rien inventer.
 *
 * `null` quand on ne peut pas conclure — horodatage illisible, ou pas de ligne.
 */
export function wasThreadBumped(row: MatchedInboxRow | null, effectAgeMs: number): boolean | null {
  if (row === null || row.ageMs === null) return null;
  if (!Number.isFinite(effectAgeMs) || effectAgeMs < 0) return null;
  return row.ageMs <= effectAgeMs + BUMP_SLACK_MS;
}

// ---------------------------------------------------------------------------
// La lecture dans la page
// ---------------------------------------------------------------------------

export interface InboxReadLimits {
  readonly maxRows: number;
  readonly maxTextLength: number;
  readonly maxAlts: number;
  /** Bornes d'une vignette de profil, en pixels. */
  readonly avatarMinPx: number;
  readonly avatarMaxPx: number;
  /** Bornes de hauteur d'une ligne de conversation. */
  readonly rowMinHeightPx: number;
  readonly rowMaxHeightPx: number;
  /**
   * Largeur minimale d'une ligne de conversation.
   *
   * C'est ce qui sépare une CONVERSATION d'une note du carrousel « Notes ».
   * Les deux portent une vignette dans la colonne de gauche et font la même
   * hauteur ; la note est une tuile étroite posée à côté d'autres, la
   * conversation occupe toute la largeur de la liste. Sans cette borne, la note
   * « Moha » et la conversation « Moha » comptaient pour deux candidates, et le
   * scanner refusait de trancher entre une conversation et une note.
   */
  readonly rowMinWidthPx: number;
  /** La liste vit dans la colonne de gauche. */
  readonly listMaxLeftPx: number;
  readonly maxAncestorWalk: number;
}

export const INBOX_READ_LIMITS: InboxReadLimits = Object.freeze({
  maxRows: 40,
  maxTextLength: 220,
  maxAlts: 4,
  avatarMinPx: 20,
  avatarMaxPx: 80,
  rowMinHeightPx: 44,
  rowMaxHeightPx: 140,
  rowMinWidthPx: 200,
  listMaxLeftPx: 620,
  maxAncestorWalk: 8,
});

/**
 * Le corps évalué dans la page, exporté pour être inspectable par un test.
 *
 * Il ne cherche plus de `a[href^="/direct/t/"]` : l'interface n'en met plus, et
 * s'y accrocher a produit « zéro ligne » sur une boîte pleine. Il part de ce
 * qui reste stable — une conversation est une VIGNETTE dans la colonne de
 * gauche, entourée d'un bloc de la hauteur d'une ligne — et remonte de la
 * vignette vers ce bloc.
 *
 * Aucune classe CSS n'est lue : elles sont minifiées et changent à chaque
 * déploiement. Aucun contenu de conversation n'est ouvert ni recopié au-delà de
 * ce que la ligne affiche déjà.
 *
 * Expression de fonction anonyme, sans fonction nommée à l'intérieur — sinon
 * `ReferenceError: __name is not defined` dans la page.
 */
export const SCAN_INBOX_IN_PAGE = function (limits: InboxReadLimits): RawInboxRead {
  const body = document.body;
  const visibleText = (body === null ? '' : body.innerText).replace(/\s+/g, ' ').trim();

  let viewerLabel: string | null = null;
  for (const heading of Array.from(document.querySelectorAll('h1, h2, span'))) {
    const box = heading.getBoundingClientRect();
    if (box.top > 120 || box.left > limits.listMaxLeftPx) continue;
    const text = ((heading as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
    // Un handle Instagram s'écrit en minuscules : « Accueil » ou « Messages »
    // ne peuvent pas en être un. Le libellé n'est que diagnostic, mais un
    // diagnostic faux vaut moins que pas de diagnostic.
    if (/^[a-z0-9._]{2,30}$/.test(text) && /[._0-9]/.test(text)) {
      viewerLabel = text;
      break;
    }
  }

  const rows: InboxRowMeasure[] = [];
  const seen: Element[] = [];
  let avatarCount = 0;

  for (const img of Array.from(document.querySelectorAll('img'))) {
    const box = img.getBoundingClientRect();
    if (box.left > limits.listMaxLeftPx) continue;
    if (box.width < limits.avatarMinPx || box.width > limits.avatarMaxPx) continue;
    if (box.height < limits.avatarMinPx) continue;
    avatarCount += 1;
    if (rows.length >= limits.maxRows) continue;

    // De la vignette vers la LIGNE : le premier ancêtre qui a la hauteur d'une
    // ligne de conversation et qui porte du texte.
    let row: Element | null = null;
    let current: Element | null = img.parentElement;
    for (let depth = 0; depth < limits.maxAncestorWalk && current !== null; depth += 1) {
      const rect = current.getBoundingClientRect();
      const text = ((current as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
      if (
        rect.height >= limits.rowMinHeightPx &&
        rect.height <= limits.rowMaxHeightPx &&
        rect.width >= limits.rowMinWidthPx &&
        rect.left <= limits.listMaxLeftPx &&
        text.length >= 2
      ) {
        row = current;
        break;
      }
      current = current.parentElement;
    }
    if (row === null) continue;

    let already = false;
    for (const known of seen) {
      if (known === row) {
        already = true;
        break;
      }
    }
    if (already) continue;
    seen.push(row);

    const rect = row.getBoundingClientRect();
    const text = ((row as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();

    const imageAlts: string[] = [];
    for (const inner of Array.from(row.querySelectorAll('img[alt]')).slice(0, limits.maxAlts)) {
      const alt = (inner.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
      if (alt.length > 0) imageAlts.push(alt.slice(0, limits.maxTextLength));
    }

    const ariaLabels: string[] = [];
    const ownLabel = (row.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
    if (ownLabel.length > 0) ariaLabels.push(ownLabel.slice(0, limits.maxTextLength));
    for (const inner of Array.from(row.querySelectorAll('[aria-label]')).slice(0, limits.maxAlts)) {
      const label = (inner.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
      if (label.length > 0) ariaLabels.push(label.slice(0, limits.maxTextLength));
    }

    // ---- L'HORODATAGE, isolé du reste ------------------------------------
    //
    // Ce que la ligne AFFICHE comme date, et jamais son aperçu. Deux formes ont
    // été observées : un `<time>` (qui porte la date en texte ou en `title`),
    // et — c'est le cas actuel — une `aria-label` de la forme « il y a 11 h ».
    //
    // Si plusieurs étiquettes distinctes ressemblent à une durée, aucune n'est
    // retenue : deux dates possibles sur une même ligne, c'est une date
    // inconnue, pas une date à tirer au sort.
    const timePattern =
      /(^|[^a-z])(\d{1,4}\s*(minutes?|mins?|mn|heures?|h|jours?|j|semaines?|sem\.?|mois|ans?|w|d|y)(?![a-z])|maintenant|à l'instant|a l'instant|just now|now)([^a-z]|$)/i;
    let timeLabel: string | null = null;
    for (const node of Array.from(row.querySelectorAll('time'))) {
      for (const raw of [
        node.getAttribute('aria-label') ?? '',
        (node as HTMLElement).innerText ?? '',
        node.getAttribute('title') ?? '',
      ]) {
        const value = raw.replace(/\s+/g, ' ').trim();
        if (value.length === 0 || value.length > 40) continue;
        timeLabel = value;
        break;
      }
      if (timeLabel !== null) break;
    }
    if (timeLabel === null) {
      const dated: string[] = [];
      for (const inner of Array.from(row.querySelectorAll('[aria-label]'))) {
        const value = (inner.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
        if (value.length === 0 || value.length > 40) continue;
        if (!timePattern.test(value)) continue;
        let known = false;
        for (const seenLabel of dated) {
          if (seenLabel === value) {
            known = true;
            break;
          }
        }
        if (!known) dated.push(value);
      }
      timeLabel = dated.length === 1 ? (dated[0] ?? null) : null;
    }

    let threadId: string | null = null;
    const link = row.querySelector('a[href^="/direct/t/"]') ?? row.closest('a[href^="/direct/t/"]');
    if (link !== null) {
      const match = /^\/direct\/t\/(\d{1,40})\//.exec(link.getAttribute('href') ?? '');
      threadId = match === null ? null : (match[1] ?? null);
    }

    rows.push({
      index: rows.length,
      threadId,
      text: text.slice(0, limits.maxTextLength),
      timeLabel,
      imageAlts,
      ariaLabels,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    });
  }

  return {
    listFound: rows.length > 0,
    rows,
    avatarCount,
    visibleTextLength: visibleText.length,
    viewerLabel,
  };
};
