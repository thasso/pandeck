/**
 * MCP naming primitives.
 *
 * This module imports NOTHING on purpose. `MCP_SERVER_NAME` is read at module
 * top level elsewhere (e.g. the `MCP_PREFIX` constant in
 * {@link ../taskOverhead.ts}), and most of its readers sit in one large import
 * cycle rooted at {@link ../agentTypes.ts}. If this module joined that cycle it
 * could be entered half-initialized, and the top-level read would then throw
 * `ReferenceError: Cannot access 'MCP_SERVER_NAME' before initialization` at
 * server startup. Keeping it a leaf makes that unrepresentable — anything here
 * that needs the agent-type registry belongs in {@link ./agentToolNames.ts}.
 */

/**
 * The in-process session tool server's MCP name. Harnesses that namespace
 * mounted servers (the Claude SDK) expose our tools as `mcp__pa__<toolName>`.
 */
export const MCP_SERVER_NAME = "pa";

/** The namespaced external name a mounted tool gets in the Claude SDK. */
export function externalToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/** The pi harness's deferred-tool loader, appended to every pi session. */
export const FIND_TOOLS_NAME = "find_tools";
