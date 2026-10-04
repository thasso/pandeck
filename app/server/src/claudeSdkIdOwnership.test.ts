/**
 * A Claude first send names its session id itself, so one that another engine
 * already holds is refused before anything is written for it: no worktree
 * edge, no frozen prompt conditions, no Claude session over a pi one.
 *
 *   pnpm --filter @assistant/server test src/claudeSdkIdOwnership.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "claude-sdk-id-ownership-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const promptConditions = await import("./promptConditions.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const claudeProfile = createCredentialProfile({
  name: "Test Claude",
  provider: "claude",
});

function firstSend(id: string) {
  const sent: Array<{ type: string; message?: string }> = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => {
      handleClaudeSdkSend: (msg: Record<string, unknown>) => Promise<void>;
    }
  )({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  });
  const acquire = vi.spyOn(hub, "acquireClaudeSdk");
  const freeze = vi.spyOn(promptConditions, "sessionPromptConditions");
  return {
    sent,
    acquire,
    freeze,
    run: () =>
      conn.handleClaudeSdkSend({
        id,
        agentType: "assistant",
        text: "hello",
        credentialProfileId: claudeProfile.id,
        clientRequestId: "creq-1",
      }),
  };
}

test("a first send for a pi session's recorded id is refused before any write", async () => {
  sessionStore.upsert({
    id: "pi-recorded",
    harness: "pi",
    agentType: "assistant",
  });
  const send = firstSend("pi-recorded");
  await send.run();
  assert.deepEqual(send.sent.at(-1), {
    type: "error",
    message: "Session pi-recorded belongs to the pi harness.",
    target: { type: "session", id: "pi-recorded" },
    failedPromptClientRequestId: "creq-1",
  });
  assert.equal(send.acquire.mock.calls.length, 0);
  assert.equal(send.freeze.mock.calls.length, 0);
  assert.equal(sessionStore.get("pi-recorded")?.harness, "pi");
});

test("a first send for a resident pi session's id is refused too", async () => {
  vi.spyOn(piStore, "getLiveById").mockImplementation((id) =>
    id === "pi-resident" ? ({ id } as never) : undefined,
  );
  const send = firstSend("pi-resident");
  await send.run();
  assert.equal(send.sent.at(-1)?.type, "error");
  assert.equal(send.acquire.mock.calls.length, 0);
  assert.equal(send.freeze.mock.calls.length, 0);
});

test("a first send for a pi transcript with no row is refused too", async () => {
  const file = canonicalPiSessionPath("pi-transcript");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  const send = firstSend("pi-transcript");
  await send.run();
  assert.equal(send.sent.at(-1)?.type, "error");
  assert.equal(send.acquire.mock.calls.length, 0);
  assert.equal(sessionStore.get("pi-transcript"), undefined, "no row written");
});

test("a first send for a Claude session's own id goes through", async () => {
  sessionStore.upsert({
    id: "claude-own",
    harness: "claude-sdk",
    agentType: "assistant",
  });
  const send = firstSend("claude-own");
  // Stop at the session, which is all this asks: it was not refused.
  send.acquire.mockImplementation(() => {
    throw new Error("reached the session");
  });
  await assert.rejects(send.run(), /reached the session/);
  assert.ok(!send.sent.some((m) => m.type === "error"));
});

test("an id pi takes while the send awaits is refused before any write", async () => {
  // Free at the door; pi has it by the time the send's awaits are done.
  vi.spyOn(harnessRegistry, "otherHolder")
    .mockReturnValueOnce(undefined)
    .mockReturnValue("pi");
  const send = firstSend("taken-meanwhile");
  await send.run();
  assert.deepEqual(send.sent.at(-1), {
    type: "error",
    message: "Session taken-meanwhile belongs to the pi harness.",
    target: { type: "session", id: "taken-meanwhile" },
    failedPromptClientRequestId: "creq-1",
  });
  assert.equal(send.acquire.mock.calls.length, 0);
  assert.equal(send.freeze.mock.calls.length, 0);
});
