/**
 * Harness-independent agent-prompt guidance for the first-class Knowledge Base.
 *
 * This is the single static system-prompt section injected into both personas by
 * `agents.ts`. It teaches reliable first-class KB behavior only; there is no
 * dynamic per-skill prompt surface.
 */

/**
 * Minimal eager pointer to the first-class Knowledge Base. Full operational
 * guidance lives in the kb_* tool descriptions and parameters (discovered when
 * the tools are activated), ensuring it reaches the model exactly when needed
 * while keeping this eager section compact.
 *
 * Since Task-286 no kb_* tool is eager, so this pointer must also make the KB
 * DISCOVERABLE: it says the tools are loaded on demand, in harness-neutral
 * wording (pi `find_tools`, Claude's native tool search).
 */
export function knowledgeBaseBehaviorGuidance(): string {
  return [
    "## Assistant Knowledge Base",
    "",
    'A versioned Knowledge Base — a Git-backed folder of Markdown and other files — lives under DATA_DIR/knowledge. Search it before answering durable questions or asking the user about facts it may already hold. Its kb_* tools load on demand: find them with a tool search for "knowledge base", then read with kb_search and kb_read, and write with kb_write and kb_edit. Never edit DATA_DIR/knowledge directly: the user edits it too, and the tools commit only your own changes. Writing, linking and scoping guidance lives in the tool descriptions.',
  ].join("\n");
}
