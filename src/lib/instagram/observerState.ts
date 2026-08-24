import { normalizeHandle } from '@/lib/instagram/identity';
import { tokensOf } from '@/lib/pipeline/icpEligibility';
import type { IdentityCheck, ObservationState, ProfileFacts } from '@/lib/pipeline/instagramObservation';

/**
 * R7.3C §10–§11 — l'identité, puis l'état. Dans cet ordre, et jamais l'inverse.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi l'identité passe en premier
 * ---------------------------------------------------------------------------
 * Un profil peut être parfaitement lisible ET appartenir à quelqu'un d'autre.
 * C'est le cas le plus dangereux du round, parce qu'il ne ressemble pas à une
 * erreur : la collecte réussit, les chiffres sont beaux, et ils sont attribués à
 * une entreprise qui n'a rien à voir. Un handle mal recopié dans une preuve
 * `search` suffit à le produire.
 *
 * D'où l'ordre : si le nom d'utilisateur observé ne correspond pas au handle
 * attendu, l'état vaut `IDENTITY_CONTRADICTION` et les faits ne sont attribués à
 * personne — même s'ils ont été lus sans le moindre incident.
 *
 * ---------------------------------------------------------------------------
 * « Ne pas savoir n'est pas savoir le contraire »
 * ---------------------------------------------------------------------------
 * Trois verdicts, pas deux. Un nom d'utilisateur illisible ne rend PAS
 * `CONTRADICTION` — il rend `UNREADABLE`, qui laisse la question ouverte. C'est
 * la même règle que celle du commit `fix(instagram)` de la branche outbound, et
 * elle vaut ici pour la raison inverse : là-bas elle empêchait d'affirmer une
 * absence, ici elle empêche d'accuser un profil d'être le mauvais.
 */

/**
 * Compare le nom d'utilisateur observé au handle attendu.
 *
 * La comparaison porte sur les deux formes NORMALISÉES. Instagram rend parfois
 * le nom avec une casse d'affichage ou un `@` ; ces différences ne sont pas des
 * identités différentes, et les traiter comme telles produirait des
 * contradictions imaginaires sur des profils parfaitement corrects.
 *
 * Ce qui reste une contradiction : deux chaînes normalisées différentes. Aucune
 * tolérance de ressemblance, aucune distance d'édition — `atelier_lyon` et
 * `atelierlyon` sont deux comptes, et deviner lequel est le bon serait
 * exactement l'invention que CLAUDE.md interdit.
 */
export interface IdentityCheckInput {
  readonly expectedHandle: string;
  readonly observedUsername: string | null;
  readonly corroboration: readonly string[];
  /**
   * Ce que le profil OUVERT affiche de lui-même : nom, bio. Sert à répondre à
   * la seconde question d'identité — « ce compte est-il bien celui de cette
   * entreprise ? » — que la comparaison de handles ne pose pas.
   */
  readonly observedProfileText?: string | null;
  /**
   * Les identités connues du prospect : nom, enseigne, raison sociale, domaine.
   * Vide ou absent ⇒ la seconde question n'est pas posée, et le verdict reste
   * celui de la comparaison de handles.
   */
  readonly prospectIdentities?: readonly (string | null)[];
}

