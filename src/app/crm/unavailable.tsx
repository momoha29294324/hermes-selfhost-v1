import { EmptyState } from '@/app/crm/ui';

/**
 * Ce que le CRM affiche quand il ne peut pas lire la base.
 *
 * La cause est presque toujours la même et elle est structurelle : PGlite est
 * une base embarquée dont un seul processus peut détenir le datadir
 * (`src/lib/db/pgliteDatadirLock.ts`). Un `campaign:run` ou un `r6b:*` en cours
 * ferme donc la porte au serveur web, et réciproquement.
 *
 * L'écran nomme la cause plutôt que d'afficher « une erreur est survenue » : la
 * correction est immédiate quand on la connaît, et impossible à deviner sinon.
 * Il la nomme en revanche comme un ÉTAT — « un autre traitement lit la base » —
 * et non comme une commande à taper : une interface produit décrit ce qui se
 * passe, elle ne dicte pas un shell (CRM1.1 §3). Le message brut du moteur
 * reste affiché, parce que c'est un fait de diagnostic, pas une instruction.
 */
export function CrmUnavailable({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const locked = message.includes('datadir');

  return (
    <div className="crm-body">
      <EmptyState icon="alert" tone="orange" title="Base indisponible">
        {locked
          ? 'La base embarquée n’accepte qu’un seul processus à la fois, et un autre traitement de ce dépôt la détient actuellement. L’écran redevient lisible dès qu’il se termine.'
          : 'La lecture de la base a échoué.'}
        <span className="crm-mono">{message}</span>
      </EmptyState>
    </div>
  );
}
