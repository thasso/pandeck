/**
 * Creating a session is a view intent claimed on ARRIVAL, ahead of every
 * asynchronous prerequisite — the model lookup, the worktree resolution — not
 * once creation completes. A newer `loadSession` that completes inside one of
 * those awaits keeps the view: the session is still created (and a first
 * send's prompt still runs), but nothing attaches, no route message moves the
 * client, and commands keep targeting the load.
 *
 *   pnpm --filter @assistant/server test src/sessionCreateRace.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "session-create-race-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
// Enabled, so a Claude first send runs.
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

// The prerequisites the test holds open, and the prompt a first send runs.
const held = vi.hoisted(() => ({
  modelLookups: [] as Array<() => void>,
  lookupArgs: [] as unknown[][],
  prompts: [] as string[],
}));
vi.mock("./piSdk/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./piSdk/models.ts")>()),
  findModelForProfile: (...args: unknown[]) =>
    new Promise((resolve) => {
      held.lookupArgs.push(args);
      held.modelLookups.push(() =>
        resolve({ provider: "openai-codex", id: "gpt-5", name: "GPT-5" }),
      );
    }),
}));
vi.mock("./session/runtimePrompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session/runtimePrompt.ts")>()),
  promptRuntimeSession: async (_live: unknown, text: string) => {
    held.prompts.push(text);
  },
}));

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  held.modelLookups.length = 0;
  held.lookupArgs.length = 0;
  held.prompts.length = 0;
});

const codexProfile = createCredentialProfile({
  name: "Pi account",
  provider: "openai-codex",
});
const claudeProfile = createCredentialProfile({
  name: "Claude account",
  provider: "claude",
});

function fakeSeam(): ClaudeSdkSeam {
  return {
    query: (_p: ClaudeQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        yield* [] as ClaudeSdkMessage[];
      },
    }),
  };
}

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function snapshots(sent: ServerMessage[]): string[] {
  return sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "snapshot" }> =>
        m.type === "snapshot",
    )
    .map((m) => m.snapshot.sessionId);
}

const B = "session-b";

/** Loads answered by the test; creations answered immediately as a fresh session. */
function harness(sent: ServerMessage[]) {
  const sessions = new Map<string, InstanceType<typeof ClaudeSdkSession>>();
  const sessionFor = (id: string) => {
    let session = sessions.get(id);
    if (!session) {
      session = new ClaudeSdkSession(id, {
        seam: async () => fakeSeam(),
        agentType: "assistant",
      });
      sessions.set(id, session);
    }
    return session;
  };
  const loads: Array<{ id: string; resolve: () => void }> = [];
  vi.spyOn(hub, "acquireById").mockImplementation(
    (id: string) =>
      new Promise((resolve) => {
        loads.push({ id, resolve: () => resolve(sessionFor(id)) });
      }),
  );
  const created: string[] = [];
  vi.spyOn(hub, "viewById").mockImplementation((id: string) => sessionFor(id));
  // At the stores, where every creation path ends (`harnesses/create.ts`).
  vi.spyOn(piStore, "acquireNew").mockImplementation(async () => {
    const id = `created-${created.length + 1}`;
    created.push(id);
    return sessionFor(id) as never;
  });
  vi.spyOn(claudeSdkStore, "acquire").mockImplementation((id: string) => {
    created.push(id);
    return sessionFor(id) as never;
  });
  vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
  const connection = new Connection(fakeSocket(sent));
  return {
    connection,
    created,
    session: sessionFor,
    /** Let a `loadSession` attach; it needs no acquisition of its own. */
    completeLoad: async (_id: string) => {
      await settle();
    },
    releaseModelLookup: async () => {
      const release = held.modelLookups.shift();
      if (!release) throw new Error("no model lookup held");
      release();
      await settle();
    },
  };
}

async function expectCommandsRouteTo(
  connection: InstanceType<typeof Connection>,
  sent: ServerMessage[],
  id: string,
  other: string,
) {
  sent.length = 0;
  await connection.handle({
    type: "loadTimelineRange",
    sessionId: other,
    beforeSeq: 0,
  } as ClientMessage);
  expect(sent.filter((m) => m.type === "timelineRange")).toEqual([]);
  await connection.handle({
    type: "loadTimelineRange",
    sessionId: id,
    beforeSeq: 0,
  } as ClientMessage);
  expect(sent.filter((m) => m.type === "timelineRange")).toHaveLength(1);
}

