/**
 * IG2/IG2.1 — les sélecteurs du DOM Instagram, en un seul endroit.
 *
 * Extraits de `playwrightLiveRail.ts` pour que le rail d'ADJUDICATION ouvre la
 * conversation par exactement le même chemin que le canari l'a ouverte. Deux
 * listes parallèles auraient dérivé, et l'adjudication aurait fini par examiner
 * une autre page que celle où le clic a eu lieu.
 *
 * Ce qui est délibéré dans ce découpage : `SEND_CONTROL_SELECTORS` est le SEUL
 * groupe dont un clic produit un effet. Il vit ici avec les autres, mais un
 * test vérifie qu'aucun module d'adjudication ne le nomme — l'import est la
 * frontière, et elle est vérifiable par `grep`.
 */

/** Le bouton « Message » d'une page de profil, en français et en anglais. */
export const MESSAGE_BUTTON_SELECTORS: readonly string[] = [
  'div[role="button"]:text-is("Envoyer un message")',
  'button:text-is("Envoyer un message")',
  'div[role="button"]:text-is("Message")',
  'button:text-is("Message")',
];

/**
 * Le détour des comptes PROFESSIONNELS : pas de « Message », mais « Contacter »,
 * qui ouvre un panneau de discussion DANS la page de profil.
 */
export const CONTACT_BUTTON_SELECTORS: readonly string[] = [
  'div[role="button"]:text-is("Contacter")',
  'button:text-is("Contacter")',
  'div[role="button"]:text-is("Contact")',
  'button:text-is("Contact")',
];

/** L'entrée « message » du menu de contact, et elle seule — jamais « Appeler » ni « e-mail ». */
export const CONTACT_MENU_MESSAGE_SELECTORS: readonly string[] = [
  'div[role="dialog"] div[role="button"]:text-is("Envoyer un message")',
  'div[role="dialog"] button:text-is("Envoyer un message")',
  'div[role="dialog"] div[role="button"]:text-is("Message")',
  'div[role="dialog"] button:text-is("Message")',
  'div[role="dialog"] div[role="button"]:text-is("Send message")',
  'div[role="dialog"] button:text-is("Send message")',
];

/** Le champ de saisie d'un fil de discussion. */
export const COMPOSER_SELECTORS: readonly string[] = [
  'div[role="textbox"][contenteditable="true"]',
  'textarea[placeholder]',
  'div[contenteditable="true"][aria-label]',
];

/**
 * Le contrôle d'envoi. Le seul groupe de ce fichier dont un clic touche un
 * prospect — nommé ici pour être trouvable, importé nulle part ailleurs que par
 * la primitive d'envoi.
 */
export const SEND_CONTROL_SELECTORS: readonly string[] = [
  'div[role="button"][aria-label="Envoyer"]',
  'div[role="button"][aria-label="Send"]',
  'button[aria-label="Envoyer"]',
  'button[aria-label="Send"]',
  'div[role="button"]:text-is("Envoyer")',
  'div[role="button"]:text-is("Send")',
  'button:text-is("Envoyer")',
  'button:text-is("Send")',
];
