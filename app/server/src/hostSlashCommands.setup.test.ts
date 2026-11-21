/**
 * Host commands in the guided setup conversation once setup is finished
 * (`docs/onboarding.md`): the session is read-only, and `/compact` would send
 * its frozen setup prompt to the provider. Every host command is refused
 * before a synthetic turn opens; compaction checks again after the memory
 * flush. An ordinary Personal Assistant session compacts as always.
 *   pnpm --filter @assistant/server test src/hostSlashCommands.setup.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test, vi } from "vitest";
import type { SyntheticToolHost } from "./hostSlashCommands.ts";

const tmp = mkdtempSync(join(tmpdir(), "host-command-setup-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const { hostSlashCommandRunner, runClearForHost, runCompactForHost } =
  await import("./hostSlashCommands.ts");
const { memoryScheduler } = await import("./memory/memoryScheduler.ts");
const { ClaudeSdkSession } = await import("./test/claudeSdkSession.ts");
const { initOnboarding, SetupFinishedError } = await import("./onboarding.ts");
const { sessionPromptConditions } = await import("./promptConditions.ts");
const { DATA_DIR } = await import("./config.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => vi.restoreAllMocks());

function onboarding(state: "setup" | "complete"): void {
  writeFileSync(join(DATA_DIR, "onboarding.json"), JSON.stringify({ state }));
  initOnboarding(() => {
    throw new Error("the file decides");
  });
}

/** A Personal Assistant session id, frozen as the setup one or not. */
function paSession(id: string, guidedSetup: boolean): string {
  sessionPromptConditions(id, "personal-assistant", { guidedSetup });
  return id;
}

function fakeHost(sessionId: string) {
  const compact = vi.fn(async () => ({
    kind: "compacted" as const,
    summary: "Summary",
    tokensBefore: 100,
  }));
  const clear = vi.fn(async () => ({ kind: "cleared" as const }));
  const begin = vi.fn(() => ({ toolId: "tool", assistantId: "assistant" }));
  const finish = vi.fn();
  const card = vi.fn();
  const host = {
    sessionId,
    kind: "personal-assistant",
    beginSyntheticTool: begin,
    updateSyntheticTool: () => {},
    finishSyntheticTool: finish,
    finishSyntheticCard: card,
    compactContext: compact,
    clearContext: clear,
  } as unknown as SyntheticToolHost;
  return { host, compact, clear, begin, finish, card };
}

test("a real Claude host never opens a compaction query for the finished setup conversation", async () => {
  const id = paSession("claude-setup-compact", true);
  onboarding("complete");
  const seam = vi.fn(async () => {
    throw new Error("Refused compaction must not open the SDK");
  });
  const live = new ClaudeSdkSession(id, {
    agentType: "personal-assistant",
    providerSessionId: "11111111-2222-3333-4444-555555555555",
    seam,
  });
  const flush = vi
    .spyOn(memoryScheduler, "flushBeforeReset")
    .mockResolvedValue();
  await assert.rejects(runCompactForHost(live, ""), SetupFinishedError);
  assert.equal(seam.mock.calls.length, 0);
  assert.equal(flush.mock.calls.length, 0);
  assert.equal(live.isRunning, false);
});

test("every host command is refused at admission, before a synthetic turn", async () => {
  const id = paSession("setup-host-commands", true);
  onboarding("complete");
  for (const name of ["compact", "clear", "commit", "push", "pr"]) {
    const fake = fakeHost(id);
    await assert.rejects(
      hostSlashCommandRunner(name)!(fake.host, ""),
      SetupFinishedError,
      `/${name}`,
    );
    assert.equal(fake.begin.mock.calls.length, 0, `/${name}`);
  }
  // Direct calls of the context commands refuse the same way (pi and Claude
  // both run them through these).
  const fake = fakeHost(id);
  await assert.rejects(runClearForHost(fake.host), SetupFinishedError);
  assert.equal(fake.clear.mock.calls.length, 0);
});

test("setup finishing during the memory flush still stops the compaction", async () => {
  const id = paSession("setup-compact-race", true);
  onboarding("setup");
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockImplementation(async () =>
    onboarding("complete"),
  );
  const fake = fakeHost(id);
  await runCompactForHost(fake.host, "");
  assert.equal(fake.compact.mock.calls.length, 0);
  assert.match(fake.finish.mock.calls[0]?.[1] ?? "", /Setup is finished/);
  assert.equal(fake.finish.mock.calls[0]?.[2], true);
});

test("the setup conversation may still compact while setup lasts", async () => {
  const id = paSession("setup-compact-live", true);
  onboarding("setup");
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockResolvedValue();
  const fake = fakeHost(id);
  await hostSlashCommandRunner("compact")!(fake.host, "");
  assert.equal(fake.compact.mock.calls.length, 1);
});

test("an ordinary Personal Assistant session compacts once setup is finished", async () => {
  const id = paSession("ordinary-pa-compact", false);
  onboarding("complete");
  vi.spyOn(memoryScheduler, "flushBeforeReset").mockResolvedValue();
  const fake = fakeHost(id);
  await hostSlashCommandRunner("compact")!(fake.host, "Keep decisions");
  assert.deepEqual(fake.compact.mock.calls, [["Keep decisions"]]);
  assert.equal(fake.card.mock.calls.length, 1);
});
