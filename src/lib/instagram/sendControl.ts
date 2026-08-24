/**
 * HERMES-SEND-CONTROL-PROBE-R1 §14/§15/§16/§18 — QUEL élément est le contrôle
 * d'envoi, décidé par du code pur sur des mesures.
 *
 * ---------------------------------------------------------------------------
 * L'ancre qui ne rendait rien
 * ---------------------------------------------------------------------------
 * Jusqu'ici, la primitive bornait sa recherche par
 * `ancestor::*[@role="dialog" or @aria-label][1]` — le premier ancêtre du
 * composeur portant un rôle ou un libellé. C'était la bonne intention : « Envoyer »
 * n'est pas un mot rare sur une page Instagram, et ce bouton est le seul dont un
 * clic produit un effet.
 *
 * Mesuré le 22 août 2026 sur un vrai `/direct/t/<id>/`, cette ancre rend ZÉRO
 * élément : les dix-huit ancêtres du composeur sont des `div` nus. L'ancre
 * décrivait le panneau du CANARI — une discussion ouverte en surimpression d'un
 * profil, qui est bien un `dialog`. Un fil plein écran n'en est pas un. Le
 * contrôle n'était donc pas jugé absent : il n'était pas cherché.
 *
 * ---------------------------------------------------------------------------
 * Ce qui le remplace, et pourquoi c'est PLUS fort
 * ---------------------------------------------------------------------------
 * Le périmètre est désormais le RECTANGLE DU PANNEAU que
 * `decideThreadIdentity` vient de retenir (`ThreadIdentityObservation.panelRect`).
 *
 * Ce n'est pas un repli, c'est une preuve strictement supérieure :
 *
 *   * l'ancienne ancre disait « un ancêtre du composeur qui porte un attribut » —
 *     une propriété de forme, vraie ou fausse selon le gabarit d'Instagram ;
 *   * `panelRect` est le panneau sur lequel l'identité du CORRESPONDANT vient
 *     d'être établie, à l'instant, sur cette page. Il englobe la barre de titre
 *     qui nomme la personne, la liste des messages, et le composeur. Cliquer
 *     dedans, c'est cliquer dans le fil qu'on vient de confirmer.
 *
 * Un panneau non retenu ⇒ `SCOPE_UNKNOWN`, et rien n'est cherché. C'est la même
 * sévérité qu'avant, sur un critère qui, lui, décrit la vraie page.
 *
 * ---------------------------------------------------------------------------
 * §18 — plusieurs prétendants ne se départagent pas
 * ---------------------------------------------------------------------------
 * Deux candidats distincts dans le panneau rendent `AMBIGUOUS`, jamais « le
 * premier ». Prendre le premier reviendrait à laisser l'ordre du document
 * décider quel bouton on clique — c'est-à-dire à ne pas décider.
 *
 * Un candidat présent mais inactif rend `DISABLED` : Instagram désactive son
 * contrôle tant que le composeur est vide, et cliquer un contrôle inactif ne
 * remet rien tout en faisant croire le contraire.
 *
 * ---------------------------------------------------------------------------
 * Ce module est PUR
 * ---------------------------------------------------------------------------
 * Il ne connaît ni Playwright, ni page, ni sélecteur. Il reçoit des mesures et
 * rend un verdict — ce qui permet d'éprouver la géométrie réelle du 22 août
 * 2026 dans un test, sans navigateur. C'est la leçon de `threadIdentity.ts` :
 * une géométrie validée à la main sur une page qui n'existe dans aucun test se
 * re-casse au premier réglage suivant.
 */

import type { ReadRect } from '@/lib/instagram/threadIdentity';

/** Un prétendant au contrôle d'envoi, tel que la page l'a mesuré. */
export interface SendControlCandidate {
  /** Index du sélecteur qui l'a trouvé, dans `SEND_CONTROL_SELECTORS`. */
  readonly selectorIndex: number;
  /** Rang de l'élément parmi les correspondances de CE sélecteur. */
  readonly nth: number;
  readonly visible: boolean;
  readonly rect: ReadRect | null;
  readonly tag: string;
  readonly role: string | null;
  readonly ariaLabel: string | null;
  /** Texte court, borné par la page. Sert au diagnostic, jamais à décider. */
  readonly text: string;
  readonly ariaDisabled: string | null;
  readonly tabIndex: string | null;
  /** Ce que Playwright conclut de `isEnabled()`. Une lecture ratée vaut `false`. */
  readonly enabled: boolean;
}

export type SendControlOutcome =
  /** Exactement un contrôle actif dans le panneau confirmé. Le seul cas cliquable. */
  | 'SEND_CONTROL_MATCH'
  /** Le panneau n'a pas été retenu : il n'y a pas de périmètre où chercher. */
  | 'SEND_CONTROL_SCOPE_UNKNOWN'
  /** Aucun prétendant dans le panneau confirmé. */
  | 'SEND_CONTROL_NOT_FOUND'
  /** Plusieurs prétendants distincts. Refus, jamais un arbitrage. */
  | 'SEND_CONTROL_AMBIGUOUS'
  /** Un seul prétendant, mais inactif. */
  | 'SEND_CONTROL_DISABLED';

export interface SendControlDecision {
  readonly outcome: SendControlOutcome;
  /** Le candidat retenu — présent pour `MATCH` et `DISABLED`, jamais autrement. */
  readonly chosen: SendControlCandidate | null;
  /** Combien de prétendants la page portait, tous périmètres confondus. */
  readonly seen: number;
  /** Combien étaient visibles ET dans le panneau confirmé, après dédoublonnage. */
  readonly inScope: number;
  readonly detail: string;
}

