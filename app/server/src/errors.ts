/** Human-readable message for an unknown thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why a private JSON file could not be read, without its contents. A
 * `JSON.parse` error quotes the text around the fault, and in a settings file
 * that text can be a token.
 */
export function fileReadErrorText(err: unknown): string {
  return err instanceof SyntaxError
    ? "the file is not valid JSON"
    : errorText(err);
}
