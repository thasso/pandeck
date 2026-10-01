/**
 * Task 330: the Plan hint as a per-turn, model-only injection.
 *   pnpm --filter @assistant/server test src/session/planHint.test.ts
 *
 * Two layers: the pure per-turn decision, and the real prompt facade with a
 * scripted adapter — asserting that what the MODEL receives carries the hint on
 * every Plan turn while the durable log and the client projection stay clean,
 * and that leaving Plan emits exactly one clearing line.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./adapters/contract.ts";
import type { SessionMode } from "@assistant/shared";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "plan-hint-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { promptRuntimeSessionWithRuntime } = await import("./runtimePrompt.ts");
const {
  planModeHint,
  planModeClearedHint,
  planTurnBlock,
  forgetPlanHintState,
} = await import("./planHint.ts");
const { ClaudeSdkSession } = await import("../claudeSdk/ClaudeSdkSession.ts");
const { closeDb } = await import("../db/index.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

// This suite covers the Plan hint, not memory: keep learning off so the
// facade's post-turn observation never invokes the real processor.
updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------- the decision ---------------------------- */

test("the per-turn block is the hint in Plan, one clearing line on the way out, nothing otherwise", () => {
  assert.equal(
    planTurnBlock("claude-sdk", "plan", false),
    planModeHint("claude-sdk"),
    "a Plan turn always carries the hint",
  );
  assert.equal(
    planTurnBlock("claude-sdk", "plan", true),
    planModeHint("claude-sdk"),
    "Plan is state: the hint rides every Plan turn, not just the first",
  );
  assert.equal(
    planTurnBlock("pi", "build", true),
    planModeClearedHint(),
    "the first Build turn after a Plan turn clears the transcript's Plan lines",
  );
  assert.equal(
    planTurnBlock("pi", "build", false),
    undefined,
    "an ordinary Build turn carries nothing",
  );
  assert.equal(
    planTurnBlock("pi", undefined, false),
    undefined,
    "a harness with no mode axis behaves as Build",
  );
});

test("the hint spells out the shell prohibition the tool policy cannot enforce", () => {
  for (const harness of ["pi", "claude-sdk"] as const) {
    const hint = planModeHint(harness);
    for (const needle of ["`>`/`>>`", "sed -i", "tee", "git checkout"])
      assert.ok(
        hint.includes(needle),
        `${harness} hint names the shell escape ${needle}`,
      );
    assert.ok(hint.includes("`rg`") || hint.includes("`git log`"));
    assert.match(
      hint,
      /task_manage/,
      "Plan explicitly permits durable Task organization",
    );
  }
  assert.ok(
    planModeHint("claude-sdk").length < planModeHint("pi").length,
    "Claude gets the short form (it injects its own plan reminder)",
  );
});

/* ---------------------- through the real prompt facade ------------------- */

interface Harnessed {
  runtime: InstanceType<typeof SessionRuntime>;
  modelTexts: string[];
  driver: {
    id: string;
    key: string;
    sessionId: string;
    harness: "pi" | "claude-sdk";
    agentType: "assistant";
    sessionFile: undefined;
    isRunning: boolean;
    canSteer: boolean;
    sessionMode?: SessionMode;
    contextInfo: () => never;
    broadcastState: () => void;
    createRuntimeAdapter: () => PromptableAdapter;
  };
}

function harnessed(sessionId: string, harness: "pi" | "claude-sdk"): Harnessed {
  const modelTexts: string[] = [];
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: false,
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, _o?: PromptOptions): Promise<AgentRunResult> => {
      modelTexts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession(sessionId, adapter);
  forgetPlanHintState(sessionId);
  return {
    runtime,
    modelTexts,
    driver: {
      id: sessionId,
      key: sessionId,
      sessionId,
      harness,
      agentType: "assistant",
      sessionFile: undefined,
      isRunning: false,
      canSteer: false,
      contextInfo: () => ({}) as never,
      broadcastState: () => {},
      createRuntimeAdapter: () => adapter,
    },
  };
}

/** Every text block of every durable user entry, as the log stored it. */
function durableUserTexts(
  runtime: InstanceType<typeof SessionRuntime>,
  sessionId: string,
): string[] {
  return runtime
    .get(sessionId)!
    .getSnapshot()
    .entries.filter((e) => e.role === "user")
    .flatMap((e) =>
      e.content
        .filter((b): b is Extract<typeof b, { type: "text" }> =>
          Boolean(b.type === "text"),
        )
        .map((b) => b.text),
    );
}

test("every Plan turn carries the hint to the model and none of it reaches the log or the projection", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-plan", "claude-sdk");
  driver.sessionMode = "plan";

  for (let i = 0; i < 3; i += 1)
    await promptRuntimeSessionWithRuntime(runtime, driver, `plan turn ${i}`, {
      clientRequestId: `p${i}`,
    });

  assert.equal(modelTexts.length, 3);
  for (const text of modelTexts) {
    assert.ok(
      text.includes(planModeHint("claude-sdk")),
      "the model-bound text carries the Plan hint on every Plan turn",
    );
    assert.ok(
      text.endsWith("plan turn 0") ||
        text.endsWith("plan turn 1") ||
        text.endsWith("plan turn 2"),
      "the human text stays last, after the model-only block",
    );
  }

  assert.deepEqual(
    durableUserTexts(runtime, "sess-plan"),
    ["plan turn 0", "plan turn 1", "plan turn 2"],
    "the durable log keeps only the clean human text",
  );
  const projected = JSON.stringify(runtime.get("sess-plan")!.clientTimeline());
  assert.ok(
    !projected.includes("<session-mode>"),
    "the client projection never shows the hint",
  );
});

