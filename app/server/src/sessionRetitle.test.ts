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

vi.mock("./harnesses/oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harnesses/oneShot.ts")>()),
  runOneShot: vi.fn(),
}));
vi.mock("./settingsModelSlots.ts", () => ({
  accountForSlot: () => "profile-1",
}));
vi.mock("./tasks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tasks.ts")>()),
  findOriginTask: vi.fn(),
  readTask: vi.fn(),
}));

const { NoHelperModelError, runOneShot } =
  await import("./harnesses/oneShot.ts");
const { findOriginTask, readTask } = await import("./tasks.ts");
const { recentTranscript, retitleSession } =
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

  assert.deepEqual(recentTranscript(sessionId), [
    { role: "user", text: "fix the login redirect" },
    { role: "assistant", text: "Fixed it." },
    { role: "user", text: "now add a /rename command" },
  ]);
});

test("the newest turns win when the conversation exceeds the budget", () => {
  const long = "x".repeat(1_100);
  writeLog(Array.from({ length: 20 }, (_, i) => user(`u${i}`, `${i} ${long}`)));

  const transcript = recentTranscript(sessionId);
  assert.ok(transcript.length < 20);
  assert.match(transcript.at(-1)!.text, /^19 /);
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

  const title = await retitleSession({
    sessionId,
    guidance: "  stress the naming agent  ",
    rename: async (next) => {
      renamed.push(next);
    },
    changed: async () => {
      pendingSeen ||= isRetitlingSession(sessionId);
    },
  });

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
    changed: async () => {},
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
      changed: async () => {},
    }),
    /No model is available/,
  );
  assert.deepEqual(renamed, []);
  assert.equal(isRetitlingSession(sessionId), false);
});
