import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadModelRouting } from '@/lib/config/load';
import { ModelRouter, timeoutForAttempt } from '@/lib/models/router';
import { createLogger } from '@/lib/logging/logger';
import { modelRoutingSchema } from '@/lib/config/schema';

const root = resolve(__dirname, '..');
const logger = createLogger({ test: 'routing-r51' });

afterEach(() => {
  delete process.env['OUTBOUND_MODELS_CONFIG'];
});

/**
 * §16 et §22 : les délais viennent de la mesure, et le retour arrière tient en
 * une variable d'environnement.
 *
 * Les valeurs fixées ici ne sont pas des intuitions. Sur le corpus gelé, la
 * latence maximale observée pour une recherche `terra-medium` est de 30,5 s
 * (51,5 s à concurrence 6) ; le plafond de 120 s garde donc plus du double de
 * marge sur la pire mesure. Et la politique bornée a été comparée à celle de R5
 * sur le modèle qui expire réellement : 18/18 réussites dans les deux cas,
 * −33 % de mur pour la version bornée.
 */
describe('routage R5.1', () => {
  const routing = loadModelRouting();

  it('borne le second essai plus court que le premier', () => {
    // R5 donnait au réessai la durée qui venait d'être prouvée insuffisante.
    for (const task of ['research', 'angle', 'message', 'synthesize']) {
      const route = routing.tasks[task];
      expect(route?.timeoutScheduleMs, `${task} sans échéancier`).toBeDefined();
      const schedule = route?.timeoutScheduleMs ?? [];
      expect(schedule.length).toBeGreaterThanOrEqual(2);
      expect(schedule[1]).toBeLessThan(schedule[0] ?? 0);
    }
  });

  it('ne dépasse plus 180 s pour un premier essai', () => {
    const router = new ModelRouter({ sql: null, logger });
    for (const task of ['research', 'angle', 'message', 'synthesize', 'classification']) {
      const route = router.routeFor(task);
      expect(timeoutForAttempt(route, 1), `${task} trop long`).toBeLessThanOrEqual(120_000);
    }
  });

  it('plafonne le budget total d’un prospect bloqué', () => {
    /**
     * Le §16 : un appel mort ne doit pas pouvoir immobiliser un prospect six
     * minutes. R5 : 180 + 180 = 360 s. Ici, la somme de l'échéancier borne ce
     * qu'un seul appel peut coûter avant d'échouer proprement.
     */
    const router = new ModelRouter({ sql: null, logger });
    const route = router.routeFor('research');
    let worstCase = 0;
    for (let attempt = 1; attempt <= route.maxAttempts; attempt += 1) {
      worstCase += timeoutForAttempt(route, attempt);
    }
    expect(worstCase).toBeLessThanOrEqual(210_000);
    expect(worstCase).toBeLessThan(360_000);
  });

  it('donne aux workers un plafond plus court, parce qu’ils lisent moins', () => {
    // Latence maximale mesurée d'un worker sur le corpus gelé : 26,1 s.
    const router = new ModelRouter({ sql: null, logger });
    for (const lane of ['worker_funnel', 'worker_offer', 'worker_contact']) {
      expect(timeoutForAttempt(router.routeFor(lane), 1)).toBeLessThanOrEqual(90_000);
    }
  });

  it('fige le routage R5.1b final : Terra pour research/angle, Sol pour message', () => {
    // Décision humaine (18/18 votes, mapping caché jusqu'au dernier) : Sol
    // gagne 8, Terra 5, 5 égalités — converge avec le juge aveugle (10/5/3).
    // §8 : research et angle restent sur Terra (aucun signal pour en changer),
    // message bascule sur Sol, seule tâche où l'avantage qualitatif est répété.
    expect(routing.tasks['research']?.model).toBe('gpt-5.6-terra');
    expect(routing.tasks['research']?.effort).toBe('medium');
    expect(routing.tasks['angle']?.model).toBe('gpt-5.6-terra');
    expect(routing.tasks['angle']?.effort).toBe('medium');
    expect(routing.tasks['message']?.model).toBe('gpt-5.6-sol');
    expect(routing.tasks['message']?.effort).toBe('medium');
    // Politique de délai R5.1 inchangée par la bascule de modèle.
    expect(routing.tasks['message']?.timeoutScheduleMs).toEqual([120000, 90000]);
    expect(routing.tasks['message']?.maxAttempts).toBe(2);
  });

  it('garde le profil R5 chargeable, et pas seulement dans l’historique', () => {
    // Un retour arrière qu'il faut reconstituer sous pression n'en est pas un.
    const r5 = modelRoutingSchema.parse(
      JSON.parse(readFileSync(resolve(root, 'config/models.r5.json'), 'utf8')),
    );
    expect(r5.tasks['research']?.model).toBe('gpt-5.6-sol');
    expect(r5.tasks['research']?.effort).toBe('medium');
    expect(r5.tasks['research']?.timeoutMs).toBe(180_000);
    expect(r5.tasks['research']?.timeoutScheduleMs).toBeUndefined();
  });

  it('bascule sur le profil R5 par variable d’environnement', () => {
    process.env['OUTBOUND_MODELS_CONFIG'] = 'config/models.r5.json';
    const rolled = loadModelRouting();
    expect(rolled.version).toContain('r5');
    expect(rolled.tasks['research']?.model).toBe('gpt-5.6-sol');
  });

  it('échoue bruyamment sur un chemin absent plutôt que de retomber en R5.1', () => {
    // Croire qu'on tourne en R5 alors qu'on tourne en R5.1 serait pire que l'échec.
    process.env['OUTBOUND_MODELS_CONFIG'] = 'config/models.inexistant.json';
    expect(() => loadModelRouting()).toThrow(/absent/);
  });
});
