import type { NextConfig } from 'next';
import { CRM_HOME, LEGACY_REVIEW_HOME } from './src/lib/crm/routes';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PGlite ships a WASM build that must stay outside the bundler.
  serverExternalPackages: ['@electric-sql/pglite'],
  typedRoutes: false,

  /**
   * La racine ouvre sur le CRM, pas sur l'atelier de revue.
   *
   * Une redirection de configuration plutôt qu'une page : « redirects are
   * checked before the filesystem », donc `/` ne compile ni ne rend rien avant
   * de partir vers le CRM. Une `page.tsx` qui n'appellerait que `redirect()`
   * ferait le même travail en payant en plus une compilation en dev et un
   * rendu React en production.
   *
   * 307 et non 308 : un 308 est mis en cache par le navigateur SANS date de
   * péremption. Si la porte d'entrée du CRM change un jour, un opérateur qui a
   * ouvert cette page une fois resterait renvoyé vers l'ancienne adresse par
   * son propre navigateur, sans qu'aucun déploiement puisse l'en défaire.
   *
   * L'atelier n'est pas supprimé — il vit à `LEGACY_REVIEW_HOME` — et cette
   * constante est importée plutôt que recopiée : la redirection et le rail de
   * navigation lisent la même valeur, donc ne peuvent pas diverger.
   */
  redirects() {
    return Promise.resolve([
      { source: '/', destination: CRM_HOME, permanent: false },
      // L'ancienne adresse de l'atelier, conservée pour les liens déjà écrits
      // ailleurs (documents, signets). Elle ne repasse jamais par la racine.
      { source: '/review', destination: LEGACY_REVIEW_HOME, permanent: false },
    ]);
  },
};

export default nextConfig;
