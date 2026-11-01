/**
 * A pi fork carries the parent's Build/Plan mode (Task 332): the fork's create
 * call requests the parent's mode and the forked session's durable record
 * persists it, so a fork of a Plan session opens in Plan.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piForkMode.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-mode-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

const { openPiEngine } = await import("./piEngineHost.ts");

type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;
type PiEngineOpened = import("./piEngineHost.ts").PiEngineOpened;

interface StoreInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  track: (
    _kind: string,
    opened: PiEngineOpened,
  ) => { sessionId: string; sessionFile?: string };
}

test("a fork of a Plan session opens (and persists) in Plan", async () => {
  const parentId = "fork-mode-parent";
  const entryId = "fork-mode-entry";
  const assistantEntryId = "fork-mode-assistant";
  const parentFile = canonicalPiSessionPath(parentId);
  mkdirSync(dirname(parentFile), { recursive: true });
  writeFileSync(
    parentFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: parentId,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "fork here", timestamp: Date.now() },
      }),
      JSON.stringify({
        type: "message",
        id: assistantEntryId,
        parentId: entryId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "forkable" }],
          timestamp: Date.now(),
        },
      }),
      "",
    ].join("\n"),
  );
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "workshop",
    mode: "plan",
    peerTurnCap: 10,
  });
  sessionStore.freezeSkills(parentId, '["parent-skill"]');
  const parentAgent = {
    name: "test-reviewer",
    blob: "0".repeat(40),
    persona: "developer",
    provider: "openai-codex",
    model: "gpt-5",
    effort: "high",
    runtimeSource: "definition",
    denyTools: ["bash"],
    skills: [],
    body: "Review the tests.",
  };
  sessionStore.freezeAgent(parentId, JSON.stringify(parentAgent));

  const internals = piStore as unknown as StoreInternals;
  const originalOpenEngine = internals.openEngine;
  const originalTrack = internals.track;
  let requestedMode: unknown;
  let inheritedSkills: unknown;
  let inheritedAgent: unknown;

  internals.openEngine = (spec) => {
    inheritedSkills = spec.start.skillNames;
    inheritedAgent = spec.start.agent;
    requestedMode = spec.mode;
    return openPiEngine(spec, {} as never, async (_spec, _ctx, { sm }) => ({
      session: {
        sessionId: sm.getSessionId(),
        get sessionFile() {
          return sm.getSessionFile();
        },
        sessionManager: sm,
        subscribe: () => () => {},
      } as never,
      notices: [],
    }));
  };
  internals.track = (_kind, { engine }) => ({
    sessionId: engine.sessionId,
    ...(engine.sessionFile !== undefined
      ? { sessionFile: engine.sessionFile }
      : {}),
  });

  try {
    const forked = await piStore.forkSession(
      "workshop",
      parentFile,
      assistantEntryId,
      "at",
      "app-entry-1",
    );
    const childId = forked.sessionId;
    assert.notEqual(childId, parentId);
    assert.equal(sessionStore.get(childId)?.peerTurnCap, undefined);
    assert.equal(
      forked.sessionFile,
      canonicalPiSessionPath(childId),
      "the fork immediately points at its canonical native transcript",
    );
    assert.equal(
      existsSync(canonicalPiSessionPath(childId)),
      true,
      "the fork's native transcript is recoverable by id after restart",
    );
    assert.deepEqual(
      inheritedSkills,
      ["parent-skill"],
      "the create call receives the parent's exact frozen skill list",
    );
    assert.deepEqual(
      inheritedAgent,
      parentAgent,
      "the create call receives the parent's frozen agent definition",
    );
    assert.equal(requestedMode, "plan", "create() is asked for Plan");
    assert.equal(
      sessionStore.get(childId)?.mode,
      "plan",
      "the fork's durable record starts in Plan",
    );
  } finally {
    internals.openEngine = originalOpenEngine;
    internals.track = originalTrack;
    rmSync(tmp, { recursive: true, force: true });
  }
});
