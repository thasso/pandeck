/**
 * Unit test for the per-agentType native-tool policy of a Claude-SDK session.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/options.test.ts
 *
 * The persona drives which native (Read/Write/Edit/Bash) tools the SDK query is
 * allowed to use:
 *   - "workshop" keeps the full native toolset;
 *   - "assistant" gets NONE — every known native tool is disallowed (its
 *     capability is the bridged `pa` MCP tools only, mirroring the pi
 *     assistant).
 *
 * The session MODE is the second, independent axis: `plan` refuses the
 * file-mutating natives per call against the live mode, and never changes the
 * tool list the process starts with.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildClaudeSdkQueryOptions,
  CLAUDE_SDK_NATIVE_TOOLS,
} from "./options.ts";
import { CLAUDE_SDK_HARNESS_SETTINGS } from "./modelSettings.ts";
import { AGENT_TYPES } from "../agentTypes.ts";

async function main(): Promise<void> {
  const base = {
    cwd: "/tmp",
    abortController: new AbortController(),
    modelId: "sonnet",
    thinkingLevel: "low" as const,
  };

  // Workshop: native file/shell tools present.
  const workshop = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "workshop",
  });
  assert.deepEqual(
    workshop.systemPrompt,
    {
      type: "preset",
      preset: "claude_code",
      append: AGENT_TYPES.workshop.systemPrompt(),
    },
    "workshop appends its persona prompt to Claude Code's default system prompt",
  );
  for (const t of CLAUDE_SDK_NATIVE_TOOLS) {
    assert.ok(
      (workshop.tools as string[]).includes(t),
      `workshop exposes native ${t}`,
    );
    assert.ok(
      !(workshop.disallowedTools as string[]).includes(t),
      `workshop does not disallow ${t}`,
    );
  }
  assert.ok(
    (workshop.tools as string[]).includes("ToolSearch"),
    "ToolSearch must ride the tools: allowlist itself or the CLI silently loads every mcp__pa__ tool definition upfront",
  );
  assert.ok(
    (workshop.tools as string[]).includes("Skill"),
    "coding personas must include Skill literally so the CLI exposes project skills",
  );
  for (const t of ["Grep", "Glob"]) {
    assert.ok(
      (workshop.tools as string[]).includes(t),
      `Task-316: coding personas search with native ${t}, not a Bash round trip`,
    );
  }
  assert.deepEqual(
    (workshop.disallowedTools as string[]).filter((t) =>
      ["Grep", "Glob", "TodoWrite", "TodoRead"].includes(t),
    ),
    ["TodoRead", "TodoWrite"],
    "the search tools leave disallowedTools; the todo tools stay on it (docs/tasks.md)",
  );
  assert.equal(
    workshop.allowedTools,
    undefined,
    "bypass mode approves before allowedTools is consulted",
  );
  assert.equal(
    workshop.canUseTool,
    undefined,
    "bypass mode never calls canUseTool, so none is passed (the SDK warns otherwise)",
  );
  assert.equal(
    workshop.permissionMode,
    "bypassPermissions",
    "host policy bypasses Claude Code's secondary command permission layer",
  );
  assert.equal(
    workshop.allowDangerouslySkipPermissions,
    true,
    "bypass mode is explicitly acknowledged",
  );
  for (const t of ["Bash", "Read", "Write", "Edit", "Skill"])
    assert.ok(
      (workshop.tools as string[]).includes(t),
      `workshop's tools allowlist carries ${t}`,
    );

  const withLibrarySkills = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "developer",
    frozenSkillNames: ["zeta-skill", "alpha-skill"],
  });
  assert.deepEqual(
    withLibrarySkills.plugins,
    [
      {
        type: "local",
        path: (withLibrarySkills.plugins as Array<{ path: string }>)[0]!.path,
        skipMcpDiscovery: true,
      },
    ],
    "coding sessions mount one local generated plugin without MCP discovery",
  );
  assert.match(
    (withLibrarySkills.plugins as Array<{ path: string }>)[0]!.path,
    /skills-runtime\/[0-9a-f]{64}$/,
    "the plugin path is the deterministic frozen-name-set runtime root",
  );
  assert.equal(
    (withLibrarySkills as { skills?: unknown }).skills,
    undefined,
    "the SDK skills filter stays omitted so repository .claude/skills retain CLI-default discovery",
  );
  assert.equal(
    withLibrarySkills.settingSources,
    undefined,
    "coding sessions retain the CLI-default project setting sources",
  );
  assert.equal(
    buildClaudeSdkQueryOptions({
      ...base,
      agentType: "developer",
      frozenSkillNames: [],
    }).plugins,
    undefined,
    "an empty frozen set mounts no plugin",
  );

  // Assistant: no native tools at all.
  const assistant = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "assistant",
  });
  assert.equal(
    assistant.systemPrompt,
    AGENT_TYPES.assistant.systemPrompt(),
    "assistant uses its locked-down persona prompt",
  );
  const personalized = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "assistant",
    additionalSystemPrompt: "Call me T.",
  });
  assert.equal(
    personalized.systemPrompt,
    `${AGENT_TYPES.assistant.systemPrompt()}\n\n## Personal profile instructions\n\nCall me T.`,
    "assistant appends session-specific profile instructions",
  );
  assert.deepEqual(
    assistant.tools,
    ["ToolSearch"],
    "assistant exposes no native tools, only the ToolSearch system tool",
  );
  assert.deepEqual(
    assistant.settingSources,
    [],
    "assistant ignores project and user setting sources",
  );
  assert.equal(
    buildClaudeSdkQueryOptions({
      ...base,
      agentType: "assistant",
      frozenSkillNames: ["alpha-skill"],
    }).plugins,
    undefined,
    "assistant personas never mount a library plugin even if names are supplied",
  );
  const coordinator = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "workflow-coordinator",
  });
  assert.deepEqual(
    coordinator.settingSources,
    [],
    "workflow coordinators cannot inherit a run worktree's CLAUDE.md",
  );
  assert.ok(
    !(coordinator.tools as string[]).includes("Skill"),
    "workflow coordinators must not receive Skill",
  );
  for (const t of ["Bash", "Read", "Write", "Edit"]) {
    assert.ok(
      (assistant.disallowedTools as string[]).includes(t),
      `assistant disallows native ${t}`,
    );
  }

  // Claude's native auto-memory is disabled globally for every persona: our
  // in-app Memory is the single authoritative memory surface.
  for (const opts of [workshop, assistant, personalized]) {
    assert.deepEqual(
      opts.settings,
      CLAUDE_SDK_HARNESS_SETTINGS,
      "every claude-sdk session disables native auto-memory via flag settings",
    );
  }
  assert.equal(
    CLAUDE_SDK_HARNESS_SETTINGS.autoMemoryEnabled,
    false,
    "native auto-memory reads/writes disabled",
  );
  assert.equal(
    CLAUDE_SDK_HARNESS_SETTINGS.autoDreamEnabled,
    false,
    "native background memory consolidation disabled",
  );

  // Default (no agentType) preserves the historical workshop behavior.
  const dflt = buildClaudeSdkQueryOptions(base);
  assert.deepEqual(
    [...(dflt.tools as string[])].sort(),
    [...CLAUDE_SDK_NATIVE_TOOLS, "Skill", "ToolSearch"].sort(),
    "default is the workshop native toolset plus Skill and ToolSearch",
  );
  assert.equal(
    dflt.env?.BASH_MAX_OUTPUT_LENGTH,
    "12000",
    "sessions without an explicit credential-profile env still receive native output caps",
  );

  // Plan is a LIVE gate, not a tool list: a retained process outlives a mode
  // switch, so both modes start the same process ([Task-756](pa://task/756)).
  let liveMode: "build" | "plan" = "plan";
  const plan = buildClaudeSdkQueryOptions({
    ...base,
    outputPolicySessionId: "options-plan-test",
    mode: () => liveMode,
  });
  const build = buildClaudeSdkQueryOptions({
    ...base,
    outputPolicySessionId: "options-plan-test",
    mode: () => "build",
  });
  for (const key of [
    "tools",
    "disallowedTools",
    "systemPrompt",
    "permissionMode",
    "allowDangerouslySkipPermissions",
  ] as const)
    assert.deepEqual(
      plan[key],
      build[key],
      `plan and build start the same process (${key})`,
    );
  assert.throws(
    () => buildClaudeSdkQueryOptions({ ...base, mode: () => "plan" }),
    /outputPolicySessionId/,
    "a moded query without the hooks that enforce Plan is refused",
  );
  const preToolUse = plan.hooks!.PreToolUse![0]!.hooks[0]!;
  const gate = (toolName: string) =>
    preToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "provider-1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
        tool_name: toolName,
        tool_input: {},
        tool_use_id: `${toolName}-1`,
      },
      `${toolName}-1`,
      { signal: new AbortController().signal },
    ) as Promise<{
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    }>;
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    const decision = (await gate(t)).hookSpecificOutput;
    assert.equal(
      decision?.permissionDecision,
      "deny",
      `plan's PreToolUse gate refuses the mutating native ${t}`,
    );
    assert.match(decision?.permissionDecisionReason ?? "", /Plan mode/);
  }
  for (const t of ["Read", "Bash", "Monitor", "Grep", "Glob"]) {
    assert.notEqual(
      (await gate(t)).hookSpecificOutput?.permissionDecision,
      "deny",
      `plan's PreToolUse gate lets ${t} run`,
    );
  }
  // The same process returns to Build without a restart.
  liveMode = "build";
  assert.notEqual(
    (await gate("Edit")).hookSpecificOutput?.permissionDecision,
    "deny",
    "switching the live mode back to Build lets Edit run on the same query",
  );
  liveMode = "plan";

  // Plan's app-tool gate is the session tool server's, which lists and refuses
  // mcp__pa__* tools against the live mode (mcp/sessionToolServer.test.ts).
  assert.equal(
    plan.permissionMode,
    "bypassPermissions",
    'plan must NOT use the CLI\'s own permissionMode: "plan"',
  );
  assert.equal(
    (plan as { planModeInstructions?: unknown }).planModeInstructions,
    undefined,
    "plan sets no CLI plan-mode instructions",
  );

  // An assistant persona has no native tools to subtract in the first place.
  const planAssistant = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "assistant",
    outputPolicySessionId: "options-plan-test",
    mode: () => "plan",
  });
  assert.deepEqual(
    planAssistant.tools,
    assistant.tools,
    "plan is a no-op for a persona that has no native file tools",
  );

  // Skill is a coding-persona capability in both modes. It only injects the
  // selected skill body, so Plan keeps it; clean-slate assistant personas never
  // discover skills and must not expose a misleading invocation surface.
  for (const agentType of ["workshop", "developer"] as const) {
    for (const mode of ["build", "plan"] as const) {
      const options = buildClaudeSdkQueryOptions({
        ...base,
        agentType,
        outputPolicySessionId: "options-plan-test",
        mode: () => mode,
      });
      assert.ok(
        (options.tools as string[]).includes("Skill"),
        `${agentType} exposes Skill in ${mode} mode`,
      );
    }
  }
  for (const agentType of [
    "assistant",
    "personal-assistant",
    "workflow-coordinator",
  ] as const) {
    for (const mode of ["build", "plan"] as const) {
      const options = buildClaudeSdkQueryOptions({
        ...base,
        agentType,
        outputPolicySessionId: "options-plan-test",
        mode: () => mode,
      });
      assert.ok(
        !(options.tools as string[]).includes("Skill"),
        `${agentType} does not expose Skill in ${mode} mode`,
      );
    }
  }

  const planWithLibrarySkill = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "workshop",
    outputPolicySessionId: "options-plan-test",
    mode: () => "plan",
    frozenSkillNames: ["alpha-skill"],
  });
  assert.ok(
    planWithLibrarySkill.plugins,
    "Plan mounts the frozen skill plugin",
  );
  assert.ok(
    (planWithLibrarySkill.tools as string[]).includes("Skill"),
    "Plan keeps the library skill invocation tool",
  );

  const compaction = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "developer",
    providerSessionId: "provider-session",
    nativeTools: [],
    disableTools: true,
    frozenSkillNames: ["alpha-skill"],
  });
  assert.deepEqual(
    compaction.tools,
    [],
    "the explicit no-tool path suppresses native, Skill, and ToolSearch tools",
  );
  assert.equal(
    compaction.plugins,
    undefined,
    "the explicit no-tool path does not load a frozen skill plugin",
  );

  console.log("claude-sdk options native-tool policy test: PASS");
}

test("builds persona-specific Claude SDK native-tool policy", async () => {
  await main();
});
