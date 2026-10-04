/**
 * `harnessRegistry`: which engine holds a session, and how both stores reach
 * the hub. Opening a pi session its metadata row names is covered end to end
 * by `sessionResolver.test.ts`.
 *   pnpm --filter @assistant/server test src/harnesses/registry.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "harness-registry-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { harnessRegistry } = await import("./registry.ts");
const { hub } = await import("../hub.ts");
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { PiSessionDeletedError, piStore } = await import("../piSdk/piStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { sessionDirFor } = await import("../piSdk/options.ts");
const { SessionHeldElsewhereError } = await import("../harness.ts");
const {
  closeProxiedConnection,
  getProxiedConnection,
  openProxiedConnection,
  setProxiedClientFactoryForTests,
} = await import("../mcp/toolGroups/proxiedServer.ts");

/** A pi transcript on disk for `id`, with no metadata row. */
function piTranscript(id: string): void {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
}

/** A legacy per-persona pi transcript for `id`, as old sessions left it. */
function legacyPiTranscript(id: string): string {
  const file = join(sessionDirFor("assistant"), `2024-01-01_${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      "",
    ].join("\n"),
  );
  return file;
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** A stand-in for a resident session of either engine. */
function resident(
  id: string,
  fields: Record<string, unknown> = {},
): { id: string; received: ServerMessage[] } & Record<string, unknown> {
  const received: ServerMessage[] = [];
  return {
    id,
    sessionId: id,
    received,
    broadcast: (message: ServerMessage) => received.push(message),
    ...fields,
  };
}

/** Hold `pi` and `claude` resident in their stores, by our id. */
function holdResident(
  pi: Array<ReturnType<typeof resident>>,
  claude: Array<ReturnType<typeof resident>>,
): void {
  vi.spyOn(piStore, "getLiveById").mockImplementation(
    (id) => pi.find((s) => s.id === id) as never,
  );
  vi.spyOn(claudeSdkStore, "get").mockImplementation(
    (id) => claude.find((s) => s.id === id) as never,
  );
}

test("a resident session is found in whichever store holds it, from memory alone", () => {
  const claude = resident("claude-a");
  const pi = resident("pi-a");
  holdResident([pi], [claude]);
  const rowRead = vi.spyOn(sessionStore, "get");

  assert.equal(harnessRegistry.residentById("claude-a"), claude);
  assert.equal(harnessRegistry.residentById("pi-a"), pi);
  assert.equal(harnessRegistry.residentById("nobody"), undefined);
  assert.equal(rowRead.mock.calls.length, 0, "no metadata read");
});

test("every resident session is listed, pi's first", () => {
  const pi = resident("pi-b");
  const claude = resident("claude-b");
  vi.spyOn(piStore, "list").mockReturnValue([pi as never]);
  vi.spyOn(claudeSdkStore, "list").mockReturnValue([claude as never]);
  assert.deepEqual(harnessRegistry.resident(), [pi, claude]);
});

test("a message for a session reaches its viewers in either engine, else every tab", () => {
  const pi = resident("pi-c");
  const claude = resident("claude-c");
  holdResident([pi], [claude]);
  const everyTab: ServerMessage[] = [];
  const tab = { send: (message: ServerMessage) => everyTab.push(message) };
  hub.register(tab);
  try {
    const queue = { items: [] } as never;
    hub.broadcastPromptQueue("pi-c", queue);
    hub.broadcastPromptQueue("claude-c", queue);
    hub.broadcastPromptQueue("gone", queue);
    assert.deepEqual(
      [pi.received, claude.received, everyTab].map((sent) =>
        sent.map((m) => (m as { sessionId?: string }).sessionId),
      ),
      [["pi-c"], ["claude-c"], ["gone"]],
    );
  } finally {
    hub.unregister(tab);
  }
});

test("a browser runtime's owner is listed with its title and file, when it has them", () => {
  const pi = resident("pi-d", {
    agentType: "developer",
    isRunning: true,
    sessionFile: "/sessions/pi-d.jsonl",
    sessionTitle: "Fix the build",
  });
  const claude = resident("claude-d", {
    agentType: "assistant",
    isRunning: false,
    sessionFile: undefined,
    sessionTitle: undefined,
  });
  holdResident([pi], [claude]);

  assert.deepEqual(harnessRegistry.browserRuntimeOwner("pi-d"), {
    agentKind: "developer",
    agentStatus: "running",
    sessionFile: "/sessions/pi-d.jsonl",
    sessionTitle: "Fix the build",
  });
  assert.deepEqual(harnessRegistry.browserRuntimeOwner("claude-d"), {
    agentKind: "assistant",
    agentStatus: "idle",
  });
  assert.equal(harnessRegistry.browserRuntimeOwner("nobody"), undefined);
});

test("a pi reopen the delete beat is no session, not a failure", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  sessionStore.upsert({
    id: "pi-deleted",
    harness: "pi",
    agentType: "assistant",
  });
  vi.spyOn(piStore, "acquireByRecordId").mockRejectedValue(
    new PiSessionDeletedError("pi-deleted"),
  );
  assert.equal(await harnessRegistry.acquireById("pi-deleted"), undefined);

  vi.spyOn(piStore, "acquireByRecordId").mockRejectedValue(new Error("boom"));
  await assert.rejects(harnessRegistry.acquireById("pi-deleted"), /boom/);
});

test("the metadata row names the engine that opens a session, as its persona", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  const piOpen = vi
    .spyOn(piStore, "acquireByRecordId")
    .mockResolvedValue(resident("pi-row") as never);
  const claudeOpen = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockReturnValue(resident("claude-row") as never);
  sessionStore.upsert({ id: "pi-row", harness: "pi", agentType: "assistant" });
  sessionStore.upsert({
    id: "claude-row",
    harness: "claude-sdk",
    agentType: "assistant",
  });

  await harnessRegistry.acquireById("pi-row");
  await harnessRegistry.acquireById("claude-row");
  assert.deepEqual(piOpen.mock.calls, [["pi-row", "assistant"]]);
  assert.deepEqual(
    claudeOpen.mock.calls.map(([id]) => id),
    ["claude-row"],
  );
});

test("a session without a row is opened by the engine that has it on disk", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "exists").mockImplementation(
    (id) => id === "claude-rowless",
  );
  const claudeOpen = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockReturnValue(resident("claude-rowless") as never);
  const piOpen = vi.spyOn(piStore, "acquireByRecordId");

  assert.ok(await harnessRegistry.acquireById("claude-rowless"));
  assert.equal(await harnessRegistry.acquireById("nowhere"), undefined);
  assert.deepEqual(
    claudeOpen.mock.calls.map(([id]) => id),
    ["claude-rowless"],
  );
  assert.equal(piOpen.mock.calls.length, 0, "no pi transcript to reopen");
});

test("a pi transcript without a row reopens as a developer session", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "exists").mockReturnValue(false);
  const piOpen = vi
    .spyOn(piStore, "acquireByRecordId")
    .mockResolvedValue(resident("pi-rowless") as never);
  piTranscript("pi-rowless");

  assert.ok(await harnessRegistry.acquireById("pi-rowless"));
  assert.deepEqual(piOpen.mock.calls, [["pi-rowless", "developer"]]);
});

test("a Claude record is preferred over a pi transcript for a rowless id", async () => {
  vi.spyOn(piStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "getForDrive").mockReturnValue(undefined);
  vi.spyOn(claudeSdkStore, "exists").mockReturnValue(true);
  const claudeOpen = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockReturnValue(resident("both-rowless") as never);
  const piOpen = vi.spyOn(piStore, "acquireByRecordId");
  piTranscript("both-rowless");

  await harnessRegistry.acquireById("both-rowless");
  assert.deepEqual(
    claudeOpen.mock.calls.map(([id]) => id),
    ["both-rowless"],
  );
  assert.equal(piOpen.mock.calls.length, 0);
});

test("a resident session is driven as it is, with a full idle grace", async () => {
  const pi = resident("pi-live");
  const getForDrive = vi
    .spyOn(piStore, "getForDrive")
    .mockReturnValue(pi as never);
  const reopen = vi.spyOn(piStore, "acquireByRecordId");
  assert.equal(await harnessRegistry.acquireById("pi-live"), pi);
  assert.deepEqual(getForDrive.mock.calls, [["pi-live"]]);
  assert.equal(reopen.mock.calls.length, 0);
});

test("an id another engine holds, resident or on record, is named as held", () => {
  const pi = resident("pi-held");
  holdResident([pi], []);
  sessionStore.upsert({
    id: "pi-rowed",
    harness: "pi",
    agentType: "assistant",
  });
  sessionStore.upsert({
    id: "claude-rowed",
    harness: "claude-sdk",
    agentType: "assistant",
  });

  assert.equal(harnessRegistry.otherHolder("pi-held", "claude-sdk"), "pi");
  assert.equal(harnessRegistry.otherHolder("pi-rowed", "claude-sdk"), "pi");
  assert.equal(
    harnessRegistry.otherHolder("claude-rowed", "claude-sdk"),
    undefined,
  );
  assert.equal(harnessRegistry.otherHolder("claude-rowed", "pi"), "claude-sdk");
  assert.equal(
    harnessRegistry.otherHolder("fresh-id", "claude-sdk"),
    undefined,
  );
  // A pi transcript with no row is pi's too: acquireById would reopen it.
  piTranscript("pi-on-disk");
  assert.equal(harnessRegistry.otherHolder("pi-on-disk", "claude-sdk"), "pi");
  // A server-minted id skips the disk: only memory and the row are asked.
  assert.equal(
    harnessRegistry.otherHolder("pi-on-disk", "claude-sdk", { onDisk: false }),
    undefined,
  );
});

test("a Claude session is never created over an id pi holds", () => {
  const pi = resident("pi-taken");
  holdResident([pi], []);
  const created = vi.spyOn(claudeSdkStore, "acquire");
  assert.throws(
    () => hub.acquireClaudeSdk("pi-taken"),
    /belongs to the pi harness/,
  );
  assert.equal(created.mock.calls.length, 0);
});

test("a legacy pi transcript is pi's, and a Claude record outranks a pi transcript", () => {
  legacyPiTranscript("pi-legacy");
  assert.equal(harnessRegistry.otherHolder("pi-legacy", "claude-sdk"), "pi");

  // Without a row, the disk decides as acquireById would: Claude first.
  piTranscript("both-on-disk");
  vi.spyOn(claudeSdkStore, "exists").mockImplementation(
    (id) => id === "both-on-disk",
  );
  assert.equal(
    harnessRegistry.otherHolder("both-on-disk", "claude-sdk"),
    undefined,
  );
  assert.equal(harnessRegistry.otherHolder("both-on-disk", "pi"), "claude-sdk");
});

test("the Claude store never registers an id pi holds resident", () => {
  vi.spyOn(piStore, "getLiveById").mockImplementation((id) =>
    id === "pi-resident-dup" ? ({ id } as never) : undefined,
  );
  assert.throws(
    () => claudeSdkStore.acquire("pi-resident-dup"),
    SessionHeldElsewhereError,
  );
  assert.equal(claudeSdkStore.get("pi-resident-dup"), undefined);
});

test("a pi reopen never registers an id the Claude store took meanwhile", async () => {
  const file = legacyPiTranscript("claude-took-it");
  const internals = piStore as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
  };
  const disposed: string[] = [];
  vi.spyOn(internals, "create").mockImplementation(async (...args) => {
    const manager = args[1] as { getSessionId(): string };
    return {
      session: {
        sessionId: manager.getSessionId(),
        dispose: () => disposed.push(manager.getSessionId()),
      },
      notices: [],
    };
  });
  // The Claude session registered while the transcript was opening.
  vi.spyOn(claudeSdkStore, "get").mockImplementation((id) =>
    id === "claude-took-it" ? ({ id } as never) : undefined,
  );

  // The Claude session's browser runtime, keyed by the same id.
  let browserClosed = 0;
  setProxiedClientFactoryForTests(async () => ({
    callTool: async () => ({ content: [] }),
    close: async () => {
      browserClosed += 1;
    },
    onUnexpectedClose() {},
  }));
  try {
    await openProxiedConnection(
      "claude-took-it",
      {
        name: "Test browser",
        outputDir: (id) => join(tmp, "browser", id),
        spawn: () => ({ command: "browser", args: [] }) as never,
      },
      false,
    );

    await assert.rejects(
      piStore.acquireExisting("assistant", file, "claude-took-it"),
      SessionHeldElsewhereError,
    );
    assert.equal(piStore.getLiveById("claude-took-it"), undefined);
    assert.deepEqual(disposed, ["claude-took-it"], "what it built is disposed");
    // What the id's holder owns stays open.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(getProxiedConnection("claude-took-it"), "browser still tracked");
    assert.equal(browserClosed, 0);
  } finally {
    await closeProxiedConnection("claude-took-it");
    setProxiedClientFactoryForTests(undefined);
  }
});

test("both stores reach the hub through one host", () => {
  const calls: string[] = [];
  // Captured, not applied: the hub's own host stays installed.
  const setPiHost = vi.spyOn(piStore, "setHost").mockImplementation(() => {});
  const setOnChange = vi
    .spyOn(claudeSdkStore, "setOnChange")
    .mockImplementation(() => {});
  const setProvider = vi
    .spyOn(claudeSdkStore, "setBrowserRuntimesProvider")
    .mockImplementation(() => {});
  const host = {
    broadcastSessions: async () => {
      calls.push("broadcastSessions");
    },
    noteRunStarted: () => {},
    checkPendingReload: () => {
      calls.push("checkPendingReload");
    },
    isReloadQueued: () => false,
    browserRuntimesFor: (sessionId: string) => {
      calls.push(`browserRuntimesFor:${sessionId}`);
      return [];
    },
  };
  harnessRegistry.setHost(host);

  assert.equal(setPiHost.mock.calls[0]?.[0], host);
  // A Claude session changing re-lists and re-checks a queued reload.
  setOnChange.mock.calls[0]?.[0]();
  setProvider.mock.calls[0]?.[0]("s1");
  assert.deepEqual(calls, [
    "broadcastSessions",
    "checkPendingReload",
    "browserRuntimesFor:s1",
  ]);
});
