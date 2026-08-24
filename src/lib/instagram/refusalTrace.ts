import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFriendlyName } from '@/lib/instagram/readOnlyGuard';

/**
 * IG2.6 — la trace de ce que NOTRE garde refuse, autour de l'effet.
 *
 * Ce module n'est pas une garde. Il ne décide rien, n'autorise rien et ne
 * refuse rien : il enregistre les décisions déjà prises ailleurs
 * (`classifyLiveDmRequest`), pour qu'une exécution qui échoue laisse derrière
 * elle de quoi savoir POURQUOI. La politique réseau vit dans `readOnlyGuard.ts`
 * et n'est pas touchée ici — c'est l'invariant de ce fichier.
 *
 * Deux défauts d'IG2.5 le motivent, et ils se seraient tous deux manifestés au
 * pire moment.
 *
 * 1. « Les 40 premiers »
 * ---------------------
 * L'enregistreur gardait les 40 premiers refus et jetait le reste. Or la seule
 * phase de brouillon en consomme déjà une vingtaine, entièrement en télémétrie
 * (`/ajax/bz`, `/ajax/qm/`, `/logging_client_events`, `/sync/instagram/`) ;
 * la requête qui compte, elle, arrive APRÈS le clic. Une politique
 * « premiers arrivés » garde donc exactement ce dont on n'a pas besoin et jette
 * ce qu'on cherche. La rétention suit maintenant la distance à l'effet, pas
 * l'ordre d'arrivée : voir `RefusalTrace`.
 *
 * 2. La trace mourait avec l'exécution
 * ------------------------------------
 * Elle ne vivait qu'en mémoire et n'était imprimée qu'après `reportRun()` —
 * donc jamais en cas de levée, de timeout ou de fermeture prématurée du
 * navigateur, c'est-à-dire précisément dans les cas où on la voudrait.
 * `persistRefusalTrace` l'écrit sur disque depuis un `finally`, et ne lève
 * jamais : une trace manquée ne doit pas pouvoir empêcher le réarmement de
 * l'arrêt global.
 *
 * Ce qui n'est JAMAIS conservé
 * ----------------------------
 * Aucun corps de requête, aucun en-tête, aucun cookie, aucun jeton. D'une
 * requête on ne garde que : la méthode, le `pathname` (sans query ni fragment,
 * car c'est là que vivent les jetons), la règle et la raison rendues par la
 * garde, et le `fb_api_req_friendly_name` — extrait par un motif borné à un
 * alphabet sans séparateur, qui ne peut pas ramener de payload. Quand l'URL est
 * illisible, elle n'est pas conservée du tout : ni chemin, ni raison, car la
 * raison de la garde cite alors l'URL entière.
 */

/** Avant ou après le clic d'envoi — la seule frontière qui compte pour le diagnostic. */
export type RefusalPhase = 'pre_effect' | 'post_effect';

/** Une requête que NOTRE garde a refusée, telle qu'on a le droit de la conserver. */
export interface RefusedRequest {
  /** Ordre d'arrivée, 1-based, jamais réattribué — c'est lui qui porte la chronologie. */
  readonly sequence: number;
  /** Millisecondes depuis l'ouverture de la trace. */
  readonly offsetMs: number;
  readonly phase: RefusalPhase;
  /** Millisecondes depuis le clic d'envoi. `null` tant qu'il n'a pas eu lieu. */
  readonly sinceEffectMs: number | null;
  readonly method: string;
  /** `pathname` seul. Jamais de query, jamais de fragment. */
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
  readonly friendlyName: string | null;
}

/**
 * Les bornes de rétention, par distance à l'effet.
 *
 * Elles se lisent comme une phrase : on garde de quoi reconnaître le début de
 * la session, ce qui précède immédiatement le clic, ce qui le suit
 * immédiatement — la fenêtre où se trouve la requête d'envoi — et la fin de la
 * fenêtre d'observation. Ce qui est jeté est le milieu, qui est du bruit de
 * télémétrie, et le nombre de jetés est rendu avec la trace : un tronquage
 * silencieux se lirait comme « il n'y avait rien d'autre ».
 */
export const REFUSAL_TRACE_CAPS = {
  /** Les tout premiers refus, quelle que soit la phase — ouverture de session. */
  head: 16,
  /** Les DERNIERS refus d'avant le clic — les plus proches de l'effet. */
  preTail: 32,
  /** Les PREMIERS refus d'après le clic — la requête d'envoi est là, ou nulle part. */
  postHead: 48,
  /** Les derniers refus de la fenêtre d'observation. */
  postTail: 16,
} as const;

/** Borne dure du nombre d'enregistrements conservés. Pas de tampon illimité. */
export const MAX_REFUSED_RECORDED =
  REFUSAL_TRACE_CAPS.head + REFUSAL_TRACE_CAPS.preTail + REFUSAL_TRACE_CAPS.postHead + REFUSAL_TRACE_CAPS.postTail;

const MAX_PATH_LENGTH = 200;
const MAX_REASON_LENGTH = 240;

