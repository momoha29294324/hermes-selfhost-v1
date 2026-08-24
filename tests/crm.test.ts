import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import {
  excerpt,
  listCrmProspects,
  loadCrmAlerts,
  loadCrmInbox,
  loadCrmInboxStatus,
  loadCrmOverview,
  loadCrmPipeline,
  loadCrmWorkspace,
  parseScoreSignals,
  parseSort,
  sortProspects,
  textList,
  type CrmProspect,
} from '@/lib/crm/queries';
import {
  CHANNEL_TONE,
  CRM_CHANNELS,
  CRM_LANES,
  CRM_TONES,
  LANE_TONE,
  activeChannels,
  bandTone,
  bestChannel,
  boardLayout,
  channelFromTransport,
  commercialShortLabel,
  formatAge,
  formatDayLabel,
  groupTimelineByDay,
  laneTone,
  observedChannels,
  prospectTone,
  resolveCommercialState,
  resolveLane,
  shortenUrl,
  sortTimeline,
  splitEvidenceRefs,
  stageTone,
  type CrmLane,
  type CrmTimelineEntry,
} from '@/lib/crm/view';
import { projectToCrm } from '@/lib/replies/crm';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { processReply } from '@/lib/replies/process';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * CRM1 — le CRM Hermes local.
 *
 * Trois familles de vérifications, et la troisième est la plus importante :
 *
 *   1. les dérivations pures (colonne du pipeline, canal, ordre de timeline)
 *      sont déterministes et testables sans base ;
 *   2. les lectures rendent bien les VRAIES lignes, avec les bonnes bornes —
 *      en particulier : la timeline d'un prospect ne montre jamais le courrier
 *      d'un autre ;
 *   3. rien dans `/crm` ne peut écrire, ni a fortiori envoyer. C'est vérifié en
 *      relisant le code source, pas en faisant confiance à une intention.
 *
 * Aucune entreprise, adresse ou identifiant réel n'apparaît ici.
 */

const logger = createLogger({ test: 'crm' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent ?';
const NO_CRM = {
  configured: false as const,
  kind: 'NOT_CONFIGURED' as const,
  reason: 'aucune projection CRM externe demandée',
  missing: [] as readonly string[],
};

let sql: Sql;
let dir: string;
let campaignId: string;
let contactedProspect: ReplyFixtures['contactedProspect'];
let inbound: ReplyFixtures['inbound'];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-crm-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    'insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id',
    ['example-crm1-test', 'Test CRM1', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  ({ contactedProspect, inbound } = makeReplyFixtures(sql, {
    campaignId,
    mailbox: MAILBOX,
    firstTouch: FIRST_TOUCH,
  }));
});

afterAll(async () => {
  await sql.close();
});

/** Un prospect nu, sans manifeste ni envoi — le cas majoritaire du corpus. */
async function plainProspect(options: {
  name: string;
  stage?: string;
  score?: number | null;
  band?: string | null;
  email?: string | null;
  instagram?: string | null;
  phone?: string | null;
  city?: string | null;
}): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects
       (campaign_id, canonical_key, display_name, stage, score, score_band, email,
        instagram_handle, phone, city)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      campaignId,
      `plain-${randomUUID()}`,
      options.name,
      options.stage ?? 'qualified',
      options.score ?? 70,
      options.band ?? 'B',
      options.email ?? null,
      options.instagram ?? null,
      options.phone ?? null,
      options.city ?? 'Lyon',
    ],
  );
  return rows[0]!.id;
}

/**
 * Un routeur qui répond toujours la même chose.
 *
 * CRM1 ne teste pas la classification — `tests/r6bReplies.test.ts` s'en
 * charge. Ce faux existe uniquement pour amener un prospect dans un état
 * commercial réel, afin que le CRM ait quelque chose de vrai à lire.
 */
function makeRouter(classify: Record<string, unknown>, draft: Record<string, unknown>): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async () => ({ text: JSON.stringify(turnAnswer(classify, draft)) }),
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

function classifyAs(category: string): Record<string, unknown> {
  return {
    category,
    confidence: 0.9,
    reasoning_summary: `réponse classée ${category} sur la base du texte reçu.`,
    evidence_excerpts: [{ quote: 'ça m’intéresse', why: 'passage décisif' }],
  };
}

const DRAFT_ANSWER = {
  body: 'Merci pour votre retour. Je vous propose un échange court quand cela vous arrange.',
  guardrail_flags: [],
};

// ---------------------------------------------------------------------------
// 1. Dérivations pures
// ---------------------------------------------------------------------------

describe('colonne du pipeline', () => {
  const base = {
    stage: 'qualified' as const,
    outreachState: null,
    sentCount: 0,
    hasLockedManifest: false,
    isClient: false,
    doNotContact: false,
  };

  it('un prospect scoré et retenu, sans manifeste, est QUALIFIED', () => {
    expect(resolveLane(base)).toBe('QUALIFIED');
  });

  it('un manifeste verrouillé fait passer à READY_TO_CONTACT', () => {
    expect(resolveLane({ ...base, hasLockedManifest: true })).toBe('READY_TO_CONTACT');
  });

  it('un envoi réel prime sur le manifeste, même sans ligne d’état', () => {
    expect(resolveLane({ ...base, hasLockedManifest: true, sentCount: 1 })).toBe('CONTACTED');
  });

  it('l’état commercial prime sur tout ce qui se déduit', () => {
    expect(resolveLane({ ...base, sentCount: 1, outreachState: 'INTERESTED' })).toBe('INTERESTED');
    expect(resolveLane({ ...base, sentCount: 1, outreachState: 'NOT_NOW' })).toBe('NOT_NOW');
    expect(resolveLane({ ...base, sentCount: 1, outreachState: 'REVIEW_REQUIRED' })).toBe(
      'REVIEW_REQUIRED',
    );
  });

  it('une protection prime sur un état positif — l’asymétrie est délibérée', () => {
    expect(resolveLane({ ...base, outreachState: 'INTERESTED', doNotContact: true })).toBe(
      'PROTECTED',
    );
    expect(resolveLane({ ...base, outreachState: 'SUPPRESSED', isClient: true })).toBe('PROTECTED');
    expect(resolveLane({ ...base, outreachState: 'BOUNCED' })).toBe('PROTECTED');
  });

  it('un prospect en amont ou écarté n’entre pas dans le pipeline', () => {
    expect(resolveLane({ ...base, stage: 'discovered' })).toBeNull();
    expect(resolveLane({ ...base, stage: 'rejected' })).toBeNull();
    expect(resolveLane({ ...base, stage: 'excluded' })).toBeNull();
  });

  it('un jalon « won » l’emporte sur l’état commercial', () => {
    expect(resolveLane({ ...base, outreachState: 'REPLIED', isClient: true })).toBe('CLIENT');
  });
});

