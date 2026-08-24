/**
 * Le jeu d'icônes du CRM — des tracés, pas une dépendance.
 *
 * Une bibliothèque d'icônes coûterait un paquet de plusieurs centaines de
 * kilo-octets pour la vingtaine de glyphes réellement utilisés ici, et
 * la documentation d’installation §11 refuse exactement ce genre de dette. Chaque
 * tracé tient sur une ligne, hérite de `currentColor` et se colore donc par la
 * teinte de son conteneur (`--tone`) sans qu'aucun composant ne nomme une
 * couleur.
 *
 * Le nom est une union fermée : ajouter un genre d'événement de timeline sans
 * lui donner d'icône ne compile pas.
 */

export type IconName =
  | 'users'
  | 'board'
  | 'inbox'
  | 'bell'
  | 'file'
  | 'lock'
  | 'search'
  | 'shield'
  | 'pin'
  | 'globe'
  | 'instagram'
  | 'facebook'
  | 'mail'
  | 'phone'
  | 'message'
  | 'form'
  | 'send'
  | 'check'
  | 'target'
  | 'clock'
  | 'alert'
  | 'sparkle'
  | 'flag'
  | 'arrow-right'
  | 'arrow-left'
  | 'external'
  | 'pencil'
  | 'reply'
  | 'activity'
  | 'gauge'
  | 'bulb'
  | 'question'
  | 'layers'
  | 'ban'
  | 'calendar'
  | 'spark-mark';

/** Les tracés, en 24×24, pensés pour un trait de 1,75 px. */
const PATHS: Readonly<Record<IconName, React.ReactNode>> = Object.freeze({
  users: (
    <>
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
      <circle cx="10" cy="7.5" r="3.5" />
      <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="5.5" height="16" rx="1.8" />
      <rect x="9.5" y="4" width="5.5" height="11" rx="1.8" />
      <rect x="16" y="4" width="5" height="7" rx="1.8" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 12.5h4l1.5 2.5h6l1.5-2.5h4" />
      <path d="M5.6 5h12.8l2.1 7.5v4.9a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6v-4.9z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5" />
      <path d="M10.3 19a2 2 0 0 0 3.4 0" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M13.5 3v5.5H19" />
      <path d="M9 14.5l2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6.2v5.4c0 4 2.9 7.6 7 8.9 4.1-1.3 7-4.9 7-8.9V6.2z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z" />
    </>
  ),
  instagram: (
    <>
      <rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.6" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M16.9 7.1h.01" />
    </>
  ),
  facebook: <path d="M14.5 21v-7.5h2.6l.4-3.2h-3V8.2c0-.9.3-1.6 1.6-1.6h1.6V3.7c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.2v2.5H8.5v3.2h2.8V21" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.4" />
      <path d="m3.6 7 7.3 5.2a2 2 0 0 0 2.2 0L20.4 7" />
    </>
  ),
  phone: <path d="M8.4 3.8h-3a1.9 1.9 0 0 0-1.9 2.1 17 17 0 0 0 14.6 14.6 1.9 1.9 0 0 0 2.1-1.9v-2.9a1.9 1.9 0 0 0-1.6-1.9c-1-.1-2-.4-2.9-.8a1.9 1.9 0 0 0-2 .4l-1.2 1.2a14 14 0 0 1-5.2-5.2l1.2-1.2a1.9 1.9 0 0 0 .4-2 12 12 0 0 1-.8-2.9 1.9 1.9 0 0 0-1.7-1.6z" />,
  message: (
    <>
      <path d="M20.5 11.6a7.9 7.9 0 0 1-8.5 7.9 9 9 0 0 1-3.4-.8L3.5 20.5l1.8-5a7.7 7.7 0 0 1-.8-3.4A7.9 7.9 0 0 1 12.4 3.6a7.9 7.9 0 0 1 8.1 8z" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="2.4" />
      <path d="M8 8.5h8M8 12.5h8M8 16.5h4" />
    </>
  ),
  send: <path d="M20.5 3.5 10 14M20.5 3.5l-6.7 17-3.8-6.5L3.5 10z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  alert: (
    <>
      <path d="M10.6 4.3 2.9 17.5a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.3a1.6 1.6 0 0 0-2.8 0z" />
      <path d="M12 9.5v4M12 17h.01" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z" />
      <path d="M18.5 16.5 19.2 19l2.3.8-2.3.8-.7 2.4" transform="translate(0 -4.5)" />
    </>
  ),
  flag: (
    <>
      <path d="M5.5 21V4.5" />
      <path d="M5.5 5.2h11l-1.8 3.6 1.8 3.6h-11" />
    </>
  ),
  'arrow-right': <path d="M4.5 12h15m-5.5-5.5L19.5 12 14 17.5" />,
  'arrow-left': <path d="M19.5 12h-15m5.5-5.5L4.5 12 10 17.5" />,
  external: (
    <>
      <path d="M13.5 4.5H19.5v6" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 14v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 19.5h4L20 8a2.5 2.5 0 0 0-3.5-3.5L4.5 15.5z" />
      <path d="m14.5 6.5 3.5 3.5" />
    </>
  ),
  reply: (
    <>
      <path d="M9.5 5.5 4 11l5.5 5.5" />
      <path d="M4 11h9.5a6 6 0 0 1 6 6v1.5" />
    </>
  ),
  activity: <path d="M3.5 12h4L10 5.5 14 18.5l2.5-6.5h4" />,
  gauge: (
    <>
      <path d="M4 17a8.5 8.5 0 1 1 16 0" />
      <path d="m12 12.5 4-3.5" />
      <circle cx="12" cy="13.5" r="1.2" />
    </>
  ),
  bulb: (
    <>
      <path d="M9.5 18h5M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9V18h5.2v-2.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3z" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .9-1 1.6v.3M12 16.8h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8.5 4.3L12 12 3.5 7.8z" />
      <path d="m3.5 12.2 8.5 4.3 8.5-4.3" />
      <path d="m3.5 16.4 8.5 4.3 8.5-4.3" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.4" />
      <path d="M3.5 10h17M8 3.5V6.5M16 3.5V6.5" />
    </>
  ),
  'spark-mark': (
    <>
      <path d="M12 2.5 14.2 9l6.3 2.4-6.3 2.4L12 20.5l-2.2-6.7L3.5 11.4 9.8 9z" />
    </>
  ),
});

