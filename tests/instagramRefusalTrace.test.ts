import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInstagramRail } from '@/lib/config/load';
import { classifyLiveDmRequest, type GuardDecision } from '@/lib/instagram/readOnlyGuard';
import { PlaywrightInstagramLiveRail } from '@/lib/instagram/playwrightLiveRail';
import {
  MAX_REFUSED_RECORDED,
  REFUSAL_TRACE_CAPS,
  RefusalTrace,
  formatRefusalTrace,
  persistRefusalTrace,
  readFriendlyName,
  reportRefusalTrace,
  sanitizeReason,
  sanitizeRequestPath,
  type RefusalTraceSnapshot,
} from '@/lib/instagram/refusalTrace';

/**
 * IG2.6 — la trace des refus doit survivre à ce qui la rendait inutilisable.
 *
 * Deux défauts sont testés ici, et un invariant.
 *
 *   * Le tampon « 40 premiers » gardait la télémétrie du brouillon et jetait la
 *     requête d'après-clic — celle qu'on cherche.
 *   * La trace n'était imprimée que sur le chemin de succès, donc perdue sur
 *     levée, timeout ou fermeture prématurée.
 *   * L'invariant : enregistrer ne doit RIEN changer aux décisions de la garde.
 *     `readOnlyGuard.ts` n'est pas touché par ce commit et ces tests le
 *     verrouillent.
 *
 * Aucun de ces tests n'ouvre de navigateur ni ne produit d'effet externe.
 */

