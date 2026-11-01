/**
 * Method/callback inventory, not a coverage counter. This guard makes a new
 * owner method/case require classification; the referenced oracle fixtures are
 * the behavioral evidence. References alone never prove a writer reports.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

type Group = {
  methods: string[];
  kind: "projected" | "nonprojected" | "read";
  reason: string;
  evidence?: string[];
};
type Owner = { path: string; groups: Group[] };
const group = (
  kind: Group["kind"],
  methods: string,
  reason: string,
  ...evidence: string[]
): Group => ({ kind, methods: methods.split(" "), reason, evidence });
const pi = "piSdk/sessionListLiveWriters.test.ts::";
const claude = "claudeSdk/sessionListLiveWriters.test.ts::";
const retained = "claudeSdk/ClaudeSdkSession.backgroundWork.test.ts::";
const old = "sessionListBehavior.test.ts::";
const owners: Record<string, Owner> = {
  PiSessionStore: {
    path: "piSdk/piStore.ts",
    groups: [
      group(
        "projected",
        "acquireNew track",
        "Publish a native handle into the live overlay; empty handles intentionally have equal public lists. A refused open discards its unregistered engine, skill snapshot and files before publishing.",
        pi + "PiStore.acquireNew",
        pi + "PiStore.acquireNew failure cleanup",
      ),
      group(
        "projected",
        "acquireExisting acquireByRecordId",
        "Reopen and register an indexed session; all paths converge on track.",
        old + "piStore.acquireExisting",
      ),
      group(
        "projected",
        "forkSession",
        "Native branch creation, fork lineage and live registration, including refusal cleanup.",
        pi + "PiStore.forkSession",
        pi + "PiStore.forkSession revoked-account cleanup",
      ),
      group(
        "projected",
        "onLiveSessionEvicted evict",
        "Remove live membership before runtime/native teardown.",
        pi + "PiStore.onLiveSessionEvicted/idle residency",
        old + "piStore.evict",
      ),
      group(
        "projected",
        "onEngineLost",
        "A Worker connection end ends the live session like an eviction, keeping its record; map removal reports it before runtime/native teardown.",
        "piSdk/remotePiEngine.test.ts::PiStore.onEngineLost connection end",
      ),
      group(
        "projected",
        "renameSession",
        "Live rename delegates to PiLiveSession.rename; cold native rename leaves indexed title unchanged until indexing.",
        old + "piStore.renameSession live",
        old +
          "cold transcript rename leaves the index update to the app rename writer",
      ),
      group(
        "nonprojected",
        "setHost setHeldElsewhere getForDrive",
        "Install host callbacks/an ownership predicate or rearm an idle timer, not session data.",
      ),
      group(
        "nonprojected",
        "freezeStart discardRefused",
        "Freeze a new or forked session's start records, or undo its refused open, before track publishes anything.",
      ),
      group(
        "nonprojected",
        "applySessionMode registerAppTools closeAppTools",
        "Policy mode and tool/browser resources are absent from LiveListInfo; map removal owns eviction reporting.",
      ),
      group(
        "read",
        "hasTranscript requireHost get list listInfo getLiveById resolvePiImage",
        "Read native bindings, live handles or transcript image content; do not mutate projection inputs.",
      ),
    ],
  },
  PiLiveSession: {
    path: "piSdk/PiLiveSession.ts",
    groups: [
      group(
        "projected",
        "syncRegistry onAgentEvent",
        "Native callbacks own running/title/updatedAt and transcript-total counts; message_end must report before the next native step.",
        pi + "Pi native message_end callback",
        pi + "Pi native retry agent_end callback",
        pi + "Pi native retry agent_settled callback",
        old + "PiLiveSession native session_info_changed",
      ),
      group(
        "projected",
        "beginSyntheticTool openSyntheticTurn discardSyntheticTool finishSyntheticTool finishSyntheticCard endSyntheticTurn",
        "Synthetic turns change running, counts and timestamps; private open/end are shared funnels.",
        old + "PiLiveSession.beginSyntheticTool",
        old + "PiLiveSession.finishSyntheticTool",
        old + "PiLiveSession.discardSyntheticTool",
        pi + "Pi.finishSyntheticCard",
      ),
      group(
        "projected",
        "switchAccount",
        "Commit the indexed credential binding and replace the native engine before resolving.",
        pi + "PiLiveSession.switchAccount",
      ),
      group(
        "projected",
        "#promptRaw continueFailedTurn finishPromptError",
        "Prompt acceptance/continuation and command-error finalization change live running/title/count/timestamps.",
        pi + "Pi prompt acceptance/settlement",
        pi + "Pi prompt error/finishPromptError",
        pi + "Pi continueFailedTurn",
        pi + "Pi finishPromptError",
      ),
      group(
        "projected",
        "autoNameFromFirstPrompt autoNameForkFromFirstPrompt",
        "Detached naming promises own public pending flags and completion titles.",
        pi + "Pi autoName start",
        pi + "Pi autoName completion",
        pi + "Pi autoNameFork completion",
      ),
      group(
        "projected",
        "setModel setThinkingLevel rename",
        "Await engine commands, then report the selected native facts before resolving.",
        old + "PiLiveSession.setModel",
        old + "PiLiveSession.setThinkingLevel",
        old + "PiLiveSession.rename",
      ),
      group(
        "projected",
        "abort createRuntimeAdapter",
        "Adapter/abort delegates to the native command and onAgentEvent; it does not invent a second row representation.",
        pi + "runtime.abort/Pi.abort",
      ),
      group(
        "nonprojected",
        "addViewer removeViewer armIdleIfUnviewed",
        "Viewer/residency bookkeeping only; its expiry callback delegates to the separately inventoried store eviction.",
        pi + "PiStore.onLiveSessionEvicted/idle residency",
      ),
      group(
        "nonprojected",
        "flushInitialNotices broadcastState broadcast subscribeAdapterEvents notice providerNotice broadcastContextInfo",
        "Transport, adapter subscriptions and transcript notices; native/DB writers own listed state.",
      ),
      group(
        "nonprojected",
        "updateSyntheticTool",
        "Tool output body is not in LiveListInfo.",
        pi + "Pi.updateSyntheticTool",
      ),
      group(
        "nonprojected",
        "commitWorkflowContext acceptCommitDryRun",
        "Commit workflow context/approvals are outside this class's list fields; approval store owns pending attention.",
      ),
      group(
        "nonprojected",
        "dropEncryptedReasoning compactContext clearContext",
        "Native context edits preserve physical transcript message totals; usage/context are not list fields.",
        pi + "Pi dropEncryptedReasoning",
        pi + "Pi compactContext",
        pi + "PiLiveSession.clearContext",
      ),
      group(
        "nonprojected",
        "applyCompactionWindow lowerCompactionWindow",
        "Change native context limits and a separate stored cap, neither exposed by LiveListInfo.",
        pi + "Pi applyCompactionWindow",
        pi + "Pi lowerCompactionWindow",
      ),
      group(
        "nonprojected",
        "setMode applyMode dispose",
        "Mode, subscription/native resource disposal and disposed flag are not list fields; store membership/removal owns visibility.",
        old + "PiLiveSession.setMode",
        pi + "PiStore.onLiveSessionEvicted/idle residency",
      ),
      group(
        "read",
        "providerErrorInfo compactionWindowStatus modelSelection snapshot branchToolCalls nativeFacts cumulativeTotals turnUsage contextInfo safeProjectContextInfo listInfo",
        "Build error/context/native/public snapshots without owning any listed write.",
      ),
    ],
  },
  ClaudeSdkSessionStore: {
    path: "claudeSdk/claudeSdkStore.ts",
    groups: [
      group(
        "projected",
        "acquire",
        "Register/reopen the live SDK overlay and synchronize indexed classification.",
        claude + "ClaudeStore.acquire",
        old + "claudeSdkStore.acquire",
      ),
      group(
        "projected",
        "forkSession",
        "Native fork and canonical log cut publish child lineage; post-cut failures unwind membership and native transcript.",
        claude + "ClaudeStore.forkSession",
        claude + "ClaudeStore.forkSession compensation",
      ),
      group(
        "projected",
        "persist syncRegistry syncRegistryRecord",
        "Persist canonical state and update the indexed metadata used by cold rows.",
        old + "claudeSdkStore.persist",
        claude + "Claude prompt acceptance/stream/result",
      ),
      group(
        "projected",
        "evictIdle remove",
        "Remove the live overlay/runtime or tombstone the entire durable row.",
        claude + "ClaudeStore.evictIdle",
        old + "claudeSdkStore.remove",
      ),
      group(
        "nonprojected",
        "setOnChange setHeldElsewhere setStateBuilder setSeam getForDrive",
        "Install callbacks/predicates/provider seams or rearm idle residency, not session projection data.",
      ),
      group(
        "nonprojected",
        "removeNativeTranscript",
        "Filesystem cleanup follows public tombstoning or unregistered fork compensation; it is not a second membership writer.",
        claude + "ClaudeStore.forkSession compensation",
      ),
      group(
        "read",
        "requireStateBuilder seam get exists unreadableRecord list metaForRemoval",
        "Read callbacks, current handles, records or a binding error; no classification/membership write.",
      ),
    ],
  },
  ClaudeSdkSession: {
    path: "claudeSdk/ClaudeSdkSession.ts",
    groups: [
      group(
        "projected",
        "appendUserEntry appendAssistantTurn appendHostCommandEntry appendTimelineEntry",
        "Canonical append changes messageCount. The shared append boundary must report even for a lifecycle-accepted steer with no enclosing turn-end persist.",
        claude + "Claude prompt acceptance/stream/result",
        claude + "Claude.finishSyntheticCard",
        retained + "Claude.acceptSteer command-lifecycle callback",
      ),
      group(
        "projected",
        "setModel setThinkingLevel",
        "Retained native controls commit model/reasoning after the awaited effect; unlocked configuration is intentionally unlisted.",
        retained + "Claude.setModel retained control",
        retained + "Claude.setThinkingLevel retained control",
        claude + "Claude.setModel unlocked",
        claude + "Claude.setThinkingLevel unlocked",
      ),
      group(
        "projected",
        "switchAccount",
        "Migrate native history and commit the indexed account binding.",
        claude + "Claude.switchAccount",
      ),
      group(
        "projected",
        "#promptRaw acceptSteer continueWithFollowUps finishTurn",
        "Accept/commit user and assistant entries, update running/timestamps and persist. Lifecycle and follow-up callbacks are checked separately.",
        claude + "Claude prompt acceptance/stream/result",
        claude + "Claude failed prompt terminal",
        retained + "Claude.acceptSteer command-lifecycle callback",
        retained + "Claude continueWithFollowUps callback",
        retained + "Claude follow-up terminal callback",
      ),
      group(
        "projected",
        "consumeQuery beginProviderInitiatedTurn openProviderTurn",
        "The provider stream opens/settles an admitted retained-host turn without a user prompt.",
        retained + "Claude.openProviderTurn callback",
        retained + "Claude provider-initiated terminal callback",
      ),
      group(
        "projected",
        "abort beginSyntheticTool discardSyntheticTool finishSyntheticTool finishSyntheticCard discardSyntheticTurn commitSyntheticTurn",
        "Running/count/timestamp writers; abort and synthetic turn funnels report before return.",
        retained + "Claude.abort retained turn",
        claude + "Claude.beginSyntheticTool",
        old + "ClaudeSdkSession.discardSyntheticTool",
        claude + "Claude.finishSyntheticTool",
        claude + "Claude.finishSyntheticCard",
      ),
      group(
        "projected",
        "handleAssistantMessage",
        "A recognized observed provider model changes the public selected model immediately, independently of terminal persistence.",
        retained + "Claude native assistant-model callback",
      ),
      group(
        "projected",
        "setTitle beginAutoName autoName",
        "Title and pending/fork-pending flag writers, including detached naming completions.",
        old + "ClaudeSdkSession.setTitle",
        claude + "Claude.beginAutoName",
        claude + "Claude.autoName completion",
        claude + "Claude fork naming completion",
      ),
      group(
        "projected",
        "createRuntimeAdapter steer settleConsumedSteers",
        "Delegate user/steer acceptance to the independently checked canonical append/turn callbacks.",
        retained + "Claude.acceptSteer command-lifecycle callback",
        retained + "Claude continueWithFollowUps callback",
      ),
      group(
        "nonprojected",
        "holdBy addViewer removeViewer armIdleIfUnviewed",
        "Ownership/viewer/residency policy is not in listItem; expiry delegates to store.evictIdle.",
        claude + "ClaudeStore.evictIdle",
      ),
      group(
        "nonprojected",
        "broadcast subscribeAdapterEvents broadcastState broadcastContextInfo",
        "Transport/subscription state only; no listed data write.",
      ),
      group(
        "nonprojected",
        "setMode",
        "Policy mode is not part of listItem; persistence mirrors it without changing public fields.",
        old + "ClaudeSdkSession.setMode",
      ),
      group(
        "nonprojected",
        "configure",
        "Allowed only before any committed/live turn. An empty SDK item is skipped by mergedSessionList.",
        claude + "Claude.configure",
      ),
      group(
        "nonprojected",
        "applyCompactionWindow lowerCompactionWindow compactContext clearContext compactRetainedQuery",
        "Context thresholds, provider resume id and cumulative billed usage are not list fields; canonical owned transcript remains intact.",
        claude + "Claude.compactContext result usage",
        claude + "Claude.clearContext",
        claude + "Claude.applyCompactionWindow",
        retained + "Claude.lowerCompactionWindow",
      ),
      group(
        "nonprojected",
        "updateSyntheticTool commitWorkflowContext",
        "Tool body/commit context only; terminal turn methods own public counters.",
        claude + "Claude.updateSyntheticTool",
      ),
      group(
        "nonprojected",
        "stopInterruptSent withdrawPendingSteers sendPromptToProcess sendPromptOnce pushSkillSubmission bindSkillCommandStart",
        "Process/input/skill queue bookkeeping; accepted entries are written through appendTimelineEntry, running state through the listed turn methods.",
      ),
      group(
        "nonprojected",
        "admitNativeBackgroundTool reconcileStopTasks observeProviderTask replaceProviderMembership allActiveProviderTasksMissing reconcileMissingProviderTasks scheduleQuietCloseIfEmpty cancelQuietClose",
        "Provider task membership/host policy delegates indexed work mutations to backgroundWorkStore's independently checked writers, not to listItem fields.",
      ),
      group(
        "nonprojected",
        "markProviderResultForDiscard consumeForeignProviderResult resetProviderResultTracking closeProcess handleInBandCompactMessage refreshToolLoadState",
        "Epoch/process/compaction/tool-loading bookkeeping; a resulting actual turn boundary goes through finishTurn.",
      ),
      group(
        "nonprojected",
        "resetTurnFailureState resetSkillTurnState reachTurnBoundary noteProviderFailure beginUsageEpoch applyResultTotals handleBackgroundSystemMessage handleAutoCompaction",
        "Failure/usage/context/task bookkeeping is absent from listItem; indexed background effects own their DB touches.",
      ),
      group(
        "nonprojected",
        "handleSdkMessage handleStreamEvent handleUserMessage repairQuestionToolCallIdsFromTimeline maybeRelinkQuestionToolCallId",
        "Dispatch to separately inventoried projected callbacks; token/tool content/context/retry fields themselves are not exposed by the current SDK list overlay.",
        retained + "Claude api_retry callback",
      ),
      group(
        "nonprojected",
        "dispose",
        "Resource/host disposal triggers indexed background-store writers and stream finishTurn; disposed is not itself a public field.",
      ),
      group(
        "read",
        "assertNotDisposed liveMessages timelineEntries committedTimeline messageCount snapshot modelOption nativeFacts contextInfo currentTurnEstimate compactionWindowStatus runningEpochKey compactionWindowStart modelSelection assertSkillRegistered answersBeforePrompt answersOnlyContext isProviderTurnContent promptConditions frozenSkillNames committedToolCalls toolLoadingFacts turnOutcome savedProviderTotals blockKey listItem toRecord toRecordMeta",
        "Read or derive native/canonical/policy/public data without changing a list input.",
      ),
    ],
  },
  SessionRuntime: {
    path: "session/runtime/runtime.ts",
    groups: [
      group(
        "projected",
        "prompt deliverPrompt abort",
        "Delegate real effects to the adapter/native callback writers; prompt receipt completion must not outrun their touches.",
        pi + "Pi prompt acceptance/settlement",
        pi + "runtime.abort/Pi.abort",
        claude + "Claude prompt acceptance/stream/result",
      ),
      group(
        "projected",
        "releaseHarness closeForTeardown disposeSession dispose",
        "Close active runtime run-state before removing ownership; native live and runtime state are independent inputs.",
        pi +
          "runtime %s closes active projected state before removing ownership",
        pi + "runtime.closeForTeardown",
        pi + "runtime.disposeSession",
      ),
      group(
        "projected",
        "emitSessionEvent",
        "Forward native run-state/progress to the installed sessionActivity writer synchronously.",
        old + "providerRetry",
        pi + "Pi native auto_retry_start callback",
        retained + "Claude provider-initiated terminal callback",
      ),
      group(
        "nonprojected",
        "createSession openForView retainView scheduleViewRelease cancelViewRelease attachAdapter",
        "Create/bind idle or detached runtime residency; only active run events affect the list. Detached view expiry removes no public conversation.",
        pi + "runtime.openForView",
        pi + "runtime.scheduleViewRelease timer",
        pi + "runtime.attachAdapter",
      ),
      group(
        "nonprojected",
        "admitPrompt openSessionStream subscribeEvents",
        "Admission counts, subscriptions and view-release callbacks are not public fields; they cannot be mistaken for run-state events.",
      ),
      group(
        "read",
        "get interruptedRunAt isRunning runProgress isBusy loadTimelineBlock loadTimelineRange locateAnchor readLog getConfig forkAnchors forkLog forkCutEntryId canForkLogAt turnEndEntryId entryText require",
        "Read active ownership/logs/config/fork cuts; no listed mutation.",
      ),
    ],
  },
};

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
type Node = { type: string; [key: string]: unknown };
function isNode(value: unknown): value is Node {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
  );
}
function nodes(root: unknown): Node[] {
  const result: Node[] = [];
  const visit = (value: unknown) => {
    if (!isNode(value)) return;
    result.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(root);
  return result;
}
function methodName(node: Node): string {
  assert.ok(isNode(node.key));
  return `${node.key.type === "PrivateIdentifier" ? "#" : ""}${String(node.key.name)}`;
}
function parse(path: string) {
  const parsed = parseSync(path, source(path), {
    lang: "ts",
    sourceType: "module",
  });
  assert.deepEqual(parsed.errors, []);
  return parsed.program;
}
for (const [name, owner] of Object.entries(owners)) {
  test(`${name}: every concrete method has a source-backed classification`, () => {
    const declaration = nodes(parse(owner.path)).find(
      (node) =>
        node.type === "ClassDeclaration" &&
        isNode(node.id) &&
        node.id.name === name,
    );
    assert.ok(
      declaration &&
        isNode(declaration.body) &&
        Array.isArray(declaration.body.body),
    );
    const actual = declaration.body.body
      .filter(isNode)
      .filter(
        (node) => node.type === "MethodDefinition" && node.kind === "method",
      )
      .map(methodName)
      .sort();
    const classified = owner.groups.flatMap((entry) => entry.methods).sort();
    assert.equal(
      new Set(classified).size,
      classified.length,
      `${name}: duplicate classifications`,
    );
    assert.deepEqual(
      classified,
      actual,
      `${name}: classify new/removed methods explicitly`,
    );
    for (const entry of owner.groups) {
      assert.ok(entry.reason.length > 30);
      if (entry.kind === "projected")
        assert.ok(
          entry.evidence?.length,
          `${name}: missing behavioral navigation`,
        );
      for (const reference of entry.evidence ?? []) {
        const [path, label] = reference.split("::");
        const fixture = source(path!);
        assert.ok(
          fixture.includes(JSON.stringify(label)),
          `${name}: stale evidence ${reference}`,
        );
      }
    }
  });
}

const callbacks = [
  {
    path: "piSdk/PiLiveSession.ts",
    method: "onAgentEvent",
    projected: [
      "agent_start",
      "message_end",
      "auto_retry_start",
      "agent_end",
      "agent_settled",
      "session_info_changed",
    ],
    nonprojected: [
      "message_update",
      "auto_retry_end",
      "compaction_start",
      "compaction_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ],
  },
  {
    path: "claudeSdk/ClaudeSdkSession.ts",
    method: "handleSdkMessage",
    projected: ["assistant"],
    nonprojected: ["stream_event", "user", "result"],
  },
  {
    path: "claudeSdk/ClaudeSdkSession.ts",
    method: "handleStreamEvent",
    projected: [],
    nonprojected: ["text", "thinking", "toolInputDelta", "toolEnd"],
  },
];
for (const callback of callbacks)
  test(`${callback.method}: every native switch case is classified`, () => {
    const declaration = nodes(parse(callback.path)).find(
      (node) =>
        node.type === "MethodDefinition" &&
        methodName(node) === callback.method,
    );
    assert.ok(declaration);
    const cases = nodes(declaration)
      .filter(
        (node) =>
          node.type === "SwitchCase" &&
          isNode(node.test) &&
          typeof node.test.value === "string",
      )
      .map((node) => {
        assert.ok(isNode(node.test));
        return String(node.test.value);
      });
    assert.deepEqual(
      [...callback.projected, ...callback.nonprojected].sort(),
      cases.sort(),
    );
  });
