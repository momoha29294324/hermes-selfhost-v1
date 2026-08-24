/**
 * HERMES-PLAN-STALE-TRIGGER-FIX-R1 — un plan ne se rend pas périmé lui-même.
 *
 * Le 23 août 2026, le premier tour réellement `AUTO_REPLY_ELIGIBLE` du test
 * contrôlé a été refusé en `PLAN_STALE` alors qu'aucun message n'était arrivé
 * après son déclencheur : la garde comparait deux horodatages dont l'un avait
 * perdu ses millisecondes, et concluait qu'un message était postérieur à
 * lui-même.
 *
 * Ces tests fixent les deux moitiés du correctif — l'identité du déclencheur,
 * et la lecture sans perte d'une `Date` — ET la propriété qui compte davantage :
 * un message réellement plus récent bloque toujours.
 */

import { describe, expect, it } from 'vitest';

import { replyStaleness } from '@/lib/conversation/preEffect';

const X = '00000000-0000-4000-8000-000000000006';
const Y = '00000000-0000-4000-8000-000000000005';

describe('replyStaleness — le déclencheur ne se bloque pas lui-même', () => {
  it('A — le dernier entrant EST le déclencheur du plan : pas périmé', () => {
    expect(
      replyStaleness('2026-08-23T07:36:19.297Z', '2026-08-23T07:36:19.297Z', {
        triggerInboundMessageId: X,
        latestInboundId: X,
      }),
    ).toBeNull();
  });

  it('B — le vrai cas du 23 août : marque arrondie à la seconde, déclencheur à la milliseconde', () => {
    // La marque telle qu'elle revenait du pilote Postgres, puis dégradée par
    // `Date.parse(String(date))` : la seconde y est, les millisecondes non.
    const watermark = new Date('2026-08-23T07:36:19.297Z');
    const degraded = new Date(Date.parse(watermark.toString()));
    expect(degraded.getTime()).toBeLessThan(watermark.getTime());

    // Sans identité, une marque déjà dégradée refuserait — c'est le bug.
    expect(
      replyStaleness(degraded.toISOString(), '2026-08-23T07:36:19.297Z'),
    ).toContain('plus la dernière');

    // Avec l'identité du déclencheur, le plan reconnaît son propre message.
    expect(
      replyStaleness(degraded.toISOString(), '2026-08-23T07:36:19.297Z', {
        triggerInboundMessageId: X,
        latestInboundId: X,
      }),
    ).toBeNull();

    // Et la marque lue comme une `Date` ne perd plus rien, identité ou non.
    expect(replyStaleness(watermark, new Date('2026-08-23T07:36:19.297Z'))).toBeNull();
  });

  it('C — un entrant RÉELLEMENT postérieur bloque toujours, identité fournie ou non', () => {
    const later = '2026-08-23T07:40:00.000Z';
    expect(replyStaleness('2026-08-23T07:36:19.297Z', later)).toContain('plus la dernière');
    expect(
      replyStaleness('2026-08-23T07:36:19.297Z', later, {
        triggerInboundMessageId: X,
        latestInboundId: Y,
      }),
    ).toContain('plus la dernière');
    // Une milliseconde suffit : la garde n'a pas été arrondie.
    expect(
      replyStaleness('2026-08-23T07:36:19.297Z', '2026-08-23T07:36:19.298Z', {
        triggerInboundMessageId: X,
        latestInboundId: Y,
      }),
    ).toContain('plus la dernière');
  });

  it('D — l’ordre d’INGESTION ne rend rien périmé : seul `received_at` compte', () => {
    // Y a été ingéré après X, mais reçu avant. La garde ne lit que la réception,
    // donc le plan de X reste frais.
    expect(
      replyStaleness('2026-08-23T07:36:19.297Z', '2026-08-23T07:30:00.000Z', {
        triggerInboundMessageId: X,
        latestInboundId: Y,
      }),
    ).toBeNull();
  });

  it('E — deux messages à la même milliseconde : égalité ≠ postérieur, et l’identité tranche', () => {
    const same = '2026-08-23T07:36:19.297Z';
    // Un autre message à la même heure ne dépasse pas : `>` strict.
    expect(
      replyStaleness(same, same, { triggerInboundMessageId: X, latestInboundId: Y }),
    ).toBeNull();
    // L'ordre déterministe (received_at desc, id desc) vit dans la requête ;
    // ici, ce qui compte est que la décision ne dépende pas de l'ordre physique.
    expect(
      replyStaleness(same, same, { triggerInboundMessageId: X, latestInboundId: X }),
    ).toBeNull();
  });

  it('une identité incomplète ne prouve rien et retombe sur la comparaison d’avant', () => {
    expect(
      replyStaleness('2026-08-23T07:36:19.000Z', '2026-08-23T07:36:19.297Z', {
        triggerInboundMessageId: null,
        latestInboundId: X,
      }),
    ).toContain('plus la dernière');
    expect(
      replyStaleness('2026-08-23T07:36:19.000Z', '2026-08-23T07:36:19.297Z', {
        triggerInboundMessageId: X,
        latestInboundId: null,
      }),
    ).toContain('plus la dernière');
  });

  it('I — aucune exception de test contrôlé dans la garde de fraîcheur', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/lib/conversation/preEffect.ts', 'utf8');
    const stale = source.slice(source.indexOf('export function replyStaleness'));
    expect(stale).not.toMatch(/controlledSelfTest|operator_second_account|selfTest/i);
  });
});
