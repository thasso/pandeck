/**
 * The Personal Assistant singleton is created once however many callers ask
 * for it at the same time.
 *   pnpm --filter @assistant/server test src/permanentAssistantAcquire.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "permanent-assistant-acquire-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({
    claudeSdk: { enabled: true },
    permanentAssistant: { provider: "claude-sdk", modelId: "sonnet" },
  }),
);

const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const {
  permanentAssistantSessionId,
  permanentAssistantViewableId,
  rotatePermanentAssistantSession,
} = await import("./permanentAssistant.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const create = await import("./harnesses/create.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const { getSettings } = await import("./settings.ts");
const { permanentAssistantProfileInstructions } =
  await import("./permanentAssistantProfile.ts");
const { hub } = await import("./hub.ts");
const { memoryScheduler } = await import("./memory/memoryScheduler.ts");

/** Creations answered in order as `assistant-1`, `assistant-2`, ... */
function assistantCreations() {
  const created: string[] = [];
  vi.spyOn(create, "createSession").mockImplementation(async () => {
    const id = `assistant-${created.length + 1}`;
    created.push(id);
    return { id, sessionId: id } as never;
  });
  return created;
}

/** The bound singleton `old`, answered as a real Personal Assistant. */
function boundOld(lookup?: Promise<void>) {
  permanentAssistantStore.setSessionId("old");
  vi.spyOn(hub, "acquireById").mockImplementation(async (id: string) => {
    if (id !== "old") return undefined;
    await lookup;
    return {
      id: "old",
      sessionId: "old",
      agentType: "personal-assistant",
      createRuntimeAdapter() {},
    } as never;
  });
}

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  permanentAssistantStore.clearSessionId();
});

test("concurrent callers share one new singleton, and it is the one bound", async () => {
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation((id: string) => ({ id, sessionId: id }) as never);

  const [first, second] = await Promise.all([
    permanentAssistantSessionId(),
    permanentAssistantSessionId(),
  ]);

  assert.equal(acquire.mock.calls.length, 1);
  assert.equal(first, second);
  assert.equal(permanentAssistantStore.sessionId(), first);
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "personal-assistant",
    credentialProfileId: acquire.mock.calls[0]?.[1]?.credentialProfileId,
    modelId: "sonnet",
    thinkingLevel: getSettings().permanentAssistant.thinkingLevel,
    additionalSystemPrompt: permanentAssistantProfileInstructions(
      getSettings().permanentAssistant,
    ),
  });
});

test("a rotation retires a creation under way: the new profile's singleton is bound", async () => {
  let finishOld!: () => void;
  const created: string[] = [];
  vi.spyOn(create, "createSession").mockImplementation(async () => {
    const id = `assistant-${created.length + 1}`;
    created.push(id);
    // The first creation is still under way when the profile rotates.
    if (created.length === 1)
      await new Promise<void>((resolve) => (finishOld = resolve));
    return { id, sessionId: id } as never;
  });

  const old = permanentAssistantSessionId();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rotatePermanentAssistantSession();
  const current = permanentAssistantSessionId();
  finishOld();

  assert.equal(await current, "assistant-2");
  // The old caller is answered by the current singleton too, not by the one
  // its retired creation made.
  assert.equal(await old, "assistant-2");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-2");
  assert.deepEqual(created, ["assistant-1", "assistant-2"]);
});

test("an acquisition asked for during a rotation waits for the old singleton to be abandoned", async () => {
  const created = assistantCreations();
  boundOld();
  const flush = held();
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockReturnValue(flush.promise);

  const rotating = rotatePermanentAssistantSession();
  const id = permanentAssistantSessionId();
  flush.release();
  await rotating;

  assert.equal(await id, "assistant-1");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-1");
  assert.deepEqual(created, ["assistant-1"]);
});

test("a rotation while the bound singleton is looked up retires that answer", async () => {
  const created = assistantCreations();
  const lookup = held();
  boundOld(lookup.promise);
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockResolvedValue(undefined);

  const id = permanentAssistantSessionId();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rotatePermanentAssistantSession();
  lookup.release();

  assert.equal(await id, "assistant-1");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-1");
  assert.deepEqual(created, ["assistant-1"]);
});

test("overlapping rotations never clear the singleton bound after them", async () => {
  assistantCreations();
  boundOld();
  // The scheduler flushes a session once: a second flush of the same session
  // returns at once while the first is still running.
  const flush = held();
  vi.spyOn(memoryScheduler, "flushBeforeReset")
    .mockReturnValueOnce(flush.promise)
    .mockResolvedValue(undefined);

  const flushes = vi.mocked(memoryScheduler.flushBeforeReset);

  const first = rotatePermanentAssistantSession();
  const second = rotatePermanentAssistantSession();
  const id = permanentAssistantSessionId();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush.release();
  await Promise.all([first, second]);

  assert.equal(await id, "assistant-1");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-1");
  // The second rotation waited for the first: it found nothing left to
  // abandon, so the old singleton was flushed once, and reset after it.
  assert.deepEqual(flushes.mock.calls, [["old"]]);
});

test("an acquisition caught between two rotations creates only the current singleton", async () => {
  const created = assistantCreations();
  boundOld();
  const flush = held();
  vi.spyOn(memoryScheduler, "flushBeforeReset")
    .mockReturnValueOnce(flush.promise)
    .mockResolvedValue(undefined);

  const first = rotatePermanentAssistantSession();
  const id = permanentAssistantSessionId();
  const second = rotatePermanentAssistantSession();
  flush.release();
  await Promise.all([first, second]);

  assert.equal(await id, "assistant-1");
  assert.equal(permanentAssistantStore.sessionId(), "assistant-1");
  assert.deepEqual(created, ["assistant-1"]);
});

test("a failed rotation does not fail the acquisitions that waited for it", async () => {
  assistantCreations();
  boundOld();
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockRejectedValue(
    new Error("flush failed"),
  );

  const rotating = rotatePermanentAssistantSession();
  const id = permanentAssistantSessionId();

  await assert.rejects(rotating, /flush failed/);
  // Nothing was abandoned, so the bound singleton still answers.
  assert.equal(await id, "old");
});

test("the singleton is not opened from storage while a rotation abandons it", async () => {
  boundOld();
  sessionStore.upsert({
    id: "old",
    harness: "claude-sdk",
    agentType: "personal-assistant",
  });
  const flush = held();
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockReturnValue(flush.promise);
  assert.equal(permanentAssistantViewableId(), "old");

  const rotating = rotatePermanentAssistantSession();
  assert.equal(permanentAssistantViewableId(), undefined);
  flush.release();
  await rotating;
  assert.equal(permanentAssistantViewableId(), undefined);
});
