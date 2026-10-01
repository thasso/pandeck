import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ClaudeQueryParams, ClaudeSdkSeam } from "./sdkSeam.ts";

const mocked = vi.hoisted(() => ({
  names: new Map<string, string[]>(),
}));

vi.mock("../sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activeSkillsForSession: (sessionId: string) =>
    mocked.names.get(sessionId) ?? [],
}));

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");

const sessions: InstanceType<typeof ClaudeSdkSession>[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  mocked.names.clear();
});

function captureSeam(calls: ClaudeQueryParams[]): ClaudeSdkSeam {
  return {
    query(params) {
      calls.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          // An empty fake stream is sufficient to inspect each query's options.
        },
      };
    },
  };
}

function makeSession(
  id: string,
  agentType: "developer" | "workshop" | "assistant",
  calls: ClaudeQueryParams[],
  preparations: string[][],
  providerSessionId?: string,
) {
  const session = new ClaudeSdkSession(id, {
    seam: () => Promise.resolve(captureSeam(calls)),
    agentType,
    ...(providerSessionId ? { providerSessionId } : {}),
    prepareSkillRuntime: async (names) => {
      preparations.push([...names]);
    },
  });
  sessions.push(session);
  return session;
}

async function hiddenPrompt(
  session: InstanceType<typeof ClaudeSdkSession>,
): Promise<void> {
  await session.createRuntimeAdapter().prompt("inspect skills", {
    hidden: true,
  });
}

function pluginPath(call: ClaudeQueryParams): string | undefined {
  return (call.options?.plugins as Array<{ path: string }> | undefined)?.[0]
    ?.path;
}

test("fresh, resumed, and forked coding queries reuse and prepare the frozen skill set", async () => {
  for (const scenario of [
    { id: "skills-fresh", providerSessionId: undefined },
    { id: "skills-resumed", providerSessionId: "provider-resumed" },
    { id: "skills-forked", providerSessionId: "provider-forked" },
  ]) {
    mocked.names.set(scenario.id, ["frozen-skill"]);
    const calls: ClaudeQueryParams[] = [];
    const preparations: string[][] = [];
    const session = makeSession(
      scenario.id,
      "developer",
      calls,
      preparations,
      scenario.providerSessionId,
    );

    await hiddenPrompt(session);
    assert.deepEqual(preparations, [["frozen-skill"]]);
    assert.match(pluginPath(calls[0]!) ?? "", /skills-runtime\/[0-9a-f]{64}$/);
    assert.equal(
      calls[0]!.options?.resume,
      scenario.providerSessionId,
      `${scenario.id} keeps its provider resume identity`,
    );
  }
});

test("every resumed query recreates the runtime, while empty and assistant sessions mount nothing", async () => {
  mocked.names.set("skills-repeat", ["frozen-skill"]);
  const repeatCalls: ClaudeQueryParams[] = [];
  const repeatPreparations: string[][] = [];
  const repeat = makeSession(
    "skills-repeat",
    "workshop",
    repeatCalls,
    repeatPreparations,
    "provider-repeat",
  );
  await hiddenPrompt(repeat);
  await hiddenPrompt(repeat);
  assert.deepEqual(repeatPreparations, [["frozen-skill"], ["frozen-skill"]]);
  assert.equal(repeatCalls.length, 2);
  assert.equal(pluginPath(repeatCalls[0]!), pluginPath(repeatCalls[1]!));

  mocked.names.set("skills-empty", []);
  const emptyCalls: ClaudeQueryParams[] = [];
  const emptyPreparations: string[][] = [];
  await hiddenPrompt(
    makeSession("skills-empty", "developer", emptyCalls, emptyPreparations),
  );
  assert.deepEqual(emptyPreparations, []);
  assert.equal(emptyCalls[0]!.options?.plugins, undefined);

  // The mocked read is deliberately hostile here: persona gating must still be
  // authoritative even if a caller or corrupt row appears to supply names.
  mocked.names.set("skills-assistant", ["frozen-skill"]);
  const assistantCalls: ClaudeQueryParams[] = [];
  const assistantPreparations: string[][] = [];
  await hiddenPrompt(
    makeSession(
      "skills-assistant",
      "assistant",
      assistantCalls,
      assistantPreparations,
    ),
  );
  assert.deepEqual(assistantPreparations, []);
  assert.equal(assistantCalls[0]!.options?.plugins, undefined);
  assert.deepEqual(assistantCalls[0]!.options?.settingSources, []);
});

test("manual compaction is explicitly skill-free and does not recreate a runtime", async () => {
  mocked.names.set("skills-compact", ["frozen-skill"]);
  const calls: ClaudeQueryParams[] = [];
  const preparations: string[][] = [];
  const session = makeSession(
    "skills-compact",
    "developer",
    calls,
    preparations,
    "provider-compact",
  );

  const outcome = await session.compactContext();
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(preparations, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options?.tools, []);
  assert.equal(calls[0]!.options?.plugins, undefined);
});
