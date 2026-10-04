/**
 * A calendar day's session is created once however many activations ask for
 * it at the same time, and it is the one the day stays bound to.
 *   pnpm --filter @assistant/server test src/daySessionCreate.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "day-session-create-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({
    claudeSdk: { enabled: true },
    calendarDaySession: { provider: "claude-sdk", modelId: "sonnet" },
  }),
);

const { Connection } = await import("./connection.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const runtimePrompt = await import("./session/runtimePrompt.ts");
const daySessions = await import("./calendarDaySessions.ts");
const { daySessionTitle, getDaySessionId, setDaySessionId } = daySessions;
const { hub } = await import("./hub.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

type Session = InstanceType<typeof ClaudeSdkSession>;

/** Claude creations answered by real sessions over a seam nothing queries. */
function claudeCreations() {
  const created = new Map<string, Session>();
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation((id: string) => {
      const session = new ClaudeSdkSession(id, {
        seam: async () => ({
          query: () => ({ async *[Symbol.asyncIterator]() {} }),
        }),
      });
      created.set(id, session);
      return session;
    });
  return { acquire, created };
}

function activate(date: string, sent: ServerMessage[]) {
  return connection(sent).handle({
    type: "calendarDayActivate",
    date,
    text: "Plan my day",
  } as ClientMessage);
}

function connection(sent: ServerMessage[]) {
  return new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
}

test("overlapping activations of an unbound day share one new session", async () => {
  const { acquire, created } = claudeCreations();
  const prompted: string[] = [];
  vi.spyOn(runtimePrompt, "promptRuntimeSession").mockImplementation(
    async (driver) => void prompted.push(driver.sessionId),
  );
  const date = "2026-10-05";

  const sent: ServerMessage[] = [];
  await Promise.all([activate(date, sent), activate(date, sent)]);

  assert.deepEqual(
    sent.filter((message) => message.type === "error"),
    [],
  );
  assert.equal(acquire.mock.calls.length, 1);
  const bound = getDaySessionId(date);
  assert.ok(bound);
  assert.deepEqual(prompted, [bound, bound]);
  assert.equal(created.get(bound)?.sessionTitle, daySessionTitle(date));
});

test("an activation that finds a stale binding late keeps the day's new session", async () => {
  const { acquire, created } = claudeCreations();
  const prompted: string[] = [];
  vi.spyOn(runtimePrompt, "promptRuntimeSession").mockImplementation(
    async (driver) => void prompted.push(driver.sessionId),
  );
  const date = "2026-10-06";
  setDaySessionId(date, "stale-day-session");
  // Each activation's look-up of the stale binding answers when the test says.
  const staleAnswers: Array<() => void> = [];
  vi.spyOn(hub, "acquireById").mockImplementation(async (id: string) => {
    if (id !== "stale-day-session") return created.get(id);
    await new Promise<void>((resolve) => staleAnswers.push(resolve));
    return undefined;
  });

  const sent: ServerMessage[] = [];
  const first = activate(date, sent);
  const second = activate(date, sent);
  await vi.waitFor(() => assert.equal(staleAnswers.length, 2));
  staleAnswers[0]!();
  await first;
  // The first activation replaced the stale binding with a new session; the
  // second only now learns its binding was stale.
  staleAnswers[1]!();
  await second;

  assert.deepEqual(
    sent.filter((message) => message.type === "error"),
    [],
  );
  assert.equal(acquire.mock.calls.length, 1);
  const bound = getDaySessionId(date);
  assert.ok(bound && created.has(bound));
  assert.deepEqual(prompted, [bound, bound]);
});

test("a binding whose look-up fails inside the shared creation is treated as stale", async () => {
  const { acquire, created } = claudeCreations();
  vi.spyOn(runtimePrompt, "promptRuntimeSession").mockResolvedValue();
  const date = "2026-10-07";
  // The activation finds the day unbound; by the time the shared creation
  // rechecks, a binding has appeared whose session cannot be opened.
  vi.spyOn(daySessions, "getDaySessionId")
    .mockReturnValueOnce(null)
    .mockReturnValueOnce("broken-day-session");
  vi.spyOn(hub, "acquireById").mockImplementation(async (id: string) => {
    if (id === "broken-day-session") throw new Error("transcript unreadable");
    return created.get(id);
  });

  const sent: ServerMessage[] = [];
  await activate(date, sent);

  assert.deepEqual(
    sent.filter((message) => message.type === "error"),
    [],
  );
  assert.equal(acquire.mock.calls.length, 1);
  vi.mocked(daySessions.getDaySessionId).mockRestore();
  const bound = getDaySessionId(date);
  assert.ok(bound && created.has(bound));
});
