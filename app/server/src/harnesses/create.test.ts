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
const { installClaudeStateBuilder } =
  await import("../test/claudeSdkSession.ts");
installClaudeStateBuilder(claudeSdkStore);
const { piStore } = await import("../piSdk/piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { createCredentialProfile, patchCredentialProfile } =
  await import("../credentialProfiles.ts");
const worktreeStore = await import("../db/worktreeStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const skillResolver = await import("../skills/skillResolver.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/**
 * A library whose current skills are `alpha`, so a freeze is told from the
 * empty fallback.
 */
function libraryHasAlpha() {
  vi.spyOn(skillResolver, "resolveSkillNames").mockReturnValue(["alpha"]);
}

const evidence = { hasAttachments: false };
const ordinaryProfileId = createCredentialProfile({
  name: "Ordinary",
  provider: "claude",
}).id;
const enterpriseProfileId = createCredentialProfile({
  name: "Enterprise",
  provider: "claude",
}).id;
patchCredentialProfile(enterpriseProfileId, { enterprise: true });

/** A stand-in Claude store that records what it was asked and what was in place. */
function claudeStore(order: string[]) {
  return vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation(
      (
        id: string,
        opts?: { agentType?: string; requiresEnterprise?: boolean },
      ) => {
        sessionStore.claimScope({
          id,
          harness: "claude-sdk",
          agentType: "developer",
          ...(opts?.requiresEnterprise ? { requiresEnterprise: true } : {}),
        });
        order.push(
          `acquire:conditions=${sessionStore.getPromptConditions(id) !== undefined}` +
            `:skills=${sessionStore.getSkills(id) ?? "none"}`,
        );
        return {
          sessionId: id,
          setTitle: (title: string) => order.push(`title:${title}`),
        } as never;
      },
    );
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
    credentialProfileId: enterpriseProfileId,
    requiresEnterprise: true,
    promptEvidence: evidence,
    additionalSystemPrompt: "Be brief.",
    title: "Fix the build",
    peerTurnCap: 10,
  });

  assert.equal(order[0], "link");
  // Its current skills are frozen before it exists.
  assert.equal(order[1], 'acquire:conditions=true:skills=["alpha"]');
  assert.equal(order[2], "title:Fix the build");
  assert.equal(sessionStore.get("claude-new")?.requiresEnterprise, true);
  assert.equal(sessionStore.get("claude-new")?.peerTurnCap, 10);
  assert.deepEqual(acquire.mock.calls[0]?.[1], {
    agentType: "developer",
    credentialProfileId: enterpriseProfileId,
    requiresEnterprise: true,
    modelId: "opus",
    thinkingLevel: "high",
    cwd: "/work/tree",
    additionalSystemPrompt: "Be brief.",
    mode: "plan",
  });
});

test("reopening Claude never reapplies a creation cap after override or reset", async () => {
  claudeStore([]);
  const exists = vi.spyOn(claudeSdkStore, "exists").mockReturnValue(false);
  const spec = {
    harness: "claude-sdk" as const,
    id: "cap-reopen",
    agentType: "assistant" as const,
    credentialProfileId: ordinaryProfileId,
    peerTurnCap: 10,
  };
  await createSession(spec);
  assert.equal(sessionStore.get(spec.id)?.peerTurnCap, 10);
  exists.mockReturnValue(true);
  sessionStore.setPeerTurnCap(spec.id, 12);
  await createSession(spec);
  assert.equal(sessionStore.get(spec.id)?.peerTurnCap, 12);
  sessionStore.setPeerTurnCap(spec.id, null);
  await createSession(spec);
  assert.equal(sessionStore.get(spec.id)?.peerTurnCap, undefined);
});