/** Une horloge que le test avance lui-même — une chronologie décrite, pas attendue. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const TELEMETRY_URL = 'https://www.instagram.com/ajax/bz?__a=1';
const SEND_URL = 'https://www.instagram.com/api/graphql';
const SEND_BODY = 'fb_api_req_friendly_name=useIGDirectSendMessageMutation&doc_id=123&variables=%7B%7D';

describe('IG2.6 — rétention de la trace autour de l’effet', () => {
  it('conserve la requête d’après-clic même noyée sous plus de 40 refus antérieurs', () => {
    const clock = fakeClock();
    const trace = new RefusalTrace(clock.now);

    // Le cas réel : la phase de brouillon inonde la trace de télémétrie.
    for (let index = 0; index < 120; index += 1) {
      clock.advance(10);
      trace.record({
        method: 'POST',
        url: TELEMETRY_URL,
        rule: 'write_method',
        reason: 'POST /ajax/bz — hors de la liste des points d’entrée de lecture',
        postData: null,
      });
    }

    clock.advance(5);
    trace.markEffect();
    clock.advance(30);
    trace.record({
      method: 'POST',
      url: SEND_URL,
      rule: 'graphql_effect',
      reason: 'mutation GraphQL sans marqueur de messagerie',
      postData: SEND_BODY,
    });

    const snapshot = trace.snapshot();
    const sendRecord = snapshot.records.find((record) => record.friendlyName === 'useIGDirectSendMessageMutation');
    expect(sendRecord).toBeDefined();
    expect(sendRecord?.phase).toBe('post_effect');
    expect(sendRecord?.sequence).toBe(121);
    expect(sendRecord?.sinceEffectMs).toBe(30);
    expect(sendRecord?.rule).toBe('graphql_effect');

    // L'ancien enregistreur s'arrêtait au 40e : il n'aurait jamais vu celui-ci.
    expect(sendRecord?.sequence ?? 0).toBeGreaterThan(40);
  });

  it('garde les refus les PLUS PROCHES du clic des deux côtés, et dit combien il en a écarté', () => {
    const clock = fakeClock();
    const trace = new RefusalTrace(clock.now);

    for (let index = 0; index < 200; index += 1) {
      clock.advance(1);
      trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    }
    trace.markEffect();
    for (let index = 0; index < 200; index += 1) {
      clock.advance(1);
      trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    }

    const snapshot = trace.snapshot();
    const sequences = snapshot.records.map((record) => record.sequence);

    // Le dernier refus d'AVANT le clic est conservé.
    expect(sequences).toContain(200);
    // Le premier refus d'APRÈS le clic est conservé.
    expect(sequences).toContain(201);
    // Le tout dernier de la fenêtre d'observation aussi.
    expect(sequences).toContain(400);
    // L'ouverture de session aussi.
    expect(sequences).toContain(1);

    expect(snapshot.totalRefused).toBe(400);
    expect(snapshot.preEffectRefused).toBe(200);
    expect(snapshot.postEffectRefused).toBe(200);
    expect(snapshot.droppedRefused).toBe(400 - snapshot.records.length);
    expect(snapshot.droppedRefused).toBeGreaterThan(0);
  });

  it('reste borné — pas de tampon illimité', () => {
    const trace = new RefusalTrace(fakeClock().now);
    for (let index = 0; index < 5_000; index += 1) {
      if (index === 2_500) trace.markEffect();
      trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    }
    const snapshot = trace.snapshot();
    expect(snapshot.records.length).toBeLessThanOrEqual(MAX_REFUSED_RECORDED);
    expect(MAX_REFUSED_RECORDED).toBe(
      REFUSAL_TRACE_CAPS.head + REFUSAL_TRACE_CAPS.preTail + REFUSAL_TRACE_CAPS.postHead + REFUSAL_TRACE_CAPS.postTail,
    );
  });

  it('conserve l’ordre temporel : séquences strictement croissantes, offsets non décroissants', () => {
    const clock = fakeClock();
    const trace = new RefusalTrace(clock.now);
    for (let index = 0; index < 300; index += 1) {
      if (index === 150) trace.markEffect();
      clock.advance(7);
      trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    }

    const { records } = trace.snapshot();
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const current = records[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous === undefined || current === undefined) continue;
      expect(current.sequence).toBeGreaterThan(previous.sequence);
      expect(current.offsetMs).toBeGreaterThanOrEqual(previous.offsetMs);
    }
    // Aucun doublon : les seaux se recouvrent, la vue rendue non.
    expect(new Set(records.map((record) => record.sequence)).size).toBe(records.length);
  });

  it('la frontière pré/post ne se réécrit pas après coup', () => {
    const clock = fakeClock();
    const trace = new RefusalTrace(clock.now);
    trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    clock.advance(100);
    trace.markEffect();
    const first = trace.snapshot().effectAtOffsetMs;
    clock.advance(500);
    trace.markEffect();
    expect(trace.snapshot().effectAtOffsetMs).toBe(first);

    const [record] = trace.snapshot().records;
    expect(record?.phase).toBe('pre_effect');
    expect(record?.sinceEffectMs).toBeNull();
  });

  it('sans clic, tout est pré-effet et la trace le dit', () => {
    const trace = new RefusalTrace(fakeClock().now);
    trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    const snapshot = trace.snapshot();
    expect(snapshot.effectAtOffsetMs).toBeNull();
    expect(snapshot.postEffectRefused).toBe(0);
    expect(snapshot.records[0]?.phase).toBe('pre_effect');
  });
});

// ---------------------------------------------------------------------------
// Rien de sensible ne sort
// ---------------------------------------------------------------------------

describe('IG2.6 — ce que la trace refuse de conserver', () => {
  it('ne garde d’une URL que son pathname — ni query, ni fragment', () => {
    const parsed = sanitizeRequestPath(
      'https://www.instagram.com/api/graphql?access_token=SECRET_TOKEN&csrftoken=abcdef#frag',
    );
    expect(parsed.readable).toBe(true);
    expect(parsed.path).toBe('/api/graphql');
    expect(parsed.path).not.toContain('SECRET_TOKEN');
  });

  it('écarte entièrement une URL illisible, ainsi que la raison qui la citerait', () => {
    const parsed = sanitizeRequestPath('pas-une-url?session=SECRET');
    expect(parsed.readable).toBe(false);
    expect(parsed.path).not.toContain('SECRET');
    expect(sanitizeReason('URL illisible : « pas-une-url?session=SECRET »', false)).not.toContain('SECRET');
  });

  it('n’extrait d’un corps que le friendly name, jamais le payload', () => {
    const body =
      'fb_api_req_friendly_name=useIGDirectSendMessageMutation&csrf_token=SECRET_CSRF' +
      '&variables=%7B%22message%22%3A%22bonjour%22%7D&session_id=SECRET_SESSION';
    expect(readFriendlyName(body)).toBe('useIGDirectSendMessageMutation');

    const trace = new RefusalTrace(fakeClock().now);
    trace.record({
      method: 'POST',
      url: 'https://www.instagram.com/api/graphql?csrftoken=SECRET_CSRF',
      rule: 'graphql_effect',
      reason: 'mutation GraphQL sans marqueur de messagerie',
      postData: body,
    });
    const serialized = JSON.stringify(trace.snapshot());
    for (const secret of ['SECRET_CSRF', 'SECRET_SESSION', 'bonjour', 'variables']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('le fichier persisté ne contient aucun secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ig-refusal-'));
    try {
      const trace = new RefusalTrace(fakeClock().now);
      trace.record({
        method: 'POST',
        url: 'https://www.instagram.com/api/v1/direct_v2/threads/?csrftoken=SECRET_CSRF',
        rule: 'write_method',
        reason: 'bruit',
        postData: 'fb_api_req_friendly_name=Foo&sessionid=SECRET_SESSION&ds_user_id=42',
      });
      const path = persistRefusalTrace(
        dir,
        { mode: 'live', subject: 'compte_test', workerId: 'test/pid-1', outcome: 'DELIVERY_FAILED' },
        trace.snapshot(),
      );
      expect(path).not.toBeNull();
      const content = readFileSync(path as string, 'utf8');
      for (const secret of ['SECRET_CSRF', 'SECRET_SESSION', 'ds_user_id', 'sessionid']) {
        expect(content).not.toContain(secret);
      }
      expect(content).toContain('/api/v1/direct_v2/threads/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// La trace survit à toutes les issues
// ---------------------------------------------------------------------------

/**
 * Le squelette EXACT des deux commandes : le rapport dans le `try`, la trace
 * dans le `finally`. C'est cette composition qui manquait — la trace vivait
 * après `reportRun()`, donc jamais quand le worker levait.
 */
