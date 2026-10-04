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
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("../piSdk/piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const worktreeStore = await import("../db/worktreeStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const evidence = { hasAttachments: false };

test("a Claude session is linked and frozen before it exists, then titled", async () => {
  const order: string[] = [];
  vi.spyOn(worktreeStore, "linkSessionToWorktree").mockImplementation(() => {
    order.push("link");
  });
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation((id: string) => {
      order.push(
        `acquire:conditions=${sessionStore.getPromptConditions(id) !== undefined}`,
      );
      return {
        sessionId: id,
        setTitle: (title: string) => order.push(`title:${title}`),
      } as never;
    });

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
    title: "Fix the build",
  });

  assert.deepEqual(order, [
    "link",
    "acquire:conditions=true",
    "title:Fix the build",
  ]);
  assert.equal(sessionStore.getSkills("claude-new"), '["alpha"]');
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "developer",
    credentialProfileId: "profile-1",
    modelId: "opus",
    cwd: "/work/tree",
  });
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

  // A pi transcript on disk holds a client-supplied id, not a minted one.
  const file = canonicalPiSessionPath("pi-on-disk");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  await assert.rejects(
    createSession({
      harness: "claude-sdk",
      id: "pi-on-disk",
      clientId: true,
      agentType: "assistant",
      credentialProfileId: "profile-1",
    }),
    SessionIdTakenError,
  );
  assert.equal(acquire.mock.calls.length, 0);
  assert.equal(link.mock.calls.length, 0);
});

test("a pi session is created first, then recorded, linked and titled", async () => {
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
    order.push("link");
  });

  await createSession({
    harness: "pi",
    agentType: "assistant",
    thinkingLevel: "low",
    mode: "plan",
    cwd: "/work/tree",
    worktreeId: "wt-1",
    credentialProfileId: "profile-2",
    promptEvidence: evidence,
    purpose: "draft",
    title: "Plan the release",
  });

  assert.deepEqual(order, ["create", "link", "title:Plan the release"]);
  assert.deepEqual(acquireNew.mock.calls[0], [
    "assistant",
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
