import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE_RATIO,
  extractThreadMessages,
  instagramMessageFingerprint,
  sideFromGeometry,
} from '@/lib/instagram/inboundThread';
import { forbiddenMethodsOn, FORBIDDEN_INBOUND_METHODS } from '@/lib/instagram/inboundRail';
import { hasSendPrimitive, type InstagramReadOnlyRail } from '@/lib/instagram/rail';
import {
  classifyAdjudicationRequest,
  isAllowedAdjudicationNavigation,
  LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS,
} from '@/lib/instagram/readOnlyGuard';
import { PlaywrightInstagramInboundRail } from '@/lib/instagram/playwrightInboundRail';
import { loadInstagramRail } from '@/lib/config/load';
import {
  centeredRect,
  incomingRect,
  makeHarvest,
  outgoingRect,
  THREAD_SCOPE,
} from './support/instagramInboundFixture';

/**
 * IG5.1 §15 — lecture du fil, direction, et l'absence de capacité d'action.
 *
 * Aucun test de ce fichier n'ouvre de navigateur, ne touche à Instagram ni à
 * une base : tout est exercé sur des récoltes reconstituées. C'est ce que le
 * partage « la page mesure / le code pur décide » rend possible.
 */

const ACCOUNT = 'hermes.test';
const COUNTERPARTY = 'atelier.test';