/**
 * CRM1.1 — l'état commercial AFFICHÉ.
 *
 * Le défaut corrigé ici n'était pas une donnée fausse mais trois couches
 * montrées à plat : « jamais contacté » (machine à états), « Contactés »
 * (colonne) et « 1 » (envois) sur la même fiche. Ces tests fixent la seule
 * lecture qu'un opérateur doit voir, et surtout le fait qu'elle ne peut pas
 * diverger de la colonne du pipeline.
 */
describe('état commercial affiché', () => {
  const base = {
    stage: 'message_ready' as const,
    outreachState: null,
    sentCount: 0,
    hasLockedManifest: false,
    isClient: false,
    doNotContact: false,
    lastReplyAt: null,
  };

  it('un envoi réel sans réponse se dit « contacté, en attente » — le cas Demo Prospect B', () => {
    const state = resolveCommercialState({
      ...base,
      sentCount: 1,
      hasLockedManifest: true,
    });

    expect(state.lane).toBe('CONTACTED');
    expect(state.short).toBe('Contacté');
    expect(state.label).toContain('Contacté');
    expect(state.label).toContain('attente de réponse');
    // La contradiction de CRM1, mot pour mot, ne peut plus être affichée.
    expect(state.label).not.toContain('jamais contacté');
    // Les faits qui l'établissent sont nommés, y compris l'absence de ligne d'état.
    expect(state.basis).toContain('1 envoi réel');
    expect(state.basis).toContain('aucune réponse reçue');
    expect(state.basis).toContain('aucune transition d’état');
    expect(state.source).toBe('facts');
  });

  it('sans aucun envoi, rien ne se dit « contacté »', () => {
    const qualified = resolveCommercialState(base);
    expect(qualified.lane).toBe('QUALIFIED');
    expect(qualified.short).toBe('Qualifié');
    expect(qualified.label).toContain('jamais contacté');
    expect(qualified.basis).not.toContain('aucune réponse reçue');

    const ready = resolveCommercialState({ ...base, hasLockedManifest: true });
    expect(ready.lane).toBe('READY_TO_CONTACT');
    expect(ready.short).toBe('Prêt à contacter');
    expect(ready.label.toLowerCase()).not.toContain('contacté —');
    expect(ready.basis).toContain('manifeste LOCKED, rien d’envoyé');
  });

  it('une réponse reçue prime sur l’attente, et la machine à états prime sur la déduction', () => {
    const replied = resolveCommercialState({
      ...base,
      sentCount: 1,
      outreachState: 'REPLIED',
      lastReplyAt: '2026-08-13T09:00:00Z',
    });
    expect(replied.lane).toBe('REPLIED');
    expect(replied.short).toBe('A répondu');
    expect(replied.basis).toContain('réponse corrélée reçue');
    expect(replied.basis).not.toContain('aucune réponse reçue');
    expect(replied.source).toBe('state_machine');
    expect(replied.tone).toBe('positive');

    const interested = resolveCommercialState({
      ...base,
      sentCount: 1,
      outreachState: 'INTERESTED',
      lastReplyAt: '2026-08-13T09:00:00Z',
    });
    expect(interested.lane).toBe('INTERESTED');
    expect(interested.short).toBe('Intéressé');
    expect(interested.source).toBe('state_machine');
  });

  it('une protection l’emporte, et se dit comme telle', () => {
    const protectedByList = resolveCommercialState({
      ...base,
      sentCount: 1,
      outreachState: 'INTERESTED',
      doNotContact: true,
    });
    expect(protectedByList.lane).toBe('PROTECTED');
    expect(protectedByList.label).toContain('ne pas contacter');
    expect(protectedByList.tone).toBe('negative');
    // C'est l'exclusion qui a tranché, pas la machine — et c'est ce qui est dit.
    expect(protectedByList.source).toBe('facts');
    expect(protectedByList.basis).toContain('entrée dans do_not_contact');

    const bounced = resolveCommercialState({ ...base, sentCount: 1, outreachState: 'BOUNCED' });
    expect(bounced.lane).toBe('PROTECTED');
    expect(bounced.source).toBe('state_machine');
  });

  it('hors pipeline, la phrase ne prétend rien et montre l’étape de fabrication', () => {
    const upstream = resolveCommercialState({ ...base, stage: 'discovered' });
    expect(upstream.lane).toBeNull();
    expect(upstream.label).toBe('En amont du pipeline');
    expect(upstream.short).toBe('discovered');
  });

  it('la phrase et la colonne sortent du même calcul — elles ne peuvent pas diverger', () => {
    const inputs = [
      base,
      { ...base, hasLockedManifest: true },
      { ...base, sentCount: 3 },
      { ...base, sentCount: 1, outreachState: 'NOT_NOW' as const },
      { ...base, sentCount: 1, outreachState: 'NOT_INTERESTED' as const },
      { ...base, sentCount: 1, outreachState: 'REVIEW_REQUIRED' as const },
      { ...base, sentCount: 1, outreachState: 'SUPPRESSED' as const },
      { ...base, isClient: true },
      { ...base, stage: 'rejected' as const },
    ];
    for (const input of inputs) {
      expect(resolveCommercialState(input).lane).toBe(resolveLane(input));
    }
  });
});

/**
 * CRM2 — la couche de présentation.
 *
 * La direction artistique de CRM2 attribue une FONCTION à chaque couleur (vert
 * positif, bleu prêt à agir, violet en cours, orange en attente, rouge fermé).
 * Ce sont des règles de lecture dérivées des mêmes faits que la colonne du
 * pipeline, donc du code testé — pas une décision de feuille de style.
 */
