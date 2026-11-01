/** App-owned SessionState projection from identity and native facts. */
import {
  HARNESSES,
  isCodingAgentType,
  sessionCompactionWindowState,
  type SessionState,
} from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { worktreeIdForSession } from "./db/worktreeStore.ts";
import { errorText } from "./errors.ts";
import type { SessionNativeFacts } from "./harness.ts";
import { storedCompactionWindowState } from "./harnesses/compactionWindow.ts";
import { listSessionArtifacts } from "./mcp/toolGroups/packRuntime.ts";
import {
  getPendingPostReloadContinuation,
  listBrowserRuntimes,
} from "./mcp/toolGroups/registry.ts";
import {
  directSpawnField,
  peerPromptPeersFor,
  peerPromptQueueField,
  peerPromptThreadsFor,
} from "./peerPrompt.ts";
import { backgroundUpdateQueueField } from "./backgroundUpdateQueue.ts";
import { promptQueueField } from "./promptQueue.ts";
import { activeSkillsForSession } from "./sessionSkills.ts";
import {
  displayedSessionAgent,
  sessionAgentSummary,
} from "./agents/sessionAgent.ts";
import { withoutDeniedTools } from "./agents/agentDefinitionPolicy.ts";
import { skillInvocationTrail } from "./skills/skillInvocations.ts";
import {
  findOriginTask,
  listRelatedGlobalTasks,
  listSessionTasks,
} from "./tasks.ts";
import {
  getAnsweredAgentQuestions,
  getPendingAgentQuestions,
  hasPendingAgentQuestion,
} from "./tools/core/questionTool.ts";
import {
  agentToolsFor,
  integrationGatedActiveToolNames,
  modeGatedActiveToolNames,
} from "./tools/catalog.ts";
import { sessionToolExposure } from "./tools/sessionToolExposure.ts";
import {
  buildToolExposure,
  toolDefinitionChars,
} from "./tools/toolExposure.ts";
import { hasPendingApproval } from "./pendingApprovals.ts";
import { hasChoosingTaskCard } from "./pullRequestCards.ts";
import { sessionWorktreeMissing } from "./worktrees/sessionCwd.ts";

/** A store hiccup degrades one field, with one diagnostic per failed read. */
function safe<T>(field: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    console.warn(`Session state ${field} read failed:`, errorText(error));
    return fallback;
  }
}

function toolExposureFor(sessionId: string, facts: SessionNativeFacts) {
  const loading = facts.live?.toolLoading;
  // Existing registrations still serve views without native loading facts.
  if (!loading) return sessionToolExposure(sessionId);
  const catalog = agentToolsFor(facts.kind);
  const tools = withoutDeniedTools(catalog, displayedSessionAgent(sessionId));
  const integrated = integrationGatedActiveToolNames(
    facts.kind,
    tools,
    new Set(tools.map((tool) => tool.name)),
  );
  const usable = modeGatedActiveToolNames(
    facts.mode ?? "build",
    tools,
    integrated,
  );
  const definitionCharsByName = new Map(
    tools.map((tool) => [
      tool.name,
      toolDefinitionChars(
        tool,
        `${loading.definitionNamePrefix ?? ""}${tool.name}`,
      ),
    ]),
  );
  const catalogNames = new Set(catalog.map((tool) => tool.name));
  // Only native definitions outside the catalog, such as pi's loader, need overrides.
  for (const [name, chars] of loading.definitionCharsByName ?? [])
    if (!catalogNames.has(name)) definitionCharsByName.set(name, chars);
  return buildToolExposure({
    ...loading,
    agentType: facts.kind,
    usableToolNames: usable,
    loadedToolNames: new Set(
      [...loading.loadedToolNames].filter((name) => usable.has(name)),
    ),
    definitionCharsByName,
    tokensByName: new Map(
      [...(loading.tokensByName ?? [])].filter(
        ([name]) =>
          usable.has(name) ||
          (loading.includeFindTools && name === "find_tools"),
      ),
    ),
  });
}

