/**
 * Tests for the `find_tools` loader (`findTools.ts`): catalog search scoring,
 * additive activation through the host inside the execute window, already-
 * active reporting, and the unavailable path (integration gate off, including
 * the browser-raw-mcp gate).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallContext } from "../mcp/tool.ts";
import {
  createFindToolsTool,
  rankToolSearch,
  type FindToolsHost,
} from "./findTools.ts";
import { agentToolsFor, eagerToolNamesFor } from "./catalog.ts";

const CTX: ToolCallContext = {
  toolCallId: "find-1",
  session: { sessionId: "sess-find", harness: "pi", agentType: "assistant" },
};

interface HostState {
  host: FindToolsHost;
  activated: string[][];
}

function makeHost(
  overrides?: Partial<
    Pick<FindToolsHost, "usableToolNames" | "activeToolNames">
  >,
): HostState {
  const eager = eagerToolNamesFor("assistant");
  const all = new Set(agentToolsFor("assistant").map((tool) => tool.name));
  const activated: string[][] = [];
  const active = new Set(eager);
  const host: FindToolsHost = {
    agentType: "assistant",
    usableToolNames: () => all,
    activeToolNames: () => active,
    activate: (names) => {
      activated.push(names);
      for (const name of names) active.add(name);
      return names;
    },
    ...overrides,
  };
  return { host, activated };
}

async function run(
  host: FindToolsHost,
  queryOrParams: string | { query?: string; names?: string[]; limit?: number },
  limit?: number,
) {
  const tool = createFindToolsTool(host);
  const params =
    typeof queryOrParams === "string"
      ? { query: queryOrParams, ...(limit ? { limit } : {}) }
      : queryOrParams;
  const result = await tool.execute(params, CTX);
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? first.text : "{}") as {
    loaded?: string[];
    alreadyActive?: string[];
    unavailable?: Array<{ tool: string; group?: string; how: string }>;
    candidates?: Array<{ name: string; group: string; summary: string }>;
    note?: string;
  };
}

test("whole-token IDF scoring rejects the historical cross-family false positives", () => {
  for (const query of [
    "read another session transcript",
    "look at what another agent session did",
  ]) {
    const ranked = rankToolSearch("developer", query);
    assert.match(ranked[0]!.name, /^session_/);
    assert.ok(
      ranked.findIndex((row) => row.name === "jira_search_issues") > 3,
      JSON.stringify(ranked.slice(0, 8)),
    );
  }
});

test("loader guidance stays within its eager description budget", () => {
  const { host } = makeHost();
  assert.ok(createFindToolsTool(host).description.length <= 550);
});

test("ranks skill authoring for library skill intent", () => {
  const ranked = rankToolSearch(
    "assistant",
    "create and edit a skill in the skills library",
  );
  assert.ok(
    ranked.slice(0, 3).some((row) => row.name === "skill_create"),
    JSON.stringify(ranked.slice(0, 5)),
  );
  const history = rankToolSearch("workshop", "skill library git history diff");
  assert.ok(
    history.slice(0, 5).some((row) => row.name.startsWith("skill_")),
    JSON.stringify(history.slice(0, 5)),
  );
});

test("ranks the provider PR check watcher for wait-on-CI intent", () => {
  const github = rankToolSearch(
    "developer",
    "wait for GitHub pull request checks to finish and report merge readiness",
  );
  assert.equal(github[0]?.name, "github_watch_pull_request_checks");
  const forgejo = rankToolSearch(
    "developer",
    "watch Forgejo PR CI checks until complete",
  );
  assert.equal(forgejo[0]?.name, "forgejo_watch_pull_request_checks");
});

test("loads matching deferred tools through the host", async () => {
  const { host, activated } = makeHost();
  const payload = await run(host, "calendar events");
  assert.ok(
    payload.loaded?.includes("google_calendar_list_events"),
    JSON.stringify(payload),
  );
  assert.equal(activated.length, 1, "activation happened inside execute");
});

test("reports already-active tools instead of re-loading them", async () => {
  const { host } = makeHost();
  const payload = await run(host, "search long-term memory");
  assert.ok(
    payload.alreadyActive?.includes("memory_search"),
    JSON.stringify(payload),
  );
  assert.ok(!payload.loaded?.includes("memory_search"));
});

test("exact names bypass scoring and report unknown or gate-disabled names", async () => {
  const all = new Set(agentToolsFor("assistant").map((tool) => tool.name));
  all.delete("jira_get_issue");
  const { host, activated } = makeHost({ usableToolNames: () => all });
  const payload = await run(host, {
    names: ["session_read", "jira_get_issue", "not_a_tool"],
  });
  assert.deepEqual(payload.loaded, ["session_read"]);
  assert.deepEqual(activated, [["session_read"]]);
  assert.match(
    payload.unavailable!.find((entry) => entry.tool === "jira_get_issue")!.how,
    /Settings/,
  );
  assert.match(
    payload.unavailable!.find((entry) => entry.tool === "not_a_tool")!.how,
    /Unknown/,
  );
});

test("structured names reliably activates the workflow result tool", async () => {
  const all = new Set(agentToolsFor("developer").map((tool) => tool.name));
  const active = eagerToolNamesFor("developer");
  const tool = createFindToolsTool({
    agentType: "developer",
    usableToolNames: () => all,
    activeToolNames: () => active,
    activate: (names) => names,
  });
  const result = await tool.execute({ names: ["session_submit_result"] }, CTX);
  const first = result.content[0];
  const payload = JSON.parse(first?.type === "text" ? first.text : "{}");
  assert.deepEqual(payload.loaded, ["session_submit_result"]);
});

test("durable project knowledge intent does not activate registries or write tools", async () => {
  const all = new Set(agentToolsFor("developer").map((tool) => tool.name));
  const active = eagerToolNamesFor("developer");
  const tool = createFindToolsTool({
    agentType: "developer",
    usableToolNames: () => all,
    activeToolNames: () => active,
    activate: (names) => names,
  });
  const result = await tool.execute(
    { query: "what do we already know about this project" },
    CTX,
  );
  const first = result.content[0];
  const payload = JSON.parse(first?.type === "text" ? first.text : "{}") as {
    loaded?: string[];
  };
  assert.deepEqual(payload.loaded, ["kb_get_entry", "kb_search"]);
});

test("a session transcript query loads only a small coherent session set", async () => {
  const { host } = makeHost();
  const payload = await run(host, "read another agent session transcript");
  assert.ok(payload.loaded?.includes("session_read"), JSON.stringify(payload));
  assert.ok((payload.loaded?.length ?? 0) <= 4);
  for (const name of payload.loaded ?? [])
    assert.match(name, /^session_/, `unrelated tool loaded: ${name}`);
});

test("canonical session inspection query keeps the default load in one family", async () => {
  const { host } = makeHost();
  const payload = await run(
    host,
    "list and inspect recent agent sessions including worktree path, prompts, commands, and outcomes",
  );
  assert.ok(payload.loaded?.includes("session_read"), JSON.stringify(payload));
  assert.ok((payload.loaded?.length ?? 0) <= 4);
  for (const name of payload.loaded ?? [])
    assert.match(name, /^session_/, `unrelated tool loaded: ${name}`);
});

test("an ambiguous broad search returns candidates without activation", async () => {
  const { host, activated } = makeHost();
  const payload = await run(host, "find relevant documents and messages");
  assert.deepEqual(payload.loaded, []);
  assert.ok((payload.candidates?.length ?? 0) > 0, JSON.stringify(payload));
  assert.equal(activated.length, 0);
  assert.match(payload.note ?? "", /names/);
});

test("a search with zero matches suggests new keywords instead of exact names", async () => {
  const { host, activated } = makeHost();
  const payload = await run(host, "xyzzy quux frobnicator");
  assert.deepEqual(payload.loaded, []);
  assert.deepEqual(payload.candidates, []);
  assert.equal(activated.length, 0);
  assert.match(payload.note ?? "", /keywords/);
  assert.doesNotMatch(payload.note ?? "", /with names/);
});

test("gate-disabled integrations are reported with the Settings path, not activated", async () => {
  const { host, activated } = makeHost({
    usableToolNames: () => new Set<string>(), // every gate off
  });
  const payload = await run(host, "jira issue");
  assert.equal(activated.length, 0);
  const jira = payload.unavailable?.find((entry) =>
    entry.tool.startsWith("jira_"),
  );
  assert.ok(jira, JSON.stringify(payload));
  assert.match(jira!.how, /Settings/);
});

test("browser tool group is directly loadable (no approval step)", async () => {
  const eager = eagerToolNamesFor("workshop");
  const all = new Set(agentToolsFor("workshop").map((tool) => tool.name));
  const active = new Set(eager);
  const host: FindToolsHost = {
    agentType: "workshop",
    usableToolNames: () => all,
    activeToolNames: () => active,
    activate: (names) => {
      for (const name of names) active.add(name);
      return names;
    },
  };
  const payload = await run(host, "browser screenshot page");
  assert.ok(
    payload.loaded?.includes("browser_screenshot"),
    JSON.stringify(payload),
  );
});

test("gate-disabled browser-raw-mcp points at Settings, not a separate approval tool", async () => {
  const eager = eagerToolNamesFor("workshop");
  const all = new Set(agentToolsFor("workshop").map((tool) => tool.name));
  all.delete("browser_mcp_call"); // gate off
  const active = new Set(eager);
  const host: FindToolsHost = {
    agentType: "workshop",
    usableToolNames: () => all,
    activeToolNames: () => active,
    activate: (names) => names,
  };
  const payload = await run(host, "raw playwright mcp call escape hatch");
  const rawMcp = payload.unavailable?.find(
    (entry) => entry.tool === "browser_mcp_call",
  );
  assert.ok(rawMcp, JSON.stringify(payload));
  assert.match(rawMcp!.how, /Settings/);
});

test("rejects an empty query and caps the limit", async () => {
  const { host } = makeHost();
  const tool = createFindToolsTool(host);
  await assert.rejects(() => tool.execute({ query: "  " }, CTX), /non-empty/);
  const payload = await run(
    host,
    "google gmail drive calendar meet slack jira tempo github web",
    8,
  );
  assert.ok((payload.loaded?.length ?? 0) <= 8);
});
