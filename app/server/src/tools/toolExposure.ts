/**
 * Harness-neutral builder for a session's {@link SessionToolExposure}
 * projection (the Inspector "Tools" section): every catalog tool of the
 * persona with its group, loading tier, current usability
 * (gates/approval), and whether its definition is LOADED into the model
 * context right now. Each harness supplies its own loaded-set semantics —
 * pi's active set, Claude's `getContextUsage()` isLoaded flags — plus the
 * bounded load-event trail it recorded.
 */
import type {
  SessionToolExposure,
  SessionToolExposureTool,
  SessionToolLoadEvent,
  AgentType,
} from "@assistant/shared";
import { toolGroupsFor } from "./catalog.ts";
import { FIND_TOOLS_NAME } from "../mcp/names.ts";

export interface BuildToolExposureInput {
  agentType: AgentType;
  /** Names currently usable (integration gates + tool-group approval applied). */
  usableToolNames: ReadonlySet<string>;
  /** Names whose definitions are in the model context right now. */
  loadedToolNames: ReadonlySet<string>;
  /** Names this transcript has actually called. */
  usedToolNames?: ReadonlySet<string>;
  /** Exact definition chars overrides (notably the out-of-catalog pi loader). */
  definitionCharsByName?: ReadonlyMap<string, number>;
  /** Per-tool definition token sizes, when the harness knows them. */
  tokensByName?: ReadonlyMap<string, number>;
  /** Whether this session carries the pi `find_tools` loader. */
  includeFindTools?: boolean;
  loadEvents: readonly SessionToolLoadEvent[];
}

const LOAD_EVENT_LIMIT = 50;

export function buildToolExposure(
  input: BuildToolExposureInput,
): SessionToolExposure {
  const tools: SessionToolExposureTool[] = [];
  if (input.includeFindTools) {
    tools.push({
      name: FIND_TOOLS_NAME,
      group: "loader",
      groupLabel: "Tool loader",
      loading: "eager",
      usable: true,
      loaded: true,
      definitionChars: input.definitionCharsByName?.get(FIND_TOOLS_NAME) ?? 0,
      used: input.usedToolNames?.has(FIND_TOOLS_NAME) ?? false,
      ...tokensEntry(input.tokensByName, FIND_TOOLS_NAME),
    });
  }
  for (const group of toolGroupsFor(input.agentType)) {
    for (const tool of group.tools) {
      tools.push({
        name: tool.name,
        group: group.id,
        groupLabel: group.label,
        loading: group.loading,
        usable: input.usableToolNames.has(tool.name),
        loaded: input.loadedToolNames.has(tool.name),
        definitionChars:
          input.definitionCharsByName?.get(tool.name) ??
          toolDefinitionChars(tool),
        used: input.usedToolNames?.has(tool.name) ?? false,
        ...tokensEntry(input.tokensByName, tool.name),
      });
    }
  }
  // This diagnostic measures deferred-load waste. Eager definitions are a
  // fixed first-request cost and are neither discovered nor prune candidates.
  const loadedButUnused = tools.filter(
    (tool) => tool.loading === "deferred" && tool.loaded && !tool.used,
  );
  const counts = {
    total: tools.length,
    eager: tools.filter((tool) => tool.loading === "eager").length,
    usable: tools.filter((tool) => tool.usable).length,
    loaded: tools.filter((tool) => tool.loaded).length,
    loadedButUnused: loadedButUnused.length,
    loadedButUnusedDefinitionChars: loadedButUnused.reduce(
      (sum, tool) => sum + tool.definitionChars,
      0,
    ),
  };
  return {
    counts,
    tools,
    loadEvents: input.loadEvents.slice(-LOAD_EVENT_LIMIT),
  };
}

/** Wire-definition accounting shared with prompt/tool measurements. */
export function toolDefinitionChars(
  tool: {
    name: string;
    description: string;
    parameters: unknown;
  },
  wireName = tool.name,
): number {
  return (
    wireName.length +
    tool.description.length +
    JSON.stringify(tool.parameters).length
  );
}

function tokensEntry(
  tokensByName: ReadonlyMap<string, number> | undefined,
  name: string,
): { tokens?: number } {
  const tokens = tokensByName?.get(name);
  return tokens === undefined ? {} : { tokens };
}
