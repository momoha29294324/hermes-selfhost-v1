'use client';

/**
 * La barre d'onglets de la fiche — le seul composant client du CRM.
 *
 * Le CRM reste rendu par le serveur : les cinq panneaux arrivent ICI DÉJÀ
 * RENDUS, en `children`. Ce composant ne connaît donc aucune donnée prospect,
 * ne refait aucune requête, et changer d'onglet ne provoque aucun aller-retour
 * réseau — la fiche est chargée une fois, entièrement, et l'onglet ne fait que
 * choisir ce qui est visible.
 *
 * Les panneaux inactifs restent dans le DOM, marqués `hidden` : c'est ce qui
 * préserve la position de défilement de la conversation quand on va vérifier
 * une preuve et qu'on revient. `hidden` les retire de l'arbre d'accessibilité,
 * donc un lecteur d'écran ne lit jamais deux panneaux à la fois.
 *
 * Le clavier suit le motif ARIA des onglets : flèches pour se déplacer, Début
 * et Fin pour les extrémités, et un seul onglet dans l'ordre de tabulation.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/app/crm/icons';
import {
  CRM_PROSPECT_DEFAULT_TAB,
  CRM_PROSPECT_TABS,
  type CrmProspectTabId,
} from '@/lib/crm/tabs';

export const TAB_ICON: Readonly<Record<CrmProspectTabId, IconName>> = Object.freeze({
  overview: 'board',
  conversation: 'message',
  evidence: 'layers',
  analysis: 'sparkle',
  history: 'file',
});

/**
 * De quoi changer d'onglet depuis l'INTÉRIEUR d'un panneau.
 *
 * La vue d'ensemble ne montre que les faits récents et renvoie vers le panneau
 * complet — « voir toute l'activité ». Sans ce contexte, ce renvoi serait une
 * ancre morte ou un rechargement de page ; avec lui, c'est le même geste que
 * cliquer l'onglet.
 *
 * Le défaut est une fonction vide : un panneau rendu hors de la barre
 * d'onglets (dans un test, par exemple) ne doit pas lever.
 */
const TabSwitch = createContext<(id: CrmProspectTabId) => void>(() => {});

/** Un renvoi vers un autre onglet, rendu comme un bouton parce que c'en est un. */
export function TabLink({ to, children }: { to: CrmProspectTabId; children: React.ReactNode }) {
  const switchTo = useContext(TabSwitch);
  return (
    <button type="button" className="crm-tablink" onClick={() => switchTo(to)}>
      {children}
      <Icon name="arrow-right" size={13} />
    </button>
  );
}

export interface ProspectTabsProps {
  readonly panels: Readonly<Record<CrmProspectTabId, React.ReactNode>>;
}

export function ProspectTabs({ panels }: ProspectTabsProps) {
  const [active, setActive] = useState<CrmProspectTabId>(CRM_PROSPECT_DEFAULT_TAB);
  const list = useRef<HTMLDivElement | null>(null);
  const switchTo = useMemo(() => (id: CrmProspectTabId) => setActive(id), []);

  /**
   * Le déplacement au clavier déplace AUSSI le focus, sans quoi la flèche
   * changerait le panneau sous un focus resté en arrière — et la touche
   * suivante repartirait du mauvais onglet.
   */
  const move = useCallback((index: number) => {
    const count = CRM_PROSPECT_TABS.length;
    const target = CRM_PROSPECT_TABS[((index % count) + count) % count];
    if (target === undefined) return;
    setActive(target.id);
    const node = list.current?.querySelector<HTMLButtonElement>(`#crm-tab-${target.id}`);
    node?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        move(index + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        move(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        move(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        move(CRM_PROSPECT_TABS.length - 1);
      }
    },
    [move],
  );

  return (
    <TabSwitch.Provider value={switchTo}>
      <div className="crm-tabs" role="tablist" aria-label="Sections de la fiche" ref={list}>
        {CRM_PROSPECT_TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`crm-tab-${tab.id}`}
            type="button"
            role="tab"
            className="crm-tab"
            aria-selected={active === tab.id}
            aria-controls={`crm-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <Icon name={TAB_ICON[tab.id]} size={14} />
            <span className="full">{tab.label}</span>
            <span className="short">{tab.short}</span>
          </button>
        ))}
      </div>

      {CRM_PROSPECT_TABS.map((tab) => (
        <div
          key={tab.id}
          id={`crm-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`crm-tab-${tab.id}`}
          tabIndex={0}
          hidden={active !== tab.id}
          className="crm-panel"
          data-tab={tab.id}
        >
          {panels[tab.id]}
        </div>
      ))}
    </TabSwitch.Provider>
  );
}
