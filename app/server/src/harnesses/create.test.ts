/**
 * `createSession`: each engine's creation sequence, in its own order.
 *   pnpm --filter @assistant/server test src/harnesses/create.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-create-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { createSession, SessionIdTakenError } = await import("./create.ts");
const { harnessRegistry } = await import("./registry.ts");
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("../piSdk/piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const worktreeStore = await import("../db/worktreeStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const evidence = { hasAttachments: false };

/** A stand-in Claude store that records what it was asked and what was in place. */
function claudeStore(order: string[]) {
  return vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation((id: string) => {
      order.push(
        `acquire:conditions=${sessionStore.getPromptConditions(id) !== undefined}` +
          `:skills=${sessionStore.getSkills(id) ?? "none"}`,
      );
      return {
        sessionId: id,
        setTitle: (title: string) => order.push(`title:${title}`),
      } as never;
    });
}

test("a Claude session is linked and frozen before it exists, then titled", async () => {
  const order: string[] = [];
  vi.spyOn(worktreeStore, "linkSessionToWorktree").mockImplementation(() => {
    order.push("link");
  });
  const acquire = claudeStore(order);

  await createSession({
    harness: "claude-sdk",
    id: "claude-new",
    agentType: "developer",
    modelId: "opus",
    cwd: "/work/tree",
    worktreeId: "wt-1",
    credentialProfileId: "profile-1",
    promptEvidence: evidence,
    skills: ["alpha"],
    additionalSystemPrompt: "Be brief.",
    title: "Fix the build",
  });

  assert.deepEqual(order, [
    "link",
    'acquire:conditions=true:skills=["alpha"]',
    "title:Fix the build",
  ]);
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "developer",
    credentialProfileId: "profile-1",
    modelId: "opus",
    cwd: "/work/tree",
    additionalSystemPrompt: "Be brief.",
  });
});

test("a Claude session's current skills are resolved and frozen before it exists", async () => {
  const order: string[] = [];
  claudeStore(order);
  await createSession({
    harness: "claude-sdk",
    id: "claude-current-skills",
    agentType: "developer",
    credentialProfileId: "profile-1",
    skills: true,
  });
  assert.equal(order.length, 1);
  assert.match(order[0]!, /:skills=\[/, "frozen before the store acquired");
});

test("a named Claude id is checked against the disk too; a minted one is not", async () => {
  const otherHolder = vi.spyOn(harnessRegistry, "otherHolder");
  claudeStore([]);
  const named = await createSession({
    harness: "claude-sdk",
    id: "claude-named",
    agentType: "assistant",
    credentialProfileId: "profile-1",
  });
  const minted = await createSession({
    harness: "claude-sdk",
    agentType: "assistant",
    credentialProfileId: "profile-1",
  });
  assert.equal(named.sessionId, "claude-named");
  assert.notEqual(minted.sessionId, "claude-named");
  assert.deepEqual(otherHolder.mock.calls, [
    ["claude-named", "claude-sdk", { onDisk: true }],
    [minted.sessionId, "claude-sdk", { onDisk: false }],
  ]);
});

test("a Claude id another engine holds is refused before anything is written", async () => {
  const acquire = vi.spyOn(claudeSdkStore, "acquire");
  const link = vi.spyOn(worktreeStore, "linkSessionToWorktree");
  sessionStore.upsert({ id: "pi-row", harness: "pi", agentType: "assistant" });
  await assert.rejects(
    createSession({
      harness: "claude-sdk",
      id: "pi-row",
      agentType: "assistant",
      worktreeId: "wt-1",
      credentialProfileId: "profile-1",
    }),
    SessionIdTakenError,
  );

  const file = canonicalPiSessionPath("pi-on-disk");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  await assert.rejects(
    createSession({
      harness: "claude-sdk",
      id: "pi-on-disk",
      agentType: "assistant",
      credentialProfileId: "profile-1",
      promptEvidence: evidence,
    }),
    SessionIdTakenError,
  );
  assert.equal(acquire.mock.calls.length, 0);
  assert.equal(link.mock.calls.length, 0);
  assert.equal(sessionStore.getPromptConditions("pi-on-disk"), undefined);
});

test("a pi session is created first, then recorded, frozen, linked and titled", async () => {
  const order: string[] = [];
  const acquireNew = vi
    .spyOn(piStore, "acquireNew")
    .mockImplementation(async () => {
      order.push("create");
      return {
        sessionId: "pi-new",
        sessionMode: "plan",
        rename: (title: string) => order.push(`title:${title}`),
      } as never;
    });
  vi.spyOn(worktreeStore, "linkSessionToWorktree").mockImplementation(() => {
    order.push(`link:skills=${sessionStore.getSkills("pi-new") ?? "none"}`);
  });

  await createSession({
    harness: "pi",
    agentType: "developer",
    thinkingLevel: "low",
    mode: "plan",
    cwd: "/work/tree",
    worktreeId: "wt-1",
    credentialProfileId: "profile-2",
    promptEvidence: evidence,
    skills: true,
    purpose: "draft",
    title: "Plan the release",
  });

  assert.equal(order[0], "create");
  assert.match(order[1]!, /^link:skills=\[/, "skills frozen before the link");
  assert.equal(order[2], "title:Plan the release");
  assert.deepEqual(acquireNew.mock.calls[0], [
    "developer",
    undefined,
    "low",
    {
      cwd: "/work/tree",
      credentialProfileId: "profile-2",
      promptEvidence: evidence,
      mode: "plan",
    },
  ]);
  const row = sessionStore.get("pi-new");
  assert.equal(row?.harness, "pi");
  assert.equal(row?.purpose, "draft");
  assert.equal(row?.mode, "plan");
  assert.equal(row?.credentialProfileId, "profile-2");
});
