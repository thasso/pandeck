/**
 * Collapse whitespace runs to one space and retain the raw index represented by
 * each normalized character.
 */
export function normalizeWithMap(text: string): {
  text: string;
  map: number[];
} {
  let normalized = "";
  const map: number[] = [];
  let inWhitespace = false;

  for (let index = 0; index < text.length; index += 1) {
    const whitespace = /\s/.test(text[index]!);
    if (whitespace) {
      if (!inWhitespace) {
        normalized += " ";
        map.push(index);
      }
    } else {
      normalized += text[index]!;
      map.push(index);
    }
    inWhitespace = whitespace;
  }

  return { text: normalized, map };
}

/**
 * Find a rendered quote without requiring its whitespace to exactly match the
 * DOM text. Returned offsets address the original, unnormalized haystack and
 * use the usual exclusive end boundary.
 */
export function findQuoteOffsets(
  haystack: string,
  quote: string,
): { start: number; end: number } | null {
  const normalizedHaystack = normalizeWithMap(haystack);
  const normalizedQuote = normalizeWithMap(quote).text;
  if (normalizedQuote.trim().length === 0) return null;

  const normalizedStart = normalizedHaystack.text.indexOf(normalizedQuote);
  if (normalizedStart < 0) return null;
  const normalizedEnd = normalizedStart + normalizedQuote.length;
  return {
    start: normalizedHaystack.map[normalizedStart]!,
    end: normalizedHaystack.map[normalizedEnd - 1]! + 1,
  };
}
