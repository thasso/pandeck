/**
 * `find_tools` — the pi-harness loader for deferred catalog tools.
 *
 * Exact `names` activation bypasses search. Query discovery uses whole-token,
 * catalog-relative scoring and either activates a small coherent result or
 * returns cheap candidates for a second exact call. Activation happens inside
 * execute so pi records native deferred definitions on this tool result.
 */
import { defineAgentTool, jsonResult, type AgentTool } from "../mcp/tool.ts";
import { FIND_TOOLS_NAME } from "../mcp/names.ts";
import type { AgentType } from "@assistant/shared";
import { toolGroupsFor, type ToolGroup } from "./catalog.ts";

const FIND_TOOLS_DEFAULT_LIMIT = 4;
const FIND_TOOLS_MAX_LIMIT = 8;
const SCORE_FLOOR = 4;
const RELATIVE_SCORE_THRESHOLD = 0.5;
const MAX_GROUPS = 2;

/** Per-session activation surface the pi wiring provides. */
export interface FindToolsHost {
  agentType: AgentType;
  usableToolNames(): ReadonlySet<string>;
  activeToolNames(): ReadonlySet<string>;
  activate(names: string[]): string[];
}

interface ScoredTool {
  tool: { name: string; description: string; searchHint?: string };
  group: ToolGroup;
  score: number;
  nameMatches: number;
  specificNameMatches: number;
  phraseMatches: number;
}

/** Whole-word normalization shared by query and catalog documents. */
function toolSearchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .map((token) => {
      if (token.endsWith("ies") && token.length > 4)
        return `${token.slice(0, -3)}y`;
      if (token.endsWith("ing") && token.length > 5) {
        const root = token.slice(0, -3);
        return root.at(-1) === root.at(-2) ? root.slice(0, -1) : root;
      }
      if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
      if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
      return token;
    });
}