describe('la teinte d’un prospect se dérive, elle ne se choisit pas', () => {
  // La liste vient de `view.ts`, elle n'est plus recopiée ici : une teinte
  // ajoutée au module et oubliée dans le test rendait ce contrôle muet sur
  // elle, ce qui est exactement l'inverse de son but.
  const TONES = CRM_TONES;

  it('chaque colonne et chaque canal ont une teinte déclarée', () => {
    for (const lane of CRM_LANES) {
      expect(TONES).toContain(LANE_TONE[lane.key]);
    }
    for (const channel of CRM_CHANNELS) {
      expect(TONES).toContain(CHANNEL_TONE[channel]);
    }
  });

  it('hors pipeline, seule une décision qui ferme une porte porte du rouge', () => {
    expect(laneTone(null)).toBe('slate');
    expect(stageTone('discovered')).toBe('slate');
    expect(stageTone('enriched')).toBe('slate');
    expect(stageTone('rejected')).toBe('red');
    expect(stageTone('excluded')).toBe('red');
  });

  it('la colonne l’emporte sur l’étape quand le prospect est dans le pipeline', () => {
    expect(prospectTone({ lane: 'QUALIFIED', stage: 'qualified' })).toBe('green');
    expect(prospectTone({ lane: 'READY_TO_CONTACT', stage: 'message_ready' })).toBe('blue');
    expect(prospectTone({ lane: 'PROTECTED', stage: 'approved' })).toBe('red');
    expect(prospectTone({ lane: null, stage: 'rejected' })).toBe('red');
    expect(prospectTone({ lane: null, stage: 'discovered' })).toBe('slate');
  });

  it('la bande de score descend avec l’échelle, et l’absence ne juge pas', () => {
    expect(bandTone('A')).toBe('green');
    expect(bandTone('B')).toBe('blue');
    expect(bandTone('C')).toBe('orange');
    expect(bandTone('D')).toBe('red');
    expect(bandTone(null)).toBe('slate');
  });

  /**
   * `commercial.short` reste l'identifiant de machine — d'autres vérifications
   * s'appuient dessus. Seul l'AFFICHAGE traduit, et seulement hors pipeline.
   */
  it('une étape de fabrication s’affiche en français, sans que la valeur change', () => {
    const upstream = resolveCommercialState({
      stage: 'rejected',
      outreachState: null,
      sentCount: 0,
      hasLockedManifest: false,
      isClient: false,
      doNotContact: false,
      lastReplyAt: null,
    });
    expect(upstream.short).toBe('rejected');
    expect(
      commercialShortLabel({ lane: upstream.lane, stage: 'rejected', short: upstream.short }),
    ).toBe('Écarté');
    // Dans le pipeline, la phrase de la colonne l'emporte : rien n'est traduit.
    expect(commercialShortLabel({ lane: 'CONTACTED', stage: 'approved', short: 'Contacté' })).toBe(
      'Contacté',
    );
  });
});

/**
 * CRM2 — la timeline se lit par jour.
 *
 * Le regroupement ne trie rien : il coupe la suite DÉJÀ triée à chaque
 * changement de date. C'est ce qui garantit qu'il hérite du tri déterministe de
 * `sortTimeline` au lieu d'en introduire un second.
 */
describe('le regroupement par jour d’une timeline', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');

  it('coupe à chaque changement de date, sans réordonner', () => {
    const entries = sortTimeline([
      entry({ id: 'a', kind: 'outbound_sent', occurredAt: '2026-08-15T11:00:00Z' }),
      entry({ id: 'b', kind: 'manifest_locked', occurredAt: '2026-08-15T09:00:00Z' }),
      entry({ id: 'c', kind: 'manifest_locked', occurredAt: '2026-08-14T10:00:00Z' }),
    ]);
    const days = groupTimelineByDay(entries, now);

    expect(days).toHaveLength(2);
    expect(days[0]?.label).toBe("Aujourd'hui");
    expect(days[0]?.entries.map((item) => item.id)).toEqual(['a', 'b']);
    expect(days[1]?.label).toBe('Hier');
    expect(days[1]?.entries.map((item) => item.id)).toEqual(['c']);
    // Rien ne se perd en route.
    expect(days.flatMap((day) => day.entries)).toHaveLength(entries.length);
  });

  it('nomme les jours proches, date les autres', () => {
    expect(formatDayLabel('2026-08-15T08:00:00Z', now)).toBe("Aujourd'hui");
    expect(formatDayLabel('2026-08-14T08:00:00Z', now)).toBe('Hier');
    expect(formatDayLabel('2026-08-02T08:00:00Z', now)).toContain('août');
  });

  it('une timeline vide ne produit aucun jour', () => {
    expect(groupTimelineByDay([], now)).toEqual([]);
  });
});

/**
 * CRM1.1 — la répartition des colonnes du pipeline.
 *
 * Une règle et une seule : une sortie VIDE se replie, une sortie PEUPLÉE reste
 * une colonne. Le repli est un poids visuel, pas un filtre — aucun prospect
 * n'y devient invisible, et c'est exactement ce que ces tests vérifient.
 */
describe('répartition des colonnes du pipeline', () => {
  function counts(patch: Partial<Record<CrmLane, number>> = {}): Record<CrmLane, number> {
    return {
      QUALIFIED: 0,
      READY_TO_CONTACT: 0,
      CONTACTED: 0,
      REPLIED: 0,
      INTERESTED: 0,
      NOT_NOW: 0,
      NOT_INTERESTED: 0,
      CLIENT: 0,
      REVIEW_REQUIRED: 0,
      PROTECTED: 0,
      ...patch,
    };
  }

  it('les cinq étapes actives restent des colonnes, même vides', () => {
    const layout = boardLayout(counts({ QUALIFIED: 73, READY_TO_CONTACT: 4, CONTACTED: 1 }));
    expect(layout.primary.map((lane) => lane.key)).toEqual([
      'QUALIFIED',
      'READY_TO_CONTACT',
      'CONTACTED',
      'REPLIED',
      'INTERESTED',
    ]);
  });

  it('les sorties vides se replient toutes ensemble — l’état réel du dépôt', () => {
    const layout = boardLayout(counts({ QUALIFIED: 73, READY_TO_CONTACT: 4, CONTACTED: 1 }));
    expect(layout.terminal).toEqual([]);
    expect(layout.collapsed.map((lane) => lane.key)).toEqual([
      'NOT_NOW',
      'NOT_INTERESTED',
      'CLIENT',
      'REVIEW_REQUIRED',
      'PROTECTED',
    ]);
  });

  it('une sortie PEUPLÉE ne se replie jamais', () => {
    const layout = boardLayout(counts({ CONTACTED: 1, PROTECTED: 2, CLIENT: 1 }));
    expect(layout.terminal.map((lane) => lane.key)).toEqual(['CLIENT', 'PROTECTED']);
    expect(layout.collapsed.map((lane) => lane.key)).toEqual([
      'NOT_NOW',
      'NOT_INTERESTED',
      'REVIEW_REQUIRED',
    ]);
    // Aucune colonne repliée ne contient quoi que ce soit.
    for (const lane of layout.collapsed) {
      expect(counts({ CONTACTED: 1, PROTECTED: 2, CLIENT: 1 })[lane.key]).toBe(0);
    }
  });

  it('les dix colonnes sont toujours présentes, quelle que soit la répartition', () => {
    for (const patch of [{}, { PROTECTED: 5 }, { NOT_NOW: 1, CLIENT: 1, REVIEW_REQUIRED: 1 }]) {
      const layout = boardLayout(counts(patch));
      const keys = [...layout.primary, ...layout.terminal, ...layout.collapsed].map(
        (lane) => lane.key,
      );
      expect(new Set(keys).size).toBe(10);
    }
  });
});