test("enterprise sessions refuse missing or ordinary accounts before creating either harness", async () => {
  const acquireClaude = vi.spyOn(claudeSdkStore, "acquire");
  const acquirePi = vi.spyOn(piStore, "acquireNew");
  const link = vi.spyOn(worktreeStore, "linkSessionToWorktree");

  for (const credentialProfileId of ["missing-profile", ordinaryProfileId]) {
    await assert.rejects(
      createSession({
        harness: "pi",
        agentType: "assistant",
        credentialProfileId,
        requiresEnterprise: true,
      }),
      /requires an enterprise account/i,
    );
  }

  assert.equal(acquireClaude.mock.calls.length, 0);
  assert.equal(acquirePi.mock.calls.length, 0);
  assert.equal(link.mock.calls.length, 0);
});

test("a Claude account changed after lookup is revalidated before creation", async () => {
  const acquire = vi.spyOn(claudeSdkStore, "acquire");
  const pending = createSession({
    harness: "claude-sdk",
    id: "enterprise-race",
    agentType: "assistant",
    credentialProfileId: enterpriseProfileId,
    requiresEnterprise: true,
  });
  patchCredentialProfile(enterpriseProfileId, { enterprise: false });
  try {
    await assert.rejects(pending, /requires an enterprise account/i);
    assert.equal(acquire.mock.calls.length, 0);
  } finally {
    patchCredentialProfile(enterpriseProfileId, { enterprise: true });
  }
});

