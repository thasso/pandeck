import { sessionStore } from "./db/sessionStore.ts";

/** Trusted provenance captured by a helper's transcript-reading caller. */
export interface HelperSourceContext {
  sourceSessionId?: string;
  requiresEnterprise?: boolean;
}

/**
 * Capture the helper's account requirement before any await. Caller false cannot
 * clear a source requirement; missing retained provenance fails closed.
 */
export function sourceRequiresEnterprise(
  sourceSessionIds: readonly string[],
  requested = false,
): boolean {
  return (
    requested ||
    sourceSessionIds.some((id) => {
      const source = sessionStore.getIncludingDeleted(id);
      return !source || source.requiresEnterprise === true;
    })
  );
}
