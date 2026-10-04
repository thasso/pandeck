/**
 * Tests for the per-session pi tool activation (`toolActivation.ts`):
 * initial eager active set, find_tools additive activation, transcript
 * `addedToolNames` seeding on reopen, and prompt-cache prefix stability across
 * activation (asserted against pi's real buildSystemPrompt).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolCallContext } from "../mcp/tool.ts";
import {
  createPiToolActivation,
  loadedToolNamesFromMessages,
  mergedActiveToolNames,
  toolExposureForSession,
  UNUSED_TOOL_PRUNE_IDLE_MS,
} from "./toolActivation.ts";
import { sessionToolExposure } from "../tools/sessionToolExposure.ts";
import {
  loadPiPromptBuilder,
  piBuiltinPromptTools,
  piPromptExtras,
} from "./piPromptMeasure.ts";
import { FIND_TOOLS_NAME } from "../mcp/names.ts";
import { agentToolsFor, eagerToolNamesFor } from "../tools/catalog.ts";
import {
  buildAgentOptions,
  PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
  PI_SEARCH_BUILTIN_TOOLS,
} from "./options.ts";

const CTX: ToolCallContext = {
  toolCallId: "act-1",
  session: {
    sessionId: "sess-activation",
    harness: "pi",
    agentType: "assistant",
  },
};

function assistantActivation(
  applied: Array<ReadonlySet<string>>,
  loadedSeed: string[] = [],
) {
  const activation = createPiToolActivation({
    sessionId: `activation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    agentType: "assistant",
    agentTools: agentToolsFor("assistant"),
    eagerToolNames: eagerToolNamesFor("assistant"),
    deferToolLoading: true,
    applyActiveToolNames: (names) => applied.push(new Set(names)),
  });
  activation.initialize(loadedSeed);
  return activation;
}

test("initial active set is eager + find_tools; deferred tools stay out", () => {
  const applied: Array<ReadonlySet<string>> = [];
  const activation = assistantActivation(applied);
  try {
    const initial = applied[applied.length - 1]!;
    assert.ok(initial.has("current_time"));
    assert.ok(initial.has("memory_search"));
    assert.ok(initial.has("find_tools"));
    assert.equal(initial.has("web_search"), false);
    assert.equal(initial.has("kb_search"), false, "Task-286: KB reads defer");
    assert.equal(initial.has("kb_write_entry"), false);
    assert.equal(initial.has("session_send_prompt"), false);
  } finally {
    activation.dispose();
  }
});

test("Plan keeps Task mutations but removes other side-effecting app tools", () => {
  const applied: Array<ReadonlySet<string>> = [];
  let mode: "build" | "plan" = "build";
  const activation = createPiToolActivation({
    sessionId: `mode-activation-${Date.now()}`,
    agentType: "assistant",
    agentTools: agentToolsFor("assistant"),
    eagerToolNames: eagerToolNamesFor("assistant"),
    deferToolLoading: true,
    mode: () => mode,
    applyActiveToolNames: (names) => applied.push(new Set(names)),
  });
  try {
    activation.initialize(["kb_get_entry", "kb_write_entry"]);
    const build = applied.at(-1)!;
    assert.ok(build.has("task_read"));
    assert.ok(build.has("task_manage"));
    assert.ok(build.has("kb_get_entry"));
    assert.ok(build.has("kb_write_entry"));

    mode = "plan";
    activation.reapply();
    const plan = applied.at(-1)!;
    assert.ok(plan.has("task_read"));
    assert.ok(plan.has("kb_get_entry"));
    assert.ok(plan.has("find_tools"));
    assert.ok(plan.has("task_manage"), "Plan permits durable Task mutations");
    assert.equal(plan.has("kb_write_entry"), false);

    mode = "build";
    activation.reapply();
    assert.deepEqual(applied.at(-1), build);
  } finally {
    activation.dispose();
  }
});

test("find_tools activates deferred tools additively inside its execute window", async () => {
  const applied: Array<ReadonlySet<string>> = [];
  const activation = assistantActivation(applied);
  try {
    const findTools = activation.piToolUniverse.find(
      (tool) => tool.name === "find_tools",
    )!;
    const before = applied.length;
    const result = await findTools.execute(
      { query: "fetch a public web page" },
      CTX,
    );
    const payload = JSON.parse(
      (result.content[0] as { text: string }).text,
    ) as { loaded?: string[] };
    assert.ok(payload.loaded?.includes("web_fetch"), JSON.stringify(payload));
    assert.ok(applied.length > before, "activation applied during execute");
    const latest = applied[applied.length - 1]!;
    assert.ok(latest.has("web_fetch"));
    assert.ok(
      latest.has("current_time"),
      "eager tools stay active (additive change)",
    );
  } finally {
    activation.dispose();
  }
});

test("a durable-knowledge query reaches the deferred KB reads in one find_tools call", async () => {
  // Task-286 deferred `knowledge-core`, so a KB lookup now costs exactly one
  // discovery round trip. These are the phrasings the eager KB pointer steers
  // a session to ("find them with a tool search for 'knowledge base'") plus the
  // ones a user question produces directly.
  for (const query of [
    "knowledge base",
    "search the knowledge base for durable knowledge",
    "what do we already know about this project",
    "read a knowledge base entry",
  ]) {
    const applied: Array<ReadonlySet<string>> = [];
    const activation = assistantActivation(applied);
    try {
      const findTools = activation.piToolUniverse.find(
        (tool) => tool.name === FIND_TOOLS_NAME,
      )!;
      const result = await findTools.execute({ query }, CTX);
      const payload = JSON.parse(
        (result.content[0] as { text: string }).text,
      ) as { loaded?: string[] };
      assert.ok(
        payload.loaded?.includes("kb_search") ||
          payload.loaded?.includes("kb_get_entry"),
        `"${query}" did not discover the KB read tools: ${JSON.stringify(payload)}`,
      );
      if (query === "what do we already know about this project")
        assert.deepEqual(
          payload.loaded,
          ["kb_get_entry", "kb_search"],
          `durable-knowledge read intent loaded another family or a write tool: ${JSON.stringify(payload)}`,
        );
      assert.ok(applied.at(-1)!.has("current_time"), "activation is additive");
    } finally {
      activation.dispose();
    }
  }
});

test("transcript addedToolNames seed keeps previously loaded tools active on reopen", () => {
  const applied: Array<ReadonlySet<string>> = [];
  const activation = assistantActivation(applied, [
    "web_search",
    "kb_write_entry",
  ]);
  try {
    const initial = applied[applied.length - 1]!;
    assert.ok(initial.has("web_search"));
    assert.ok(initial.has("kb_write_entry"));
    assert.equal(initial.has("jira_get_issue"), false);
  } finally {
    activation.dispose();
  }
});

test("loadedToolNamesFromMessages reads toolResult addedToolNames only", () => {
  const names = loadedToolNamesFromMessages([
    { role: "user", content: "hi" },
    {
      role: "toolResult",
      toolName: "find_tools",
      addedToolNames: ["web_search", "web_fetch"],
    },
    { role: "toolResult", toolName: "web_search" },
    { role: "assistant", addedToolNames: ["bogus"] },
    {
      role: "toolResult",
      toolName: "some_other_tool",
      addedToolNames: ["browser_navigate", 42],
    },
  ]);
  assert.deepEqual(names, ["web_search"]);
});

test("never-used loads prune only after six idle hours; called tools survive", async () => {
  const applied: Array<ReadonlySet<string>> = [];
  const activation = assistantActivation(applied);
  try {
    const findTools = activation.piToolUniverse.find(
      (tool) => tool.name === FIND_TOOLS_NAME,
    )!;
    await findTools.execute({ names: ["web_search", "session_read"] }, CTX);
    activation.markUsed("session_read");
    assert.deepEqual(
      activation.onUserTurnStart(UNUSED_TOOL_PRUNE_IDLE_MS - 1),
      [],
    );
    assert.ok(applied.at(-1)!.has("web_search"));
    assert.deepEqual(activation.onUserTurnStart(UNUSED_TOOL_PRUNE_IDLE_MS), [
      "web_search",
    ]);
    assert.equal(applied.at(-1)!.has("web_search"), false);
    assert.ok(applied.at(-1)!.has("session_read"));
    assert.ok(applied.at(-1)!.has(FIND_TOOLS_NAME));
    assert.ok(applied.at(-1)!.has("current_time"));
  } finally {
    activation.dispose();
  }
});

test("coding personas activate pi's search builtins; assistant personas get none", async () => {
  // Task-316: pi registers all seven builtin DEFINITIONS but activates only
  // read/bash/edit/write, so grep/find ride the built-in half of piStore's
  // active-set merge. Never a `tools:` allowlist (see options.ts). `ls` stays
  // deactivated — Task-319 serves it as an app tool through the bridge instead.
  for (const agentType of ["developer", "workshop"] as const) {
    const opts = await buildAgentOptions(agentType, process.cwd());
    // `ls` is the app tool, eager on the bridge side (Task-319). It SHADOWS pi's
    // same-named builtin in pi's name-keyed registry, so listing the builtin
    // here would be dead config the prompt inventory still prices — not a
    // duplicate tool (see PI_SEARCH_BUILTIN_TOOLS for the ordering).
    assert.ok(
      !opts.extraBuiltinToolNames.includes("ls"),
      `${agentType} must not list pi's shadowed ls builtin next to the app tool`,
    );
    assert.ok(
      opts.eagerToolNames.has("ls"),
      `${agentType} must carry the app-side ls tool eagerly`,
    );
    assert.deepEqual(
      opts.extraBuiltinToolNames,
      [...PI_SEARCH_BUILTIN_TOOLS],
      `${agentType} must activate pi's bounded search builtins`,
    );
    assert.equal(opts.noTools, undefined);
  }
  for (const agentType of ["assistant", "personal-assistant"] as const) {
    const opts = await buildAgentOptions(agentType, process.cwd());
    assert.deepEqual(
      opts.extraBuiltinToolNames,
      [],
      `${agentType} has no pi builtins at all`,
    );
    assert.equal(opts.noTools, "builtin");
  }
});

test("the pi active-set merge keeps builtins, extras and active bridge names", () => {
  // The four lines this feature actually runs through in `piStore.create`.
  // `setActiveToolsByName` ignores names it does not know, so a mistake here is
  // silent in a live session — assert the merge itself.
  // `ls` is in the BRIDGE half since Task-319 (an app tool), not the builtin one.
  const bridge = new Set(["ls", "current_time", "web_fetch", "find_tools"]);
  const merged = mergedActiveToolNames({
    current: ["read", "bash", "edit", "write", "current_time", "web_fetch"],
    bridgeToolNames: bridge,
    extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
    planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
    mode: "build",
    activeBridge: ["ls", "current_time", "find_tools"],
  });
  assert.deepEqual(merged, [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "current_time",
    "find_tools",
  ]);
  assert.equal(
    merged.includes("web_fetch"),
    false,
    "a bridge tool that is no longer active must be dropped, not carried",
  );

  // Idempotence: pi rebuilds the whole system prompt from the active set, so a
  // repeated apply must produce the SAME list or the cache prefix moves.
  assert.deepEqual(
    mergedActiveToolNames({
      current: merged,
      bridgeToolNames: bridge,
      extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
      planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
      mode: "build",
      activeBridge: ["ls", "current_time", "find_tools"],
    }),
    merged,
  );

  // A registry refresh that resets pi to its default four: the extras come back.
  assert.deepEqual(
    mergedActiveToolNames({
      current: ["read", "bash", "edit", "write"],
      bridgeToolNames: bridge,
      extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
      planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
      mode: "build",
      activeBridge: [],
    }),
    ["read", "bash", "edit", "write", "grep", "find"],
  );

  // An assistant persona: no builtins to start with, none added.
  assert.deepEqual(
    mergedActiveToolNames({
      current: ["current_time"],
      bridgeToolNames: bridge,
      extraBuiltin: [],
      planRestrictedBuiltin: [],
      mode: "build",
      activeBridge: ["current_time", "find_tools"],
    }),
    ["current_time", "find_tools"],
  );

  // Plan removes only edit/write from the BUILTIN half. Search, shell, reads,
  // and every currently active bridge tool remain available.
  const plan = mergedActiveToolNames({
    current: merged,
    bridgeToolNames: bridge,
    extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
    planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
    mode: "plan",
    activeBridge: ["ls", "current_time", "find_tools"],
  });
  assert.deepEqual(plan, [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "current_time",
    "find_tools",
  ]);
  assert.deepEqual(
    mergedActiveToolNames({
      current: plan,
      bridgeToolNames: bridge,
      extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
      planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
      mode: "plan",
      activeBridge: ["ls", "current_time", "find_tools"],
    }),
    plan,
    "Plan remains stable under repeated application",
  );

  const restoredBuild = mergedActiveToolNames({
    current: plan,
    bridgeToolNames: bridge,
    extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
    planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
    mode: "build",
    activeBridge: ["ls", "current_time", "find_tools"],
  });
  assert.ok(restoredBuild.includes("edit"));
  assert.ok(restoredBuild.includes("write"));
  assert.deepEqual(
    mergedActiveToolNames({
      current: restoredBuild,
      bridgeToolNames: bridge,
      extraBuiltin: PI_SEARCH_BUILTIN_TOOLS,
      planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
      mode: "build",
      activeBridge: ["ls", "current_time", "find_tools"],
    }),
    restoredBuild,
    "Build remains stable after restoring the restricted tools",
  );
});

test("piBuiltinPromptTools excludes definitions shadowed on the wire", () => {
  // Bash is priced once as the provider-native app shadow, not again as pi's
  // inactive builtin definition.
  assert.deepEqual(
    piBuiltinPromptTools(process.cwd()).map((tool) => tool.name),
    ["read", "edit", "write", ...PI_SEARCH_BUILTIN_TOOLS],
  );
});

test("no app tool carries pi prompt extras, on either tier", () => {
  // Task-282 deleted the concept, so pi's "Available tools:" and "Guidelines:"
  // lists are built from pi's builtins alone. This is what makes the prompt
  // constant across activation (see the next test).
  for (const agentType of ["assistant", "developer"] as const) {
    const extras = piPromptExtras(agentToolsFor(agentType));
    assert.deepEqual(
      extras.toolSnippets,
      {},
      `${agentType}: an app tool reintroduced promptSnippet`,
    );
    assert.deepEqual(
      extras.promptGuidelines,
      [],
      `${agentType}: an app tool reintroduced promptGuidelines`,
    );
  }
});

test("activating a deferred tool leaves pi's system prompt byte-identical", async () => {
  // pi rebuilds the WHOLE system prompt inside setActiveToolsByName. Asserted
  // against pi's real buildSystemPrompt rather than assumed (Task-282).
  const agentType = "developer";
  const applied: Array<ReadonlySet<string>> = [];
  const activation = createPiToolActivation({
    sessionId: `activation-prefix-${Date.now()}`,
    agentType,
    agentTools: agentToolsFor(agentType),
    eagerToolNames: eagerToolNamesFor(agentType),
    deferToolLoading: true,
    applyActiveToolNames: (names) => applied.push(new Set(names)),
  });
  try {
    activation.initialize([]);
    const builder = await loadPiPromptBuilder();
    const cwd = process.cwd();
    const builtins = piBuiltinPromptTools(cwd);
    const promptFor = (active: ReadonlySet<string>) => {
      const activeTools = activation.piToolUniverse.filter((tool) =>
        active.has(tool.name),
      );
      const extras = piPromptExtras([...builtins, ...activeTools]);
      return builder.build({
        cwd,
        contextFiles: [],
        selectedTools: [
          ...builtins.map((tool) => tool.name),
          ...[...active].sort(),
        ],
        toolSnippets: extras.toolSnippets,
        promptGuidelines: extras.promptGuidelines,
      });
    };

    const before = promptFor(applied.at(-1)!);
    const loaded = await activation.piToolUniverse
      .find((tool) => tool.name === FIND_TOOLS_NAME)!
      .execute({ query: "read another session log" }, CTX);
    const after = promptFor(applied.at(-1)!);

    const payload = JSON.parse(
      (loaded.content[0] as { text: string }).text,
    ) as { loaded?: string[] };
    assert.ok(
      (payload.loaded ?? []).length > 0,
      "the activation under test must actually load a deferred tool",
    );
    assert.equal(
      after,
      before,
      "activation changed pi's system prompt — the cache prefix is no longer stable",
    );
    assert.ok(
      activation.onUserTurnStart(UNUSED_TOOL_PRUNE_IDLE_MS).length > 0,
      "cold-boundary branch must actually prune the never-used load",
    );
    assert.equal(
      promptFor(applied.at(-1)!),
      before,
      "cold pruning changed pi's system prompt",
    );
  } finally {
    activation.dispose();
  }
});

test("pi's Available tools list holds only pi's own builtins", async () => {
  // The accepted consequence of deleting promptSnippet (Task-282): that list is
  // built from snippets alone, so our tools are visible to a pi session only
  // through the tool-definition block, pi's generic "other custom tools"
  // sentence, and find_tools' own description. Verified, not assumed.
  const agentType = "developer";
  const builder = await loadPiPromptBuilder();
  const cwd = process.cwd();
  const builtins = piBuiltinPromptTools(cwd);
  const tools = agentToolsFor(agentType);
  const extras = piPromptExtras([...builtins, ...tools]);
  const prompt = builder.build({
    cwd,
    contextFiles: [],
    selectedTools: [
      ...builtins.map((tool) => tool.name),
      ...[...eagerToolNamesFor(agentType)],
    ],
    toolSnippets: extras.toolSnippets,
    promptGuidelines: extras.promptGuidelines,
  });

  // pi 0.87 wraps the list in a `<tools>` section (it was an "Available tools:"
  // heading before); the entry lines and their `\n\n` terminator are unchanged.
  const section = prompt.slice(prompt.indexOf("<tools>"));
  const listed = section.slice(0, section.indexOf("\n\n"));
  // Entry lines are `- name: snippet`, so parse the NAMES rather than substring
  // matching the block: a short app-tool name like `ls` occurs inside other
  // entries (bash's snippet is literally "Execute bash commands (ls, grep, …)")
  // and would look listed when it is not.
  const listedNames = new Set(
    listed
      .split("\n")
      .map((line) => /^- ([^:]+):/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  assert.deepEqual(
    Object.keys(extras.toolSnippets).sort(),
    builtins.map((tool) => tool.name).sort(),
  );
  for (const name of PI_SEARCH_BUILTIN_TOOLS)
    assert.ok(
      listedNames.has(name),
      `pi's search builtin ${name} is missing from the Available tools list`,
    );
  for (const tool of tools)
    assert.ok(
      !listedNames.has(tool.name),
      `${tool.name} is back in pi's Available tools list — snippets were reintroduced`,
    );
});

test("find_tools still discovers app tools by capability", async () => {
  // The other half of the accepted consequence: discovery must work from name +
  // description + searchHint alone, with nothing in the system prompt naming
  // our tools. One query per capability family a session realistically asks for.
  const applied: Array<ReadonlySet<string>> = [];
  const activation = createPiToolActivation({
    sessionId: `activation-discovery-${Date.now()}`,
    agentType: "assistant",
    agentTools: agentToolsFor("assistant"),
    eagerToolNames: eagerToolNamesFor("assistant"),
    deferToolLoading: true,
    applyActiveToolNames: (names) => applied.push(new Set(names)),
  });
  try {
    activation.initialize([]);
    const findTools = activation.piToolUniverse.find(
      (tool) => tool.name === FIND_TOOLS_NAME,
    )!;
    const expectations: Array<[string, string]> = [
      ["read another session's log", "session_read"],
      ["send a prompt to another session", "session_send_prompt"],
      ["stop a spawned child session", "session_control"],
      ["search the web", "web_search"],
      ["convert a pdf attachment to markdown", "convert_pdf"],
      ["write a knowledge base entry", "kb_write_entry"],
      ["look up a person in the contacts directory", "contacts_lookup"],
      ["project registry mapping for a local repo", "project_registry_read"],
      ["propose an app change to the workshop", "workshop_draft_handoff"],
    ];
    for (const [query, expected] of expectations) {
      const result = await findTools.execute({ query }, CTX);
      const payload = JSON.parse(
        (result.content[0] as { text: string }).text,
      ) as { loaded?: string[]; alreadyActive?: string[] };
      const found = [
        ...(payload.loaded ?? []),
        ...(payload.alreadyActive ?? []),
      ];
      assert.ok(
        found.includes(expected),
        `find_tools("${query}") did not surface ${expected} — ${JSON.stringify(payload)}`,
      );
    }
  } finally {
    activation.dispose();
  }
});

test("a stale activation disposed after its replacement leaves the replacement registered", () => {
  const sessionId = `activation-replaced-${Date.now()}`;
  const activationFor = () =>
    createPiToolActivation({
      sessionId,
      agentType: "assistant",
      agentTools: agentToolsFor("assistant"),
      eagerToolNames: eagerToolNamesFor("assistant"),
      deferToolLoading: true,
      applyActiveToolNames: () => {},
    });
  const stale = activationFor();
  const replacement = activationFor();
  try {
    stale.dispose();
    // Both readers still answer from the replacement, and agree.
    assert.ok(toolExposureForSession(sessionId));
    assert.deepEqual(
      sessionToolExposure(sessionId),
      toolExposureForSession(sessionId),
    );
  } finally {
    replacement.dispose();
  }
  assert.equal(toolExposureForSession(sessionId), undefined);
  assert.equal(sessionToolExposure(sessionId), undefined);
});