test("pi revalidates enterprise metadata after async creation and disposes a refused session", async () => {
  const disposed = vi.fn();
  const storeWithCreate = piStore as unknown as {
    create: (...args: never[]) => Promise<{
      session: { sessionId: string; dispose: () => void };
      notices: never[];
    }>;
  };
  vi.spyOn(storeWithCreate, "create").mockImplementation(async () => {
    await Promise.resolve();
    return {
      session: { sessionId: "pi-enterprise-race", dispose: disposed },
      notices: [],
    };
  });
  const pending = piStore.acquireNew("assistant", undefined, undefined, {
    credentialProfileId: enterpriseProfileId,
    requiresEnterprise: true,
  });
  patchCredentialProfile(enterpriseProfileId, { enterprise: false });
  try {
    await assert.rejects(pending, /requires an enterprise account/i);
    assert.equal(disposed.mock.calls.length, 1);
    assert.equal(sessionStore.get("pi-enterprise-race"), undefined);
  } finally {
    patchCredentialProfile(enterpriseProfileId, { enterprise: true });
  }
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
    .mockImplementation(async (kind, _model, _thinkingLevel, opts) => {
      sessionStore.claimScope({
        id: "pi-new",
        harness: "pi",
        agentType: kind,
        ...(opts?.requiresEnterprise ? { requiresEnterprise: true } : {}),
      });
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
    peerTurnCap: 10,
    agentType: "developer",
    thinkingLevel: "low",
    mode: "plan",
    worktree: { id: "wt-1", path: "/work/tree" },
    credentialProfileId: enterpriseProfileId,
    requiresEnterprise: true,
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
      credentialProfileId: enterpriseProfileId,
      requiresEnterprise: true,
      promptEvidence: evidence,
      mode: "plan",
    },
  ]);
  const row = sessionStore.get("pi-new");
  assert.equal(row?.peerTurnCap, 10);
  assert.equal(row?.harness, "pi");
  assert.equal(row?.purpose, "draft");
  assert.equal(row?.mode, "plan");
  assert.equal(row?.credentialProfileId, enterpriseProfileId);
  assert.equal(row?.requiresEnterprise, true);
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

test("an agent is never grafted onto a Claude session that already exists", async () => {
  const { SessionAgentConflictError } = await import("./create.ts");
  const agent = {
    name: "researcher",
    blob: "b".repeat(40),
    persona: "assistant" as const,
    provider: "claude-sdk",
    model: "opus",
    effort: "high" as const,
    runtimeSource: "definition" as const,
    denyTools: [],
    skills: [],
    body: "Research carefully.",
  };
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation(
      (id: string) => ({ sessionId: id, setTitle() {} }) as never,
    );
  vi.spyOn(claudeSdkStore, "exists").mockReturnValue(true);
  const start = (id: string, name = "researcher") =>
    createSession({
      harness: "claude-sdk",
      id,
      agentType: "assistant",
      credentialProfileId: "profile-1",
      agent: { ...agent, name },
    });

  // A plain session under the id: it would keep its own runtime.
  await assert.rejects(start("existing-plain"), SessionAgentConflictError);
  assert.equal(sessionStore.getAgent("existing-plain"), undefined);

  // A session created as another agent.
  sessionStore.freezeAgent(
    "existing-other",
    JSON.stringify({ ...agent, name: "drafter" }),
  );
  await assert.rejects(start("existing-other"), SessionAgentConflictError);
  assert.equal(
    JSON.parse(sessionStore.getAgent("existing-other")!).name,
    "drafter",
  );
  assert.equal(acquire.mock.calls.length, 0);

  // Not even as the same agent: the session runs what it was created with,
  // not what this creation names (another account, say).
  sessionStore.freezeAgent("existing-same", JSON.stringify(agent));
  await assert.rejects(
    start("existing-same"),
    /already exists, and an agent only ever starts a new session/,
  );
  assert.equal(acquire.mock.calls.length, 0);
});

test("a second agent creation under a live Claude id is refused, not merged into it", async () => {
  const { SessionAgentConflictError } = await import("./create.ts");
  const agent = {
    name: "researcher",
    blob: "d".repeat(40),
    persona: "assistant" as const,
    provider: "claude-sdk",
    model: "opus",
    effort: "high" as const,
    runtimeSource: "definition" as const,
    denyTools: [],
    skills: [],
    body: "Research carefully.",
  };
  const start = (credentialProfileId: string) =>
    createSession({
      harness: "claude-sdk",
      id: "live-agent",
      agentType: "assistant",
      credentialProfileId,
      agent,
    });

  // The real store: the first creation makes the session.
  const first = await start("account-a");
  assert.equal(claudeSdkStore.get("live-agent"), first);
  // The same definition on another account would get that session back.
  await assert.rejects(start("account-b"), SessionAgentConflictError);
});

test("an agent row left by a creation that never finished binds its id", async () => {
  const { SessionAgentConflictError } = await import("./create.ts");
  const agent = {
    name: "reviewer",
    blob: "c".repeat(40),
    persona: "assistant" as const,
    provider: "claude-sdk",
    model: "opus",
    effort: "high" as const,
    runtimeSource: "definition" as const,
    denyTools: ["worktree_push"],
    skills: [],
    body: "Review only.",
  };
  const acquire = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation(
      (id: string) => ({ sessionId: id, setTitle() {} }) as never,
    );
  // No Claude session exists: only the row the failed creation wrote first.
  vi.spyOn(claudeSdkStore, "exists").mockReturnValue(false);
  const start = (id: string, spec: Partial<typeof agent> | undefined) =>
    createSession({
      harness: "claude-sdk",
      id,
      agentType: "assistant",
      credentialProfileId: "profile-1",
      ...(spec ? { agent: { ...agent, ...spec } } : {}),
    });
  for (const id of ["abandoned-other", "abandoned-plain", "abandoned-edited"])
    sessionStore.freezeAgent(id, JSON.stringify(agent));

  await assert.rejects(
    start("abandoned-other", { name: "drafter", model: "sonnet" }),
    SessionAgentConflictError,
  );
  await assert.rejects(
    start("abandoned-plain", undefined),
    SessionAgentConflictError,
  );
  // Same name, but the definition changed since: the row would not describe it.
  await assert.rejects(
    start("abandoned-edited", { denyTools: [] }),
    /Session abandoned-edited is already bound to the "reviewer" agent as it was defined then \(AGENT\.md ccccccc\), not to the "reviewer" agent as it is defined now; start a new session to run it\./,
  );
  assert.equal(acquire.mock.calls.length, 0);

  // The same creation retried finishes it.
  sessionStore.freezeAgent("abandoned-same", JSON.stringify(agent));
  await start("abandoned-same", {});
  assert.equal(acquire.mock.calls.length, 1);
});
