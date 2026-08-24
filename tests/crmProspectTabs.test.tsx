// @vitest-environment jsdom

/**
 * Ce que la fiche fait RÉELLEMENT dans un navigateur.
 *
 * Les autres tests de la refonte portent sur des fonctions pures ; ceux-ci
 * rendent les deux seuls composants dont le comportement ne se déduit pas de
 * leur type : la barre d'onglets, qui a un état, et la bulle de message, dont
 * tout l'intérêt est de rendre deux interlocuteurs impossibles à confondre.
 *
 * L'assertion la plus importante du fichier est la dernière : après rendu du
 * fil complet, le DOM ne contient AUCUN moyen d'envoyer quoi que ce soit. Un
 * grep sur le source dirait la même chose du fichier ; seul un rendu le dit de
 * l'écran.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProspectTabs } from '@/app/crm/prospects/[id]/tabs';
import { ConversationThread, MessageBubble } from '@/app/crm/prospects/[id]/conversation';
import { buildConversation } from '@/lib/crm/conversation';
import { CRM_PROSPECT_TABS } from '@/lib/crm/tabs';
import type { CrmTimelineEntry } from '@/lib/crm/view';

afterEach(cleanup);

const NOW = Date.parse('2026-08-21T18:00:00.000Z');

function panels() {
  return {
    overview: <p>panneau vue d’ensemble</p>,
    conversation: <p>panneau conversation</p>,
    evidence: <p>panneau preuves</p>,
    analysis: <p>panneau analyse</p>,
    history: <p>panneau dossier</p>,
  } as const;
}

function entry(
  over: Partial<CrmTimelineEntry> & Pick<CrmTimelineEntry, 'id' | 'kind'>,
): CrmTimelineEntry {
  return {
    direction: 'system',
    occurredAt: '2026-08-21T12:00:00.000Z',
    channel: null,
    title: 'titre',
    body: null,
    facts: [],
    ...over,
  } as CrmTimelineEntry;
}

describe('barre d’onglets', () => {
  it('rend les cinq onglets, et un seul panneau à la fois', () => {
    render(<ProspectTabs panels={panels()} />);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('s’ouvre sur la vue d’ensemble', () => {
    render(<ProspectTabs panels={panels()} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/vue d’ensemble/i);
    expect(screen.getByRole('tabpanel').textContent).toContain('panneau vue d’ensemble');
  });

  it('change réellement de panneau au clic', () => {
    render(<ProspectTabs panels={panels()} />);
    fireEvent.click(screen.getByRole('tab', { name: /preuves/i }));
    expect(screen.getByRole('tabpanel').textContent).toContain('panneau preuves');
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/preuves/i);
    // Le panneau précédent existe toujours — il est seulement masqué, ce qui
    // préserve le défilement de la conversation quand on y revient.
    const overview = document.querySelector('#crm-panel-overview');
    expect(overview).not.toBeNull();
    expect((overview as HTMLElement).hidden).toBe(true);
  });

  it('atteint chacun des cinq panneaux', () => {
    render(<ProspectTabs panels={panels()} />);
    for (const tab of CRM_PROSPECT_TABS) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(tab.short, 'i') }));
      expect(screen.getByRole('tabpanel').getAttribute('id')).toBe(`crm-panel-${tab.id}`);
    }
  });

  it('se pilote au clavier, en emmenant le focus avec lui', () => {
    render(<ProspectTabs panels={panels()} />);
    const first = screen.getByRole('tab', { selected: true });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('crm-panel-conversation');
    expect(document.activeElement?.getAttribute('id')).toBe('crm-tab-conversation');

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('crm-panel-history');

    // La flèche droite depuis le dernier onglet revient au premier.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('crm-panel-overview');
  });

  it('ne garde qu’un seul onglet dans l’ordre de tabulation', () => {
    render(<ProspectTabs panels={panels()} />);
    const focusable = screen.getAllByRole('tab').filter((tab) => tab.getAttribute('tabindex') === '0');
    expect(focusable).toHaveLength(1);
  });
});

describe('bulles de conversation', () => {
  it('nomme les deux interlocuteurs et les distingue par le côté', () => {
    const conversation = buildConversation([
      entry({
        id: 'outreach:1',
        kind: 'outbound_sent',
        body: 'Bonjour ! J’ai repéré votre activité.',
        channel: 'instagram_dm',
      }),
      entry({
        id: 'inbound:1',
        kind: 'inbound_reply',
        body: 'Oui avec plaisir, je suis dispo.',
        channel: 'instagram_dm',
        occurredAt: '2026-08-21T12:30:00.000Z',
      }),
    ]);

    render(
      <ConversationThread conversation={conversation} prospectName="Atelier Auto 33" now={NOW} />,
    );

    const messages = document.querySelectorAll('.crm-msg');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.getAttribute('data-side')).toBe('hermes');
    expect(messages[1]?.getAttribute('data-side')).toBe('prospect');

    expect(within(messages[0] as HTMLElement).getByText('Hermes (vous)')).toBeTruthy();
    expect(within(messages[1] as HTMLElement).getByText('Atelier Auto 33')).toBeTruthy();
    expect(screen.getByText('Oui avec plaisir, je suis dispo.')).toBeTruthy();
  });

  it('affiche le canal et la provenance réels du message', () => {
    render(
      <MessageBubble
        entry={{
          id: 'inbound:1',
          side: 'prospect',
          status: 'received',
          origin: null,
          kind: 'inbound_reply',
          occurredAt: '2026-08-21T12:30:00.000Z',
          channel: 'instagram_dm',
          body: 'Principalement mon site internet',
          facts: ['de @demo_account_17', 'corrélation HIGH_CONFIDENCE'],
        }}
        prospectName="Atelier Auto 33"
      />,
    );
    expect(screen.getByText('Instagram')).toBeTruthy();
    expect(screen.getByText('corrélation HIGH_CONFIDENCE')).toBeTruthy();
    expect(screen.getByText('reçu')).toBeTruthy();
  });

  it('HERMES-CONVERSATION-R2 §29 — une intention autonome se lit « Hermes (auto) »', () => {
    render(
      <MessageBubble
        entry={{
          id: 'plan:1',
          side: 'hermes',
          status: 'draft',
          origin: 'machine',
          kind: 'conversation_plan',
          occurredAt: '2026-08-21T12:35:00.000Z',
          channel: 'instagram_dm',
          body: 'Et ça vous ramène des demandes régulièrement ?',
          facts: ['décision AUTO_REPLY_ELIGIBLE', 'politique hermes-conversation-r2'],
        }}
        prospectName="Atelier Auto 33"
      />,
    );
    // Le texte dit d'où il vient, et il ne prétend pas qu'un humain l'a écrit.
    expect(screen.getByText('Hermes (auto)')).toBeTruthy();
    expect(screen.queryByText('Hermes (vous)')).toBeNull();
    expect(screen.getByText('politique hermes-conversation-r2')).toBeTruthy();
  });

  it('un brouillon relu par un humain reste « Hermes (vous) »', () => {
    render(
      <MessageBubble
        entry={{
          id: 'draft:2',
          side: 'hermes',
          status: 'draft',
          origin: 'human_reviewed',
          kind: 'reply_draft',
          occurredAt: '2026-08-21T12:35:00.000Z',
          channel: null,
          body: 'Réponse proposée',
          facts: [],
        }}
        prospectName="Atelier Auto 33"
      />,
    );
    expect(screen.getByText('Hermes (vous)')).toBeTruthy();
  });

  it('marque un brouillon comme jamais envoyé', () => {
    render(
      <MessageBubble
        entry={{
          id: 'draft:1',
          side: 'hermes',
          status: 'draft',
          origin: 'human_reviewed',
          kind: 'reply_draft',
          occurredAt: '2026-08-21T12:30:00.000Z',
          channel: null,
          body: 'Et ça vous apporte déjà des demandes ?',
          facts: ['statut APPROVED'],
        }}
        prospectName="Atelier Auto 33"
      />,
    );
    expect(screen.getByText('brouillon — jamais envoyé')).toBeTruthy();
    expect(document.querySelector('.crm-msg')?.getAttribute('data-status')).toBe('draft');
  });

  it('dit qu’un fil vide est vide, sans fabriquer de message', () => {
    render(
      <ConversationThread
        conversation={buildConversation([])}
        prospectName="Atelier Auto 33"
        now={NOW}
      />,
    );
    expect(screen.getByText('Aucun message pour le moment')).toBeTruthy();
    expect(document.querySelectorAll('.crm-msg')).toHaveLength(0);
  });

  it('encaisse un fil très long sans perdre son conteneur défilant', () => {
    const many: CrmTimelineEntry[] = [];
    for (let index = 0; index < 300; index += 1) {
      many.push(
        entry({
          id: `msg:${index}`,
          kind: index % 2 === 0 ? 'outbound_sent' : 'inbound_reply',
          body: `message ${index}`,
          channel: 'instagram_dm',
          occurredAt: new Date(Date.UTC(2026, 7, 21, 0, index)).toISOString(),
        }),
      );
    }
    render(
      <ConversationThread
        conversation={buildConversation(many)}
        prospectName="Atelier Auto 33"
        now={NOW}
      />,
    );
    expect(document.querySelectorAll('.crm-msg')).toHaveLength(300);
    // Le fil reste DANS son conteneur borné : c'est lui qui défile, pas la page.
    expect(document.querySelector('.crm-thread.crm-scroll')).not.toBeNull();
  });

  it('n’expose AUCUN moyen d’envoyer un message', () => {
    const conversation = buildConversation([
      entry({ id: 'outreach:1', kind: 'outbound_sent', body: 'Bonjour', channel: 'instagram_dm' }),
      entry({ id: 'inbound:1', kind: 'inbound_reply', body: 'Oui', channel: 'instagram_dm' }),
    ]);
    const { container } = render(
      <ConversationThread conversation={conversation} prospectName="Atelier Auto 33" now={NOW} />,
    );

    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByText(/Lecture seule/)).toBeTruthy();
  });
});