/**
 * L'identifiant du symbole d'une icône dans la planche.
 *
 * Préfixé, parce que la planche vit dans le document RACINE et cohabite donc
 * avec tout ce que les autres surfaces y mettent : un `id="check"` nu finirait
 * par entrer en collision, et un `<use>` qui pointe vers le mauvais fragment ne
 * lève aucune erreur — il dessine simplement autre chose.
 */
/**
 * Les noms, dérivés des TRACÉS et non recopiés.
 *
 * Une seconde liste écrite à la main finirait par diverger, et le symptôme
 * serait une icône manquante quelque part — pas une erreur de compilation.
 */
const ICON_NAMES: readonly IconName[] = Object.freeze(Object.keys(PATHS) as IconName[]);

/** L'épaisseur de trait pour laquelle les tracés ont été dessinés. */
const DEFAULT_STROKE = 1.75;

function symbolId(name: IconName): string {
  return `crm-i-${name}`;
}

/**
 * La planche d'icônes — les tracés, une seule fois par document.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une planche plutôt que des tracés en ligne
 * ---------------------------------------------------------------------------
 *
 * Une ligne de la table portait cinq icônes, chacune rendue avec ses tracés
 * complets et ses huit attributs. Sur cinquante lignes, cela faisait deux cent
 * cinquante SVG écrits en toutes lettres — DEUX fois, puisque le document porte
 * à la fois le HTML et la charge utile que React inline pour le routeur.
 *
 * Avec la planche, une icône ne coûte plus qu'une référence d'une centaine
 * d'octets. Les tracés, eux, sont écrits une fois pour toute la page.
 *
 * Elle est rendue dans le layout RACINE : les trois surfaces du dépôt (le CRM,
 * la revue, les écrans de calibration) partagent ce jeu d'icônes, et une
 * planche par surface reviendrait à ne rien mutualiser.
 *
 * `display: none` retirerait les symboles du rendu chez certains moteurs ; on
 * masque donc par la taille, la façon dont toutes les planches SVG le font.
 */
export function CrmIconSprite() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        {ICON_NAMES.map((name) => (
          <symbol key={name} id={symbolId(name)} viewBox="0 0 24 24">
            {PATHS[name]}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

/**
 * Une icône : une référence à la planche, et les attributs de TRAIT.
 *
 * `stroke`, `stroke-width`, `stroke-linecap` et `stroke-linejoin` sont des
 * propriétés SVG HÉRITÉES : posées ici, elles traversent le `<use>` et
 * s'appliquent aux tracés du symbole. C'est ce qui permet de garder
 * `strokeWidth` réglable au cas par cas — la marque du rail est à 1,6 — sans
 * dupliquer un symbole par épaisseur.
 *
 * `currentColor` est conservé : une icône prend toujours la teinte de son
 * conteneur (`--tone`), et aucun composant ne nomme de couleur.
 *
 * Les quatre attributs CONSTANTS (`fill`, `stroke`, et les deux terminaisons de
 * trait) sont descendus dans `.crm-icon`. Écrits ici, ils pesaient une centaine
 * d'octets par icône, deux cent dix-huit fois par page, deux fois par document.
 * `strokeWidth` reste un attribut mais n'est écrit que lorsqu'il s'écarte du
 * défaut — c'est-à-dire une fois dans tout le CRM.
 */
export function Icon({
  name,
  size = 16,
  strokeWidth = DEFAULT_STROKE,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      className="crm-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...(strokeWidth === DEFAULT_STROKE ? {} : { strokeWidth })}
    >
      <use href={`#${symbolId(name)}`} />
    </svg>
  );
}