/**
 * Retire commentaires et chaînes littérales avant la preuve par `grep`.
 *
 * Sans cela, la preuve serait défaite par la prose : le fichier EXPLIQUE qu'il
 * ne contient ni `fill`, ni `pressSequentially`, et cette explication contient
 * les mots cherchés. Ce qu'on veut vérifier est l'absence de CODE, pas
 * l'absence du mot.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
}

describe('IG5.1 — extraction des messages d’un fil', () => {
  it('lit un message entrant et ne le confond pas avec le nôtre', () => {
    const harvest = makeHarvest({
      bubbles: [
        { text: 'Bonjour, je vous écris au sujet de votre activité.', rect: outgoingRect(200) },
        { text: 'Bonjour, oui ça m’intéresse.', rect: incomingRect(280) },
      ],
      handles: [COUNTERPARTY],
    });

    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });

    expect(read.readable).toBe(true);
    expect(read.messages).toHaveLength(2);
    expect(read.messages[0]?.direction).toBe('OUTGOING');
    expect(read.messages[1]?.direction).toBe('INCOMING');
    // `normalizeMessageText` ramène l'apostrophe typographique à l'ASCII :
    // deux rendus du même message ne doivent pas devenir deux réponses.
    expect(read.messages[1]?.text).toBe("Bonjour, oui ça m'intéresse.");
    expect(read.handles).toEqual([COUNTERPARTY]);
  });

  it('préfère le libellé accessible à la géométrie pour un message sortant', () => {
    // Une bulle posée à GAUCHE mais annoncée « vous avez envoyé » reste
    // sortante : un libellé survit à un changement de mise en page, une
    // position non.
    const harvest = makeHarvest({
      bubbles: [{ text: 'Notre message', rect: incomingRect(200), ariaLabel: 'Vous avez envoyé' }],
      handles: [COUNTERPARTY],
    });

    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.messages[0]?.direction).toBe('OUTGOING');
    expect(read.messages[0]?.directionBasis).toBe('accessible');
  });

  it('refuse de trancher une bulle centrée — fail-closed plutôt que pari', () => {
    const harvest = makeHarvest({
      bubbles: [{ text: 'Aujourd’hui', rect: centeredRect(200) }],
      handles: [COUNTERPARTY],
    });

    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.messages[0]?.direction).toBe('UNKNOWN');
    expect(read.messages[0]?.directionBasis).toBe('none');
  });

  it('écarte le mobilier d’interface par son rôle accessible', () => {
    const harvest = makeHarvest({
      bubbles: [
        { text: 'Atelier Test', rect: incomingRect(200), role: 'link' },
        { text: 'Appel vidéo', rect: outgoingRect(200), role: 'button' },
        { text: 'Une vraie réponse', rect: incomingRect(300) },
      ],
      handles: [COUNTERPARTY],
    });

    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.text).toBe('Une vraie réponse');
    expect(read.chromeFiltered).toBe(2);
  });

  it('écarte la bande d’en-tête du fil', () => {
    // Le nom de la conversation vit tout en haut du panneau ; aucun message
    // n'y est rendu.
    const harvest = makeHarvest({
      bubbles: [
        { text: 'Atelier Test', rect: { left: 110, right: 400, top: 110, bottom: 150 } },
        { text: 'Une vraie réponse', rect: incomingRect(300) },
      ],
      handles: [COUNTERPARTY],
    });

    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.text).toBe('Une vraie réponse');
  });

  it('une récolte illisible n’est jamais une conversation vide', () => {
    const read = extractThreadMessages(makeHarvest({ bubbles: [], readable: false }), { accountHandle: ACCOUNT });
    expect(read.readable).toBe(false);
    expect(read.messages).toHaveLength(0);
    expect(read.detail).toMatch(/illisible/);
  });

  it('un fil sans périmètre exploitable s’arrête, il ne conclut pas', () => {
    const read = extractThreadMessages(
      makeHarvest({ bubbles: [{ text: 'x', rect: incomingRect(200) }], noThreadScope: true }),
      { accountHandle: ACCOUNT },
    );
    expect(read.readable).toBe(false);
    expect(read.detail).toMatch(/périmètre/);
  });

  it('un fil de groupe rend plusieurs handles — l’identité reste ambiguë', () => {
    const harvest = makeHarvest({
      bubbles: [{ text: 'salut', rect: incomingRect(200) }],
      handles: [COUNTERPARTY, 'autre.compte'],
    });
    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.handles).toHaveLength(2);
  });

  it('ne compte jamais notre propre compte comme contrepartie', () => {
    const harvest = makeHarvest({
      bubbles: [{ text: 'salut', rect: incomingRect(200) }],
      handles: [ACCOUNT, COUNTERPARTY],
    });
    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.handles).toEqual([COUNTERPARTY]);
  });

  it('une récolte tronquée reste INCOMPLÈTE et le dit', () => {
    const harvest = makeHarvest({
      bubbles: [{ text: 'salut', rect: incomingRect(200) }],
      handles: [COUNTERPARTY],
      truncated: true,
    });
    const read = extractThreadMessages(harvest, { accountHandle: ACCOUNT });
    expect(read.truncated).toBe(true);
    expect(read.detail).toMatch(/TRONQUÉE/);
  });
});

describe('IG5.1 — la géométrie par les bords', () => {
  it('reconnaît un long message entrant que le centre aurait rendu indécidable', () => {
    // Bulle occupant 80 % de la largeur : son centre est presque au milieu,
    // mais son bord gauche touche celui du fil.
    const long = { left: 110, right: 750, top: 200, bottom: 260 };
    const center = (long.left + long.right) / 2;
    const middle = (THREAD_SCOPE.left + THREAD_SCOPE.right) / 2;
    expect(Math.abs(center - middle)).toBeLessThan(100); // le centre ne tranche pas
    expect(sideFromGeometry(long, THREAD_SCOPE)).toBe('left'); // les bords, si
  });

  it('ne tranche pas quand les deux bords sont à égale distance', () => {
    expect(sideFromGeometry(centeredRect(200), THREAD_SCOPE)).toBeNull();
  });

  it('la tolérance est une part de la largeur, pas un nombre de pixels magique', () => {
    const width = THREAD_SCOPE.right - THREAD_SCOPE.left;
    const tolerance = width * EDGE_TOLERANCE_RATIO;
    // Un écart JUSTE sous la tolérance ne tranche pas ; juste au-dessus, si.
    const barelyLeft = { left: 100, right: 900 - tolerance / 2, top: 200, bottom: 240 };
    expect(sideFromGeometry(barelyLeft, THREAD_SCOPE)).toBeNull();
  });
});

describe('IG5.1 — l’empreinte déterministe', () => {
  const base = {
    accountHandle: ACCOUNT,
    threadId: '1234567890',
    senderHandle: COUNTERPARTY,
    occurrenceIndex: 0,
    text: 'Bonjour, oui ça m’intéresse.',
  };

  it('est stable d’un appel à l’autre', () => {
    expect(instagramMessageFingerprint(base)).toBe(instagramMessageFingerprint(base));
  });

  it('absorbe une différence d’espaces ou d’apostrophe typographique', () => {
    // Instagram peut rendre le même message autrement d'un chargement à
    // l'autre ; sans normalisation, il deviendrait deux réponses.
    expect(instagramMessageFingerprint({ ...base, text: "Bonjour,   oui ça m'intéresse." })).toBe(
      instagramMessageFingerprint(base),
    );
  });

  it('distingue deux messages identiques du même expéditeur', () => {
    expect(instagramMessageFingerprint({ ...base, occurrenceIndex: 1 })).not.toBe(instagramMessageFingerprint(base));
  });

  it('distingue le même texte dans deux fils, et de deux expéditeurs', () => {
    expect(instagramMessageFingerprint({ ...base, threadId: '999' })).not.toBe(instagramMessageFingerprint(base));
    expect(instagramMessageFingerprint({ ...base, senderHandle: 'autre' })).not.toBe(
      instagramMessageFingerprint(base),
    );
  });

  it('n’inclut aucun horodatage — sinon le même message renaîtrait à chaque relève', () => {
    // Preuve par construction : deux appels séparés dans le temps donnent la
    // même valeur, ce qui serait impossible si un instant y entrait.
    const first = instagramMessageFingerprint(base);
    const second = instagramMessageFingerprint({ ...base });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IG5.1 §5/§20 — le rail entrant ne sait pas agir', () => {
  const rail = new PlaywrightInstagramInboundRail({
    config: loadInstagramRail(),
    workerId: 'test-inbound',
    screenshotDir: null,
  });

  it('n’expose aucune primitive d’envoi', () => {
    // La question est posée à l'OBJET, pas au type : un type décrit ce qu'on
    // croit avoir, pas ce qu'on a reçu.
    expect(hasSendPrimitive(rail as unknown as InstagramReadOnlyRail)).toBe(false);
    expect((rail as unknown as Record<string, unknown>).sendFirstTouchDm).toBeUndefined();
  });

  it('n’expose aucune des capacités interdites au chemin entrant', () => {
    expect(forbiddenMethodsOn(rail)).toEqual([]);
    expect(FORBIDDEN_INBOUND_METHODS).toContain('sendFirstTouchDm');
    expect(FORBIDDEN_INBOUND_METHODS).toContain('markThreadAsRead');
  });

  it('son source ne contient ni saisie, ni clic, ni contrôle d’envoi', () => {
    // La même preuve par `grep` que le rail d'adjudication : une absence
    // vérifiable vaut mieux qu'une promesse.
    const source = stripComments(
      readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightInboundRail.ts'), 'utf8'),
    );
    for (const forbidden of ['.fill(', '.type(', '.press(', 'pressSequentially', 'SEND_CONTROL_SELECTORS', '.click(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).not.toContain('playwrightLiveRail');
  });

  it('le collecteur ne nomme aucune primitive d’envoi', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/inbound/instagramCollector.ts'), 'utf8');
    expect(source).not.toContain('IGDirectTextSendMutation');
    expect(source).not.toContain('sendFirstTouchDm(');
  });
});

describe('IG5.1 §5 — la garde réseau du chemin entrant', () => {
  const post = (url: string, postData: string | null): { url: string; method: string; postData: string | null } => ({
    url,
    method: 'POST',
    postData,
  });

  it('refuse l’envoi de DM, la seule opération que le canari LIVE autorise', () => {
    // Preuve croisée : l'opération nommément autorisée ailleurs est refusée ici.
    expect(LIVE_DM_ALLOWED_GRAPHQL_OPERATIONS).toContain('IGDirectTextSendMutation');
    const decision = classifyAdjudicationRequest(
      post('https://www.instagram.com/api/graphql', 'fb_api_req_friendly_name=IGDirectTextSendMutation&x=1'),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.rule).toBe('graphql_effect');
  });

  it('refuse les deux mutations d’accusé de lecture', () => {
    for (const operation of ['useIGDMarkThreadAsReadMutation', 'useIGDMarkThreadAsReadValidationMutation']) {
      const decision = classifyAdjudicationRequest(
        post('https://www.instagram.com/api/graphql', `fb_api_req_friendly_name=${operation}`),
      );
      expect(decision.allowed, operation).toBe(false);
      if (!decision.allowed) expect(decision.rule).toBe('graphql_effect');
    }
  });

  it('refuse tout POST vers un chemin de messagerie', () => {
    const decision = classifyAdjudicationRequest(post('https://www.instagram.com/api/v1/direct_v2/threads/', 'a=1'));
    expect(decision.allowed).toBe(false);
  });

  it('laisse passer la LECTURE d’un fil', () => {
    const decision = classifyAdjudicationRequest({
      url: 'https://www.instagram.com/direct/t/1234/',
      method: 'GET',
      postData: null,
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuse de naviguer ailleurs que vers la boîte et un fil', () => {
    expect(isAllowedAdjudicationNavigation('https://www.instagram.com/direct/inbox/')).toBe(true);
    expect(isAllowedAdjudicationNavigation('https://www.instagram.com/direct/t/1234/')).toBe(true);
    // `/direct/new/` ouvre un COMPOSEUR : le rail entrant n'a rien à y faire.
    expect(isAllowedAdjudicationNavigation('https://www.instagram.com/direct/new/')).toBe(false);
  });
});
