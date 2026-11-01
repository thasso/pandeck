/**
 * Unit test for the per-agentType native-tool policy of a Claude-SDK session.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/options.test.ts
 *
 * The persona drives which native (Read/Write/Edit/Bash) tools the SDK query is
 * allowed to use:
 *   - "workshop" keeps the full native toolset;
 *   - "assistant" gets NONE — every known native tool is disallowed and the
 *     canUseTool permission callback denies them (its capability is the bridged
 *     `pa` MCP tools only, mirroring the pi assistant).
 *
 * The session MODE is the second, independent axis: `plan` refuses the
 * file-mutating natives per call against the live mode, and never changes the
 * tool list the process starts with. A query reads the mode through its
 * session hooks, which the session's binding answers on the server.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentType, SessionMode } from "@assistant/shared";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  buildClaudeSdkQueryOptions,
  claudeQueryEnvironment,
  claudeQueryOpenSpec,
  claudeQueryOptions,
  claudeSessionHookBinding,
  claudeToolPermission,
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  CLAUDE_SDK_NATIVE_TOOLS,
} from "./options.ts";
import type { ClaudeSdkOptions } from "./sdkSeam.ts";
import { childProcessEnv } from "../subprocessEnv.ts";
import { withClaudeOutputBudgetEnvironment } from "./outputPolicyHooks.ts";
import { CLAUDE_SDK_HARNESS_SETTINGS } from "./modelSettings.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import { SESSION_HOOK_METHODS } from "../workerProtocol/sessionHookMethods.ts";
import { sessionHooksFor } from "../workers/inProcessWorker.ts";
import {
  registerSessionHooks,
  sessionHookCallsServedForTests,
} from "../workers/sessionHookHost.ts";

const disposers: Array<() => void> = [];

/**
 * A query's session hooks for `sessionId`, answered by a session binding in
 * `mode` with no background work, as a live session's would be.
 */
