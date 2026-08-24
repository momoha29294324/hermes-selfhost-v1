import type { DispatchMode } from '@/lib/pipeline/r6bDispatcher';

/**
 * R6B-C.2B — la réconciliation est une lecture, pas un mode de dispatch :
 * elle interroge le provider sur une tentative dont l'issue est inconnue et
 * n'envoie jamais rien. Elle vit ici parce qu'elle partage l'unique règle de
 * sélection : un `--manifest-id` explicite, et rien d'autre.
 */
export type DispatchAction = DispatchMode | 'RECONCILE';

/**
 * R6B-C.1 §12 — analyse de la ligne de commande de `npm run r6b:dispatch`.
 *
 * Séparée de l'exécutable pour être testable sans lancer de dispatch, et
 * parce que c'est ici que vit la garantie la plus facile à perdre : la
 * commande ne doit accepter *aucun* autre moyen de désigner une cible qu'un
 * `--manifest-id` explicite.
 *
 * Liste blanche plutôt que liste noire. Refuser nommément `--batch`,
 * `--prospect` et `--all` protégerait contre les trois options auxquelles on
 * a pensé aujourd'hui ; refuser tout ce qui n'est pas explicitement autorisé
 * protège aussi contre celle que quelqu'un ajoutera demain.
 */

const ALLOWED = new Set(['--manifest-id', '--dry-run', '--live', '--reconcile', '--allow-idempotent-replay']);

/** Options de sélection alternative, refusées avec un message qui dit pourquoi (§12). */
const REFUSED_SELECTORS = new Map<string, string>([
  ['--batch', 'un batch entier n’est pas une cible de dispatch'],
  ['--batch-id', 'un batch entier n’est pas une cible de dispatch'],
  ['--batch-item', 'un item de batch peut avoir plusieurs manifestes dans son historique'],
  ['--batch-item-id', 'un item de batch peut avoir plusieurs manifestes dans son historique'],
  ['--prospect', 'un prospect n’identifie pas le texte ni le transport approuvés'],
  ['--prospect-id', 'un prospect n’identifie pas le texte ni le transport approuvés'],
  ['--all', 'un dispatch de masse n’existe pas'],
  ['--send-all', 'un dispatch de masse n’existe pas'],
  ['--recipient', 'le destinataire vient du manifeste verrouillé, jamais de l’appelant'],
  ['--transport', 'le transport vient du manifeste verrouillé, jamais de l’appelant'],
  ['--text', 'le texte vient du manifeste verrouillé, jamais de l’appelant'],
  ['--message', 'le texte vient du manifeste verrouillé, jamais de l’appelant'],
]);

export class DispatchArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchArgError';
  }
}

export interface ParsedDispatchArgs {
  readonly manifestId: string;
  readonly mode: DispatchAction;
  /**
   * R6B-C.2B.1 — autorise la réconciliation à rejouer le `POST` d'origine à
   * l'identique (même clé d'idempotence, même payload, dans la fenêtre de 24 h
   * documentée par Resend).
   *
   * Option distincte plutôt que comportement par défaut de `--reconcile` :
   * dans le monde où la première requête n'était jamais arrivée, ce rejeu
   * délivre réellement l'email. Le résultat reste « exactement un email » —
   * c'est toute la garantie d'idempotence — mais toucher au réseau avec un
   * verbe d'écriture doit rester une décision humaine, pas un effet de bord
   * d'une commande qui s'annonce en lecture seule.
   */
  readonly allowIdempotentReplay: boolean;
}

export function parseDispatchArgs(argv: readonly string[]): ParsedDispatchArgs {
  let manifestId: string | null = null;
  let dryRun = false;
  let live = false;
  let reconcile = false;
  let allowIdempotentReplay = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (!ALLOWED.has(token)) {
      const reason = REFUSED_SELECTORS.get(token.split('=')[0] ?? token);
      throw new DispatchArgError(
        reason !== undefined
          ? `option refusée « ${token} » : ${reason}. Un dispatch = un --manifest-id explicite.`
          : `option inconnue « ${token} ». Options acceptées : --manifest-id <uuid>, --dry-run, --live, --reconcile.`,
      );
    }

    if (token === '--manifest-id') {
      if (manifestId !== null) {
        throw new DispatchArgError('--manifest-id ne peut être passé qu’une seule fois — un dispatch vise un seul manifeste.');
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new DispatchArgError('--manifest-id exige une valeur.');
      }
      manifestId = value;
      i += 1;
      continue;
    }
    if (token === '--dry-run') dryRun = true;
    if (token === '--live') live = true;
    if (token === '--reconcile') reconcile = true;
    if (token === '--allow-idempotent-replay') allowIdempotentReplay = true;
  }

  if (manifestId === null || manifestId.trim().length === 0) {
    throw new DispatchArgError(
      'un --manifest-id explicite est obligatoire — il n’existe aucun autre moyen de désigner une cible.',
    );
  }
  const chosen = [dryRun, live, reconcile].filter(Boolean).length;
  if (chosen > 1) {
    throw new DispatchArgError('--dry-run, --live et --reconcile sont exclusifs.');
  }
  // §12 : aucune valeur LIVE implicite. Omettre le mode ne « choisit » pas
  // l'envoi par défaut — la commande refuse de deviner.
  if (chosen === 0) {
    throw new DispatchArgError(
      'un mode explicite est obligatoire (--dry-run, --live ou --reconcile) — aucun mode par défaut n’est supposé.',
    );
  }

  const mode: DispatchAction = live ? 'LIVE' : reconcile ? 'RECONCILE' : 'DRY_RUN';

  // Le rejeu n'a de sens que pour une réconciliation. L'accepter ailleurs
  // laisserait croire qu'il module aussi un `--live` — alors qu'un LIVE ne
  // rejoue jamais rien, par construction.
  if (allowIdempotentReplay && mode !== 'RECONCILE') {
    throw new DispatchArgError('--allow-idempotent-replay n’a de sens qu’avec --reconcile.');
  }

  return { manifestId: manifestId.trim(), mode, allowIdempotentReplay };
}