/** Recomputed on every state broadcast; walk only this session's domain edges. */
export function buildSessionState(
  sessionId: string,
  facts: SessionNativeFacts,
  browserRuntimeOwner?: Parameters<typeof listBrowserRuntimes>[1],
): SessionState {
  const idleReasonValue = hasPendingAgentQuestion(sessionId)
    ? "awaiting_question"
    : hasPendingApproval(sessionId)
      ? "awaiting_approval"
      : hasChoosingTaskCard(sessionId)
        ? "awaiting_task_choice"
        : undefined;
  const pendingQuestionsValue = getPendingAgentQuestions(sessionId);
  const pendingPostReloadContinuationValue =
    getPendingPostReloadContinuation(sessionId);
  const activeSkillsValue = activeSkillsForSession(sessionId, facts.kind);
  const agentValue = sessionAgentSummary(sessionId);
  const worktreeIdValue = safe(
    "worktree link",
    () => worktreeIdForSession(sessionId),
    undefined,
  );
  const originTaskValue = safe(
    "origin Task",
    () => findOriginTask(sessionId),
    undefined,
  );
  const toolExposureValue = toolExposureFor(sessionId, facts);
  const coding = isCodingAgentType(facts.kind);
  // A view can outlive a stored-window change. Never use its captured setting.
  const stored = sessionStore.getIncludingDeleted(sessionId);
  const visibleStored = stored?.deletedAt === undefined ? stored : undefined;
  const window = facts.live?.compactionWindow;
  const compactionWindowValue = facts.live
    ? sessionCompactionWindowState(HARNESSES[facts.harness].compactionWindow, {
        stored: stored?.compactionWindow,
        note: stored?.compactionWindowNote,
        ...window,
      })
    : visibleStored
      ? storedCompactionWindowState(visibleStored)
      : undefined;
  return {
    sessionId,
    ...(facts.sessionFile !== undefined
      ? { sessionFile: facts.sessionFile }
      : {}),
    harness: facts.harness,
    agentType: facts.agentType,
    ...(facts.forkOrigin !== undefined ? { forkOrigin: facts.forkOrigin } : {}),
    ...(facts.model !== undefined ? { model: facts.model } : {}),
    thinkingLevel: facts.thinkingLevel,
    ...(facts.mode !== undefined ? { mode: facts.mode } : {}),
    ...(stored?.requiresEnterprise ? { requiresEnterprise: true } : {}),
    ...(compactionWindowValue !== undefined
      ? { compactionWindow: compactionWindowValue }
      : {}),
    canSteer: facts.live?.canSteer ?? false,
    ...(idleReasonValue !== undefined ? { idleReason: idleReasonValue } : {}),
    ...(pendingQuestionsValue.length > 0
      ? { pendingQuestions: pendingQuestionsValue }
      : {}),
    answeredQuestions: getAnsweredAgentQuestions(sessionId),
    tasks: safe(
      "Session Tasks",
      () => listSessionTasks(facts.kind, sessionId),
      [],
    ),
    relatedGlobalTasks: safe(
      "related Tasks",
      () => listRelatedGlobalTasks(facts.kind, sessionId),
      [],
    ),
    ...(originTaskValue !== undefined ? { originTask: originTaskValue } : {}),
    ...(toolExposureValue !== undefined
      ? { toolExposure: toolExposureValue }
      : {}),
    ...(activeSkillsValue !== undefined
      ? {
          activeSkills: activeSkillsValue,
          ...(facts.live
            ? {
                skillInvocations:
                  activeSkillsValue.length === 0
                    ? []
                    : skillInvocationTrail(
                        activeSkillsValue,
                        facts.live.skillInvocationTranscript(activeSkillsValue),
                      ),
              }
            : {}),
        }
      : {}),
    ...(agentValue !== undefined ? { agent: agentValue } : {}),
    ...(coding ? { artifacts: listSessionArtifacts(sessionId) } : {}),
    ...(facts.kind === "workshop" &&
    pendingPostReloadContinuationValue !== undefined
      ? { pendingPostReloadContinuation: pendingPostReloadContinuationValue }
      : {}),
    ...(coding && facts.live
      ? {
          browserRuntimes: browserRuntimeOwner
            ? listBrowserRuntimes(sessionId, browserRuntimeOwner)
            : [],
        }
      : {}),
    peerPrompts: peerPromptThreadsFor(sessionId),
    peerPromptPeers: peerPromptPeersFor(sessionId),
    ...promptQueueField(sessionId),
    ...peerPromptQueueField(sessionId),
    ...directSpawnField(sessionId),
    ...backgroundUpdateQueueField(sessionId),
    ...(worktreeIdValue !== undefined ? { worktreeId: worktreeIdValue } : {}),
    ...(safe("worktree status", () => sessionWorktreeMissing(sessionId), false)
      ? { worktreeMissing: true }
      : {}),
  };
}
