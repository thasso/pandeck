import assert from "node:assert/strict";
import { test } from "vitest";
import { deleteToolGroupSessionData } from "../mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "../mcp/toolGroups/packRuntime.ts";
import { setChildProcessEnvOverlay } from "../subprocessEnv.ts";
import {
  claudeOutputPolicyHooks,
  withClaudeOutputBudgetEnvironment,
} from "./outputPolicyHooks.ts";

test("Claude hooks bound the real FileReadOutput shape without silent pagination", async () => {
  // This fixture is the FileReadOutput text variant from the installed
  // @anthropic-ai/claude-agent-sdk sdk-tools.d.ts. updatedToolOutput must retain
  // this exact outer/file schema because the shipped CLI validates it.
  const sessionId = `claude-output-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const hooks = claudeOutputPolicyHooks(sessionId);
    const pre = hooks.PreToolUse![0]!.hooks[0]!;
    const preResult = await pre(
      {
        hook_event_name: "PreToolUse",
        session_id: "provider-1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
        tool_name: "Read",
        tool_input: { file_path: "ordinary-source.ts" },
        tool_use_id: "read-1",
      },
      "read-1",
      { signal: new AbortController().signal },
    );
    assert.equal(
      (
        preResult as {
          hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
        }
      ).hookSpecificOutput?.updatedInput?.limit,
      400,
    );

    const response = {
      type: "text",
      file: {
        filePath: "/tmp/ordinary-source.ts",
        content: "1\tfirst\n2\tsecond",
        numLines: 2,
        startLine: 1,
        totalLines: 500,
      },
    };
    const post = hooks.PostToolUse![0]!.hooks[0]!;
    const postResult = await post(
      {
        hook_event_name: "PostToolUse",
        session_id: "provider-1",
        transcript_path: "/tmp/transcript",
        cwd: "/tmp",
        tool_name: "Read",
        tool_input: { file_path: "ordinary-source.ts", limit: 400 },
        tool_response: response,
        tool_use_id: "read-1",
      },
      "read-1",
      { signal: new AbortController().signal },
    );
    const updated = (
      postResult as {
        hookSpecificOutput?: { updatedToolOutput?: unknown };
      }
    ).hookSpecificOutput?.updatedToolOutput as typeof response;
    assert.equal(updated.type, "text");
    assert.equal(updated.file.filePath, response.file.filePath);
    assert.equal(updated.file.startLine, 1);
    assert.equal(updated.file.totalLines, 500);
    assert.equal(updated.file.numLines, 2);
    assert.match(updated.file.content, /1\tfirst/);
    assert.match(updated.file.content, /Bounded default window/);
    assert.match(updated.file.content, /next offset=3/);
    assert.doesNotMatch(updated.file.content, /Full raw output:/);
    assert.deepEqual(
      listSessionArtifacts(sessionId),
      [],
      "navigation-only reads do not register duplicate window artifacts",
    );
  } finally {
    deleteToolGroupSessionData(sessionId);
  }
});

test("Claude background denial uses the authoritative permission decision shape", async () => {
  const seen: string[] = [];
  const hooks = claudeOutputPolicyHooks("session-1", {
    preToolUse: async ({ toolName }) => {
      seen.push(toolName);
      return toolName === "Monitor"
        ? { allowed: false, reason: "background capacity is full" }
        : { allowed: true };
    },
    stop: () => undefined,
    postCompact: () => undefined,
  });
  const pre = hooks.PreToolUse![0]!.hooks[0]!;
  const denied = await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-1",
      transcript_path: "/tmp/transcript",
      cwd: "/tmp",
      tool_name: "Monitor",
      tool_input: {
        description: "watch",
        timeout_ms: 1_000,
        persistent: true,
        command: "echo ready",
      },
      tool_use_id: "monitor-1",
    },
    "monitor-1",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(denied, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "background capacity is full",
    },
  });
  assert.equal(
    "continue" in denied,
    false,
    "continue:false must never deny a tool",
  );

  const foreground = await pre(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-1",
      transcript_path: "/tmp/transcript",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_use_id: "bash-foreground",
    },
    "bash-foreground",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(foreground, { continue: true });
  assert.deepEqual(seen, ["Monitor", "Bash"]);
});

test("an admitted Claude background launch passes its context to the model", async () => {
  const hooks = claudeOutputPolicyHooks("session-1", {
    preToolUse: async () => ({ allowed: true, context: "PA task bgw_1" }),
    stop: () => undefined,
    postCompact: () => undefined,
  });
  const result = await hooks.PreToolUse![0]!.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      session_id: "provider-1",
      transcript_path: "/tmp/transcript",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "pnpm dev", run_in_background: true },
      tool_use_id: "bash-background",
    },
    "bash-background",
    { signal: new AbortController().signal },
  );
  assert.deepEqual(result, {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "PA task bgw_1",
    },
  });
});

test("Claude failure hook adds bounded conflict diagnostics", async () => {
  const hooks = claudeOutputPolicyHooks("session-1");
  const failure = hooks.PostToolUseFailure![0]!.hooks[0]!;
  const result = await failure(
    {
      hook_event_name: "PostToolUseFailure",
      session_id: "provider-1",
      transcript_path: "/tmp/transcript",
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: "git rebase main" },
      tool_use_id: "bash-1",
      error: "Command failed",
    },
    "bash-1",
    { signal: new AbortController().signal },
  );
  const context = (
    result as { hookSpecificOutput?: { additionalContext?: string } }
  ).hookSpecificOutput?.additionalContext;
  assert.match(context ?? "", /Failed command: git rebase main/);
  assert.match(context ?? "", /git diff --name-only --diff-filter=U/);
});

test("Claude subprocess budgets preserve supplied or inherited environment", () => {
  const env = withClaudeOutputBudgetEnvironment({ PATH: "/bin", LANG: "C" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.BASH_MAX_OUTPUT_LENGTH, "12000");
  assert.equal(env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS, "3000");
  assert.equal(env.ENABLE_MCP_LARGE_OUTPUT_FILES, "true");

  const inherited = withClaudeOutputBudgetEnvironment(undefined);
  assert.equal(inherited.BASH_MAX_OUTPUT_LENGTH, "12000");
  assert.equal(inherited.PATH, process.env.PATH);

  // The inherited default is the child view, package-proxy overlay included.
  setChildProcessEnvOverlay({ HTTPS_PROXY: "http://127.0.0.1:9/budget" });
  try {
    assert.equal(
      withClaudeOutputBudgetEnvironment(undefined).HTTPS_PROXY,
      "http://127.0.0.1:9/budget",
    );
  } finally {
    setChildProcessEnvOverlay(null);
  }
});
