/**
 * Per-session deferred tool activation for the pi harness.
 *
 * A pi session registers the persona's FULL tool universe as customTools (pi
 * cannot add definitions mid-session) but keeps only the eager-tier catalog
 * tools + the `find_tools` loader ACTIVE initially, so the first request's
 * tool block stays small. This module owns that active-set state machine:
 *
 *  - usable  = integration gates applied (same semantics the session tool
 *    server enforces for Claude — see `tools/catalog.ts` `IntegrationToolGates`);
 *  - loaded  = names activated during the session (find_tools) plus names
 *    recorded as `addedToolNames` in the reopened transcript, so previously
 *    loaded tools stay active across reopen;
 *  - active  = usable ∩ (eager ∪ loaded ∪ find_tools) — or simply usable when
 *    deferral is off (the constrained manager variant).
 *
 * Activation is ADDITIVE and happens synchronously inside find_tools' execute
 * window, so pi records `addedToolNames` on that tool result and natively
 * defer-loads the definitions on supported models.
 *
 * System-prompt stability: pi rebuilds the whole system prompt in
 * `setActiveToolsByName`, from the ACTIVE tools' prompt extras. Since Task-282
 * an AgentTool carries none, so that rebuild is constant across deferred
 * activation and the cache prefix survives it by construction — asserted in
 * `toolActivation.test.ts`, not assumed. A Build/Plan flip intentionally changes
 * the builtin prompt once. A deferred tool's guidance lives in its description,
 * which arrives with the definition at the tool-result position rather than in
 * the prompt.
 */
import type {
  AgentType,
  SessionMode,
  SessionToolExposure,
  SessionToolLoadEvent,
} from "@assistant/shared";
import {
  integrationGatedActiveToolNames,
  modeGatedActiveToolNames,
} from "../tools/catalog.ts";
import type { AgentTool } from "../mcp/tool.ts";
import { subscribeIntegrationToolChanges } from "../integrationToolChanges.ts";
import { createFindToolsTool } from "../tools/findTools.ts";
import { FIND_TOOLS_NAME } from "../mcp/names.ts";
import {
  buildToolExposure,
  toolDefinitionChars,
} from "../tools/toolExposure.ts";

export interface PiToolActivationConfig {
  sessionId: string;
  agentType: AgentType;
  /** The persona's full tool universe (catalog composition). */
  agentTools: AgentTool[];
  /** Eager-tier names kept in the initial context. */
  eagerToolNames: ReadonlySet<string>;
  /** False for the constrained manager variant: every usable tool stays active. */
  deferToolLoading: boolean;
  /** Current Build/Plan mode; omitted only by mode-agnostic tests/callers. */
  mode?(): SessionMode;
  /**
   * Apply the computed active BRIDGE tool names to the pi session (the caller
   * merges them with pi's built-in tools). Safe to call before the session
   * exists — the caller guards.
   */
  applyActiveToolNames(active: ReadonlySet<string>): void;
}

export interface PiToolActivation {
  /**
   * The pi custom-tool universe: the persona tools plus `find_tools` when
   * deferral is on.
   */
  piToolUniverse: AgentTool[];
  /** Every bridge tool name (for the built-in/bridge active-set merge). */
  toolNames: ReadonlySet<string>;
  /**
   * Compute + apply the initial active set. `loadedSeed` carries the
   * transcript's `addedToolNames` on reopen so previously loaded tools stay
   * active (and stay natively deferred at their original load point).
   */
  initialize(loadedSeed: Iterable<string>, usedSeed?: Iterable<string>): void;
  /** Reapply the current bridge set (for a Build/Plan policy change). */
  reapply(): void;
  /** Record a real tool call for diagnostics and prune protection. */
  markUsed(name: string): void;
  /** Prune never-called deferred loads at a cold user-turn boundary. */
  onUserTurnStart(idleMs: number): string[];
  /** The session's Tools-inspector projection. */
  exposure(): SessionToolExposure;
  /** Unsubscribe change listeners (session eviction/teardown). */
  dispose(): void;
}

