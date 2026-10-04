/** A bounded text hint. Plain labels/commands must not be parsed as Markdown. */
export function activityPreview(
  text: string,
  format: "markdown" | "text" = "markdown",
): string {
  let plain = text.slice(0, 2048);
  if (format === "markdown") {
    plain = plain
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
      // Match whole code spans first so their identifiers/globs remain literal.
      // Emphasis must be paired and outside a word, never snake_case punctuation.
      .replace(
        /(`+)([\s\S]*?)\1|(?<![\p{L}\p{N}_])(\*\*|__|\*|_|~~)(?=\S)(.*?\S)\3(?![\p{L}\p{N}_])/gu,
        (
          _match,
          _ticks,
          code: string | undefined,
          _delimiter,
          emphasis: string | undefined,
        ) => code ?? emphasis ?? "",
      );
  }
  plain = plain.replace(/\s+/g, " ").trim();
  return plain.length > 180 ? `${plain.slice(0, 179).trimEnd()}…` : plain;
}
