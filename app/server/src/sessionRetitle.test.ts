/**
 * `/rename`'s contract: the naming agent reads recent visible turns (never tool
 * calls), the user's guidance and the origin Task; the list shows the title as
 * pending while it runs; and a manual rename in the meantime wins.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";

vi.mock("./harnesses/oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harnesses/oneShot.ts")>()),
  runOneShot: vi.fn(),
}));
vi.mock("./tasks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tasks.ts")>()),
  findOriginTask: vi.fn(),
  readTask: vi.fn(),
}));

const { NoHelperModelError, runOneShot } =
  await import("./harnesses/oneShot.ts");
const { findOriginTask, readTask } = await import("./tasks.ts");
const { namingTranscript, retitleSession } =
  await import("./sessionRetitle.ts");
const { cancelSessionRetitle, isRetitlingSession } =
  await import("./sessionRetitlePending.ts");

let counter = 0;
let sessionId = "";

function writeLog(rows: unknown[]): void {
  const path = canonicalSessionLogPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
}

const user = (id: string, text: string) => ({
  type: "message",
  id,
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (id: string, content: unknown[]) => ({
  type: "message",
  id,
  role: "assistant",
  content,
});

beforeEach(() => {
  sessionId = `retitle-session-${counter++}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "claude-sdk",
    agentType: "developer",
    title: "Fix login redirect",
    scope: "user",
  });
  vi.mocked(runOneShot).mockReset();
  vi.mocked(findOriginTask).mockReset();
  vi.mocked(readTask).mockReset();
});
afterEach(() => {
  rmSync(dirname(canonicalSessionLogPath(sessionId)), {
    recursive: true,
    force: true,
  });
});

test("the transcript keeps prompts and replies but no tool traffic", () => {
  writeLog([
    user(
      "u1",
      "<memory>\nsecret preference\n</memory>\nfix the login redirect",
    ),
    assistant("a1", [
      { type: "thinking", text: "hmm" },
      { type: "toolCall", name: "Bash", arguments: { command: "ls" } },
      { type: "text", text: "Fixed it." },
    ]),
    {
      type: "message",
      id: "t1",
      role: "toolResult",
      toolName: "Bash",
      content: [{ type: "text", text: "file.ts" }],
    },
    user("u2", "now add a /rename command"),
  ]);

  assert.deepEqual(namingTranscript(sessionId), {
    recent: [
      { role: "user", text: "fix the login redirect" },
      { role: "assistant", text: "Fixed it." },
      { role: "user", text: "now add a /rename command" },
    ],
  });
});

test("the newest turns win when the conversation exceeds the budget", () => {
  const long = "x".repeat(1_100);
  writeLog(Array.from({ length: 20 }, (_, i) => user(`u${i}`, `${i} ${long}`)));

  const { opening, recent } = namingTranscript(sessionId);
  assert.ok(recent.length < 20);
  assert.match(recent.at(-1)!.text, /^19 /);
  // The opening prompt fell out of the recent turns, so it comes separately.
  assert.match(opening!, /^0 /);
});

test("a tool-heavy log is read only within its tail bytes", () => {
  const output = "y".repeat(64 * 1024);
  writeLog([
    user("u1", "start the migration"),
    assistant("a1", [{ type: "text", text: "Starting." }]),
    // ~2 MiB of tool traffic: past the tail window, nothing visible in it.
    ...Array.from({ length: 32 }, (_, i) => ({
      type: "message",
      id: `t${i}`,
      role: "toolResult",
      toolName: "Bash",
      content: [{ type: "text", text: output }],
    })),
    assistant("a2", [{ type: "text", text: "Migration done." }]),
  ]);

  assert.deepEqual(namingTranscript(sessionId), {
    opening: "start the migration",
    recent: [{ role: "assistant", text: "Migration done." }],
  });
});

test("guidance, current title and origin Task reach the agent; the reference prefixes the title", async () => {
  writeLog([user("u1", "add a /rename command to the composer")]);
  vi.mocked(findOriginTask).mockReturnValue({
    id: "42",
    title: "Session rename command",
    status: "doing",
  });
  vi.mocked(readTask).mockReturnValue(null);
  vi.mocked(runOneShot).mockResolvedValue({
    text: '"Add Composer Rename Command."',
    usage: {},
  });
  const renamed: string[] = [];
  let pendingSeen = false;

  const touches = recordSessionRowTouches((ids) => {
    if (ids.has(sessionId)) pendingSeen ||= isRetitlingSession(sessionId);
  });
  const title = await retitleSession({
    sessionId,
    guidance: "  stress the naming agent  ",
    rename: async (next) => {
      renamed.push(next);
    },
  }).finally(() => touches.stop());

  assert.equal(title, "Task-42: Add Composer Rename Command");
  assert.deepEqual(renamed, ["Task-42: Add Composer Rename Command"]);
  assert.equal(pendingSeen, true);
  assert.equal(isRetitlingSession(sessionId), false);
  const request = vi.mocked(runOneShot).mock.calls[0]![0];
  assert.match(
    request.prompt,
    /User's naming guidance[^<]*<<<\nstress the naming agent\n>>>/,
  );
  assert.match(request.prompt, /Current title:\n<<<\nFix login redirect\n>>>/);
  assert.match(request.prompt, /Task-42 \(doing\): Session rename command/);
  assert.match(request.prompt, /User: add a \/rename command to the composer/);
  assert.equal(request.record?.parentSessionId, sessionId);
});

test("retitling captures enterprise scope before it announces the pending state", async () => {
  sessionId = `enterprise-retitle-${counter++}`;
  sessionStore.upsert({
    id: sessionId,
    harness: "claude-sdk",
    agentType: "developer",
    requiresEnterprise: true,
  });
  const original = sessionStore.get(sessionId)!;
  writeLog([user("u1", "Enterprise transcript")]);
  vi.mocked(runOneShot).mockResolvedValue({
    text: "Enterprise Title",
    usage: {},
  });
  let spy: { mockRestore(): void } | undefined;
  // The pending state's touch is the first thing a viewer can react to.
  const touches = recordSessionRowTouches(() => {
    spy ??= vi
      .spyOn(sessionStore, "get")
      .mockReturnValue({ ...original, requiresEnterprise: false });
  });
  try {
    await retitleSession({
      sessionId,
      rename: async () => {},
    });
    assert.equal(
      vi.mocked(runOneShot).mock.calls[0]?.[0].requiresEnterprise,
      true,
    );
  } finally {
    touches.stop();
    spy?.mockRestore();
  }
});

test("a manual rename during generation wins", async () => {
  writeLog([user("u1", "hello")]);
  let finish!: (value: { text: string; usage: object }) => void;
  vi.mocked(runOneShot).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const renamed: string[] = [];

  const run = retitleSession({
    sessionId,
    rename: async (next) => {
      renamed.push(next);
    },
  });
  await vi.waitFor(() => assert.ok(finish));
  assert.equal(cancelSessionRetitle(sessionId), true);
  finish({ text: "Generated Title", usage: {} });

  assert.equal(await run, undefined);
  assert.deepEqual(renamed, []);
  assert.equal(isRetitlingSession(sessionId), false);
});

test("no usable model is an error the user sees, and the old title stays", async () => {
  writeLog([user("u1", "hello")]);
  vi.mocked(runOneShot).mockRejectedValue(
    new NoHelperModelError("No model is available for session titles."),
  );
  const renamed: string[] = [];

  await assert.rejects(
    retitleSession({
      sessionId,
      rename: async (next) => {
        renamed.push(next);
      },
    }),
    /No model is available/,
  );
  assert.deepEqual(renamed, []);
  assert.equal(isRetitlingSession(sessionId), false);
});

test("the opening prompt is looked for only near the start of the log", () => {
  const output = "y".repeat(64 * 1024);
  writeLog([
    // ~320 KiB of tool traffic before any visible record, then the prompt.
    ...Array.from({ length: 5 }, (_, i) => ({
      type: "message",
      id: `t${i}`,
      role: "toolResult",
      toolName: "Bash",
      content: [{ type: "text", text: output }],
    })),
    user("u1", "late prompt"),
    ...Array.from({ length: 32 }, (_, i) => ({
      type: "message",
      id: `r${i}`,
      role: "toolResult",
      toolName: "Bash",
      content: [{ type: "text", text: output }],
    })),
  ]);

  // Past the head cap and outside the tail window: nothing to name.
  assert.deepEqual(namingTranscript(sessionId), { recent: [] });
});

test("an opening prompt followed only by tool traffic is still found", () => {
  const output = "y".repeat(64 * 1024);
  writeLog([
    user("u1", "start the migration"),
    ...Array.from({ length: 32 }, (_, i) => ({
      type: "message",
      id: `t${i}`,
      role: "toolResult",
      toolName: "Bash",
      content: [{ type: "text", text: output }],
    })),
  ]);

  assert.deepEqual(namingTranscript(sessionId), {
    opening: "start the migration",
    recent: [],
  });
});

test("a superseded run reports nothing, even when it fails", async () => {
  writeLog([user("u1", "hello")]);
  let fail!: (err: Error) => void;
  vi.mocked(runOneShot).mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );

  const run = retitleSession({
    sessionId,
    rename: async () => {},
  });
  await vi.waitFor(() => assert.ok(fail));
  cancelSessionRetitle(sessionId);
  fail(new Error("Session title generation timed out."));

  assert.equal(await run, undefined);
});

test("a run that broke off mid-answer keeps the old title", async () => {
  writeLog([user("u1", "hello")]);
  vi.mocked(runOneShot).mockResolvedValue({
    text: "Half a ti",
    usage: {},
    failure: "aborted",
  });
  const renamed: string[] = [];

  await assert.rejects(
    retitleSession({
      sessionId,
      rename: async (next) => {
        renamed.push(next);
      },
    }),
    /aborted/,
  );
  assert.deepEqual(renamed, []);
});

test("a session whose log names nothing is refused without a run", async () => {
  await assert.rejects(
    retitleSession({
      sessionId,
      rename: async () => {},
    }),
    /no conversation/,
  );
  assert.equal(vi.mocked(runOneShot).mock.calls.length, 0);
  assert.equal(isRetitlingSession(sessionId), false);
});
