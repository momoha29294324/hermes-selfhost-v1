import { createHash } from 'node:crypto';

/**
 * sha256 hexadécimal d'un texte, en UTF-8.
 *
 * Vit ici plutôt que dans `r6bDispatch.ts` parce que deux modules distincts en
 * dépendent désormais — l'empreinte du texte approuvé (`approved_text_sha256`)
 * et celle du payload transport (`transport_payload_sha256`, R6B-C.2A) — et
 * qu'une seconde définition ferait exister deux façons de calculer ce qui doit
 * rester une seule et même empreinte.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
