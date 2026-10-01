import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-skills-lifecycle-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionStore } = await import("./db/sessionStore.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
type RuntimePromptDriver =
  import("./session/runtimePrompt.ts").RuntimePromptDriver;
type SessionRuntime = import("./session/runtime/runtime.ts").SessionRuntime;

function driver(id: string): RuntimePromptDriver {
  return {
    id,
    key: id,
    sessionId: id,
    harness: "claude-sdk",
    agentType: "developer",
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    createRuntimeAdapter() {
      throw new Error("the runtime adapter is reached only after freezing");
    },
  } as unknown as RuntimePromptDriver;
}

function runtimeReachedAfter(
  expectedSkills: string | undefined,
): SessionRuntime {
  return {
    get(id: string) {
      assert.equal(
        sessionStore.getSkills(id),
        expectedSkills,
        "skills are frozen before the runtime can append the first user entry",
      );
      throw new Error("runtime reached after freeze");
    },
    admitPrompt: () => () => {},
  } as unknown as SessionRuntime;
}

test("the runtime-prompt backstop freezes a legacy coding session before runtime creation", async () => {
  const id = "legacy-coding-session";
  assert.equal(sessionStore.getSkills(id), undefined);

  await assert.rejects(
    promptRuntimeSessionWithRuntime(
      runtimeReachedAfter("[]"),
      driver(id),
      "hi",
    ),
    /runtime reached after freeze/,
  );
  assert.equal(sessionStore.getSkills(id), "[]");
});

test("reopening through the runtime-prompt backstop preserves the stored list", async () => {
  const id = "reopened-coding-session";
  sessionStore.freezeSkills(id, '["stable-skill"]');

  await assert.rejects(
    promptRuntimeSessionWithRuntime(
      runtimeReachedAfter('["stable-skill"]'),
      driver(id),
      "resume",
    ),
    /runtime reached after freeze/,
  );
  assert.equal(sessionStore.getSkills(id), '["stable-skill"]');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
