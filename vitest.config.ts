import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` n'existe que pour faire échouer un import depuis un
      // Client Component ; hors bundler React il lève à l'import, ce qui
      // rendrait intestable toute couche de lecture qui s'en protège
      // (`src/lib/crm/queries.ts`, `src/lib/dashboard/queries.ts`).
      // Le neutraliser SOUS VITEST ne relâche rien : la garde reste active là
      // où elle sert, c'est-à-dire au build Next.
      'server-only': fileURLToPath(new URL('./tests/support/serverOnlyStub.ts', import.meta.url)),
    },
  },
  // Les tests de composants sont écrits en TSX ; le transformateur doit donc
  // produire du JSX exécutable, là où `tsconfig.json` le laisse tel quel pour
  // que Next le compile lui-même.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    /**
     * La suite tourne sur la configuration d'EXEMPLE, jamais sur celle d'une
     * instance en service.
     *
     * `config/icp/example-icp.json` est synthétique et versionné : les tests
     * ont donc toujours une forme valide à charger, sans qu'aucun ICP réel ne
     * soit nécessaire. Une instance fraîche, elle, n'a pas cette variable —
     * `OUTBOUND_ICP_PROFILE` est absente de `.env.example` — et son état ICP
     * reste UNCONFIGURED tant que l'opérateur n'a pas construit le sien.
     */
    env: {
      OUTBOUND_ICP_PROFILE: 'example-icp',
    },
    // `node` reste le défaut : la quasi-totalité de la suite teste des
    // fonctions pures et n'a aucun besoin d'un DOM, qui ne ferait que la
    // ralentir. Les rares fichiers qui rendent un composant demandent
    // `jsdom` eux-mêmes, par un commentaire `@vitest-environment` en tête.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
