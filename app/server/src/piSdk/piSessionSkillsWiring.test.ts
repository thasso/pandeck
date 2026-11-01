import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-session-skills-wiring-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const mocked = vi.hoisted(() => ({
  resolveCalls: [] as unknown[][],
  enabledNames: ["frozen-skill"],
}));
// The id-free resolution a new session freezes: the globally enabled skills
// (fixed here) plus a spawned definition's.
vi.mock("../sessionSkills.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startSessionSkillNames: async (
    ...args: [string, readonly string[] | undefined]
  ) => {
    mocked.resolveCalls.push(args);
    return [...new Set([...mocked.enabledNames, ...(args[1] ?? [])])].sort();
  },
}));

await import("../hub.ts");
const { piStore } = await import("./piStore.ts");
const { openPiEngine } = await import("./piEngineHost.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { parseSessionSkills } = await import("../sessionSkills.ts");
const { freezeSessionAgent, sessionAgent } =
  await import("../agents/sessionAgent.ts");
type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;
type PiEngineOpened = import("./piEngineHost.ts").PiEngineOpened;

interface StoreInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  track: (_kind: string, opened: PiEngineOpened) => { sessionId: string };
}

const agent = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "openai-codex",
  model: "gpt-5",
  effort: "high" as const,
  runtimeSource: "definition" as const,
  denyTools: ["bash"],
  skills: ["agent-skill"],
  body: "Review the tests.",
};

const internals = piStore as unknown as StoreInternals;
const originalOpenEngine = internals.openEngine;
const originalTrack = internals.track;
/** Every spec the store opened, and what each id had frozen when tracked. */
let specs: PiEngineOpenSpec[] = [];
let atTrack: Array<{ id: string; skills?: string; agent?: unknown }> = [];

beforeEach(() => {
  specs = [];
  atTrack = [];
  mocked.resolveCalls.length = 0;
  // The open succeeds on the real transcript; only pi's session is a stand-in.
  internals.openEngine = (spec) => {
    specs.push(spec);
    return openPiEngine(spec, {} as never, async (_spec, _ctx, { sm }) => ({
      session: {
        sessionId: sm.getSessionId(),
        get sessionFile() {
          return sm.getSessionFile();
        },
        sessionManager: sm,
        subscribe: () => () => {},
        dispose: () => {},
      } as never,
      notices: [],
    }));
  };
  internals.track = (_kind, { info }) => {
    const skills = sessionStore.getSkills(info.sessionId);
    const frozenAgent = sessionAgent(info.sessionId);
    atTrack.push({
      id: info.sessionId,
      ...(skills !== undefined ? { skills } : {}),
      ...(frozenAgent ? { agent: frozenAgent } : {}),
    });
    return { sessionId: info.sessionId };
  };
});

afterEach(() => {
  internals.openEngine = originalOpenEngine;
  internals.track = originalTrack;
});

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

test("pi new-session creation opens with the skills it freezes under the minted id", async () => {
  const live = await piStore.acquireNew("developer");

  assert.deepEqual(mocked.resolveCalls, [["developer", undefined]]);
  assert.deepEqual(specs[0]?.start.skillNames, mocked.enabledNames);
  assert.deepEqual(
    parseSessionSkills(sessionStore.getSkills(live.sessionId)),
    mocked.enabledNames,
  );
  assert.deepEqual(atTrack, [
    { id: live.sessionId, skills: JSON.stringify(mocked.enabledNames) },
  ]);
});

test("pi reopen passes the stored skills through the same creation seam", async () => {
  const id = "pi-reopen-skills";
  const file = writeTranscript(id);
  sessionStore.freezeSkills(id, '["stored-skill"]');

  await piStore.acquireExisting("developer", file, id);

  assert.deepEqual(mocked.resolveCalls, []);
  assert.deepEqual(specs[0]?.start.skillNames, ["stored-skill"]);
});

test("pi creation freezes a spawn's agent under the id it mints, after the open", async () => {
  const live = await piStore.acquireNew("developer", undefined, undefined, {
    agent,
  });

  const id = live.sessionId;
  assert.deepEqual(specs[0]?.start.agent, agent);
  // Its skills join the globally enabled ones in the first freeze.
  assert.deepEqual(mocked.resolveCalls, [["developer", ["agent-skill"]]]);
  assert.deepEqual(specs[0]?.start.skillNames, ["agent-skill", "frozen-skill"]);
  assert.deepEqual(sessionAgent(id), agent);
  assert.deepEqual(parseSessionSkills(sessionStore.getSkills(id)), [
    "agent-skill",
    "frozen-skill",
  ]);
  // Frozen before `track`, which registers the app tools from the agent.
  assert.deepEqual(atTrack, [
    {
      id,
      skills: JSON.stringify(["agent-skill", "frozen-skill"]),
      agent,
    },
  ]);
});

test("pi reopen builds with the stored agent, never the library's", async () => {
  const id = "pi-reopen-agent";
  const file = writeTranscript(id);
  freezeSessionAgent(id, agent);

  await piStore.acquireExisting("developer", file, id);

  assert.deepEqual(specs[0]?.start.agent, agent);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