/** Ce que la garde a refusé, dans l'ordre, avec ce qui a été perdu au milieu. */
export interface RefusalTraceSnapshot {
  readonly records: readonly RefusedRequest[];
  /** Tous les refus vus, y compris ceux que la rétention a écartés. */
  readonly totalRefused: number;
  readonly preEffectRefused: number;
  readonly postEffectRefused: number;
  /** `totalRefused - records.length` — rendu explicitement, jamais sous-entendu. */
  readonly droppedRefused: number;
  /** Offset du clic d'envoi. `null` si le parcours s'est arrêté avant. */
  readonly effectAtOffsetMs: number | null;
}

/*
 * `readFriendlyName` vivait ici. Depuis IG2.7 il vit dans `readOnlyGuard.ts`,
 * et pour une raison de fond : ce n'est plus seulement une étiquette de
 * diagnostic, c'est la valeur sur laquelle la garde décide d'autoriser
 * l'opération d'envoi. Deux implémentations auraient pu diverger — celle qui
 * décide et celle qui raconte — et le désaccord n'aurait été visible que dans
 * une trace mensongère. Il n'y en a qu'une, et la trace lit celle qui décide.
 */
export { readFriendlyName } from '@/lib/instagram/readOnlyGuard';

/**
 * Ce qu'on a le droit de garder d'une URL : son `pathname`, et rien d'autre.
 *
 * Une URL illisible n'est pas tronquée « au cas où » : elle est écartée. Ce
 * qu'on ne sait pas parser, on ne sait pas non plus en retirer les jetons.
 */
export function sanitizeRequestPath(rawUrl: string): { readonly path: string; readonly readable: boolean } {
  try {
    const parsed = new URL(rawUrl);
    return { path: parsed.pathname.slice(0, MAX_PATH_LENGTH), readable: true };
  } catch {
    return { path: '(url illisible — non conservée)', readable: false };
  }
}

/**
 * La raison rendue par la garde, bornée — et remplacée quand l'URL est
 * illisible, car la garde la cite alors intégralement.
 */
export function sanitizeReason(reason: string, urlReadable: boolean): string {
  if (!urlReadable) return 'URL illisible — raison non conservée (elle citerait l’URL)';
  return reason.slice(0, MAX_REASON_LENGTH);
}

/** Garde les `capacity` PREMIERS éléments, puis n'accepte plus rien. */
class FirstN<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    if (this.items.length < this.capacity) this.items.push(item);
  }
  toArray(): readonly T[] {
    return this.items;
  }
}

/** Garde les `capacity` DERNIERS éléments — l'ancien tombe pour le récent. */
class LastN<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray(): readonly T[] {
    return this.items;
  }
}

/**
 * L'enregistreur.
 *
 * Il ne connaît ni Playwright ni Instagram : on lui donne une décision déjà
 * prise et il la range. C'est ce qui le rend testable sans navigateur — et
 * c'est la seule raison pour laquelle les régressions de ce commit peuvent
 * exister sans produire le moindre effet externe.
 */
export class RefusalTrace {
  private readonly startedAtMs: number;
  private effectAtMs: number | null = null;
  private seen = 0;
  private preEffect = 0;
  private postEffect = 0;

  private readonly head = new FirstN<RefusedRequest>(REFUSAL_TRACE_CAPS.head);
  private readonly preTail = new LastN<RefusedRequest>(REFUSAL_TRACE_CAPS.preTail);
  private readonly postHead = new FirstN<RefusedRequest>(REFUSAL_TRACE_CAPS.postHead);
  private readonly postTail = new LastN<RefusedRequest>(REFUSAL_TRACE_CAPS.postTail);

