/**
 * The bare tool name used for matching/display across the chat UI, shared with
 * the server's card acceptance (`@assistant/shared/toolCards`) so both ends
 * resolve a harness spelling the same way.
 *
 * Standalone module (not in registry.tsx) so the lazy-loaded card components can
 * import it without an import cycle back through the registry.
 */
export { normalizedToolName } from "@assistant/shared/toolCards";