/** Live activations by session id (for the SessionState exposure projection). */
const activations = new Map<string, PiToolActivation>();

/** The Tools-inspector projection for a live pi session, if one is registered. */
export function toolExposureForSession(
  sessionId: string,
): SessionToolExposure | undefined {
  return activations.get(sessionId)?.exposure();
}

/** Apply the conservative cold-boundary prune to a live pi session. */
export function prepareToolsForUserTurn(
  sessionId: string,
  idleMs: number,
): string[] {
  return activations.get(sessionId)?.onUserTurnStart(idleMs) ?? [];
}

const LOAD_EVENT_LIMIT = 50;
/**
 * Measured provider-tail cache survival falls off around one hour. Six hours is
 * deliberately conservative: only ~3.8% of user-turn boundaries cross it, so
 * pruning cannot invalidate a tail that would otherwise still be warm.
 */
export const UNUSED_TOOL_PRUNE_IDLE_MS = 6 * 60 * 60 * 1_000;

export function createPiToolActivation(
  config: PiToolActivationConfig,
): PiToolActivation {
  const loaded = new Set<string>();
  const used = new Set<string>();
  const loadEvents: SessionToolLoadEvent[] = [];
  let initialized = false;

  const recordLoad = (
    via: SessionToolLoadEvent["via"],
    names: readonly string[],
  ) => {
    if (names.length === 0) return;
    loadEvents.push({ at: Date.now(), via, names: [...names] });
    if (loadEvents.length > LOAD_EVENT_LIMIT)
      loadEvents.splice(0, loadEvents.length - LOAD_EVENT_LIMIT);
  };

  const usableToolNames = (): ReadonlySet<string> => {
    const integrationActive = integrationGatedActiveToolNames(
      config.agentType,
      config.agentTools,
      new Set(config.agentTools.map((tool) => tool.name)),
    );
    return modeGatedActiveToolNames(
      config.mode?.() ?? "build",
      config.agentTools,
      integrationActive,
    );
  };

  const activeToolNames = (): ReadonlySet<string> => {
    const usable = usableToolNames();
    if (!config.deferToolLoading) return usable;
    const active = new Set<string>();
    for (const name of usable) {
      if (config.eagerToolNames.has(name) || loaded.has(name)) active.add(name);
    }
    active.add(FIND_TOOLS_NAME);
    return active;
  };

  const apply = () => config.applyActiveToolNames(activeToolNames());

  const findToolsTool = config.deferToolLoading
    ? createFindToolsTool({
        agentType: config.agentType,
        usableToolNames,
        activeToolNames,
        activate: (names) => {
          const usable = usableToolNames();
          const before = activeToolNames();
          const added = names.filter(
            (name) => usable.has(name) && !before.has(name),
          );
          for (const name of added) loaded.add(name);
          if (added.length > 0) {
            recordLoad("find_tools", added);
            apply();
          }
          return added;
        },
      })
    : undefined;

  const piToolUniverse = [
    ...config.agentTools,
    ...(findToolsTool ? [findToolsTool] : []),
  ];
  const definitionCharsByName = new Map(
    piToolUniverse.map((tool) => [tool.name, toolDefinitionChars(tool)]),
  );

  // Integration gate flips only change `usable`; they never auto-load tools.
  const unsubscribeIntegrations = subscribeIntegrationToolChanges(() => {
    if (initialized) apply();
  });

  const activation: PiToolActivation = {
    piToolUniverse,
    toolNames: new Set(piToolUniverse.map((tool) => tool.name)),
    initialize(loadedSeed, usedSeed = []) {
      const seed = [...loadedSeed];
      for (const name of seed) loaded.add(name);
      for (const name of usedSeed) used.add(name);
      if (config.deferToolLoading) recordLoad("reopen", seed);
      initialized = true;
      apply();
    },
    reapply() {
      if (initialized) apply();
    },
    markUsed(name) {
      used.add(name);
    },
    onUserTurnStart(idleMs) {
      if (!config.deferToolLoading || idleMs < UNUSED_TOOL_PRUNE_IDLE_MS)
        return [];
      const pruned = [...loaded].filter(
        (name) => !used.has(name) && !config.eagerToolNames.has(name),
      );
      for (const name of pruned) loaded.delete(name);
      if (pruned.length > 0) apply();
      return pruned;
    },
    exposure() {
      return buildToolExposure({
        agentType: config.agentType,
        usableToolNames: usableToolNames(),
        loadedToolNames: activeToolNames(),
        usedToolNames: used,
        definitionCharsByName,
        includeFindTools: config.deferToolLoading,
        loadEvents,
      });
    },
    dispose() {
      activations.delete(config.sessionId);
      unsubscribeIntegrations();
    },
  };
  activations.set(config.sessionId, activation);
  return activation;
}

