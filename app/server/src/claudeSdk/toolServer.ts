/**
 * Claude-side wiring for the generic session tool server (`mcp/sessionToolServer.ts`).
 * Synthesizes the fully-populated {@link ToolSession} for a `claude-sdk` session
 * so tasks/assistance created by a tool link back to it (and show
 * up in the app like a workshop session's would), and mounts the persona's
 * toolset from the harness-independent {@link AGENT_TYPES} registry:
 *
 *   - `workshop` — the app-modifying toolset. Claude also has the native
 *     Read/Write/Edit/Bash built-ins, so this adds only the custom workshop
 *     tools (commit, browser tool groups, etc.), all ordinary catalog tools
 *     discovered via the SDK's native tool search like any other deferred
 *     group (no separate per-session enable step).
 *   - `assistant` — the restricted personal-assistant toolset. The session has
 *     NO native file/shell tools (see `claudeCommand`), so ALL of its capability
 *     comes from these dedicated integration tools over the mounted server.
 */
import type { AgentType, SessionMode } from "@assistant/shared";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { AGENT_TYPES } from "../agentTypes.ts";
import {
  integrationGatedActiveToolNames,
  catalogSearchHintFor,
  eagerToolNamesFor,
  modeGatedActiveToolNames,
} from "../tools/catalog.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import { sessionPromptConditions } from "../promptConditions.ts";
import { buildCommitSessionManager } from "../claudeCommitContext.ts";
import {
  createSessionToolServer,
  type SessionToolServer,
} from "../mcp/sessionToolServer.ts";
import {
  planModeToolUnavailableMessage,
  type ToolSession,
  type ToolSessionManager,
} from "../mcp/tool.ts";

/** The narrow ClaudeSdkSession surface the tool server needs (test-friendly). */
export interface ClaudeToolSessionSource {
  id: string;
  agentType: AgentType;
  sessionMode: SessionMode;
  /** Where the session executes (worktree path or app CWD). */
  cwd: string;
  /** The live session's own field is `string | undefined`, so this admits it. */
  sessionFile?: string | undefined;
  title?: string;
  timelineEntries(): ClientTimelineEntry[];
  broadcastState(): void;
}

function claudeToolSession(
  source: ClaudeToolSessionSource,
  commitManager: ReturnType<typeof buildCommitSessionManager>,
): ToolSession {
  const sessionManager: ToolSessionManager = {
    getSessionId: () => source.id,
    getBranch: () => commitManager.getBranch(),
    appendCustomEntry: (type, data) =>
      commitManager.appendCustomEntry(type, data),
  };
  return {
    sessionId: source.id,
    harness: "claude-sdk",
    agentType: source.agentType,
    ...(source.sessionFile !== undefined
      ? { sessionFile: source.sessionFile }
      : {}),
    ...(source.title !== undefined ? { title: source.title } : {}),
    cwd: source.cwd,
    sessionManager,
  };
}

/**
 * Build the per-session tool server a `claude-sdk` session mounts as `pa`.
 * Integration-gate changes push tools/list_changed (wired inside the generic
 * server), so the Claude client can refresh its tool list mid-session.
 */
export function createClaudeSessionToolServer(
  source: ClaudeToolSessionSource,
): SessionToolServer {
  // The generic server asks for fresh ToolSession facts per call, but commit
  // checkpoints must span tool rounds within one Claude turn. Keep this narrow
  // manager for the lifetime of the per-session tool server.
  const commitManager = buildCommitSessionManager(() =>
    source.timelineEntries(),
  );
  return createSessionToolServer({
    sessionId: source.id,
    harness: "claude-sdk",
    tools: () => AGENT_TYPES[source.agentType].tools(),
    activeToolNames: () => {
      const tools = AGENT_TYPES[source.agentType].tools();
      const integrationActive = integrationGatedActiveToolNames(
        source.agentType,
        tools,
        new Set(tools.map((tool) => tool.name)),
      );
      return modeGatedActiveToolNames(
        source.sessionMode,
        tools,
        integrationActive,
      );
    },
    searchHint: (tool) => catalogSearchHintFor(source.agentType, tool.name),
    inactiveToolMessage: (tool) =>
      source.sessionMode === "plan" && !isPlanModeToolAllowed(tool)
        ? planModeToolUnavailableMessage(tool.name)
        : undefined,
    // Eager-tier catalog tools are marked anthropic/alwaysLoad so the SDK's
    // native tool search keeps them in the initial context and defers the rest.
    // The session's FROZEN start conditions decide the conditional eager groups
    // (Task 287), so a tools/list_changed refresh cannot move the tier tail.
    eagerToolNames: () =>
      eagerToolNamesFor(
        source.agentType,
        sessionPromptConditions(source.id, source.agentType),
      ),
    session: () => claudeToolSession(source, commitManager),
    onToolExecuted: () => source.broadcastState(),
  });
}
