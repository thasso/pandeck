/** Human-readable message for an unknown thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