/**
 * The next pi active-tool list, merging the two halves of the set: pi's OWN
 * active tools (builtins, extension tools) and ours (the bridge). Bridge names
 * are recomputed from scratch every time, so they are dropped and re-added;
 * `extraBuiltin` are the builtins the persona activates on top of pi's default
 * four (`PI_SEARCH_BUILTIN_TOOLS`, Task-316) and must be re-asserted here
 * because a registry refresh can rebuild the active set from pi's defaults.
 * `planRestrictedBuiltin` names the default builtins removed in Plan and
 * re-asserted in Build, so a Plan → Build flip restores them even though they
 * are no longer present in `current`.
 *
 * Pure and exported for tests: `setActiveToolsByName` silently ignores names it
 * does not know, so a mistake in this merge fails quietly in a live session.
 * The result is stable under repeated application (feed it back as `current`),
 * which is what keeps pi's rebuilt system prompt cache-stable across
 * activations.
 */
export function mergedActiveToolNames(input: {
  /** What pi reports as active right now. */
  current: Iterable<string>;
  /** Every bridge (app) tool name, active or not. */
  bridgeToolNames: ReadonlySet<string>;
  /** Extra pi builtins this persona keeps active. */
  extraBuiltin: Iterable<string>;
  /** Builtins removed in Plan and restored in Build. */
  planRestrictedBuiltin: Iterable<string>;
  mode: SessionMode;
  /** The bridge names that should be active now. */
  activeBridge: Iterable<string>;
}): string[] {
  const active = new Set(input.current);
  for (const name of input.bridgeToolNames) active.delete(name);
  for (const name of input.planRestrictedBuiltin) {
    if (input.mode === "plan") active.delete(name);
    else active.add(name);
  }
  for (const name of input.extraBuiltin) active.add(name);
  for (const name of input.activeBridge) active.add(name);
  return [...active];
}

/**
 * Reopen seed: only names both deferred-loaded and actually called somewhere
 * in the transcript. Reopen is cold by construction, so carrying never-used
 * historical definitions has no cache benefit.
 */
export function loadedToolNamesFromMessages(
  messages: ReadonlyArray<unknown>,
): string[] {
  const loaded = new Set<string>();
  const called = calledToolNamesFromMessages(messages);
  for (const message of messages) {
    const record = message as {
      role?: unknown;
      toolName?: unknown;
      addedToolNames?: unknown;
      content?: unknown;
    };
    if (record.role === "toolResult" && Array.isArray(record.addedToolNames))
      for (const name of record.addedToolNames)
        if (typeof name === "string") loaded.add(name);
  }
  return [...loaded].filter((name) => called.has(name));
}

/** Every app tool called in a pi transcript, for inspector diagnostics. */
export function calledToolNamesFromMessages(
  messages: ReadonlyArray<unknown>,
): Set<string> {
  const called = new Set<string>();
  for (const message of messages) {
    const record = message as {
      role?: unknown;
      toolName?: unknown;
      content?: unknown;
    };
    if (record.role === "toolResult" && typeof record.toolName === "string")
      called.add(record.toolName);
    if (record.role === "assistant" && Array.isArray(record.content))
      for (const block of record.content) {
        const call = block as { type?: unknown; name?: unknown };
        if (call.type === "toolCall" && typeof call.name === "string")
          called.add(call.name);
      }
  }
  return called;
}
