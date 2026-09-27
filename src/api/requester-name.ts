/**
 * Nombre del que pide ("requestedBy"): el DJ lo puede nombrar en el aire.
 *
 * La radio sanitiza el `name` con: solo letras (unicode: latin/cirílico/griego/
 * árabe/heb/deva/gurmu/han/kana/hangul/thai), dígitos Nd, espacios y -_.' ;
 * recorta a 40 y trim. Replicamos la regla acá para maximizar que el nombre
 * sobreviva en vez de quedar "anon" ganador. Si al final queda vacío → anónimo.
 */
const DISALLOWED = /[^\p{sc=Latin}\p{sc=Cyrillic}\p{sc=Greek}\p{sc=Arabic}\p{sc=Hebrew}\p{sc=Devanagari}\p{sc=Gurmukhi}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{Nd}\s\-_.']/gu;

export const REQUESTER_NAME_MAX = 40;

export function cleanRequesterName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(DISALLOWED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REQUESTER_NAME_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