function sessionIn(
  sessionId: string,
  mode: () => SessionMode,
  agentType: AgentType = "workshop",
) {
  disposers.push(
    registerSessionHooks(
      sessionId,
      claudeSessionHookBinding({
        agentType,
        agent: undefined,
        mode,
        admit: async () => ({ allowed: true }),
        stop: () => undefined,
        postCompact: () => undefined,
      }),
    ),
  );
  return { sessionHooks: { ...sessionHooksFor(sessionId), epoch: "epoch-1" } };
}

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
    "ToolSearch must ride the tools: allowlist itself (not just canUseTool) or the CLI silently loads every mcp__pa__ tool definition upfront",
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
    "bare allowedTools must not shadow canUseTool",
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
  for (const t of ["Bash", "Read", "Write", "Edit", "Skill"]) {
    const verdict = await workshop.canUseTool!(t, {}, {} as never);
    assert.ok(verdict, `workshop canUseTool returns a verdict for ${t}`);
    assert.equal(verdict.behavior, "allow", `workshop canUseTool allows ${t}`);
  }

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

  const pa = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "personal-assistant",
  });
  assert.deepEqual(pa.tools, [...CLAUDE_SDK_NATIVE_TOOLS, "ToolSearch"]);
  assert.deepEqual(pa.settingSources, []);
  for (const tool of CLAUDE_SDK_NATIVE_TOOLS)
    assert.equal(
      (await pa.canUseTool!(tool, {}, {} as never))?.behavior,
      "allow",
    );
  const paPlan = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "personal-assistant",
    ...sessionIn("pa-plan", () => "plan", "personal-assistant"),
  });
  assert.deepEqual(paPlan.tools, pa.tools);
  for (const tool of ["Edit", "Write"])
    assert.equal(
      (await paPlan.canUseTool!(tool, {}, {} as never))?.behavior,
      "deny",
    );
  assert.equal(
    (await paPlan.canUseTool!("Bash", {}, {} as never))?.behavior,
    "allow",
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
  assert.deepEqual(coordinator.tools, []);
  for (const t of ["Bash", "Read", "Write", "Edit"]) {
    assert.equal(
      (await coordinator.canUseTool!(t, {}, {} as never))?.behavior,
      "deny",
    );
    assert.ok(
      (assistant.disallowedTools as string[]).includes(t),
      `assistant disallows native ${t}`,
    );
    const verdict = await assistant.canUseTool!(t, {}, {} as never);
    assert.ok(verdict, `assistant canUseTool returns a verdict for ${t}`);
    assert.equal(verdict.behavior, "deny", `assistant canUseTool denies ${t}`);
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
    ...sessionIn("options-plan-test", () => liveMode),
  });
  const build = buildClaudeSdkQueryOptions({
    ...base,
    ...sessionIn("options-build-test", () => "build"),
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
    const verdict = await plan.canUseTool!(t, {}, {} as never);
    assert.ok(verdict, `plan canUseTool returns a verdict for ${t}`);
    assert.equal(
      verdict.behavior,
      "deny",
      `plan canUseTool denies ${t} (it decides whenever bypass is downgraded)`,
    );
  }
  for (const t of ["Read", "Bash", "Monitor", "Grep", "Glob"]) {
    assert.notEqual(
      (await gate(t)).hookSpecificOutput?.permissionDecision,
      "deny",
      `plan's PreToolUse gate lets ${t} run`,
    );
    const verdict = await plan.canUseTool!(t, {}, {} as never);
    assert.ok(verdict, `plan canUseTool returns a verdict for ${t}`);
    assert.equal(verdict.behavior, "allow", `plan still allows ${t}`);
  }
  // The same process returns to Build without a restart.
  liveMode = "build";
  assert.notEqual(
    (await gate("Edit")).hookSpecificOutput?.permissionDecision,
    "deny",
    "switching the live mode back to Build lets Edit run on the same query",
  );
  const backInBuild = await plan.canUseTool!("Edit", {}, {} as never);
  assert.equal(backInBuild?.behavior, "allow");
  liveMode = "plan";

  const planWithMcp = buildClaudeSdkQueryOptions({
    ...base,
    ...sessionIn("options-plan-mcp", () => "plan"),
    mcpServer: {} as never,
  });
  const mcpVerdict = await planWithMcp.canUseTool!(
    "mcp__pa__kb_write",
    {},
    {} as never,
  );
  assert.ok(
    mcpVerdict,
    "plan canUseTool returns a verdict for an mcp__pa__ tool",
  );
  assert.equal(mcpVerdict.behavior, "deny");
  assert.match(
    "message" in mcpVerdict ? (mcpVerdict.message ?? "") : "",
    /not available in Plan mode because it can make changes/,
  );
  const taskManageVerdict = await planWithMcp.canUseTool!(
    "mcp__pa__task_manage",
    {},
    {} as never,
  );
  assert.ok(taskManageVerdict);
  assert.equal(
    taskManageVerdict.behavior,
    "allow",
    "Plan permits durable Task mutations",
  );
  const readMcpVerdict = await planWithMcp.canUseTool!(
    "mcp__pa__kb_read",
    {},
    {} as never,
  );
  assert.ok(readMcpVerdict);
  assert.equal(
    readMcpVerdict.behavior,
    "allow",
    "Plan keeps read-only app tools reachable",
  );
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
    ...sessionIn("options-plan-assistant", () => "plan", "assistant"),
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
        ...sessionIn(`options-${agentType}-${mode}`, () => mode, agentType),
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
        ...sessionIn(`options-${agentType}-${mode}`, () => mode, agentType),
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
    ...sessionIn("options-plan-skill", () => "plan"),
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
  try {
    await main();
  } finally {
    for (const dispose of disposers.splice(0)) dispose();
  }
});

