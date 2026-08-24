/**
 * HERMES-IDENTITY-CANONICALIZATION-R1 §4/§6/§7 — NOTRE compte, et la
 * distinction que le dépôt confondait.
 *
 * ---------------------------------------------------------------------------
 * Deux questions que le même mot posait
 * ---------------------------------------------------------------------------
 * `r6b_inbound_messages.mailbox` porte le handle sous lequel la relève tournait
 * quand elle a lu le message. C'est un FAIT D'OBSERVATION, daté, et il reste
 * vrai pour toujours : le 21 août 2026, cette boîte s'appelait
 * `hermesagency_`.
 *
 * `sendThreadReply` s'en servait pour répondre à une tout autre question :
 * « sous quel compte cette session est-elle ouverte MAINTENANT ? ». Les deux
 * coïncidaient tant que personne ne renommait le compte. Le 22 août 2026, la
 * page `instagram.com/hermesagency_/` a répondu « cette page n'est pas
 * disponible » : le compte avait été renommé `hermes__`, et le rail de réponse
 * refusait à sa première porte — correctement, sur une question mal posée.
 *
 * Réécrire les huit lignes historiques aurait fait disparaître le seul endroit
 * où le dépôt sait sous quel nom il a lu ces messages. Ce module fait l'inverse :
 * il sépare les deux notions et laisse l'histoire tranquille.
 *
 *   * **identité courante** — `currentHandle`, ce qu'on va confronter à la page ;
 *   * **identités connues** — `currentHandle` ∪ `formerHandles`, ce qui permet
 *     de dire d'un `mailbox` historique : « oui, c'était nous ».
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un handle, et pas un identifiant provider
 * ---------------------------------------------------------------------------
 * Un handle est mutable — c'est précisément l'incident qui a créé ce module —
 * et un identifiant numérique Instagram ne l'est pas. §7 demande donc de
 * préférer l'identifiant stable S'IL EXISTE DÉJÀ dans le système.
 *
 * Il n'existe pas. Aucune table ne porte l'identifiant Instagram de NOTRE
 * compte : `ig_identity_checks` décrit des PROSPECTS, `ig_browser_sessions`
 * décrit un profil de navigateur (`profile_label`), `ig_inbound_polls` porte un
 * `account_handle`. La seule preuve d'identité de l'émetteur que ce dépôt sache
 * produire est « Modifier le profil » lu sur `instagram.com/<handle>/`
 * (`readRelationship`), et elle part d'un handle.
 *
 * Aller chercher un identifiant numérique demanderait une nouvelle collecte sur
 * une page — ce que §7 interdit explicitement pour cette mission. Le handle
 * reste donc l'identité, et ce module rend son changement RATTRAPABLE plutôt
 * qu'invisible : une renomination s'inscrit dans `formerAccountHandles`, en
 * config, dans un diff que quelqu'un signe.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module refuse
 * ---------------------------------------------------------------------------
 * Il est pur : ni base, ni page, ni horloge. Il ne devine aucun handle, n'en
 * normalise aucun au-delà de ce que `normalizeHandle` fait déjà (casse), et
 * refuse une configuration ambiguë plutôt que de l'arranger — un ancien handle
 * égal au courant, ou un doublon, décrit une intention que personne ne peut
 * relire.
 */

import { normalizeHandle } from '@/lib/instagram/identity';

/** L'identité de NOTRE compte : celle d'aujourd'hui, et celles qu'il a portées. */
export interface CanonicalAccountIdentity {
  /** Le handle actuel, normalisé. C'est LUI qu'on confronte à la page. */
  readonly currentHandle: string;
  /**
   * Les handles que ce MÊME compte a portés avant. Normalisés, sans doublon,
   * et le courant n'en fait jamais partie.
   */
  readonly formerHandles: readonly string[];
}

