'use client';

import Link from 'next/link';
import { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Icon, type IconName } from '@/app/crm/icons';
import { LEGACY_REVIEW_HOME } from '@/lib/crm/routes';

export interface NavCounts {
  readonly prospects: number | null;
  readonly pipeline: number | null;
  readonly inbox: number | null;
  readonly alerts: number | null;
}

const ENTRIES: readonly {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly key: keyof NavCounts;
  readonly shortcut: string;
}[] = [
  { href: '/crm/prospects', label: 'Prospects', icon: 'users', key: 'prospects', shortcut: 'p' },
  { href: '/crm/pipeline', label: 'Pipeline', icon: 'board', key: 'pipeline', shortcut: 'k' },
  { href: '/crm/inbox', label: 'Inbox', icon: 'inbox', key: 'inbox', shortcut: 'i' },
  { href: '/crm/alerts', label: 'Alertes', icon: 'bell', key: 'alerts', shortcut: 'a' },
];

/**
 * Le rail de navigation, et les seuls raccourcis globaux du CRM.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi `Link` et non `<a>` — la correction la plus rentable de CRM-UX-R1
 * ---------------------------------------------------------------------------
 *
 * Ce rail portait des ancres nues. Chaque clic était donc un CHARGEMENT DE
 * DOCUMENT : le navigateur jetait la page, retéléchargeait le HTML entier,
 * réévaluait le JavaScript, et remontait la coquille — rail compris — avant de
 * peindre quoi que ce soit. Sur `/crm/prospects`, dont le document pesait plus
 * de deux mégaoctets, cela se voyait à l’œil nu.
 *
 * `Link` fait une navigation cliente : seul le segment sous la coquille est
 * refait, et le rail n’est jamais démonté.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi `prefetch={false}` — mesuré, pas supposé
 * ---------------------------------------------------------------------------
 *
 * Le préchargement est le réflexe, et il est ici du gaspillage pur. Les six
 * routes du rail sont toutes `force-dynamic` : elles lisent la base à chaque
 * requête, donc le routeur ne met JAMAIS leur charge utile en cache côté
 * client. Observé au navigateur, en production : le rail déclenchait onze
 * requêtes de préchargement au chargement d’une page — dont `/revue`, le
 * tableau de bord historique — et chaque clic refaisait quand même sa propre
 * requête. Six rendus serveur et six lectures de base, pour rien.
 *
 * Ce n’est pas un compromis sur la fraîcheur : c’est le contraire. Une route
 * préchargée qui SERAIT réutilisée afficherait l’état de la base au moment du
 * survol, pas au moment du clic. Le CRM doit dire ce qui est vrai maintenant.
 *
 * ---------------------------------------------------------------------------
 * Le retour visuel ne doit RIEN attendre
 * ---------------------------------------------------------------------------
 *
 * `usePathname` ne change qu’une fois la navigation validée — c’est-à-dire
 * après le serveur. S’y fier seul rendrait le rail muet pendant tout le
 * trajet, exactement au moment où l’opérateur se demande si son clic a été
 * pris. L’entrée cliquée est donc marquée ACTIVE tout de suite
 * (`onNavigate`, qui ne se déclenche que sur une navigation cliente), et
 * `useLinkStatus` allume en plus un fil de progression sur la ligne tant que
 * la route n’a pas répondu.
 *
 * Rien de tout cela ne masque une latence : la barre dit « c'est parti », elle
 * ne prétend pas que c’est arrivé. Quand la route répond, `usePathname`
 * reprend la main et la marque optimiste s’efface.
 *
 * Client uniquement pour trois raisons, toutes impossibles cote serveur :
 * connaître la route courante, écouter le clavier, et savoir qu’une navigation
 * est en cours.
 */
