/**
 * CONVERSATION-R1 — normaliser AVANT de reconnaître.
 *
 * Ce fichier existe à cause d'un défaut que les tests ont attrapé et qu'aucune
 * relecture n'aurait vu : « j'ai déjà quelqu'un » et « j’ai déjà quelqu’un »
 * sont le même message pour un lecteur humain, et deux chaînes différentes pour
 * une expression régulière. Or les claviers réels — iOS, Word, Instagram sur
 * mobile — produisent l'apostrophe typographique U+2019, tandis qu'un lexique
 * écrit dans un fichier source porte l'apostrophe droite U+0027.
 *
 * Sans cette normalisation, TOUTE la détection de sujets marchait sur les
 * textes de test rédigés au clavier droit et échouait en silence sur les vrais
 * messages — c'est-à-dire exactement à l'envers de ce qu'on veut. Un échec
 * silencieux, en plus : l'objection tombait dans `OTHER_OBJECTION`, une valeur
 * plausible, donc personne n'aurait rien remarqué.
 *
 * On normalise la FORME, jamais le fond : aucune lettre n'est retirée, aucun
 * accent n'est écrasé, aucune casse n'est forcée ici. Le texte reste celui de
 * la personne ; seules les variantes typographiques d'un même signe convergent.
 */

/**
 * Ramène les variantes d'apostrophes, guillemets et espaces à une forme unique.
 *
 * Volontairement minimal. Écraser les accents ferait matcher « cout » sur
 * « coût », mais aussi « a » sur « à » — et le lexique deviendrait alors une
 * source de faux positifs qu'on ne saurait plus expliquer.
 */
export function normalizeForMatching(text: string): string {
  return text
    // Apostrophes : U+2019 (typographique), U+02BC, U+2018, accent grave utilisé
    // comme apostrophe par certains claviers.
    .replace(/[’ʼ‘`´]/g, "'")
    // Guillemets doubles typographiques.
    .replace(/[“”„]/g, '"')
    // Tirets longs employés comme traits d'union.
    .replace(/[–—]/g, '-')
    // Espaces insécables et fines, qui coupent les mots composés.
    .replace(/[   ]/g, ' ');
}
