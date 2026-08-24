import type { Metadata } from 'next';
import { CrmIconSprite } from '@/app/crm/icons';
import './globals.css';

/**
 * Racine minimale : `<html>`, `<body>`, la feuille de style globale.
 *
 * La planche d'icônes est le seul contenu que la racine porte elle-même : les
 * trois surfaces du dépôt partagent le même jeu de tracés, et les écrire une
 * fois par document plutôt qu'une fois par icône est ce qui a fait tomber la
 * liste des prospects sous les trois cents kilo-octets.
 *
 * La coquille visuelle vit un cran plus bas, dans les layouts de groupe —
 * `(review)` porte la revue humaine (colonne centrée, bandeau de sûreté),
 * `crm` porte l'interface opérateur (rail de navigation, pleine hauteur).
 * Les deux ne peuvent pas partager le même cadre : l'une est un document,
 * l'autre une application.
 */
export const metadata: Metadata = {
  title: 'Hermes',
  description: 'SDR IA atelier automobile — revue humaine avant tout envoi.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <CrmIconSprite />
        {children}
      </body>
    </html>
  );
}