export function CrmNav({ counts }: { counts: NavCounts }) {
  const pathname = usePathname();
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  // La marque optimiste ne survit pas à l’arrivée : dès que la route courante
  // est celle qu’on visait, c’est `pathname` qui décide de nouveau. Sans cette
  // remise à zéro, un retour navigateur laisserait deux entrées allumées.
  useEffect(() => {
    if (target !== null && pathname?.startsWith(target) === true) setTarget(null);
  }, [pathname, target]);

  const isActive = useCallback(
    (href: string): boolean =>
      target === null ? (pathname?.startsWith(href) ?? false) : target === href,
    [pathname, target],
  );

  useEffect(() => {
    let pendingG = false;
    let pendingGAt = 0;

    function isTyping(node: EventTarget | null): boolean {
      if (!(node instanceof HTMLElement)) return false;
      return (
        node.tagName === 'INPUT' ||
        node.tagName === 'TEXTAREA' ||
        node.tagName === 'SELECT' ||
        node.isContentEditable
      );
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape' && isTyping(event.target)) {
        (event.target as HTMLElement).blur();
        return;
      }
      if (isTyping(event.target)) return;

      if (event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('input[data-crm-search]');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }

      // `g` puis une lettre, dans la seconde. Au-delà, la séquence expire —
      // sinon un `g` oublie detournerait une frappe cinq minutes plus tard.
      if (pendingG && Date.now() - pendingGAt < 1000) {
        pendingG = false;
        const entry = ENTRIES.find((candidate) => candidate.shortcut === event.key);
        if (entry !== undefined) {
          event.preventDefault();
          // `router.push` et non `location.assign` : le raccourci clavier doit
          // coûter exactement ce que coûte le clic, pas un rechargement.
          setTarget(entry.href);
          router.push(entry.href);
        }
        return;
      }

      if (event.key === 'g') {
        pendingG = true;
        pendingGAt = Date.now();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

  return (
    <nav className="crm-rail">
      <div className="crm-rail-brand">
        <span className="crm-rail-mark">
          <Icon name="spark-mark" size={17} strokeWidth={1.6} />
        </span>
        <span>
          <b>Hermes CRM</b>
          <small>atelier · France</small>
        </span>
      </div>

      <div className="crm-rail-group">Commercial</div>
      {ENTRIES.map((entry) => (
        <Link
          key={entry.href}
          href={entry.href}
          className={isActive(entry.href) ? 'active' : ''}
          aria-current={isActive(entry.href) ? 'page' : undefined}
          onNavigate={() => setTarget(entry.href)}
          prefetch={false}
        >
          <Icon name={entry.icon} size={16} />
          <span className="l">{entry.label}</span>
          {counts[entry.key] === null ? null : <span className="count">{counts[entry.key]}</span>}
          <NavPending />
        </Link>
      ))}

      <div className="crm-rail-group">Atelier</div>
      <Link href={LEGACY_REVIEW_HOME} prefetch={false}>
        <Icon name="file" size={16} />
        <span className="l">Revue des brouillons</span>
        <NavPending />
      </Link>
      <Link href="/pilot/r6b-dispatch" prefetch={false}>
        <Icon name="lock" size={16} />
        <span className="l">Manifestes</span>
        <NavPending />
      </Link>

      <div className="crm-rail-foot">
        <div className="t">
          <Icon name="shield" size={14} />
          Lecture seule
        </div>
        Aucun envoi ne part d’ici.
        <div className="keys">
          <span className="crm-kbd">/</span>
          <span className="crm-kbd">j</span>
          <span className="crm-kbd">k</span>
          <span className="crm-kbd">g p</span>
          <span className="crm-kbd">g k</span>
          <span className="crm-kbd">g i</span>
        </div>
      </div>
    </nav>
  );
}

/**
 * Le fil de progression d’une entrée du rail.
 *
 * `useLinkStatus` exige d’être appelé SOUS un `Link` — d’où ce composant d’une
 * ligne plutôt qu’un booléen passé en propriété. L’élément est toujours rendu
 * et seule son opacité change : un indicateur qui apparaît pousserait le
 * libellé d’un pixel à chaque clic, ce qui est précisément le tremblement
 * qu’on cherche à éviter.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  return <i className="crm-rail-pending" data-pending={pending ? 'yes' : 'no'} aria-hidden="true" />;
}
