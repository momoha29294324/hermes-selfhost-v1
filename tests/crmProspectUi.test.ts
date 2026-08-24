/**
 * La fiche prospect CRM-UI-R1 — ce que la refonte n'a PAS le droit de changer.
 *
 * Deux familles d'assertions :
 *
 *   1. les VUES dérivées (fil de conversation, action suivante, onglets) sont
 *      des fonctions pures, testées comme telles ;
 *   2. les INVARIANTS produits qu'aucun type ne protège — pas de primitive
 *      d'envoi, « non observé » conservé, conversation défilante — sont
 *      vérifiés sur le source et la feuille de style. Une refonte visuelle est
 *      exactement le moment où ces règles se perdent sans que rien ne casse.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildConversation,
  groupConversationByDay,
  type CrmConversationEntry,
} from '@/lib/crm/conversation';
import { resolveNextAction } from '@/lib/crm/next-action';
import {
  CRM_PROSPECT_DEFAULT_TAB,
  CRM_PROSPECT_TABS,
  resolveProspectTab,
} from '@/lib/crm/tabs';
import type { CrmTimelineEntry } from '@/lib/crm/view';

const FICHE_DIR = resolve(process.cwd(), 'src/app/crm/prospects/[id]');
const CRM_CSS = resolve(process.cwd(), 'src/app/crm/crm.css');

function ficheSources(): { file: string; text: string }[] {
  return readdirSync(FICHE_DIR)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ file: name, text: readFileSync(join(FICHE_DIR, name), 'utf8') }));
}

function entry(over: Partial<CrmTimelineEntry> & Pick<CrmTimelineEntry, 'id' | 'kind'>): CrmTimelineEntry {
  return Object.freeze({
    direction: 'system',
    occurredAt: '2026-08-21T10:00:00.000Z',
    channel: null,
    title: 'titre',
    body: null,
    facts: Object.freeze([]),
    ...over,
  }) as CrmTimelineEntry;
}

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------

describe('onglets de la fiche', () => {
  it('en déclare exactement cinq, dans l’ordre de lecture', () => {
    expect(CRM_PROSPECT_TABS.map((tab) => tab.id)).toEqual([
      'overview',
      'conversation',
      'evidence',
      'analysis',
      'history',
    ]);
  });

  it('n’a ni identifiant ni libellé en double', () => {
    expect(new Set(CRM_PROSPECT_TABS.map((tab) => tab.id)).size).toBe(CRM_PROSPECT_TABS.length);
    expect(new Set(CRM_PROSPECT_TABS.map((tab) => tab.label)).size).toBe(CRM_PROSPECT_TABS.length);
  });

  it('s’ouvre sur la vue d’ensemble', () => {
    expect(CRM_PROSPECT_DEFAULT_TAB).toBe('overview');
    expect(resolveProspectTab(null)).toBe('overview');
    expect(resolveProspectTab(undefined)).toBe('overview');
  });

  it('retombe sur la vue d’ensemble plutôt que d’ouvrir un panneau inconnu', () => {
    expect(resolveProspectTab('inexistant')).toBe('overview');
    expect(resolveProspectTab('')).toBe('overview');
  });

  it('accepte chacun de ses propres identifiants', () => {
    for (const tab of CRM_PROSPECT_TABS) expect(resolveProspectTab(tab.id)).toBe(tab.id);
  });

  it('donne un panneau réel à chaque onglet — aucun onglet décoratif', () => {
    const page = readFileSync(join(FICHE_DIR, 'page.tsx'), 'utf8');
    for (const tab of CRM_PROSPECT_TABS) {
      expect(page).toContain(`${tab.id}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

describe('fil de conversation', () => {
  it('est vide quand rien n’a été échangé, sans inventer de message', () => {
    const conversation = buildConversation([]);
    expect(conversation.entries).toEqual([]);
    expect(conversation.sent).toBe(0);
    expect(conversation.received).toBe(0);
    expect(conversation.lastAt).toBeNull();
  });

  it('distingue ce qui part de ce qui arrive', () => {
    const conversation = buildConversation([
      entry({
        id: 'outreach:1',
        kind: 'outbound_sent',
        direction: 'outbound',
        channel: 'instagram_dm',
        body: 'Bonjour !',
        occurredAt: '2026-08-21T12:29:00.000Z',
      }),
      entry({
        id: 'inbound:1',
        kind: 'inbound_reply',
        direction: 'inbound',
        channel: 'instagram_dm',
        body: 'Oui avec plaisir',
        occurredAt: '2026-08-21T12:35:00.000Z',
      }),
    ]);

    expect(conversation.entries.map((message) => message.side)).toEqual(['hermes', 'prospect']);
    expect(conversation.entries.map((message) => message.status)).toEqual(['sent', 'received']);
    expect(conversation.sent).toBe(1);
    expect(conversation.received).toBe(1);
  });

  it('se lit du plus ancien au plus récent, l’inverse de la timeline', () => {
    const conversation = buildConversation([
      entry({
        id: 'inbound:2',
        kind: 'inbound_reply',
        body: 'deuxième',
        occurredAt: '2026-08-21T14:00:00.000Z',
      }),
      entry({
        id: 'outreach:1',
        kind: 'outbound_sent',
        body: 'premier',
        occurredAt: '2026-08-21T09:00:00.000Z',
      }),
    ]);
    expect(conversation.entries.map((message) => message.body)).toEqual(['premier', 'deuxième']);
  });

  it('départage deux événements de la même seconde de façon STABLE', () => {
    const same = '2026-08-21T09:00:00.000Z';
    const build = (order: readonly CrmTimelineEntry[]) =>
      buildConversation(order).entries.map((message) => message.id);
    const a = entry({ id: 'outreach:a', kind: 'outbound_sent', body: 'a', occurredAt: same });
    const b = entry({ id: 'inbound:b', kind: 'inbound_reply', body: 'b', occurredAt: same });
    expect(build([a, b])).toEqual(build([b, a]));
  });

  it('ne recopie que les événements PORTEURS D’UN TEXTE ÉCHANGÉ', () => {
    const conversation = buildConversation([
      entry({ id: 'manifest:1', kind: 'manifest_locked', body: 'texte approuvé' }),
      entry({ id: 'state:1', kind: 'state_transition', body: 'CONTACTED' }),
      entry({ id: 'analysis:1', kind: 'reply_analysis', body: 'raisonnement' }),
      entry({ id: 'alert:1', kind: 'alert', body: 'alerte' }),
      entry({ id: 'outreach:1', kind: 'outbound_sent', body: 'vrai message' }),
    ]);
    expect(conversation.entries.map((message) => message.id)).toEqual(['outreach:1']);
  });

  it('montre un brouillon comme un brouillon — jamais comme un envoi', () => {
    const conversation = buildConversation([
      entry({ id: 'draft:1', kind: 'reply_draft', body: 'réponse proposée' }),
    ]);
    const [message] = conversation.entries;
    expect(message?.status).toBe('draft');
    expect(message?.side).toBe('hermes');
    expect(conversation.sent).toBe(0);
    expect(conversation.drafts).toBe(1);
  });

  it('garde un envoi qui n’a rien remis, même sans corps', () => {
    const conversation = buildConversation([
      entry({
        id: 'attempt:1',
        kind: 'send_failure',
        body: null,
        facts: ['code IG_SEND_COMPOSER_NOT_FOUND'],
      }),
    ]);
    const [message] = conversation.entries;
    expect(message?.status).toBe('failed');
    expect(message?.side).toBe('system');
    expect(conversation.failures).toBe(1);
    expect(conversation.sent).toBe(0);
  });

  it('écarte un message vide plutôt que d’afficher une bulle sans texte', () => {
    const conversation = buildConversation([
      entry({ id: 'outreach:1', kind: 'outbound_sent', body: '   ' }),
      entry({ id: 'inbound:1', kind: 'inbound_reply', body: null }),
    ]);
    expect(conversation.entries).toEqual([]);
  });

  it('ne retient que les canaux qui ont RÉELLEMENT porté un message', () => {
    const conversation = buildConversation([
      entry({ id: 'outreach:1', kind: 'outbound_sent', body: 'a', channel: 'instagram_dm' }),
      entry({ id: 'inbound:1', kind: 'inbound_reply', body: 'b', channel: 'email' }),
    ]);
    expect([...conversation.channels].sort()).toEqual(['email', 'instagram_dm']);
  });

  it('encaisse un fil très long sans se dégrader', () => {
    const many: CrmTimelineEntry[] = [];
    for (let index = 0; index < 500; index += 1) {
      many.push(
        entry({
          id: `outreach:${index}`,
          kind: index % 2 === 0 ? 'outbound_sent' : 'inbound_reply',
          body: `message ${index}`,
          occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        }),
      );
    }
    const conversation = buildConversation(many);
    expect(conversation.entries).toHaveLength(500);
    expect(conversation.sent + conversation.received).toBe(500);
    expect(conversation.entries[0]?.body).toBe('message 0');
    expect(conversation.entries[499]?.body).toBe('message 499');
  });

  it('regroupe le fil par journée, dans l’ordre croissant', () => {
    const conversation = buildConversation([
      entry({ id: 'outreach:1', kind: 'outbound_sent', body: 'j1', occurredAt: '2026-08-19T10:00:00.000Z' }),
      entry({ id: 'inbound:1', kind: 'inbound_reply', body: 'j2', occurredAt: '2026-08-20T10:00:00.000Z' }),
      entry({ id: 'inbound:2', kind: 'inbound_reply', body: 'j2b', occurredAt: '2026-08-20T18:00:00.000Z' }),
    ]);
    const days = groupConversationByDay(conversation.entries, Date.parse('2026-08-21T10:00:00.000Z'));
    expect(days).toHaveLength(2);
    expect(days[1]?.entries).toHaveLength(2);
    const bodies = days.flatMap((day) => day.entries.map((e: CrmConversationEntry) => e.body));
    expect(bodies).toEqual(['j1', 'j2', 'j2b']);
  });
});

// ---------------------------------------------------------------------------
// Action suivante — la règle n'a pas bougé
// ---------------------------------------------------------------------------

describe('action suivante', () => {
  it('laisse le dernier mot à l’analyse de la réponse', () => {
    const action = resolveNextAction({
      recommendedNextAction: 'proposer un appel',
      doNotContact: true,
      lane: 'CONTACTED',
    });
    expect(action.label).toBe('proposer un appel');
    expect(action.basis).toBe('recommandée par l’analyse de la réponse');
    expect(action.tone).toBe('orange');
  });

  it('interdit le contact avant toute considération de pipeline', () => {
    const action = resolveNextAction({
      recommendedNextAction: null,
      doNotContact: true,
      lane: 'READY_TO_CONTACT',
    });
    expect(action.key).toBe('do_not_contact');
    expect(action.label).toBe('ne pas contacter');
    expect(action.tone).toBe('red');
  });

  it('rend les mêmes phrases que CRM2 pour les couloirs du pipeline', () => {
    expect(
      resolveNextAction({ recommendedNextAction: null, doNotContact: false, lane: 'READY_TO_CONTACT' }),
    ).toMatchObject({
      label: 'manifeste prêt',
      basis: 'texte, transport et destinataire figés',
      tone: 'blue',
    });
    expect(
      resolveNextAction({ recommendedNextAction: null, doNotContact: false, lane: 'CONTACTED' }),
    ).toMatchObject({
      label: 'attendre la réponse',
      basis: 'envoi réel, aucune réponse reçue',
      tone: 'violet',
    });
  });

  it('n’invente aucune action quand aucune règle ne s’applique', () => {
    const action = resolveNextAction({
      recommendedNextAction: null,
      doNotContact: false,
      lane: null,
    });
    expect(action.label).toBe('—');
    expect(action.basis).toBe('aucune action enregistrée');
    expect(action.key).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Invariants produits
// ---------------------------------------------------------------------------

describe('invariants de la fiche', () => {
  it('n’introduit AUCUNE primitive d’envoi', () => {
    for (const { file, text } of ficheSources()) {
      expect(text, `${file} ne doit pas déclarer d'action serveur`).not.toContain("'use server'");
      expect(text, `${file} ne doit contenir aucun formulaire`).not.toMatch(/<form\b/);
      expect(text, `${file} ne doit contenir aucun champ de saisie`).not.toMatch(/<input\b/);
      expect(text, `${file} ne doit contenir aucune zone de texte`).not.toMatch(/<textarea\b/);
      expect(text, `${file} ne doit pas appeler un transport`).not.toMatch(
        /\bsendMessage\b|\bdispatch\b|\bfetch\(/,
      );
    }
  });

  it('dit explicitement que la conversation est en lecture seule', () => {
    const convo = readFileSync(join(FICHE_DIR, 'conversation.tsx'), 'utf8');
    expect(convo).toContain('Lecture seule');
  });

  it('conserve la distinction « non observé » ≠ « inexistant »', () => {
    const parts = readFileSync(join(FICHE_DIR, 'parts.tsx'), 'utf8');
    expect(parts).toContain("placeholder = 'non observé'");
    const overview = readFileSync(join(FICHE_DIR, 'overview.tsx'), 'utf8');
    expect(overview).toContain('n’est pas « inexistant »');
  });

  it('ne recalcule ni le score ni l’état commercial', () => {
    for (const { file, text } of ficheSources()) {
      expect(text, `${file} ne doit pas rescorer`).not.toMatch(/scoreProspect|computeScore|resolveLane\(/);
      expect(text, `${file} ne doit pas transitionner un état`).not.toMatch(/transitionTo|applyTransition/);
    }
  });

  it('replie les preuves au lieu de les déverser', () => {
    const evidence = readFileSync(join(FICHE_DIR, 'evidence.tsx'), 'utf8');
    expect(evidence).toMatch(/<details className="crm-details">/);
    // Les lignes de preuve, les manifestes et les couches restent fermés ;
    // seules les observations s'ouvrent d'office.
    expect(evidence.match(/<details className="crm-details" open>/g) ?? []).toHaveLength(1);
  });

  it('donne à la conversation son propre défilement, borné en hauteur', () => {
    const css = readFileSync(CRM_CSS, 'utf8');
    const rule = css.match(/\.crm-scroll \{[^}]+\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toMatch(/max-height:/);
    expect(rule?.[0]).toMatch(/overflow-y: auto/);
    const convo = readFileSync(join(FICHE_DIR, 'conversation.tsx'), 'utf8');
    expect(convo).toContain('crm-thread crm-scroll');
  });

  it('empêche tout débordement horizontal de la page', () => {
    const css = readFileSync(CRM_CSS, 'utf8');
    expect(css).toContain('.crm-panel[hidden]');
    // Chaque grille de la fiche borne ses colonnes par `minmax(0, …)`, faute de
    // quoi une longue URL élargirait la page entière.
    for (const selector of ['.crm-convo-layout', '.crm-analysis', '.crm-history']) {
      const block = css.match(new RegExp(`\\${selector} \\{[^}]+\\}`));
      expect(block?.[0], selector).toMatch(/minmax\(0,/);
    }
  });

  it('garde la fiche découpée en composants plutôt qu’en une page monolithique', () => {
    const sources = ficheSources();
    expect(sources.length).toBeGreaterThanOrEqual(8);
    for (const { file, text } of sources) {
      expect(text.split('\n').length, `${file} est trop long`).toBeLessThan(420);
    }
  });
});