describe('canaux', () => {
  it('un transport de manifeste se traduit en canal, sans deviner l’inconnu', () => {
    expect(channelFromTransport('email')).toBe('email');
    expect(channelFromTransport('phone_call')).toBe('phone');
    expect(channelFromTransport('instagram_dm')).toBe('instagram_dm');
    expect(channelFromTransport('pigeon_voyageur')).toBeNull();
    expect(channelFromTransport(null)).toBeNull();
  });

  it('seuls les canaux réellement observés sont listés', () => {
    expect(
      observedChannels({ email: 'a@b.fr', instagramHandle: null, facebookUrl: null, phone: null }),
    ).toEqual(['email']);
    // Un numéro ne prouve qu'un appel : ni SMS, ni WhatsApp (migration 0020).
    expect(
      observedChannels({ email: null, instagramHandle: null, facebookUrl: null, phone: '+33...' }),
    ).toEqual(['phone']);
    expect(
      observedChannels({ email: '  ', instagramHandle: null, facebookUrl: null, phone: null }),
    ).toEqual([]);
  });

  it('un manifeste verrouillé impose le canal retenu', () => {
    expect(
      bestChannel({
        email: 'a@b.fr',
        instagramHandle: '@x',
        facebookUrl: null,
        phone: null,
        lockedTransport: 'instagram_dm',
      }),
    ).toBe('instagram_dm');
    expect(
      bestChannel({
        email: 'a@b.fr',
        instagramHandle: '@x',
        facebookUrl: null,
        phone: null,
        lockedTransport: null,
      }),
    ).toBe('email');
  });

  it('seuls les canaux ayant produit un événement sont « actifs »', () => {
    const entries: CrmTimelineEntry[] = [
      entry({ id: 'a', kind: 'outbound_sent', occurredAt: '2026-08-01T10:00:00Z', channel: 'email' }),
      entry({ id: 'b', kind: 'reply_analysis', occurredAt: '2026-08-01T11:00:00Z', channel: null }),
    ];
    expect(activeChannels(entries)).toEqual(['email']);
  });
});