export function checkIdentity(input: IdentityCheckInput): IdentityCheck {
  const expected = normalizeHandle(input.expectedHandle);
  const observed = input.observedUsername === null ? null : normalizeHandle(input.observedUsername);

  if (expected === null) {
    return {
      expectedHandle: input.expectedHandle,
      observedUsername: input.observedUsername,
      verdict: 'UNREADABLE',
      reason: `handle attendu « ${input.expectedHandle} » invalide — rien ne peut lui être attribué`,
      corroboration: [...input.corroboration],
    };
  }
  if (observed === null) {
    return {
      expectedHandle: expected,
      observedUsername: input.observedUsername,
      verdict: 'UNREADABLE',
      reason: 'nom d’utilisateur non lu sur la page — l’identité reste ouverte, elle n’est pas contredite',
      corroboration: [...input.corroboration],
    };
  }
  if (observed !== expected) {
    return {
      expectedHandle: expected,
      observedUsername: observed,
      verdict: 'CONTRADICTION',
      reason: `le profil ouvert se nomme « ${observed} », le prospect attend « ${expected} » — aucune attribution`,
      corroboration: [...input.corroboration],
    };
  }
  /**
   * Le compte visé a bien été ouvert. Reste la seconde question : ce qu'il
   * AFFICHE rattache-t-il ce compte à cette entreprise ?
   *
   * La règle est volontairement asymétrique. Un recouvrement lexical CORROBORE ;
   * son absence ne CONDAMNE pas — beaucoup de comptes légitimes portent un nom
   * sans rapport avec la raison sociale. C'est pourquoi l'absence produit
   * `UNCORROBORATED` et non `CONTRADICTION` : elle retire une garantie, elle
   * n'en affirme pas l'inverse.
   */
  const identityTokens = new Set(
    (input.prospectIdentities ?? []).flatMap((value) =>
      tokensOf(typeof value === 'string' ? value.replace(/\.[a-z]{2,}$/i, '') : value),
    ),
  );
  /**
   * Texte APLATI : accents retirés, minuscules, tout séparateur supprimé.
   *
   * Le collage est délibéré. Un nom d'utilisateur est un mot collé
   * (`northstarstudio`), et une comparaison à frontière de mot n'y trouverait jamais
   * « kapital ». Le plancher de quatre caractères de `tokensOf` est ce qui garde
   * la sous-chaîne honnête : « car » trouverait « carrosserie », « care » et
   * « scarface », « auto » ne trouve que ce qui contient réellement « auto ».
   */
  const profileText = `${observed ?? ''} ${input.observedProfileText ?? ''}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (identityTokens.size > 0 && profileText.trim().length > 0) {
    const shared = [...identityTokens].filter((token) => profileText.includes(token));
    if (shared.length === 0) {
      return {
        expectedHandle: expected,
        observedUsername: observed,
        verdict: 'UNCORROBORATED',
        reason:
          `le compte « ${observed} » est bien celui qui était visé, mais rien de ce qu’il affiche ` +
          `(nom, bio) ne partage un mot avec l’identité connue du prospect — ` +
          'le handle vient peut-être d’un pied de page ou d’un gabarit, pas de l’entreprise',
        corroboration: [...input.corroboration],
      };
    }
    return {
      expectedHandle: expected,
      observedUsername: observed,
      verdict: 'MATCH',
      reason:
        `nom d’utilisateur conforme ; le profil ouvert partage « ${shared.join(', ')} » ` +
        'avec l’identité connue du prospect',
      corroboration: [...input.corroboration],
    };
  }

  return {
    expectedHandle: expected,
    observedUsername: observed,
    verdict: 'MATCH',
    reason:
      input.corroboration.length > 0
        ? `nom d’utilisateur conforme ; handle corroboré par ${input.corroboration.join(', ')}`
        : 'nom d’utilisateur conforme au handle attendu',
    corroboration: [...input.corroboration],
  };
}

/**
 * Les faits SANS lesquels une observation ne peut pas être dite complète.
 *
 * Le choix est celui du §12 : les trois comptages qui font sortir la
 * classification d'`UNKNOWN`, plus le nom d'utilisateur qui les attribue. Une
 * bio absente ne dégrade pas l'état — beaucoup de comptes n'en ont pas, et
 * l'exiger transformerait un fait commercial en défaut technique.
 */
const REQUIRED_FOR_COMPLETE: readonly (keyof ProfileFacts)[] = ['username', 'postCount'];

export interface PageSignals {
  /** Texte VISIBLE de la page (`innerText`), jamais le HTML ni `textContent`. */
  readonly visibleText: string;
  readonly finalUrl: string;
  /** Widgets de vérification réellement présents dans le DOM. */
  readonly captchaWidgets: number;
  /** Statut HTTP de la navigation principale, quand il a pu être lu. */
  readonly httpStatus: number | null;
}

const NOT_FOUND_MARKERS: readonly RegExp[] = [
  /sorry,?\s*this page\s*isn'?t available/i,
  /cette page n'?est pas disponible/i,
  /the link you followed may be broken/i,
  /le lien que vous avez suivi est peut-être rompu/i,
];

const PRIVATE_MARKERS: readonly RegExp[] = [
  /this account is private/i,
  /ce compte est privé/i,
  /follow (this account )?to see (their|its) photos/i,
  /abonnez-vous pour voir (ses|leurs) photos/i,
];

const LOGIN_MARKERS: readonly RegExp[] = [
  /log in to instagram/i,
  /connectez-vous à instagram/i,
  /phone number, username, or email/i,
  /numéro de téléphone, nom d.utilisateur ou e-?mail/i,
];

const CHALLENGE_MARKERS: readonly RegExp[] = [
  /confirm(er)? (your|votre) (identity|identité)/i,
  /we detected an unusual login/i,
  /connexion inhabituelle/i,
  /help us confirm/i,
  /suspicious login attempt/i,
];

const BLOCKED_MARKERS: readonly RegExp[] = [
  /your account has been temporarily (blocked|locked)/i,
  /votre compte a été temporairement (bloqué|verrouillé)/i,
  /we restrict certain activity/i,
  /nous limitons certaines activités/i,
  /action blocked/i,
  /action bloquée/i,
];

const RATE_LIMIT_MARKERS: readonly RegExp[] = [
  /please wait a few minutes before you try again/i,
  /veuillez patienter quelques minutes/i,
  /try again later/i,
  /réessayez plus tard/i,
];

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * L'état de la tentative, dans l'ordre de gravité décroissante.
 *
 * L'ordre n'est pas cosmétique : une page qui affiche À LA FOIS un mur de
 * connexion et un compte privé doit sortir `LOGIN_REQUIRED`, parce que c'est ce
 * qui bloque REELLEMENT — le compte n'est peut-être pas privé du tout, on ne l'a
 * simplement pas vu.
 *
 * Les marqueurs sont cherchés dans le texte VISIBLE. La leçon est celle du rail
 * outbound, payée au premier smoke réel : `textContent` inclut les balises
 * `<script>`, et le bootstrap d'Instagram y cite `arkose_captcha` — une page
 * d'accueil parfaitement ordinaire se classait donc en arrêt dur, sur la foi
 * d'un mot trouvé dans du JavaScript minifié.
 */
export function classifyObservationState(input: {
  readonly page: PageSignals;
  readonly identity: IdentityCheck;
  readonly facts: ProfileFacts;
  readonly postsObserved: number;
}): { readonly state: ObservationState; readonly detail: string } {
  const { page, identity, facts } = input;
  const text = page.visibleText;
  const path = (() => {
    try {
      return new URL(page.finalUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (path.startsWith('/challenge')) {
    return { state: 'CHALLENGE', detail: 'Instagram demande une vérification (/challenge)' };
  }
  if (matches(text, BLOCKED_MARKERS)) {
    return { state: 'SESSION_BLOCKED', detail: 'Instagram annonce une restriction sur cette session' };
  }
  if (page.captchaWidgets > 0 || matches(text, CHALLENGE_MARKERS)) {
    return {
      state: 'CHALLENGE',
      detail:
        page.captchaWidgets > 0
          ? `${page.captchaWidgets} widget(s) de vérification affiché(s)`
          : 'Instagram demande une confirmation d’identité',
    };
  }
  if (page.httpStatus === 429 || matches(text, RATE_LIMIT_MARKERS)) {
    return { state: 'RATE_LIMITED', detail: 'Instagram demande d’attendre avant une nouvelle requête' };
  }
  if (path.startsWith('/accounts/login') || matches(text, LOGIN_MARKERS)) {
    return { state: 'LOGIN_REQUIRED', detail: 'Instagram exige une connexion pour afficher ce contenu' };
  }
  if (page.httpStatus === 404 || matches(text, NOT_FOUND_MARKERS)) {
    return {
      state: 'NOT_FOUND',
      detail: 'ce handle ne résout aucun profil — un fait sur notre donnée, pas sur l’entreprise',
    };
  }

  /**
   * L'identité APRÈS les portes de plateforme, et avant tout le reste.
   *
   * Après, parce qu'un mur de connexion explique un nom d'utilisateur illisible
   * et qu'il serait absurde d'en faire une contradiction. Avant, parce qu'un
   * profil lisible mais étranger ne doit rien apporter à ce prospect.
   */
  if (identity.verdict === 'CONTRADICTION') {
    return { state: 'IDENTITY_CONTRADICTION', detail: identity.reason };
  }

  if (facts.isPrivate?.value === true || matches(text, PRIVATE_MARKERS)) {
    return {
      state: 'PRIVATE',
      detail: 'compte privé — ses publications ne nous sont pas visibles, ce qui ne dit rien de son activité',
    };
  }

  const missing = REQUIRED_FOR_COMPLETE.filter((key) => facts[key] === undefined);
  if (missing.length === REQUIRED_FOR_COMPLETE.length) {
    return {
      state: 'UNREADABLE',
      detail: 'aucun fait de profil n’a pu être lu — illisible, ce qui n’est pas la même chose qu’absent',
    };
  }
  if (missing.length > 0 || input.postsObserved === 0) {
    return {
      state: 'PARTIAL',
      detail:
        missing.length > 0
          ? `profil partiellement lu — manquent : ${missing.join(', ')}`
          : 'profil lu, mais aucune publication horodatée visible — la cadence restera inconnue',
    };
  }

  return {
    state: 'OBSERVED',
    detail: `profil lu, ${input.postsObserved} publication(s) horodatée(s) visible(s)`,
  };
}