function frozen(decision: SendControlDecision): SendControlDecision {
  return Object.freeze(decision);
}

/**
 * Ce rectangle est-il ENTIÈREMENT dans le panneau ?
 *
 * Containment strict, et non un simple chevauchement : un élément qui déborde
 * du panneau n'appartient pas au fil confirmé, et « il le touche » n'est pas
 * une preuve d'appartenance. La tolérance d'un pixel absorbe les arrondis de
 * `getBoundingClientRect`, rien de plus.
 */
const EDGE_TOLERANCE_PX = 1;

export function isInsidePanel(rect: ReadRect, panel: ReadRect): boolean {
  return (
    rect.top >= panel.top - EDGE_TOLERANCE_PX &&
    rect.bottom <= panel.bottom + EDGE_TOLERANCE_PX &&
    rect.left >= panel.left - EDGE_TOLERANCE_PX &&
    rect.right <= panel.right + EDGE_TOLERANCE_PX
  );
}

/**
 * Deux mesures désignent-elles le MÊME élément ?
 *
 * `SEND_CONTROL_SELECTORS` porte huit sélecteurs qui se recouvrent
 * délibérément — `div[role="button"][aria-label="Envoyer"]` et
 * `div[role="button"]:text-is("Envoyer")` peuvent trouver le même nœud. Sans
 * dédoublonnage, un contrôle unique se présenterait comme deux prétendants et
 * `AMBIGUOUS` refuserait une page parfaitement claire.
 *
 * L'égalité se juge sur ce que la page a mesuré : même rectangle, même balise,
 * même rôle, même libellé. Deux nœuds distincts qui partagent tout cela sont
 * indiscernables pour un clic — et s'il y en avait vraiment deux, en cliquer un
 * ou l'autre reviendrait au même geste au même endroit.
 */
function sameElement(a: SendControlCandidate, b: SendControlCandidate): boolean {
  if (a.rect === null || b.rect === null) return false;
  return (
    a.tag === b.tag &&
    a.role === b.role &&
    a.ariaLabel === b.ariaLabel &&
    a.rect.top === b.rect.top &&
    a.rect.bottom === b.rect.bottom &&
    a.rect.left === b.rect.left &&
    a.rect.right === b.rect.right
  );
}

function describe(candidate: SendControlCandidate): string {
  const name = candidate.ariaLabel ?? (candidate.text.length > 0 ? candidate.text : '—');
  const rect = candidate.rect;
  const where = rect === null ? 'sans rectangle' : `y${rect.top}..${rect.bottom} x${rect.left}..${rect.right}`;
  return `${candidate.tag}[role=${candidate.role ?? '—'}] « ${name} » ${where}`;
}

/**
 * Le contrôle d'envoi, ou la raison pour laquelle il n'y en a pas.
 *
 * L'ordre des refus est celui de leur CAUSE, parce que chacun fait chercher à
 * un endroit différent : pas de périmètre ⇒ revoir l'ancre ; aucun prétendant
 * ⇒ revoir les sélecteurs ; plusieurs ⇒ revoir la page avant de toucher quoi
 * que ce soit.
 */
export function decideSendControl(input: {
  readonly candidates: readonly SendControlCandidate[];
  readonly panelRect: ReadRect | null;
}): SendControlDecision {
  const seen = input.candidates.length;
  const panel = input.panelRect;

  if (panel === null) {
    return frozen({
      outcome: 'SEND_CONTROL_SCOPE_UNKNOWN',
      chosen: null,
      seen,
      inScope: 0,
      detail:
        'le panneau du fil n’a pas été retenu — il n’existe aucun périmètre dans lequel chercher, et ' +
        'chercher dans la page entière reviendrait à cliquer « le premier Envoyer visible »',
    });
  }

  const scoped: SendControlCandidate[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.visible) continue;
    const rect = candidate.rect;
    if (rect === null || !isInsidePanel(rect, panel)) continue;
    if (scoped.some((kept) => sameElement(kept, candidate))) continue;
    scoped.push(candidate);
  }

  if (scoped.length === 0) {
    return frozen({
      outcome: 'SEND_CONTROL_NOT_FOUND',
      chosen: null,
      seen,
      inScope: 0,
      detail:
        `aucun contrôle d’envoi visible DANS le panneau confirmé (${String(seen)} prétendant(s) mesuré(s) ` +
        'sur la page). Cliquer un « Envoyer » trouvé ailleurs serait cliquer autre chose',
    });
  }

  if (scoped.length > 1) {
    return frozen({
      outcome: 'SEND_CONTROL_AMBIGUOUS',
      chosen: null,
      seen,
      inScope: scoped.length,
      detail:
        `${String(scoped.length)} contrôles distincts dans le panneau confirmé — ` +
        `${scoped.map(describe).join(' | ')}. Prendre le premier laisserait l’ordre du document décider ` +
        'quel bouton on clique',
    });
  }

  const chosen = scoped[0] as SendControlCandidate;
  if (!chosen.enabled) {
    return frozen({
      outcome: 'SEND_CONTROL_DISABLED',
      chosen,
      seen,
      inScope: 1,
      detail:
        `${describe(chosen)} — présent dans le panneau confirmé mais INACTIF ` +
        `(aria-disabled=${chosen.ariaDisabled ?? '—'}, tabindex=${chosen.tabIndex ?? '—'}). Le cliquer ne ` +
        'remettrait rien tout en faisant croire le contraire',
    });
  }

  return frozen({
    outcome: 'SEND_CONTROL_MATCH',
    chosen,
    seen,
    inScope: 1,
    detail: `${describe(chosen)} — unique et actif dans le panneau confirmé`,
  });
}