describe('ordre de la timeline', () => {
  it('du plus récent au plus ancien', () => {
    const sorted = sortTimeline([
      entry({ id: 'a', kind: 'outbound_sent', occurredAt: '2026-08-01T10:00:00Z' }),
      entry({ id: 'b', kind: 'inbound_reply', occurredAt: '2026-08-03T10:00:00Z' }),
      entry({ id: 'c', kind: 'manifest_locked', occurredAt: '2026-08-02T10:00:00Z' }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('à date égale, l’effet passe avant sa cause et l’ordre reste stable', () => {
    const at = '2026-08-01T10:00:00Z';
    const first = sortTimeline([
      entry({ id: 'manifest', kind: 'manifest_locked', occurredAt: at }),
      entry({ id: 'state', kind: 'state_transition', occurredAt: at }),
      entry({ id: 'sent', kind: 'outbound_sent', occurredAt: at }),
    ]);
    expect(first.map((item) => item.id)).toEqual(['state', 'sent', 'manifest']);

    // Même entrée, ordre d'arrivée inverse : même résultat.
    const second = sortTimeline([
      entry({ id: 'sent', kind: 'outbound_sent', occurredAt: at }),
      entry({ id: 'manifest', kind: 'manifest_locked', occurredAt: at }),
      entry({ id: 'state', kind: 'state_transition', occurredAt: at }),
    ]);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('deux événements de même date et de même nature se départagent par identifiant', () => {
    const at = '2026-08-01T10:00:00Z';
    const sorted = sortTimeline([
      entry({ id: 'aaa', kind: 'alert', occurredAt: at }),
      entry({ id: 'zzz', kind: 'alert', occurredAt: at }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['zzz', 'aaa']);
  });
});

describe('formatage', () => {
  it('les références de preuve sont isolées, jamais supprimées', () => {
    const segments = splitEvidenceRefs(
      'Deux formules affichées [00000000-0000-4000-8000-000000000009] sur le site.',
    );
    expect(segments.filter((segment) => segment.isRef).map((segment) => segment.text)).toEqual([
      '00000000',
    ]);
    expect(segments.map((segment) => segment.text).join('')).toContain('Deux formules affichées');
    expect(segments.map((segment) => segment.text).join('')).toContain('sur le site.');
  });

  it('une référence tronquée en fin de texte est mise en puce, pas laissée en clair', () => {
    // La forme exacte écrite en base par le pipeline : crochet ouvrant, pas de
    // fermant. Elle traversait CRM1 en clair au bout de la phrase.
    const segments = splitEvidenceRefs(
      'repéré sur ces requêtes au rang 3. [cd83dd66-4e7f-449f-a99e-dc7e',
    );
    expect(segments.filter((segment) => segment.isRef).map((segment) => segment.text)).toEqual([
      'cd83dd66',
    ]);
    expect(segments.map((segment) => segment.text).join('')).toContain('au rang 3.');
  });

  it('un crochet ouvert AILLEURS qu’en fin de texte reste du texte', () => {
    const segments = splitEvidenceRefs('un [cd83dd66-4e7f au milieu, puis la suite de la phrase.');
    expect(segments.some((segment) => segment.isRef)).toBe(false);
  });

  it('un texte sans référence traverse intact', () => {
    expect(splitEvidenceRefs('Aucune référence.')).toEqual([
      { text: 'Aucune référence.', isRef: false },
    ]);
  });

  it('une URL est raccourcie sans devenir ambiguë', () => {
    expect(shortenUrl('https://www.example.com/contact?utm=1')).toBe('example.com/contact');
    expect(shortenUrl(null)).toBeNull();
    expect(shortenUrl('   ')).toBeNull();
  });

  it('un âge relatif est borné et déterministe', () => {
    const now = Date.parse('2026-08-13T12:00:00Z');
    expect(formatAge('2026-08-13T11:00:00Z', now)).toBe('1 h');
    expect(formatAge('2026-08-10T12:00:00Z', now)).toBe('3 j');
    expect(formatAge(null, now)).toBe('—');
    expect(formatAge('pas une date', now)).toBe('—');
  });

  it('un extrait coupe sur un mot et le signale', () => {
    expect(excerpt('un texte assez long pour être coupé quelque part', 20)).toBe('un texte assez long…');
    expect(excerpt('court', 20)).toBe('court');
  });

  it('les listes JSONB hétérogènes deviennent des phrases, sans « [object Object] »', () => {
    expect(textList(['a', { text: 'b' }, { autre: 'c' }, 42, null])).toEqual(['a', 'b']);
    expect(textList('pas un tableau')).toEqual([]);
  });

  it('les signaux de score sont lus dans l’ordre du barème', () => {
    const signals = parseScoreSignals({
      coverage: 0.8,
      signals: [
        { key: 'a', label: 'A — Activité', max: 20, points: 15, detail: 'x', observed: true },
        { key: 'd', label: 'D — Capacité', max: 16, points: 0, detail: 'y', observed: false },
      ],
    });
    expect(signals.map((signal) => signal.key)).toEqual(['a', 'd']);
    expect(signals[1]!.observed).toBe(false);
    expect(parseScoreSignals(null)).toEqual([]);
    expect(parseScoreSignals({ signals: 'non' })).toEqual([]);
  });

  it('un tri inconnu retombe sur le score', () => {
    expect(parseSort('n’importe quoi')).toBe('score');
    expect(parseSort(undefined)).toBe('score');
    expect(parseSort('city')).toBe('city');
  });
});

// ---------------------------------------------------------------------------
// 2. Lectures réelles
// ---------------------------------------------------------------------------

describe('table des prospects', () => {
  it('rend les vraies lignes, avec leurs dérivations', async () => {
    const contacted = await contactedProspect('table-a@example.com', {
      displayName: 'TABLE ALPHA',
    });
    const qualified = await plainProspect({ name: 'TABLE BETA', email: 'beta@example.com' });

    const rows = await listCrmProspects({}, sql);
    const alpha = rows.find((row) => row.id === contacted.prospectId);
    const beta = rows.find((row) => row.id === qualified);

    expect(alpha?.displayName).toBe('TABLE ALPHA');
    expect(alpha?.sentCount).toBe(1);
    expect(alpha?.lane).toBe('CONTACTED');
    expect(alpha?.bestChannel).toBe('email');
    expect(alpha?.lastOutreachAt).not.toBeNull();

    expect(beta?.lane).toBe('QUALIFIED');
    expect(beta?.sentCount).toBe(0);
    expect(beta?.lastOutreachAt).toBeNull();
  });

  it('la recherche libre porte sur des colonnes réelles', async () => {
    await plainProspect({ name: 'CHERCHABLE UNIQUE SARL', city: 'Annecy' });
    const found = await listCrmProspects({ q: 'CHERCHABLE UNIQUE' }, sql);
    expect(found.map((row) => row.displayName)).toEqual(['CHERCHABLE UNIQUE SARL']);

    const byCity = await listCrmProspects({ q: 'Annecy' }, sql);
    expect(byCity.some((row) => row.displayName === 'CHERCHABLE UNIQUE SARL')).toBe(true);

    expect(await listCrmProspects({ q: 'zzz-inexistant-zzz' }, sql)).toEqual([]);
  });

  it('les filtres sont déterministes et se combinent', async () => {
    const all = await listCrmProspects({}, sql);
    const qualified = await listCrmProspects({ lane: 'QUALIFIED' }, sql);
    const contacted = await listCrmProspects({ lane: 'CONTACTED' }, sql);

    expect(qualified.every((row) => row.lane === 'QUALIFIED')).toBe(true);
    expect(contacted.every((row) => row.lane === 'CONTACTED')).toBe(true);
    expect(qualified.length + contacted.length).toBeLessThanOrEqual(all.length);

    const bandB = await listCrmProspects({ lane: 'QUALIFIED', band: 'B' }, sql);
    expect(bandB.every((row) => row.lane === 'QUALIFIED' && row.scoreBand === 'B')).toBe(true);

    // Deux exécutions identiques rendent exactement la même liste.
    const again = await listCrmProspects({ lane: 'QUALIFIED', band: 'B' }, sql);
    expect(again.map((row) => row.id)).toEqual(bandB.map((row) => row.id));
  });

  it('le tri est total : deux prospects sans score gardent le même ordre', () => {
    const rows = [
      fakeProspect({ id: 'b', displayName: 'BETA', score: null }),
      fakeProspect({ id: 'a', displayName: 'ALPHA', score: null }),
      fakeProspect({ id: 'c', displayName: 'GAMMA', score: 90 }),
    ];
    expect(sortProspects(rows, 'score').map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(sortProspects([...rows].reverse(), 'score').map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(sortProspects(rows, 'name').map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('une date absente passe après une date présente, quel que soit le tri', () => {
    const rows = [
      fakeProspect({ id: 'sans', displayName: 'SANS', lastOutreachAt: null }),
      fakeProspect({ id: 'avec', displayName: 'AVEC', lastOutreachAt: '2026-08-01T10:00:00Z' }),
    ];
    expect(sortProspects(rows, 'outreach').map((row) => row.id)).toEqual(['avec', 'sans']);
  });
});

describe('pipeline', () => {
  it('reflète l’état réel et compte l’amont sans l’afficher en colonne', async () => {
    await plainProspect({ name: 'AMONT', stage: 'discovered', score: null, band: null });
    const pipeline = await loadCrmPipeline(sql);

    expect(pipeline.upstream).toBeGreaterThan(0);
    expect(pipeline.total).toBeGreaterThan(pipeline.upstream);
    expect(pipeline.lanes.CONTACTED.length).toBeGreaterThan(0);
    // Aucune colonne ne contient un prospect qui n'y appartient pas.
    for (const [lane, rows] of Object.entries(pipeline.lanes)) {
      for (const row of rows) expect(row.lane).toBe(lane);
    }
  });

  it('la somme des colonnes plus l’amont fait le total', async () => {
    const pipeline = await loadCrmPipeline(sql);
    const inLanes = Object.values(pipeline.lanes).reduce((sum, rows) => sum + rows.length, 0);
    expect(inLanes + pipeline.upstream).toBe(pipeline.total);
  });
});

describe('workspace', () => {
  it('rend le prospect demandé, et lui seul', async () => {
    const contacted = await contactedProspect('workspace@example.com', {
      displayName: 'WORKSPACE SARL',
    });
    const workspace = await loadCrmWorkspace(contacted.prospectId, sql);

    expect(workspace).not.toBeNull();
    expect(workspace!.prospect.id).toBe(contacted.prospectId);
    expect(workspace!.prospect.displayName).toBe('WORKSPACE SARL');
    expect(workspace!.research?.summary).toContain('Prestation standard intérieur');
    expect(workspace!.evidence.length).toBeGreaterThan(0);
    expect(workspace!.manifests.some((manifest) => manifest.status === 'LOCKED')).toBe(true);
  });

  it('un identifiant inconnu rend null plutôt qu’une fiche vide', async () => {
    expect(await loadCrmWorkspace(randomUUID(), sql)).toBeNull();
  });

  it('la timeline est ordonnée et ne contient que des faits de CE prospect', async () => {
    const mine = await contactedProspect('timeline-mine@example.com', {
      displayName: 'TIMELINE MIENNE',
    });
    const other = await contactedProspect('timeline-other@example.com', {
      displayName: 'TIMELINE AUTRE',
    });
    await inbound({ ...mine, body: 'Oui, envoyez-moi des détails.' });
    await inbound({ ...other, body: 'Non merci, message d’un autre dossier.' });

    const workspace = await loadCrmWorkspace(mine.prospectId, sql);
    const timeline = workspace!.timeline;

    expect(timeline.length).toBeGreaterThan(1);
    for (let index = 1; index < timeline.length; index += 1) {
      expect(Date.parse(timeline[index - 1]!.occurredAt)).toBeGreaterThanOrEqual(
        Date.parse(timeline[index]!.occurredAt),
      );
    }

    const bodies = timeline.map((event) => event.body ?? '').join('\n');
    expect(bodies).toContain('envoyez-moi des détails');
    // §16 — aucun contenu de boîte sans rapport n'apparaît sur cette fiche.
    expect(bodies).not.toContain("message d’un autre dossier");
    expect(timeline.some((event) => event.kind === 'inbound_reply' && event.channel === 'email')).toBe(
      true,
    );
    expect(timeline.some((event) => event.kind === 'outbound_sent')).toBe(true);
  });

  it('un prospect protégé le montre — colonne et motif', async () => {
    const id = await plainProspect({
      name: 'PROTÉGÉ SARL',
      email: 'stop@example.com',
    });
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('email', $1, 'demande explicite d’arrêt', 'test')`,
      ['stop@example.com'],
    );

    const workspace = await loadCrmWorkspace(id, sql);
    expect(workspace!.prospect.doNotContact).toBe(true);
    expect(workspace!.prospect.lane).toBe('PROTECTED');
    expect(workspace!.protections.map((protection) => protection.matchKind)).toContain('email');

    const pipeline = await loadCrmPipeline(sql);
    expect(pipeline.lanes.PROTECTED.some((row) => row.id === id)).toBe(true);
    expect(pipeline.lanes.QUALIFIED.some((row) => row.id === id)).toBe(false);
  });
});

/**
 * CRM1.1 — ce que l'interface AFFICHE des vraies lignes.
 *
 * Les trois vérifications précédentes portaient sur des fonctions pures. Ici,
 * la donnée traverse la base : c'est le seul moyen de garantir que la phrase
 * affichée sur une fiche réelle est bien celle qu'on a fixée.
 */
describe('état commercial sur des lignes réelles', () => {
  it('un prospect ayant reçu un envoi, sans réponse, s’affiche « contacté — en attente »', async () => {
    const contacted = await contactedProspect('etat-contacte@example.com', {
      displayName: 'ÉTAT CONTACTÉ SARL',
    });

    const workspace = await loadCrmWorkspace(contacted.prospectId, sql);
    const { commercial } = workspace!.prospect;

    expect(workspace!.prospect.sentCount).toBe(1);
    // Aucune ligne de machine à états : c'est exactement le cas de production.
    expect(workspace!.prospect.outreachState).toBeNull();
    expect(commercial.short).toBe('Contacté');
    expect(commercial.label).toContain('attente de réponse');
    expect(commercial.lane).toBe('CONTACTED');
    expect(commercial.source).toBe('facts');

    // Et la table dit la même chose, au mot près.
    const rows = await listCrmProspects({}, sql);
    const row = rows.find((entry) => entry.id === contacted.prospectId);
    expect(row?.commercial.short).toBe('Contacté');
    expect(row?.commercial.label).toBe(commercial.label);
  });

  it('un prospect sans aucun envoi ne s’affiche jamais « contacté »', async () => {
    const id = await plainProspect({ name: 'ÉTAT JAMAIS CONTACTÉ SARL' });
    const workspace = await loadCrmWorkspace(id, sql);
    const { commercial } = workspace!.prospect;

    expect(workspace!.prospect.sentCount).toBe(0);
    expect(commercial.lane).toBe('QUALIFIED');
    expect(commercial.short).toBe('Qualifié');
    expect(commercial.short).not.toBe('Contacté');
    expect(commercial.label).toContain('jamais contacté');
  });

  it('une réponse traitée fait basculer la phrase, et le dit tenu par la machine', async () => {
    const fixture = await contactedProspect('etat-repondu@example.com', {
      displayName: 'ÉTAT RÉPONDU SARL',
    });
    const messageId = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });
    await processReply(sql, makeRouter(classifyAs('INTERESTED'), DRAFT_ANSWER), messageId, {
      crm: NO_CRM,
    });

    const workspace = await loadCrmWorkspace(fixture.prospectId, sql);
    const { commercial } = workspace!.prospect;

    expect(commercial.lane).toBe('INTERESTED');
    expect(commercial.short).toBe('Intéressé');
    expect(commercial.short).not.toBe('Contacté');
    expect(commercial.source).toBe('state_machine');
    expect(commercial.basis).toContain('réponse corrélée reçue');
  });

  it('la recherche réelle reste intégralement lisible — résumé, opportunités, inconnues, observations', async () => {
    const fixture = await contactedProspect('recherche@example.com', {
      displayName: 'RECHERCHE SARL',
    });
    const workspace = await loadCrmWorkspace(fixture.prospectId, sql);
    const research = workspace!.research;

    expect(research).not.toBeNull();
    expect(research!.summary).toContain('Prestation standard intérieur');
    // Les observations existaient en base et n'étaient rendues nulle part en
    // CRM1 — la hiérarchie de CRM1.1 les remet sous « Preuves et sources ».
    expect(research!.observations.length).toBeGreaterThan(0);
    expect(research!.observations.join(' ')).toContain('50 €');
    expect(research!.opportunities.length).toBeGreaterThan(0);
    expect(research!.unknowns.length).toBeGreaterThan(0);
    expect(workspace!.evidence.length).toBeGreaterThan(0);
  });
});

describe('inbox et alertes', () => {
  it('l’inbox ne montre que ce que le poller a retenu, corrélé ou non', async () => {
    const rows = await loadCrmInbox(50, sql);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.receivedAt).toBeTruthy();
      expect(['EXACT', 'HIGH_CONFIDENCE', 'REVIEW_REQUIRED', 'UNMATCHED']).toContain(
        row.correlationStatus,
      );
    }
    // L'ordre est décroissant, sans exception.
    for (let index = 1; index < rows.length; index += 1) {
      expect(Date.parse(rows[index - 1]!.receivedAt)).toBeGreaterThanOrEqual(
        Date.parse(rows[index]!.receivedAt),
      );
    }
  });

  it('les alertes sont lisibles même sans canal de livraison', async () => {
    const rows = await loadCrmAlerts(50, sql);
    for (const row of rows) expect(row.company).toBeTruthy();
  });

  /**
   * L'état vide de l'inbox n'a le droit qu'à des lignes réelles.
   *
   * Une boîte sans réponse peut vouloir dire « relevée, rien n'est arrivé » ou
   * « jamais relevée ». Les deux se distinguent par une ligne de
   * `r6b_inbound_checkpoints`, et par rien d'autre.
   */
  it('l’état de la boîte ne dit que ce qui est en base', async () => {
    const before = await loadCrmInboxStatus(sql);
    // Aucun tour de poll dans cette base de test : la page ne peut donc pas
    // prétendre qu'une boîte est connectée.
    expect(before.mailbox).toBeNull();
    expect(before.lastPolledAt).toBeNull();
    expect(before.contactedProspects).toBeGreaterThan(0);

    await sql.query(
      `insert into r6b_inbound_checkpoints (provider, mailbox, last_polled_at)
       values ('gmail', $1, $2)`,
      [MAILBOX, '2026-08-13T13:29:24Z'],
    );

    const after = await loadCrmInboxStatus(sql);
    expect(after.mailbox).toBe(MAILBOX);
    expect(Date.parse(after.lastPolledAt!)).toBe(Date.parse('2026-08-13T13:29:24Z'));
    expect(after.invalidationCount).toBe(0);

    // Les compteurs sont ceux des tables, pas une estimation.
    const [row] = await sql.query<{ contacted: string; replies: string }>(
      `select (select count(distinct prospect_id) from outreach_events where kind = 'sent')::text as contacted,
              (select count(*) from r6b_inbound_messages)::text as replies`,
    );
    expect(after.contactedProspects).toBe(Number(row!.contacted));
    expect(after.replies).toBe(Number(row!.replies));
  });

  it('l’en-tête compte ce qui existe', async () => {
    const overview = await loadCrmOverview(sql);
    const pipeline = await loadCrmPipeline(sql);
    expect(overview.prospects).toBe(pipeline.total);
    expect(overview.inPipeline).toBe(pipeline.total - pipeline.upstream);
    expect(overview.externalCrm).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Politique : le CRM local est canonique, la copie externe est optionnelle
// ---------------------------------------------------------------------------

describe('CRM local canonique, CRM externe optionnel', () => {
  it('l’absence de destination externe ne bloque rien — elle produit LOCAL_ONLY', async () => {
    const fixture = await contactedProspect('local-only@example.com', {
      displayName: 'LOCAL ONLY SARL',
    });
    const messageId = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const result = await processReply(sql, makeRouter(classifyAs('INTERESTED'), DRAFT_ANSWER), messageId, {
      crm: NO_CRM,
    });

    expect(result.crmStatus).toBe('LOCAL_ONLY');
    expect(result.crmDetail).toContain('canonique');

    const rows = await sql.query<{ status: string; provider: string }>(
      'select status, provider from r6b_crm_projections where prospect_id = $1',
      [fixture.prospectId],
    );
    expect(rows[0]!.status).toBe('LOCAL_ONLY');
    expect(rows[0]!.provider).toBe('hermes_local');

    // Et le dossier local, lui, est complet : le CRM le lit sans rien attendre.
    const workspace = await loadCrmWorkspace(fixture.prospectId, sql);
    expect(workspace!.prospect.outreachState).toBe('INTERESTED');
    expect(workspace!.prospect.lane).toBe('INTERESTED');
    expect(workspace!.externalProjection?.status).toBe('LOCAL_ONLY');
    expect(workspace!.timeline.some((event) => event.kind === 'reply_analysis')).toBe(true);
  });

  it('sans destination externe, une corrélation faible ne se présente pas comme un blocage', async () => {
    const fixture = await contactedProspect('weak@example.com', { displayName: 'FAIBLE SARL' });
    const messageId = await inbound({
      ...fixture,
      body: 'Oui pourquoi pas.',
      correlationStatus: 'HIGH_CONFIDENCE',
    });
    const context = await loadReplyContext(sql, messageId);
    await processReply(sql, makeRouter(classifyAs('INTERESTED'), DRAFT_ANSWER), messageId, { crm: NO_CRM });
    const analysis = await loadActiveAnalysis(sql, messageId);

    const projection = await projectToCrm(sql, {
      context: context!,
      analysis: analysis!,
      outreachState: 'INTERESTED',
      // Ce que la politique de corrélation dirait d'une écriture EXTERNE.
      externalWriteAllowed: false,
      resolution: NO_CRM,
    });

    expect(projection.status).toBe('LOCAL_ONLY');
    // L'information n'est pas perdue pour autant : elle est dite.
    expect(projection.detail).toContain('HIGH_CONFIDENCE');
  });

  it('une destination NOMMÉE mais refusée reste, elle, un blocage explicite', async () => {
    const fixture = await contactedProspect('blocked@example.com', { displayName: 'BLOQUÉ SARL' });
    const messageId = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });
    const context = await loadReplyContext(sql, messageId);
    await processReply(sql, makeRouter(classifyAs('INTERESTED'), DRAFT_ANSWER), messageId, { crm: NO_CRM });
    const analysis = await loadActiveAnalysis(sql, messageId);

    const projection = await projectToCrm(sql, {
      context: context!,
      analysis: analysis!,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: {
        configured: false,
        kind: 'BLOCKED_CONFIG',
        reason: 'sous-compte non confirmé',
        missing: [],
      },
    });

    expect(projection.status).toBe('BLOCKED_CONFIG');
  });
});

// ---------------------------------------------------------------------------
// 4. Ce que le CRM ne peut pas faire
// ---------------------------------------------------------------------------

describe('le CRM ne peut ni écrire, ni envoyer', () => {
  const CRM_UI = resolve(process.cwd(), 'src/app/crm');

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        out.push(...sources(path));
        continue;
      }
      if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(path);
    }
    return out;
  }

  it('aucune Server Action n’existe sous /crm', () => {
    for (const path of sources(CRM_UI)) {
      expect(readFileSync(path, 'utf8')).not.toContain("'use server'");
    }
  });

  it('aucun formulaire de mutation n’existe sous /crm', () => {
    for (const path of sources(CRM_UI)) {
      const source = readFileSync(path, 'utf8');
      // Le seul formulaire du CRM est la recherche, en GET.
      expect(source).not.toMatch(/method=["']post["']/i);
      expect(source).not.toMatch(/<button[^>]*type=["']submit["']/i);
    }
  });

  it('aucun module d’envoi, de dispatch ou de CRM externe n’est importé par /crm', () => {
    const forbidden = [
      'r6bLiveDispatch',
      'r6bDispatch',
      'resend',
      'gmailProvider',
      '@/lib/crm/ghl',
      '@/lib/crm/apply',
      '@/lib/crm/sync',
    ];
    for (const path of sources(CRM_UI)) {
      const source = readFileSync(path, 'utf8');
      for (const needle of forbidden) expect(source).not.toContain(needle);
    }
  });

  /**
   * CRM1.1 — aucune instruction d'opérateur dans l'interface produit.
   *
   * L'état vide de l'inbox affichait `npm run r6b:inbound:poll` et
   * `npm run r6b:replies:process`. Une commande shell dans un CRM n'est pas une
   * aide : c'est l'aveu que la page ne sait pas dire ce qui se passe. La règle
   * vaut pour toute page, pas seulement pour celle qui l'avait.
   */
  it('aucune commande shell n’est affichée dans le CRM', () => {
    for (const path of sources(CRM_UI)) {
      // Les commentaires sont retirés : ce fichier-ci EXPLIQUE la règle en
      // citant ce qu'elle interdit, et un commentaire n'atteint aucun écran.
      const rendered = stripComments(readFileSync(path, 'utf8'));
      expect(rendered).not.toContain('npm run');
      expect(rendered).not.toMatch(/<code>/);
      expect(rendered).not.toMatch(/\btsx src\//);
    }
  });

  /**
   * Et aucun horaire inventé.
   *
   * Ce dépôt ne contient aucun ordonnanceur : annoncer une « prochaine
   * vérification » serait un état produit fabriqué (AGENTS.md §2).
   */
  it('aucune synchronisation future n’est promise', () => {
    const inbox = readFileSync(join(CRM_UI, 'inbox/page.tsx'), 'utf8');
    const rendered = stripComments(inbox).toLowerCase();
    for (const promise of ['prochaine relève', 'prochaine vérification', 'prochaine sync']) {
      expect(rendered).not.toContain(promise);
    }
    // Ce qu'elle affiche vient d'une ligne, pas d'une estimation.
    expect(inbox).toContain('loadCrmInboxStatus');
  });

  it('la couche de lecture du CRM ne contient aucune écriture SQL', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/crm/queries.ts'), 'utf8');
    for (const verb of ['insert into', 'update ', 'delete from', 'drop ', 'alter ']) {
      expect(source.toLowerCase()).not.toContain(verb);
    }
  });

  it('lire le CRM n’écrit aucune ligne', async () => {
    const before = await counts(sql);
    await listCrmProspects({}, sql);
    await loadCrmPipeline(sql);
    await loadCrmOverview(sql);
    await loadCrmInbox(50, sql);
    await loadCrmAlerts(50, sql);
    const rows = await listCrmProspects({ lane: 'CONTACTED' }, sql);
    for (const row of rows) await loadCrmWorkspace(row.id, sql);
    expect(await counts(sql)).toEqual(before);
  });
});

/** Retire commentaires de bloc et de ligne — ce qui n'atteint jamais un écran. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function counts(db: Sql): Promise<Record<string, number>> {
  const [row] = await db.query<Record<string, string>>(
    `select (select count(*) from prospects)::text                     as prospects,
            (select count(*) from outreach_events)::text               as outreach_events,
            (select count(*) from r6b_live_send_attempts)::text        as live_send_attempts,
            (select count(*) from r6b_dispatch_attempts)::text         as dispatch_attempts,
            (select count(*) from r6b_inbound_messages)::text          as inbound,
            (select count(*) from r6b_reply_analyses)::text            as analyses,
            (select count(*) from r6b_reply_drafts)::text              as drafts,
            (select count(*) from r6b_crm_projections)::text           as projections,
            (select count(*) from r6b_prospect_state_transitions)::text as transitions,
            (select count(*) from do_not_contact)::text                as dnc,
            (select count(*) from r6b_alerts)::text                    as alerts`,
  );
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(patch: Partial<CrmTimelineEntry> & { id: string; kind: CrmTimelineEntry['kind'] }): CrmTimelineEntry {
  return {
    direction: 'system',
    occurredAt: '2026-08-01T10:00:00Z',
    channel: null,
    title: patch.id,
    body: null,
    facts: [],
    ...patch,
  };
}

function fakeProspect(patch: Partial<CrmProspect> & { id: string; displayName: string }): CrmProspect {
  return {
    commercial: resolveCommercialState({
      stage: 'qualified',
      outreachState: null,
      sentCount: 0,
      hasLockedManifest: false,
      isClient: false,
      doNotContact: false,
      lastReplyAt: null,
    }),
    legalName: null,
    city: null,
    postalCode: null,
    department: null,
    score: null,
    scoreBand: null,
    stage: 'qualified',
    nicheVerdict: null,
    websiteUrl: null,
    domain: null,
    instagramHandle: null,
    facebookUrl: null,
    email: null,
    phone: null,
    outreachState: null,
    sentCount: 0,
    lockedTransport: null,
    lastOutreachAt: null,
    lastOutreachTransport: null,
    lastReplyAt: null,
    lastReplyClassification: null,
    recommendedNextAction: null,
    isClient: false,
    doNotContact: false,
    dedupeStatus: 'unique',
    campaignSlug: 'test',
    lane: 'QUALIFIED',
    bestChannel: null,
    channels: [],
    ...patch,
  };
}