describe("creating a session against a newer load", () => {
  test("newSession: a load completing during the model lookup keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    void h.connection.handle({
      type: "newSession",
      agentType: "assistant",
      model: { provider: "openai-codex", id: "gpt-5" },
    } as ClientMessage);
    await settle();
    expect(held.modelLookups).toHaveLength(1);
    // The lookup is parked; the reader clicks B, which attaches.
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    // The lookup resumes and the session is created — but never viewed.
    await h.releaseModelLookup();
    expect(h.created).toEqual(["created-1"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(h.session("created-1").viewers.size).toBe(0);
    await expectCommandsRouteTo(h.connection, sent, B, "created-1");
  });

  test("newSession: a load completing during worktree resolution keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    let releaseWorktree!: () => void;
    (
      h.connection as unknown as { resolveWorktreeContext: unknown }
    ).resolveWorktreeContext = () =>
      new Promise((resolve) => {
        releaseWorktree = () => resolve(null);
      });
    void h.connection.handle({
      type: "newSession",
      agentType: "assistant",
      worktreeId: "wt-1",
    } as ClientMessage);
    await settle();
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    releaseWorktree();
    await settle();
    expect(h.created).toEqual(["created-1"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(h.session("created-1").viewers.size).toBe(0);
    await expectCommandsRouteTo(h.connection, sent, B, "created-1");
  });

  test("pi first send: a load completing during the model lookup keeps the view, and the prompt still runs", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    (
      h.connection as unknown as { resolveWorktreeContext: unknown }
    ).resolveWorktreeContext = async () => null;
    void h.connection.handle({
      type: "harnessSend",
      harness: "pi",
      id: "first-send",
      agentType: "assistant",
      text: "hello there",
      modelProvider: "openai-codex",
      modelId: "gpt-5",
      credentialProfileId: codexProfile.id,
      clientRequestId: "creq-1",
    } as ClientMessage);
    await settle();
    expect(held.modelLookups).toHaveLength(1);
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    await h.releaseModelLookup();
    // Created and prompted — the send is not lost — but not viewed.
    expect(h.created).toEqual(["created-1"]);
    expect(held.prompts).toEqual(["hello there"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(h.session("created-1").viewers.size).toBe(0);
    await expectCommandsRouteTo(h.connection, sent, B, "created-1");
  });
  test("Claude first send: a load completing during worktree resolution keeps the view, and the prompt still runs", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    let releaseWorktree!: () => void;
    (
      h.connection as unknown as { resolveWorktreeContext: unknown }
    ).resolveWorktreeContext = () =>
      new Promise((resolve) => {
        releaseWorktree = () => resolve(null);
      });
    void h.connection.handle({
      type: "harnessSend",
      harness: "claude-sdk",
      id: "claude-first-send",
      agentType: "assistant",
      text: "hello claude",
      credentialProfileId: claudeProfile.id,
      clientRequestId: "creq-2",
    } as ClientMessage);
    await settle();
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    releaseWorktree();
    await settle();
    // Created and prompted — the send is not lost — but not viewed.
    expect(h.created).toEqual(["claude-first-send"]);
    expect(held.prompts).toEqual(["hello claude"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(h.session("claude-first-send").viewers.size).toBe(0);
    await expectCommandsRouteTo(h.connection, sent, B, "claude-first-send");
  });

  /** View a resident session that runs a pi model on the codex account. */
  async function viewResidentPi(
    h: ReturnType<typeof harness>,
    id: string,
  ): Promise<void> {
    const session = h.session(id);
    Object.defineProperty(session, "credentialProfileId", {
      value: codexProfile.id,
    });
    session.modelSelection = () => ({
      model: { provider: "openai-codex", id: "gpt-5" },
      thinkingLevel: "low",
    });
    void h.connection.handle({ type: "loadSession", id } as ClientMessage);
    await h.completeLoad(id);
  }

  test("newSession: a load completing during the carried-model lookup keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    await viewResidentPi(h, "viewed-pi");
    sent.length = 0;
    void h.connection.handle({
      type: "newSession",
      agentType: "assistant",
    } as ClientMessage);
    await settle();
    // The viewed session's model resolves on the account it runs on.
    expect(held.lookupArgs).toEqual([
      [codexProfile.id, "openai-codex", "gpt-5"],
    ]);
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    await h.releaseModelLookup();
    expect(h.created).toEqual(["created-1"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(h.session("created-1").viewers.size).toBe(0);
    await expectCommandsRouteTo(h.connection, sent, B, "created-1");
  });

  test("createDraftSession: a load completing during the carried-model lookup keeps the view", async () => {
    const sent: ServerMessage[] = [];
    const h = harness(sent);
    await viewResidentPi(h, "viewed-pi");
    sent.length = 0;
    void h.connection.handle({
      type: "createDraftSession",
      agentType: "assistant",
      draftText: "draft this",
    } as ClientMessage);
    await settle();
    expect(held.lookupArgs).toEqual([
      [codexProfile.id, "openai-codex", "gpt-5"],
    ]);
    void h.connection.handle({ type: "loadSession", id: B } as ClientMessage);
    await h.completeLoad(B);
    expect(snapshots(sent)).toEqual([B]);
    await h.releaseModelLookup();
    expect(h.created).toEqual(["created-1"]);
    expect(snapshots(sent)).toEqual([B]);
    expect(sent.some((m) => m.type === "draftSession")).toBe(false);
  });
});