async function runWithTrace(
  dir: string,
  body: (trace: RefusalTrace) => Promise<string>,
): Promise<{ outcome: string; path: string | null }> {
  const trace = new RefusalTrace(fakeClock().now);
  let outcome = 'NO_RESULT';
  try {
    outcome = await body(trace);
    return { outcome, path: null };
  } catch (error) {
    outcome = error instanceof Error ? `THROWN:${error.name}` : 'THROWN:unknown';
    throw error;
  } finally {
    const path = persistRefusalTrace(
      dir,
      { mode: 'live', subject: 'compte_test', workerId: 'test/pid-1', outcome },
      trace.snapshot(),
    );
    expect(path).not.toBeNull();
  }
}

function onlyTraceFile(dir: string): Record<string, unknown> {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as Record<string, unknown>;
}

/** Enregistre du bruit, marque l'effet, puis enregistre la requête qui compte. */
function recordUpToSend(trace: RefusalTrace): void {
  for (let index = 0; index < 60; index += 1) {
    trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
  }
  trace.markEffect();
  trace.record({
    method: 'POST',
    url: SEND_URL,
    rule: 'graphql_effect',
    reason: 'mutation GraphQL sans marqueur de messagerie',
    postData: SEND_BODY,
  });
}

describe('IG2.6 — la trace ne dépend jamais du chemin de succès', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ig-refusal-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('chemin normal : la trace est écrite', async () => {
    await runWithTrace(dir, async (trace) => {
      recordUpToSend(trace);
      return 'SENT';
    });
    const file = onlyTraceFile(dir);
    expect(file['outcome']).toBe('SENT');
    expect(JSON.stringify(file)).toContain('useIGDirectSendMessageMutation');
  });

  it('DELIVERY_FAILED : la trace est écrite', async () => {
    await runWithTrace(dir, async (trace) => {
      recordUpToSend(trace);
      return 'CONTROLLED_TEST_DELIVERY_FAILED';
    });
    expect(onlyTraceFile(dir)['outcome']).toBe('CONTROLLED_TEST_DELIVERY_FAILED');
  });

  it('AMBIGUOUS : la trace est écrite', async () => {
    await runWithTrace(dir, async (trace) => {
      recordUpToSend(trace);
      return 'AMBIGUOUS';
    });
    expect(onlyTraceFile(dir)['outcome']).toBe('AMBIGUOUS');
  });

  it('exception APRÈS le clic : la trace est écrite, avec la requête d’après-clic', async () => {
    await expect(
      runWithTrace(dir, async (trace) => {
        recordUpToSend(trace);
        throw new Error('navigateur fermé pendant l’observation');
      }),
    ).rejects.toThrow('navigateur fermé');

    const file = onlyTraceFile(dir);
    expect(file['outcome']).toBe('THROWN:Error');
    expect(file['postEffectRefused']).toBe(1);
    expect(JSON.stringify(file)).toContain('useIGDirectSendMessageMutation');
  });

  it('timeout après le clic : la trace est écrite', async () => {
    class TimeoutError extends Error {
      override readonly name = 'TimeoutError';
    }
    await expect(
      runWithTrace(dir, async (trace) => {
        recordUpToSend(trace);
        throw new TimeoutError('Timeout 20000ms exceeded');
      }),
    ).rejects.toThrow('Timeout');

    const file = onlyTraceFile(dir);
    expect(file['outcome']).toBe('THROWN:TimeoutError');
    expect(JSON.stringify(file)).toContain('useIGDirectSendMessageMutation');
  });

  it('un répertoire inécrivable ne fait pas lever la persistance — le réarmement passe avant', () => {
    const trace = new RefusalTrace(fakeClock().now);
    recordUpToSend(trace);
    const path = persistRefusalTrace(
      join(dir, 'fichier-occupant'),
      { mode: 'live', subject: ' invalide', workerId: 'test', outcome: 'X' },
      trace.snapshot(),
    );
    expect(path === null || typeof path === 'string').toBe(true);
  });

  it('reportRefusalTrace imprime la trace ET l’écrit, sans jamais lever', () => {
    const trace = new RefusalTrace(fakeClock().now);
    recordUpToSend(trace);
    const chunks: string[] = [];
    const path = reportRefusalTrace(
      (chunk) => chunks.push(chunk),
      dir,
      { mode: 'live', subject: 'compte_test', workerId: 'test/pid-1', outcome: 'AMBIGUOUS' },
      trace.snapshot(),
    );
    const printed = chunks.join('');
    expect(printed).toContain('requêtes_refusées_par_garde');
    expect(printed).toContain('post_effect');
    expect(printed).toContain('useIGDirectSendMessageMutation');
    expect(printed).toContain('trace_refus_persistée');
    expect(path).not.toBeNull();

    // Un puits qui lève ne doit pas emporter la commande avec lui.
    expect(() =>
      reportRefusalTrace(
        () => {
          throw new Error('stdout fermé');
        },
        dir,
        { mode: 'live', subject: 'compte_test', workerId: 'test/pid-1', outcome: 'AMBIGUOUS' },
        trace.snapshot(),
      ),
    ).not.toThrow();
  });

  it('le rendu annonce ce qui a été écarté — un tronquage silencieux se lirait « rien d’autre »', () => {
    const trace = new RefusalTrace(fakeClock().now);
    for (let index = 0; index < 400; index += 1) {
      if (index === 200) trace.markEffect();
      trace.record({ method: 'POST', url: TELEMETRY_URL, rule: 'write_method', reason: 'bruit', postData: null });
    }
    const snapshot: RefusalTraceSnapshot = trace.snapshot();
    expect(formatRefusalTrace(snapshot)[0]).toContain(`écartées ${snapshot.droppedRefused}`);
  });
});

