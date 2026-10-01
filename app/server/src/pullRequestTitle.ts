export const MAX_PULL_REQUEST_TITLE_CHARS = 120;

/** Validate an explicitly authored pull-request title without rewriting it. */
export function normalizeExplicitPullRequestTitle(value: string): string {
  const title = value.trim();
  if (!title)
    throw new Error("title must not be blank after trimming whitespace.");
  if (/[\r\n\u2028\u2029]/u.test(title))
    throw new Error("title must be a single line.");
  if (title.length > MAX_PULL_REQUEST_TITLE_CHARS)
    throw new Error(
      `title exceeds ${MAX_PULL_REQUEST_TITLE_CHARS} characters after trimming whitespace.`,
    );
  return title;
}
