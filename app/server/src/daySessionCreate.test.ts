/**
 * A calendar day's session is created once however many activations ask for
 * it at the same time, and it is the one the day stays bound to.
 *   pnpm --filter @assistant/server test src/daySessionCreate.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
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
const { daySessionTitle, getDaySessionId } =
  await import("./calendarDaySessions.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function connection(sent: ServerMessage[]) {
  return new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
}

test("overlapping activations of an unbound day share one new session", async () => {
  const acquire = vi.spyOn(claudeSdkStore, "acquire").mockImplementation(
    (id: string) =>
      new ClaudeSdkSession(id, {
        // Never queried: the prompt below is a stand-in too.
        seam: async () => ({
          query: () => ({ async *[Symbol.asyncIterator]() {} }),
        }),
      }),
  );
  const prompted: string[] = [];
  vi.spyOn(runtimePrompt, "promptRuntimeSession").mockImplementation(
    async (driver) => void prompted.push(driver.sessionId),
  );
  const date = "2026-10-05";
  const activate = (sent: ServerMessage[]) =>
    connection(sent).handle({
      type: "calendarDayActivate",
      date,
      text: "Plan my day",
    } as ClientMessage);

  const sent: ServerMessage[] = [];
  await Promise.all([activate(sent), activate(sent)]);

  assert.deepEqual(
    sent.filter((message) => message.type === "error"),
    [],
  );
  assert.equal(acquire.mock.calls.length, 1);
  const bound = getDaySessionId(date);
  assert.ok(bound);
  assert.deepEqual(prompted, [bound, bound]);
  const created = acquire.mock.results[0]?.value as InstanceType<
    typeof ClaudeSdkSession
  >;
  assert.equal(created.sessionTitle, daySessionTitle(date));
});
