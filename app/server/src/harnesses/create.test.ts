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
const skillResolver = await import("../skills/skillResolver.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** A library whose current skills are `alpha`, so a freeze is told from the empty fallback. */
function libraryHasAlpha() {
  vi.spyOn(skillResolver, "resolveSkillNames").mockReturnValue(["alpha"]);
}

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
  libraryHasAlpha();

  await createSession({
    harness: "claude-sdk",
    id: "claude-new",
    agentType: "developer",
    modelId: "opus",
    thinkingLevel: "high",
    mode: "plan",
    worktree: { id: "wt-1", path: "/work/tree" },
    credentialProfileId: "profile-1",
    promptEvidence: evidence,
    additionalSystemPrompt: "Be brief.",
    title: "Fix the build",
  });

  assert.equal(order[0], "link");
  // Its current skills are frozen before it exists.
  assert.equal(order[1], 'acquire:conditions=true:skills=["alpha"]');
  assert.equal(order[2], "title:Fix the build");
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "developer",
    credentialProfileId: "profile-1",
    modelId: "opus",
    thinkingLevel: "high",
    cwd: "/work/tree",
    additionalSystemPrompt: "Be brief.",
    mode: "plan",
  });
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
      worktree: { id: "wt-1", path: "/work/tree" },
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
  libraryHasAlpha();

  await createSession({
    harness: "pi",
    agentType: "developer",
    thinkingLevel: "low",
    mode: "plan",
    worktree: { id: "wt-1", path: "/work/tree" },
    credentialProfileId: "profile-2",
    promptEvidence: evidence,
    purpose: "draft",
    title: "Plan the release",
  });

  assert.equal(order[0], "create");
  assert.equal(order[1], 'link:skills=["alpha"]', "frozen before the link");
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

test("a session in a bare directory runs there and is linked to no worktree", async () => {
  const acquireNew = vi
    .spyOn(piStore, "acquireNew")
    .mockResolvedValue({ sessionId: "pi-bare" } as never);
  const link = vi.spyOn(worktreeStore, "linkSessionToWorktree");
  await createSession({
    harness: "pi",
    agentType: "workshop",
    cwd: "/main/checkout",
    credentialProfileId: "profile-2",
  });
  assert.equal(
    (acquireNew.mock.calls[0]?.[3] as { cwd?: string } | undefined)?.cwd,
    "/main/checkout",
  );
  assert.equal(link.mock.calls.length, 0);
});

test("a worktree named without its path, not live yet, is linked and runs in the app CWD", async () => {
  const links: string[] = [];
  vi.spyOn(worktreeStore, "linkSessionToWorktree").mockImplementation(
    (sessionId, worktreeId) => void links.push(`${sessionId}->${worktreeId}`),
  );
  const acquire = claudeStore([]);
  const acquireNew = vi
    .spyOn(piStore, "acquireNew")
    .mockResolvedValue({ sessionId: "pi-pending", rename() {} } as never);
  await createSession({
    harness: "claude-sdk",
    agentType: "developer",
    id: "claude-pending",
    worktree: { id: "wt-pending" },
    credentialProfileId: "profile-1",
  });
  await createSession({
    harness: "pi",
    agentType: "developer",
    worktree: { id: "wt-pending" },
    credentialProfileId: "profile-2",
  });
  assert.deepEqual(links, [
    "claude-pending->wt-pending",
    "pi-pending->wt-pending",
  ]);
  assert.ok(!("cwd" in (acquire.mock.calls[0]?.[1] ?? {})));
  assert.ok(!("cwd" in ((acquireNew.mock.calls[0]?.[3] as object) ?? {})));
});

test("a worktree named without its path runs in its live checkout on both engines", async () => {
  const path = join(tmp, "live-checkout");
  mkdirSync(path);
  worktreeStore.insertWorktree({
    id: "wt-live",
    projectId: "project",
    mainRepoRoot: tmp,
    path,
    branch: "live",
    baseBranch: "main",
    baseCommit: "base",
    status: "active",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: null,
  });
  const acquire = claudeStore([]);
  const acquireNew = vi
    .spyOn(piStore, "acquireNew")
    .mockResolvedValue({ sessionId: "pi-live", rename() {} } as never);
  await createSession({
    harness: "claude-sdk",
    agentType: "developer",
    id: "claude-live",
    worktree: { id: "wt-live" },
    credentialProfileId: "profile-1",
  });
  await createSession({
    harness: "pi",
    agentType: "developer",
    worktree: { id: "wt-live" },
    credentialProfileId: "profile-2",
  });
  assert.equal(
    (acquire.mock.calls[0]?.[1] as { cwd?: string } | undefined)?.cwd,
    path,
  );
  assert.equal(
    (acquireNew.mock.calls[0]?.[3] as { cwd?: string } | undefined)?.cwd,
    path,
  );
});
