type Listener = () => void;

const listeners = new Set<Listener>();

/** Notify every live session MCP server that integration enablement changed. */
export function notifyIntegrationToolsChanged(): void {
  for (const listener of listeners) listener();
}

/** Subscribe one live session tool server to integration enablement changes. */
export function subscribeIntegrationToolChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
