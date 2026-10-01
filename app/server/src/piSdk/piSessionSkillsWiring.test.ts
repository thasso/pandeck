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
vi.mock("./options.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAgentOptions: async (...args: unknown[]) => {
    mocked.optionCalls.push(args);
    throw mocked.stop;
  },
}));

const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

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

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