test("leaving Plan emits exactly one clearing line, and a never-Plan session emits none", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-exit", "pi");
  driver.sessionMode = "plan";
  await promptRuntimeSessionWithRuntime(runtime, driver, "think it through", {
    clientRequestId: "a",
  });

  driver.sessionMode = "build";
  await promptRuntimeSessionWithRuntime(runtime, driver, "now build it", {
    clientRequestId: "b",
  });
  await promptRuntimeSessionWithRuntime(runtime, driver, "keep going", {
    clientRequestId: "c",
  });
  await promptRuntimeSessionWithRuntime(runtime, driver, "and finish", {
    clientRequestId: "d",
  });

  const cleared = modelTexts.filter((t) => t.includes(planModeClearedHint()));
  assert.equal(cleared.length, 1, "exactly one clearing line");
  assert.ok(
    cleared[0]!.endsWith("now build it"),
    "on the FIRST Build turn after Plan",
  );
  assert.deepEqual(
    modelTexts.slice(2),
    ["keep going", "and finish"],
    "later Build turns are unchanged",
  );

  const build = harnessed("sess-build", "pi");
  build.driver.sessionMode = "build";
  await promptRuntimeSessionWithRuntime(build.runtime, build.driver, "hello", {
    clientRequestId: "e",
  });
  const noAxis = harnessed("sess-no-axis", "pi");
  await promptRuntimeSessionWithRuntime(noAxis.runtime, noAxis.driver, "hi", {
    clientRequestId: "f",
  });
  assert.deepEqual(
    [...build.modelTexts, ...noAxis.modelTexts],
    ["hello", "hi"],
    "a session that was never in Plan sends the prompt untouched",
  );
});

test("a rejected duplicate turn neither consumes the clearing line nor claims a Plan turn", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-dup", "claude-sdk");
  driver.sessionMode = "plan";
  await promptRuntimeSessionWithRuntime(runtime, driver, "plan this", {
    clientRequestId: "dup",
  });
  // Same clientRequestId: the runtime returns before appending anything.
  await promptRuntimeSessionWithRuntime(runtime, driver, "plan this", {
    clientRequestId: "dup",
  });
  assert.equal(modelTexts.length, 1, "the duplicate never reached the model");

  driver.sessionMode = "build";
  await promptRuntimeSessionWithRuntime(runtime, driver, "build now", {
    clientRequestId: "next",
  });
  assert.ok(
    modelTexts[1]!.includes(planModeClearedHint()),
    "the clearing line is still owed to the first real Build turn",
  );
});

test("a caller's structured context block survives the Plan hint", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-ctx", "claude-sdk");
  driver.sessionMode = "plan";
  await promptRuntimeSessionWithRuntime(runtime, driver, "review this", {
    clientRequestId: "ctx",
    contextBlock: "Hidden structured review context",
  });
  const text = modelTexts[0]!;
  assert.ok(text.includes("Hidden structured review context"));
  assert.ok(text.includes(planModeHint("claude-sdk")));
  assert.ok(
    text.indexOf("Hidden structured review context") <
      text.indexOf("<session-mode>"),
    "the caller's context stays first; the mode rule sits closest to the prompt",
  );
  assert.deepEqual(durableUserTexts(runtime, "sess-ctx"), ["review this"]);
});

test("on the real Claude harness the hint reaches the SDK and not the app log", async () => {
  const prompts: string[] = [];
  const seam: ClaudeSdkSeam = {
    query(params: ClaudeQueryParams) {
      return {
        async *[Symbol.asyncIterator]() {
          const input = (params.prompt as AsyncIterable<unknown>)[
            Symbol.asyncIterator
          ]();
          const first = await input.next();
          if (!first.done) prompts.push(JSON.stringify(first.value));
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-claude-plan",
            usage: { input_tokens: 1, output_tokens: 1 },
          } as unknown as ClaudeSdkMessage;
        },
      };
    },
  };
  const session = new ClaudeSdkSession("cs-plan", { seam: async () => seam });
  session.setMode("plan");
  const runtime = new SessionRuntime(new SessionLogStore(true));
  runtime.createSession("cs-plan", session.createRuntimeAdapter());
  forgetPlanHintState("cs-plan");

  await promptRuntimeSessionWithRuntime(
    runtime,
    session,
    "how would we do X?",
    {
      clientRequestId: "cp1",
    },
  );

  assert.equal(prompts.length, 1);
  assert.ok(
    prompts[0]!.includes("Plan mode"),
    "the SDK query carries the Plan hint",
  );
  assert.deepEqual(
    durableUserTexts(runtime, "cs-plan"),
    ["how would we do X?"],
    "the app-owned log keeps only the clean human text",
  );
  const projected = JSON.stringify(runtime.get("cs-plan")!.clientTimeline());
  assert.ok(
    !projected.includes("<session-mode>"),
    "the client projection never shows the hint",
  );
});

test("hidden and agent-origin Plan turns carry the hint too", async () => {
  const { runtime, modelTexts, driver } = harnessed("sess-hidden", "pi");
  driver.sessionMode = "plan";
  await promptRuntimeSessionWithRuntime(runtime, driver, "resume answer", {
    clientRequestId: "h1",
    hidden: true,
  });
  await promptRuntimeSessionWithRuntime(runtime, driver, "peer instruction", {
    clientRequestId: "h2",
    origin: { kind: "agent", agentId: "peer-1" },
  });
  assert.equal(
    modelTexts.filter((t) => t.includes(planModeHint("pi"))).length,
    2,
    "both non-human paths reach the model, so both carry the hint",
  );
});
