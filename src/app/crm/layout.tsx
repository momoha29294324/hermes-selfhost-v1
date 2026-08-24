import type { Metadata } from 'next';
import { loadCrmOverview } from '@/lib/crm/queries';
import { CrmNav, type NavCounts } from '@/app/crm/nav';
import './crm.css';

export const metadata: Metadata = {
  title: 'Hermes CRM',
  description: 'Interface opérateur du pipeline commercial Hermes.',
};

export const dynamic = 'force-dynamic';

const NO_COUNTS: NavCounts = { prospects: null, pipeline: null, inbox: null, alerts: null };

/**
 * La coquille du CRM : rail fixe, une seule zone défilante.
 *
 * Les compteurs du rail sont chargés ici, et leur échec ne fait pas tomber
 * l'application : la base embarquée n'accepte qu'un processus à la fois
 * (`pgliteDatadirLock`), donc un run de campagne en cours doit dégrader la
 * navigation, pas l'effacer. Chaque page dit ensuite elle-même ce qu'elle n'a
 * pas pu lire.
 */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  let counts: NavCounts = NO_COUNTS;
  try {
    const overview = await loadCrmOverview();
    counts = {
      prospects: overview.prospects,
      pipeline: overview.inPipeline,
      inbox: overview.replies,
      alerts: overview.alertsOpen,
    };
  } catch {
    counts = NO_COUNTS;
  }

  return (
    <div className="crm">
      <CrmNav counts={counts} />
      <main className="crm-main">{children}</main>
    </div>
  );
}
