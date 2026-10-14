import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-session-skills-wiring-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const mocked = vi.hoisted(() => ({
  skillCalls: [] as unknown[][],
  optionCalls: [] as unknown[][],
  frozenNames: ["frozen-skill"],
  stop: new Error("stop after agent options"),
}));
vi.mock("../sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSkills: async (...args: unknown[]) => {
    mocked.skillCalls.push(args);
    return mocked.frozenNames;
  },
}));
// An agent session at an empty transcript resolves its frozen model first.
vi.mock("./models.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findModelForProfile: async (_profile: string, provider: string, id: string) =>
    ({ provider, id }) as never,
}));
vi.mock("./options.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAgentOptions: async (...args: unknown[]) => {
    mocked.optionCalls.push(args);
    throw mocked.stop;
  },
}));

const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { freezeSessionAgent, sessionAgent } =
  await import("../agents/sessionAgent.ts");

const agent = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "openai-codex",
  model: "gpt-5",
  effort: "high" as const,
  denyTools: ["bash"],
  skills: ["agent-skill"],
  body: "Review the tests.",
};

function writeTranscript(id: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: tmp,
    })}\n`,
  );
  return file;
}

test("pi new-session creation passes its frozen skills to agent options", async () => {
  await assert.rejects(piStore.acquireNew("developer"), mocked.stop);

  assert.equal(mocked.skillCalls.length, 1);
  assert.equal(mocked.skillCalls[0]![1], "developer");
  assert.equal(typeof mocked.skillCalls[0]![0], "string");
  assert.deepEqual(mocked.optionCalls[0]?.[4], mocked.frozenNames);
});

test("pi reopen passes the stored skills through the same creation seam", async () => {
  mocked.skillCalls.length = 0;
  mocked.optionCalls.length = 0;
  const id = "pi-reopen-skills";
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd: tmp,
    })}\n`,
  );

  await assert.rejects(
    piStore.acquireExisting("developer", file, id),
    mocked.stop,
  );

  assert.deepEqual(mocked.skillCalls, [[id, "developer", undefined]]);
  assert.deepEqual(mocked.optionCalls[0]?.[4], mocked.frozenNames);
});

test("pi creation freezes a spawn's agent under the id it mints", async () => {
  mocked.skillCalls.length = 0;
  mocked.optionCalls.length = 0;
  await assert.rejects(
    piStore.acquireNew("developer", undefined, undefined, { agent }),
    mocked.stop,
  );

  const id = mocked.skillCalls[0]![0] as string;
  assert.deepEqual(sessionAgent(id), agent);
  // Its skills join the globally enabled ones (none here) in the first freeze.
  assert.deepEqual(mocked.skillCalls[0]![2], ["agent-skill"]);
  assert.deepEqual(mocked.optionCalls[0]?.[5], agent);
});

test("pi reopen builds with the stored agent, never the library's", async () => {
  mocked.skillCalls.length = 0;
  mocked.optionCalls.length = 0;
  const id = "pi-reopen-agent";
  const file = writeTranscript(id);
  freezeSessionAgent(id, agent);

  await assert.rejects(
    piStore.acquireExisting("developer", file, id),
    mocked.stop,
  );

  assert.deepEqual(mocked.skillCalls, [[id, "developer", undefined]]);
  assert.deepEqual(mocked.optionCalls[0]?.[5], agent);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
