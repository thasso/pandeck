/**
 * The one wording of a background item's human title, shared by every backend
 * that admits work: the agent's description when it gave one, else the first
 * non-empty line of the command, else the caller's fallback. Whitespace is
 * collapsed so a multi-line script reads as one title, and the result is cut
 * to the store's label cap.
 */
const TITLE_MAX_CHARS = 200;

export function backgroundWorkTitle(input: {
  description?: string | undefined;
  command?: string | undefined;
  fallback: string;
}): string {
  const description = collapse(input.description);
  if (description) return description.slice(0, TITLE_MAX_CHARS);
  const line = (input.command ?? "")
    .split(/\r?\n/)
    .map((row) => collapse(row))
    .find((row) => row.length > 0);
  if (line) return line.slice(0, TITLE_MAX_CHARS);
  return input.fallback;
}

/** The description as the row stores it, or nothing when it was blank. */
export function backgroundWorkDescription(
  description: string | undefined,
): string | undefined {
  const text = collapse(description);
  return text ? text.slice(0, TITLE_MAX_CHARS) : undefined;
}

function collapse(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