/** Pourquoi une configuration d'identité n'est pas exploitable. */
export type AccountIdentityRefusal =
  /** Le handle courant n'est pas un handle Instagram lisible. */
  | 'ACCOUNT_HANDLE_UNREADABLE'
  /** Un ancien handle n'est pas un handle Instagram lisible. */
  | 'ACCOUNT_FORMER_HANDLE_UNREADABLE'
  /** Un ancien handle est aussi le courant — deux notions dans un seul mot. */
  | 'ACCOUNT_FORMER_HANDLE_IS_CURRENT'
  /** Le même ancien handle est déclaré deux fois. */
  | 'ACCOUNT_FORMER_HANDLE_DUPLICATED';

export type AccountIdentityResolution =
  | { readonly ok: true; readonly identity: CanonicalAccountIdentity }
  | { readonly ok: false; readonly refusal: AccountIdentityRefusal; readonly detail: string };

function refuse(refusal: AccountIdentityRefusal, detail: string): AccountIdentityResolution {
  return Object.freeze({ ok: false as const, refusal, detail });
}

/**
 * Construit l'identité canonique depuis ce que la configuration déclare.
 *
 * Rend un refus plutôt qu'une exception : l'appelant est toujours un chemin qui
 * a déjà un vocabulaire de refus, et une identité illisible doit s'y ranger
 * comme les autres — pas faire tomber un worker.
 */
export function canonicalAccountIdentity(input: {
  readonly accountHandle: string;
  readonly formerAccountHandles: readonly string[];
}): AccountIdentityResolution {
  const currentHandle = normalizeHandle(input.accountHandle);
  if (currentHandle === null) {
    return refuse(
      'ACCOUNT_HANDLE_UNREADABLE',
      `« ${input.accountHandle} » n’est pas un handle Instagram lisible — sans compte courant, aucune ` +
        'session ne peut être confrontée à quoi que ce soit',
    );
  }

  const formerHandles: string[] = [];
  for (const raw of input.formerAccountHandles) {
    const handle = normalizeHandle(raw);
    if (handle === null) {
      return refuse(
        'ACCOUNT_FORMER_HANDLE_UNREADABLE',
        `« ${raw} » est déclaré comme ancien handle de ce compte et n’est pas un handle Instagram lisible`,
      );
    }
    if (handle === currentHandle) {
      return refuse(
        'ACCOUNT_FORMER_HANDLE_IS_CURRENT',
        `« ${handle} » est déclaré à la fois comme handle courant et comme ancien — l'un des deux est ` +
          'faux, et deviner lequel reviendrait à choisir une identité à la place de quelqu’un',
      );
    }
    if (formerHandles.includes(handle)) {
      return refuse(
        'ACCOUNT_FORMER_HANDLE_DUPLICATED',
        `« ${handle} » est déclaré deux fois parmi les anciens handles — une liste qui se répète ne dit ` +
          'pas ce qu’elle veut dire',
      );
    }
    formerHandles.push(handle);
  }

  return Object.freeze({
    ok: true as const,
    identity: Object.freeze({
      currentHandle,
      formerHandles: Object.freeze([...formerHandles]),
    }),
  });
}

/**
 * Ce `mailbox` observé désigne-t-il bien CE compte ?
 *
 * La question que pose une ligne historique. `false` n'est pas « une valeur
 * périmée » : c'est « ce message a été reçu ailleurs que chez nous », et
 * répondre dedans reviendrait à parler depuis un compte qui ne l'a jamais lu.
 *
 * Une valeur illisible rend `false` — « je n'ai pas su lire » n'est pas
 * « c'était nous ».
 */
export function isKnownAccountIdentity(identity: CanonicalAccountIdentity, observedHandle: string): boolean {
  const observed = normalizeHandle(observedHandle);
  if (observed === null) return false;
  return observed === identity.currentHandle || identity.formerHandles.includes(observed);
}

/** Les identités connues, courante d'abord. Pour un journal, jamais pour décider. */
export function knownAccountHandles(identity: CanonicalAccountIdentity): readonly string[] {
  return Object.freeze([identity.currentHandle, ...identity.formerHandles]);
}