test("routed verdicts equal the direct ones for every persona, in Build and Plan", async () => {
  const base = {
    cwd: "/tmp",
    abortController: new AbortController(),
    modelId: "sonnet",
    thinkingLevel: "low" as const,
    mcpServer: {} as never,
  };
  const tools = [
    "Edit",
    "Read",
    "mcp__other__lookup",
    "mcp__pa__kb_write",
    "mcp__pa__kb_read",
    "mcp__pa__task_manage",
  ];
  const input = { file_path: "/tmp/x" };
  try {
    for (const agentType of [
      "workshop",
      "developer",
      "assistant",
      "personal-assistant",
      "workflow-coordinator",
    ] as const) {
      for (const mode of ["build", "plan"] as const) {
        const routed = buildClaudeSdkQueryOptions({
          ...base,
          agentType,
          ...sessionIn(`parity-${agentType}-${mode}`, () => mode, agentType),
        });
        const direct = claudeToolPermission({
          agentType,
          allowPaMcp: true,
          mode: () => mode,
        });
        const unhooked = buildClaudeSdkQueryOptions({ ...base, agentType });
        for (const tool of tools) {
          const served = sessionHookCallsServedForTests(
            SESSION_HOOK_METHODS.canUseTool,
          );
          const verdict = await routed.canUseTool!(tool, input, {} as never);
          assert.equal(
            sessionHookCallsServedForTests(SESSION_HOOK_METHODS.canUseTool),
            served + 1,
            "one verdict is one request",
          );
          const expected = direct(tool);
          assert.deepEqual(
            verdict,
            expected.behavior === "allow"
              ? { behavior: "allow", updatedInput: input }
              : expected,
            `${agentType} in ${mode}: ${tool}`,
          );
          if (mode === "build")
            assert.deepEqual(
              verdict,
              await unhooked.canUseTool!(tool, input, {} as never),
              `${agentType}: ${tool} as a query without session hooks decides`,
            );
        }
      }
    }
  } finally {
    for (const dispose of disposers.splice(0)) dispose();
  }
});

test("a stored compaction window rides the start settings and drops the inherited variable", () => {
  const base = {
    cwd: "/tmp",
    abortController: new AbortController(),
    modelId: "opus",
    thinkingLevel: "low" as const,
    agentType: "developer" as const,
  };
  const previous = process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
  process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] = "150000";
  try {
    const explicitEnv = {
      PATH: "/bin",
      [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: "150000",
    };

    // No stored window: settings and env are exactly today's.
    const unsetExplicit = buildClaudeSdkQueryOptions({
      ...base,
      env: explicitEnv,
    });
    assert.equal(unsetExplicit.settings, CLAUDE_SDK_HARNESS_SETTINGS);
    assert.equal(unsetExplicit.env?.[CLAUDE_AUTO_COMPACT_WINDOW_ENV], "150000");
    const unsetInherited = buildClaudeSdkQueryOptions(base);
    assert.equal(unsetInherited.settings, CLAUDE_SDK_HARNESS_SETTINGS);
    assert.equal(
      unsetInherited.env?.[CLAUDE_AUTO_COMPACT_WINDOW_ENV],
      "150000",
      "an unbound query keeps the server's variable when nothing is stored",
    );

    for (const env of [explicitEnv, undefined]) {
      const set = buildClaudeSdkQueryOptions({
        ...base,
        ...(env ? { env } : {}),
        compactionWindow: 150_000,
      });
      assert.deepEqual(set.settings, {
        ...CLAUDE_SDK_HARNESS_SETTINGS,
        autoCompactWindow: 150_000,
      });
      assert.equal(
        Object.hasOwn(set.env ?? {}, CLAUDE_AUTO_COMPACT_WINDOW_ENV),
        false,
      );
      assert.equal(
        Object.hasOwn(set.settings as object, "idleCompaction"),
        false,
      );
    }
    assert.equal(
      explicitEnv[CLAUDE_AUTO_COMPACT_WINDOW_ENV],
      "150000",
      "the caller's env object is not mutated",
    );
  } finally {
    if (previous === undefined)
      delete process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
    else process.env[CLAUDE_AUTO_COMPACT_WINDOW_ENV] = previous;
  }
});