function bigrams(tokens: readonly string[]): Set<string> {
  return new Set(tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`));
}

function scoreCatalog(candidates: ScoredTool[], queryTokens: string[]): void {
  const documents = candidates.map(
    (candidate) =>
      new Set(
        toolSearchTokens(
          `${candidate.tool.name} ${candidate.tool.description} ${candidate.tool.searchHint ?? ""} ${candidate.group.id} ${candidate.group.label} ${candidate.group.description} ${candidate.group.searchHint ?? ""}`,
        ),
      ),
  );
  const documentFrequency = new Map<string, number>();
  for (const document of documents)
    for (const token of document)
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const idf = (token: string) =>
    Math.log(
      (candidates.length + 1) / ((documentFrequency.get(token) ?? 0) + 1),
    ) + 1;
  // Catalog-wide common terms become stopwords automatically. This avoids a
  // hand-maintained language list while retaining every discriminating noun.
  const discriminating = queryTokens.filter(
    (token) =>
      (documentFrequency.get(token) ?? 0) / Math.max(1, candidates.length) <=
      0.35,
  );
  const effectiveQuery =
    discriminating.length > 0 ? discriminating : queryTokens;
  const query = [...new Set(effectiveQuery)];
  const queryBigrams = bigrams(effectiveQuery);

  for (const candidate of candidates) {
    const nameTokens = new Set(toolSearchTokens(candidate.tool.name));
    const toolTokens = toolSearchTokens(
      `${candidate.tool.name} ${candidate.tool.description} ${candidate.tool.searchHint ?? ""}`,
    );
    const toolSet = new Set(toolTokens);
    const groupTokens = toolSearchTokens(
      `${candidate.group.id} ${candidate.group.label} ${candidate.group.description} ${candidate.group.searchHint ?? ""}`,
    );
    const groupSet = new Set(groupTokens);
    let score = 0;
    let groupMatches = 0;
    let nameMatches = 0;
    let specificNameMatches = 0;
    let phraseMatches = 0;
    for (const token of query) {
      const weight = idf(token);
      if (nameTokens.has(token)) {
        score += 6 * weight;
        nameMatches += 1;
        if (
          (documentFrequency.get(token) ?? 0) /
            Math.max(1, candidates.length) <=
          0.1
        )
          specificNameMatches += 1;
      } else if (toolSet.has(token)) score += 2 * weight;
      if (groupSet.has(token)) {
        score += 0.75 * weight;
        groupMatches += 1;
      }
    }
    const toolBigrams = bigrams(toolTokens);
    const groupBigrams = bigrams(groupTokens);
    for (const phrase of queryBigrams) {
      const phraseWeight =
        phrase.split(" ").reduce((sum, token) => sum + idf(token), 0) / 2;
      if (toolBigrams.has(phrase)) {
        score += 2.5 * phraseWeight;
        phraseMatches += 1;
      }
      if (groupBigrams.has(phrase)) {
        // A phrase in curated family metadata is stronger than isolated words
        // from a long schema description. This keeps "already know" on the KB
        // reads ahead of a generic name hit on "project".
        score += 5 * phraseWeight;
        phraseMatches += 1;
      }
    }
    // A query matching several terms from one group is stronger than unrelated
    // tools independently accumulating generic vocabulary.
    score += groupMatches * groupMatches * 0.2;
    candidate.score = score;
    candidate.nameMatches = nameMatches;
    candidate.specificNameMatches = specificNameMatches;
    candidate.phraseMatches = phraseMatches;
  }
}

/** Deterministic scored rows used by the loader, tests, and measurement. */
export function rankToolSearch(
  agentType: AgentType,
  query: string,
): Array<{ name: string; group: string; score: number }> {
  const candidates = toolGroupsFor(agentType).flatMap((group) =>
    group.tools.map((tool) => emptyScoredTool(tool, group)),
  );
  scoreCatalog(candidates, toolSearchTokens(query));
  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((candidate) => ({
      name: candidate.tool.name,
      group: candidate.group.id,
      score: candidate.score,
    }));
}

function emptyScoredTool(
  tool: ScoredTool["tool"],
  group: ToolGroup,
): ScoredTool {
  return {
    tool,
    group,
    score: 0,
    nameMatches: 0,
    specificNameMatches: 0,
    phraseMatches: 0,
  };
}

function hasDirectEvidence(candidate: ScoredTool): boolean {
  return (
    candidate.nameMatches >= 2 ||
    candidate.specificNameMatches > 0 ||
    candidate.phraseMatches > 0
  );
}

function unavailableReason(group: ToolGroup): string {
  return group.gate
    ? `The ${group.label} integration is disabled — it can be enabled in Settings.`
    : "Currently unavailable for this session.";
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}

/** Build the per-session `find_tools` loader over the activation host. */
export function createFindToolsTool(host: FindToolsHost): AgentTool {
  const groups = toolGroupsFor(host.agentType);
  const catalog = groups.flatMap((group) =>
    group.tools.map((tool) => emptyScoredTool(tool, group)),
  );
  const byName = new Map(
    catalog.map((candidate) => [candidate.tool.name, candidate]),
  );

  return defineAgentTool<{ query?: string; names?: string[]; limit?: number }>({
    name: FIND_TOOLS_NAME,
    label: "Find Tools",
    description:
      "Search this session's full tool catalog and load matching tools. Most integrations and specialized capabilities are deferred. Search by a specific capability; a low-confidence search returns candidates without loading them, then call again with names for exact activation. Use names whenever tool ids are known. Search here BEFORE telling the user a capability is missing.",
    executionMode: "sequential",
    sideEffects: "none",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Capability or task to search for, e.g. 'calendar events'.",
        },
        names: {
          type: "array",
          items: { type: "string" },
          maxItems: FIND_TOOLS_MAX_LIMIT,
          description:
            "Exact tool names to activate, bypassing search. Unknown and disabled names are reported.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_TOOLS_MAX_LIMIT,
          default: FIND_TOOLS_DEFAULT_LIMIT,
        },
      },
      additionalProperties: false,
    },
    async execute(params) {
      const limit = Math.max(
        1,
        Math.min(
          FIND_TOOLS_MAX_LIMIT,
          params.limit ?? FIND_TOOLS_DEFAULT_LIMIT,
        ),
      );
      const requestedNames = [
        ...new Set(
          (Array.isArray(params.names) ? params.names : [])
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ];
      if (requestedNames.length > FIND_TOOLS_MAX_LIMIT)
        throw new Error(
          `find_tools accepts at most ${FIND_TOOLS_MAX_LIMIT} exact names.`,
        );
      if (requestedNames.length > 0)
        return activateMatches(requestedNames, true);

      const queryTokens = toolSearchTokens(params.query ?? "");
      if (queryTokens.length === 0)
        throw new Error("find_tools needs a non-empty query or names array.");
      scoreCatalog(catalog, queryTokens);
      const ranked = catalog
        .filter((candidate) => candidate.score > 0)
        .sort(
          (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
        );
      const top = ranked[0]?.score ?? 0;
      const relevant = ranked.filter(
        (candidate) =>
          candidate.score >= SCORE_FLOOR &&
          candidate.score >= top * RELATIVE_SCORE_THRESHOLD,
      );
      const relevantGroups = [
        ...new Set(relevant.map((candidate) => candidate.group.id)),
      ];
      const first = relevant[0];
      const firstGroup = first?.group.id;
      const selectedGroups = firstGroup ? [firstGroup] : [];
      for (const groupId of relevantGroups.slice(1)) {
        if (selectedGroups.length >= MAX_GROUPS) break;
        const groupCandidates = relevant.filter(
          (candidate) => candidate.group.id === groupId,
        );
        // A lone above-threshold straggler must not displace a coherent family.
        // Multi-family intent remains possible when a second family contributes
        // several results and carries direct name/phrase evidence.
        if (
          groupCandidates.length >= 2 &&
          groupCandidates.some(hasDirectEvidence)
        )
          selectedGroups.push(groupId);
      }
      const coherent = relevant.filter((candidate) =>
        selectedGroups.includes(candidate.group.id),
      );
      const competing = first
        ? relevant.find((candidate) => candidate.group.id !== first.group.id)
        : undefined;
      const ambiguous =
        !!first &&
        !!competing &&
        !hasDirectEvidence(first) &&
        competing.score >= first.score * 0.9;
      const resultCandidates = ranked.slice(0, limit).map((candidate) => ({
        name: candidate.tool.name,
        group: candidate.group.label,
        summary: oneLine(candidate.tool.description),
      }));

      if (coherent.length === 0 || ambiguous) {
        return jsonResult({
          query: params.query,
          loaded: [],
          candidates: resultCandidates,
          note:
            resultCandidates.length > 0
              ? "Low-confidence search: no tools were loaded. Call find_tools again with names to activate the intended candidates exactly."
              : "No matching tools found. Try different, more specific capability keywords.",
        });
      }
      return activateMatches(
        coherent.slice(0, limit).map((candidate) => candidate.tool.name),
        false,
      );

      function activateMatches(names: string[], exact: boolean) {
        const usable = host.usableToolNames();
        const active = host.activeToolNames();
        const toLoad: string[] = [];
        const alreadyActive: string[] = [];
        const unavailable: Array<{
          tool: string;
          group?: string;
          how: string;
        }> = [];
        for (const name of names) {
          const candidate = byName.get(name);
          if (!candidate) {
            unavailable.push({
              tool: name,
              how: "Unknown tool name for this session.",
            });
          } else if (active.has(name)) {
            alreadyActive.push(name);
          } else if (!usable.has(name)) {
            unavailable.push({
              tool: name,
              group: candidate.group.label,
              how: unavailableReason(candidate.group),
            });
          } else {
            toLoad.push(name);
          }
        }
        const loaded = toLoad.length > 0 ? host.activate(toLoad) : [];
        return jsonResult({
          ...(exact ? { names } : { query: params.query }),
          loaded,
          ...(alreadyActive.length > 0 ? { alreadyActive } : {}),
          ...(unavailable.length > 0 ? { unavailable } : {}),
          note:
            loaded.length > 0
              ? "These tools are now available and can be called directly. Re-run a specific search or use names if another capability is needed."
              : unavailable.length === 0
                ? "All matching tools were already active."
                : "No requested tools were activated; inspect unavailable and retry with valid names or enable the integration.",
        });
      }
    },
  });
}
