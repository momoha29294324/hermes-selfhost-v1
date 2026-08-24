'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * La navigation d'une liste : au clavier, et à la souris sur la ligne ENTIÈRE.
 *
 * Composant sans rendu, monté à côté de la table. Il opère sur le DOM déjà
 * produit par le serveur (`tr[data-href]`) plutôt que de rendre la table
 * cliente : la table reste un Server Component, il n'y a rien à hydrater, et ce
 * fichier n'a aucune connaissance des colonnes.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le clic de ligne est ici, et non en CSS
 * ---------------------------------------------------------------------------
 *
 * La cible cliquable d'une ligne, c'était le NOM : douze caractères dans une
 * ligne de quinze cents pixels de large. Le réflexe est d'étendre le lien par un
 * calque absolu (`::after { inset: 0 }`) sur une ligne en `position: relative` —
 * et cela ne marche pas : un `<tr>` n'est pas un bloc conteneur fiable pour un
 * descendant absolu. Mesuré au navigateur : le clic au milieu de la ligne ne
 * déclenchait rien.
 *
 * Un gestionnaire délégué le fait, et fait mieux — il peut distinguer les cas
 * où l'opérateur voulait autre chose :
 *
 *   — un clic sur un lien ou un bouton DANS la ligne (le site du prospect, son
 *     compte Instagram) garde son propre effet ;
 *   — `⌘`/`Ctrl`/`Maj` et le clic du milieu sont laissés au navigateur, donc
 *     « ouvrir dans un nouvel onglet » continue de marcher ;
 *   — une SÉLECTION de texte en cours n'ouvre pas la fiche : on lisait une
 *     adresse, on ne cliquait pas.
 *
 * Le nom reste un vrai `<a>` : c'est lui qui porte l'accessibilité, le menu
 * contextuel et le survol. Ce gestionnaire n'est qu'un raccourci de confort
 * par-dessus.
 *
 * `Entrée` et le clic passent tous deux par le ROUTEUR, jamais par
 * `location.assign` : ouvrir une fiche doit coûter une navigation cliente, pas
 * le rechargement complet du document que la version précédente déclenchait.
 */
export function RowNav() {
  const router = useRouter();

  useEffect(() => {
    let index = -1;

    function rows(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('tr[data-href]'));
    }

    function paint(list: HTMLElement[]): void {
      list.forEach((row, i) => row.classList.toggle('is-active', i === index));
      const current = list[index];
      if (current) current.scrollIntoView({ block: 'nearest' });
    }

    function isTyping(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const list = rows();
      if (list.length === 0) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        index = Math.min(list.length - 1, index + 1);
        paint(list);
        return;
      }
      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = Math.max(0, index - 1);
        paint(list);
        return;
      }
      if (event.key === 'Enter') {
        const current = list[index];
        const href = current?.dataset['href'];
        if (href) {
          event.preventDefault();
          router.push(href);
        }
      }
    }

    function onClick(event: MouseEvent): void {
      // Bouton principal seulement, et sans modificateur : tout le reste
      // appartient au navigateur (nouvel onglet, nouvelle fenêtre).
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Ce qui est déjà interactif garde son effet.
      if (target.closest('a, button, input, select, textarea, summary, [role="button"]')) return;
      const row = target.closest<HTMLElement>('tr[data-href]');
      const href = row?.dataset['href'];
      if (href === undefined) return;
      // On lisait, on ne cliquait pas.
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;

      event.preventDefault();
      const list = rows();
      index = list.indexOf(row as HTMLElement);
      paint(list);
      router.push(href);
    }

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick);
    };
  }, [router]);

  return null;
}