/** A frozen agent definition, as a spawned session carries it. */
const reviewerAgent = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "claude-sdk",
  model: "opus",
  pinnedModel: "claude-opus-5-5",
  effort: "high" as const,
  runtimeSource: "definition" as const,
  denyTools: ["bash"],
  skills: [],
  body: "Review the exact head.",
};

/** The JSON-comparable part of a query's options: its callbacks' presence. */
function comparable(options: ClaudeSdkOptions) {
  const { abortController, canUseTool, hooks, mcpServers, ...rest } = options;
  return {
    ...rest,
    abortController,
    canUseTool: typeof canUseTool,
    hooks: hooks && Object.keys(hooks),
    mcpServers,
  };
}

const SENTINEL_KEY = "options-test-sentinel-api-key";

test("a query's open spec is JSON, and composing it on its host gives today's options", async () => {
  const {
    createCredentialProfile,
    claudeProfileEnvironment,
    claudeProfileRuntime,
    ensureDefaultPiProfile,
  } = await import("../credentialProfiles.ts");
  // The registry lives under the suite's temporary DATA_DIR.
  ensureDefaultPiProfile();
  const named = createCredentialProfile({
    name: "Claude spec",
    provider: "claude",
  });
  const tmp = { TMPDIR: "/tmp/epoch", CLAUDE_CODE_TMPDIR: "/tmp/epoch" };
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = SENTINEL_KEY;
  const mcpServer = { name: "pa-fixture" } as unknown as Server;
  try {
    const cases = [
      {
        label:
          "a coding turn under a named profile, resumed, windowed, with skills",
        input: {
          cwd: "/tmp/work",
          modelId: "opus",
          thinkingLevel: "high" as const,
          providerSessionId: "prov-1",
          agentType: "developer" as const,
          additionalSystemPrompt: "Suffix.",
          agent: reviewerAgent,
          frozenSkillNames: ["alpha", "beta"],
          compactionWindow: 150_000,
        },
        profile: named.id,
        set: tmp,
        hooked: true,
        mounted: true,
      },
      {
        label: "an assistant turn without a profile",
        input: {
          cwd: "/tmp/work",
          modelId: "sonnet",
          thinkingLevel: "off" as const,
          agentType: "assistant" as const,
        },
        set: tmp,
        hooked: true,
        mounted: true,
      },
      {
        label: "a standalone compaction under the default profile",
        input: {
          cwd: "relative/work",
          modelId: "sonnet",
          thinkingLevel: "low" as const,
          providerSessionId: "prov-2",
          nativeTools: [],
          disableTools: true,
          agentType: "workshop" as const,
          frozenSkillNames: ["alpha"],
          compactionWindow: 200_000,
        },
        profile: "claude-default",
        captureCompactSummary: true,
      },
      {
        label: "an unhooked assistant query without a profile or tool server",
        input: {
          cwd: "/tmp/work",
          modelId: "opus",
          thinkingLevel: "medium" as const,
          agentType: "personal-assistant" as const,
        },
      },
    ];
    for (const item of cases) {
      const profile =
        item.profile !== undefined
          ? claudeProfileRuntime(item.profile)
          : undefined;
      const spec = claudeQueryOpenSpec({
        ...item.input,
        sessionId: "spec-session",
        mountToolServer: item.mounted === true,
        ...(item.hooked ? { sessionHooksEpoch: "epoch-1" } : {}),
        ...(item.captureCompactSummary ? { captureCompactSummary: true } : {}),
        env: {
          ...(profile ? { profile } : {}),
          ...(item.set ? { set: item.set } : {}),
        },
      });
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(spec)),
        spec,
        `${item.label}: the spec survives JSON`,
      );
      assert.doesNotMatch(
        JSON.stringify(spec),
        new RegExp(SENTINEL_KEY),
        `${item.label}: no server environment rides the spec`,
      );
      assert.equal(spec.sessionId, "spec-session");
      assert.equal(spec.sessionHooksEpoch, item.hooked ? "epoch-1" : undefined);
      assert.equal(spec.captureCompactSummary, item.captureCompactSummary);

      // Today's server-built env: the profile's, or the server's own, then
      // the epoch's temp pair.
      const serverEnv =
        item.profile !== undefined
          ? { ...claudeProfileEnvironment(item.profile), ...item.set }
          : item.set
            ? { ...childProcessEnv(), ...item.set }
            : undefined;
      const env = claudeQueryEnvironment(spec.env, childProcessEnv());
      const sessionHooks = item.hooked
        ? {
            canUseTool: async () => ({ behavior: "allow" as const }),
            preToolUse: async () => ({ allowed: true as const }),
            stop: async () => {},
            postCompact: async () => {},
            persistOutput: async () => ({ path: "", url: "" }),
            epoch: "epoch-1",
          }
        : undefined;
      const abortController = new AbortController();
      const hosted = claudeQueryOptions(spec, {
        abortController,
        env,
        ...(sessionHooks ? { sessionHooks } : {}),
        ...(item.mounted ? { mcpServer } : {}),
      });
      const today = buildClaudeSdkQueryOptions({
        ...item.input,
        abortController,
        ...(serverEnv ? { env: serverEnv } : {}),
        ...(sessionHooks ? { sessionHooks } : {}),
        ...(item.mounted ? { mcpServer } : {}),
      });
      assert.deepStrictEqual(comparable(hosted), comparable(today), item.label);
      if (item.profile !== undefined)
        assert.equal(hosted.env?.ANTHROPIC_API_KEY, undefined, item.label);
      else
        assert.equal(hosted.env?.ANTHROPIC_API_KEY, SENTINEL_KEY, item.label);
      if (!item.hooked)
        for (const tool of ["Read", "Bash", "mcp__pa__task_read", "Agent"])
          assert.deepEqual(
            await hosted.canUseTool!(tool, {}, {} as never),
            await today.canUseTool!(tool, {}, {} as never),
            `${item.label}: ${tool}`,
          );
    }
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("a query's environment applies the profile, then its variables, the output budget and the window rule", () => {
  const base = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: SENTINEL_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    AWS_PROFILE: "aws",
    [CLAUDE_AUTO_COMPACT_WINDOW_ENV]: "150000",
    UNSET: undefined,
  };
  const set = { TMPDIR: "/tmp/epoch", CLAUDE_CODE_TMPDIR: "/tmp/epoch" };
  const { UNSET: _unset, ...defined } = base;
  assert.deepStrictEqual(
    claudeQueryEnvironment({ set }, base),
    withClaudeOutputBudgetEnvironment({ ...defined, ...set }),
    "no profile: the base as is",
  );
  assert.deepStrictEqual(
    claudeQueryEnvironment({ profile: {} }, base),
    withClaudeOutputBudgetEnvironment({ PATH: "/bin" }),
    "the default profile scrubs credentials and keeps ~/.claude",
  );
  assert.deepStrictEqual(
    claudeQueryEnvironment(
      { profile: { configDir: "/data/profile/claude" }, set },
      base,
    ),
    withClaudeOutputBudgetEnvironment({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/data/profile/claude",
      ...set,
    }),
  );
  const windowed = claudeQueryEnvironment(
    { dropAutoCompactWindow: true },
    base,
  );
  assert.equal(Object.hasOwn(windowed, CLAUDE_AUTO_COMPACT_WINDOW_ENV), false);
  assert.equal(base[CLAUDE_AUTO_COMPACT_WINDOW_ENV], "150000");
});