// ---------------------------------------------------------------------------
// L'invariant : la politique réseau n'a pas bougé
// ---------------------------------------------------------------------------

/** Expose le classificateur du rail sans ouvrir de navigateur. */
class TraceProbeRail extends PlaywrightInstagramLiveRail {
  classifyForTest(request: { url: string; method: string; postData: string | null }): GuardDecision {
    return this.requestClassifier()(request);
  }
}

describe('IG2.6 — enregistrer ne change aucune décision de la garde', () => {
  const requests: readonly { url: string; method: string; postData: string | null }[] = [
    { url: 'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/', method: 'POST', postData: 'text=x' },
    { url: 'https://www.instagram.com/direct/t/1234/', method: 'GET', postData: null },
    { url: 'https://www.instagram.com/api/graphql', method: 'POST', postData: SEND_BODY },
    { url: 'https://www.instagram.com/api/graphql', method: 'POST', postData: 'mutation direct_v2 { send }' },
    { url: 'https://www.instagram.com/ajax/bz', method: 'POST', postData: null },
    { url: 'https://www.instagram.com/web/friendships/42/follow/', method: 'POST', postData: null },
    { url: 'https://www.instagram.com/web/likes/42/like/', method: 'POST', postData: null },
    { url: 'https://www.instagram.com/graphql/query', method: 'POST', postData: 'mutation { followUser }' },
    { url: 'pas-une-url', method: 'POST', postData: null },
  ];

  it('le rail rend exactement ce que rend `classifyLiveDmRequest`', () => {
    const rail = new TraceProbeRail({
      config: loadInstagramRail(),
      headless: true,
      screenshotDir: null,
      workerId: 'test/pid-1',
    });
    for (const request of requests) {
      expect(rail.classifyForTest(request)).toEqual(classifyLiveDmRequest(request));
    }
    // Et il a bien tracé ce qui a été refusé, sans rien changer d'autre.
    const snapshot = rail.refusalSnapshot();
    const refusedCount = requests.filter((request) => !classifyLiveDmRequest(request).allowed).length;
    expect(snapshot.totalRefused).toBe(refusedCount);
    expect(snapshot.effectAtOffsetMs).toBeNull();
  });

  it('la politique elle-même est inchangée — messagerie permise, effets sociaux refusés', () => {
    // Ce test n'est pas redondant : il fige la politique, pour qu'un
    // assouplissement de la garde ne puisse pas passer inaperçu dans un commit
    // qui ne prétend toucher qu'à l'instrumentation.
    const decisions = requests.map((request) => classifyLiveDmRequest(request));
    expect(decisions.map((decision) => decision.allowed)).toEqual([
      true, // POST /api/v1/direct_v2/ — envoyer un DM
      true, // GET /direct/t/ — lire un fil
      false, // /api/graphql, mutation sans marqueur de messagerie
      true, // /api/graphql, mutation AVEC marqueur de messagerie
      false, // /ajax/bz — télémétrie
      false, // follow
      false, // like
      false, // mutation GraphQL non-messagerie
      false, // URL illisible
    ]);
  });
});