  /** L'horloge est injectable pour que les tests décrivent une chronologie, pas l'attendent. */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = now();
  }

  /**
   * Le clic d'envoi a eu lieu. Tout ce qui suit est `post_effect`.
   *
   * Appelé depuis l'unique site de clic du dépôt, et une seule fois : un second
   * appel ne déplace pas la frontière, sinon la chronologie deviendrait
   * réécrivable après coup.
   */
  markEffect(): void {
    if (this.effectAtMs === null) this.effectAtMs = this.now();
  }

  get effectMarked(): boolean {
    return this.effectAtMs !== null;
  }

  /** Range un refus. Ne juge rien : la décision est déjà prise en amont. */
  record(input: { method: string; url: string; rule: string; reason: string; postData: string | null }): void {
    const at = this.now();
    this.seen += 1;
    const { path, readable } = sanitizeRequestPath(input.url);
    const phase: RefusalPhase = this.effectAtMs === null ? 'pre_effect' : 'post_effect';
    const record: RefusedRequest = {
      sequence: this.seen,
      offsetMs: at - this.startedAtMs,
      phase,
      sinceEffectMs: this.effectAtMs === null ? null : at - this.effectAtMs,
      method: input.method.toUpperCase().slice(0, 12),
      path,
      rule: input.rule,
      reason: sanitizeReason(input.reason, readable),
      friendlyName: readFriendlyName(input.postData),
    };

    this.head.push(record);
    if (phase === 'pre_effect') {
      this.preEffect += 1;
      this.preTail.push(record);
    } else {
      this.postEffect += 1;
      this.postHead.push(record);
      this.postTail.push(record);
    }
  }

  /** Les enregistrements conservés, dédupliqués et remis dans l'ordre d'arrivée. */
  snapshot(): RefusalTraceSnapshot {
    const bySequence = new Map<number, RefusedRequest>();
    for (const bucket of [this.head, this.preTail, this.postHead, this.postTail]) {
      for (const record of bucket.toArray()) bySequence.set(record.sequence, record);
    }
    const records = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
    return {
      records,
      totalRefused: this.seen,
      preEffectRefused: this.preEffect,
      postEffectRefused: this.postEffect,
      droppedRefused: this.seen - records.length,
      effectAtOffsetMs: this.effectAtMs === null ? null : this.effectAtMs - this.startedAtMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Rendu et persistance
// ---------------------------------------------------------------------------

/** Le rendu texte de la trace, pour le rapport de la commande. */
export function formatRefusalTrace(snapshot: RefusalTraceSnapshot): readonly string[] {
  const lines: string[] = [
    `  requêtes_refusées_par_garde  ${snapshot.totalRefused}` +
      ` (avant clic ${snapshot.preEffectRefused} · après clic ${snapshot.postEffectRefused}` +
      ` · conservées ${snapshot.records.length} · écartées ${snapshot.droppedRefused})`,
  ];
  for (const record of snapshot.records) {
    const since = record.sinceEffectMs === null ? '' : ` +${record.sinceEffectMs}ms après clic`;
    lines.push(
      `    ✗ #${record.sequence} [${record.phase}${since}] ${record.method} ${record.path}` +
        ` [${record.rule}]${record.friendlyName === null ? '' : ` « ${record.friendlyName} »`}`,
    );
  }
  return lines;
}

export interface RefusalTraceContext {
  readonly mode: string;
  /** Handle de test ou identifiant du test contrôlé — jamais un secret. */
  readonly subject: string;
  readonly workerId: string;
  /** Issue de l'exécution : un statut, ou la nature de la levée. */
  readonly outcome: string;
}

export const REFUSAL_TRACE_SCHEMA = 'instagram.refusal_trace.v1' as const;

/**
 * Écrit la trace sur disque, et ne lève jamais.
 *
 * Le `never throws` n'est pas de la prudence décorative : l'appel vit dans le
 * `finally` qui réengage l'arrêt global. Une écriture qui lèverait empêcherait
 * le réarmement — la trace du diagnostic ferait tomber la garde de sécurité,
 * ce qui serait exactement le mauvais ordre de priorité.
 *
 * Rend le chemin écrit, ou `null` si rien n'a pu l'être.
 */
export function persistRefusalTrace(
  directory: string,
  context: RefusalTraceContext,
  snapshot: RefusalTraceSnapshot,
  capturedAt: Date = new Date(),
): string | null {
  // L'écriture est volontairement synchrone : elle a lieu dans un `finally`,
  // parfois sur un chemin de sortie de processus, où une promesse pendante
  // n'aurait aucune garantie d'être tenue.
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const stamp = capturedAt.toISOString().replace(/[:.]/g, '-');
    const safeSubject = context.subject.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    const path = resolve(directory, `${context.mode.toLowerCase()}-${safeSubject}-${stamp}.json`);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema: REFUSAL_TRACE_SCHEMA,
          capturedAt: capturedAt.toISOString(),
          mode: context.mode,
          subject: context.subject,
          workerId: context.workerId,
          outcome: context.outcome,
          caps: REFUSAL_TRACE_CAPS,
          totalRefused: snapshot.totalRefused,
          preEffectRefused: snapshot.preEffectRefused,
          postEffectRefused: snapshot.postEffectRefused,
          droppedRefused: snapshot.droppedRefused,
          effectAtOffsetMs: snapshot.effectAtOffsetMs,
          records: snapshot.records,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return path;
  } catch {
    return null;
  }
}

/**
 * Rend la trace ET l'écrit, en une fois, pour que les deux commandes qui
 * ouvrent un rail LIVE aient exactement le même comportement.
 *
 * Le puits d'écriture est passé en paramètre : ce module n'appelle pas
 * `process.stdout` lui-même, ce qui le laisse testable sans capturer la sortie
 * du processus.
 *
 * Comme `persistRefusalTrace`, cette fonction ne lève jamais — elle est appelée
 * depuis le `finally` qui réengage l'arrêt global.
 */
export function reportRefusalTrace(
  sink: (chunk: string) => void,
  directory: string,
  context: RefusalTraceContext,
  snapshot: RefusalTraceSnapshot,
): string | null {
  try {
    for (const line of formatRefusalTrace(snapshot)) sink(`${line}\n`);
    const path = persistRefusalTrace(directory, context, snapshot);
    sink(
      path === null
        ? '  trace_refus_persistée        (échec d’écriture — la trace ci-dessus reste la seule copie)\n'
        : `  trace_refus_persistée        ${path}\n`,
    );
    return path;
  } catch {
    return null;
  }
}
