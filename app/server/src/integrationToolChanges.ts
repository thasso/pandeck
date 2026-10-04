type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Notify every live session MCP server that integration enablement changed.
 * One failing server never keeps the rest from hearing; the failures are
 * thrown together once all were told.
 */
export function notifyIntegrationToolsChanged(): void {
  const failures: unknown[] = [];
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `${failures.length} session tool servers failed to update`,
    );
}

/** Subscribe one live session tool server to integration enablement changes. */
export function subscribeIntegrationToolChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
