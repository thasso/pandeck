/**
 * Reading a session opens NO harness.
 *
 *   pnpm --filter @assistant/server test src/detachedSessionView.test.ts
 *
 * This is the load-time contract: a `loadSession` answers from the metadata row
 * and the app-owned log, so the reader waits for storage instead of for a
 * provider transcript to be parsed (measured at 1.7s for one 51 MB pi native
 * file, and the Claude SDK record is a single large JSON document). The harness
 * opens on the first thing that actually needs it, and the view is upgraded in
 * place — the transcript stream is not rebuilt under the reader.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "detached-session-view-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { ViewSession } = await import("./viewSession.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

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

/** A stored, non-resident session plus a spy on every harness acquisition. */
function storedSession(id: string) {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  const acquired: string[] = [];
  vi.spyOn(hub, "acquireById").mockImplementation(async (wanted: string) => {
    acquired.push(wanted);
    return new ClaudeSdkSession(wanted, {
      seam: async () => fakeSeam(),
      agentType: "assistant",
    });
  });
  return { acquired };
}

describe("viewing a stored session", () => {
  test("attaches without opening its harness, and still renders it", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const { acquired } = storedSession("stored-a");

    void connection.handle({
      type: "loadSession",
      id: "stored-a",
    } as ClientMessage);
    await settle();

    expect(acquired).toEqual([]);
    const snapshot = sent.find((m) => m.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.snapshot.sessionId).toBe(
      "stored-a",
    );
    // The runtime session backing it exists, and knows it has no harness.
    expect(sessionRuntime.get("stored-a")?.isDetached).toBe(true);
    expect(
      (connection as unknown as { viewing: unknown }).viewing,
    ).toBeInstanceOf(ViewSession);
  });

  test("the first prompt opens the harness and upgrades the view in place", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const { acquired } = storedSession("stored-b");
    vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);

    void connection.handle({
      type: "loadSession",
      id: "stored-b",
    } as ClientMessage);
    await settle();
    expect(acquired).toEqual([]);
    const snapshotsBefore = sent.filter((m) => m.type === "snapshot").length;

    await connection.handle({
      type: "prompt",
      text: "go",
      clientRequestId: "req-1",
    } as ClientMessage);
    await settle();

    expect(acquired).toEqual(["stored-b"]);
    expect(sessionRuntime.get("stored-b")?.isDetached).toBe(false);
    expect(
      (connection as unknown as { viewing: unknown }).viewing,
    ).toBeInstanceOf(ClaudeSdkSession);
    // Upgraded IN PLACE: the reader's transcript is not re-sent under them.
    expect(sent.filter((m) => m.type === "snapshot").length).toBe(
      snapshotsBefore,
    );
    expect(sent.some((m) => m.type === "state")).toBe(true);
  });

  test("a command that is not a prompt opens the harness too, runtime included", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    const { acquired } = storedSession("stored-d");

    void connection.handle({
      type: "loadSession",
      id: "stored-d",
    } as ClientMessage);
    await settle();
    expect(sessionRuntime.get("stored-d")?.isDetached).toBe(true);

    // Changing the thinking level drives the session through the RUNTIME, not
    // through the prompt facade: a runtime still bound to the detached adapter
    // refuses it, which is invisible until a reader touches the control.
    await connection.handle({
      type: "setThinkingLevel",
      level: "medium",
    } as ClientMessage);
    await settle();

    expect(acquired).toEqual(["stored-d"]);
    expect(sessionRuntime.get("stored-d")?.isDetached).toBe(false);
    expect(sent.filter((m) => m.type === "error")).toEqual([]);
  });

  test("a prompt keeps its own session when the reader navigates mid-open", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    sessionStore.upsert({
      id: "stored-e",
      harness: "pi",
      agentType: "assistant",
    });
    sessionStore.upsert({
      id: "stored-f",
      harness: "pi",
      agentType: "assistant",
    });
    vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
    // F is already live, so navigating to it attaches a REAL driver — the one a
    // stale command would reach for after its own session finished opening.
    const liveF = new ClaudeSdkSession("stored-f", {
      seam: async () => fakeSeam(),
      agentType: "assistant",
    });
    vi.spyOn(hub, "getLiveById").mockImplementation((id: string) =>
      id === "stored-f" ? liveF : undefined,
    );
    // The harness open for E is held: this is the window the reader navigates in.
    let releaseE!: () => void;
    vi.spyOn(hub, "acquireById").mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          releaseE = () =>
            resolve(
              new ClaudeSdkSession(id, {
                seam: async () => fakeSeam(),
                agentType: "assistant",
              }),
            );
        }),
    );

    void connection.handle({
      type: "loadSession",
      id: "stored-e",
    } as ClientMessage);
    await settle();
    void connection.handle({
      type: "prompt",
      text: "meant for E",
      clientRequestId: "req-e",
    } as ClientMessage);
    await settle();

    // The reader moves to F while E's harness is still opening.
    void connection.handle({
      type: "loadSession",
      id: "stored-f",
    } as ClientMessage);
    await settle();
    releaseE();
    await settle();

    // F is what the reader is looking at, and it must not have been prompted:
    // the text was typed into E.
    expect(sessionRuntime.get("stored-f")?.getSnapshot().entries).toEqual([]);
    // E ran it: the harness belongs to the session, and the command belongs to
    // the session it was issued against — not to whichever one is on show when
    // the open finishes.
    const ePrompt = sessionRuntime.get("stored-e")?.getSnapshot().entries[0];
    expect(ePrompt?.role).toBe("user");
    expect(JSON.stringify(ePrompt?.content)).toContain("meant for E");
  });

  test("a control command cannot land on the session a queued navigation moved to", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    sessionStore.upsert({
      id: "live-g",
      harness: "pi",
      agentType: "assistant",
    });
    sessionStore.upsert({
      id: "live-h",
      harness: "pi",
      agentType: "assistant",
    });
    vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
    const liveG = new ClaudeSdkSession("live-g", {
      seam: async () => fakeSeam(),
      agentType: "assistant",
    });
    const liveH = new ClaudeSdkSession("live-h", {
      seam: async () => fakeSeam(),
      agentType: "assistant",
    });
    // BOTH are already live: this is the path that opens no harness at all, so
    // the only suspension is the `await` itself.
    vi.spyOn(hub, "getLiveById").mockImplementation((id: string) =>
      id === "live-g" ? liveG : id === "live-h" ? liveH : undefined,
    );

    void connection.handle({
      type: "loadSession",
      id: "live-g",
    } as ClientMessage);
    await settle();
    // "medium" is the default, so the level asked for has to be a different one
    // or neither assertion below would say anything.
    const before = liveH.state().thinkingLevel;
    expect(before).not.toBe("high");

    // Frames that arrive in one read are dispatched in one tick: the thinking
    // change suspends on its await and the navigation behind it runs to
    // completion before it resumes. Deliberately not awaited in between.
    void connection.handle({
      type: "setThinkingLevel",
      level: "high",
    } as ClientMessage);
    void connection.handle({
      type: "loadSession",
      id: "live-h",
    } as ClientMessage);
    await settle();

    expect(liveH.state().thinkingLevel).toBe(before);
    expect(liveG.state().thinkingLevel).toBe("high");
  });

  test("a control command is dropped, not redirected, when its harness open is overtaken", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    sessionStore.upsert({
      id: "stored-i",
      harness: "pi",
      agentType: "assistant",
    });
    sessionStore.upsert({
      id: "live-j",
      harness: "pi",
      agentType: "assistant",
    });
    vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
    const liveJ = new ClaudeSdkSession("live-j", {
      seam: async () => fakeSeam(),
      agentType: "assistant",
    });
    vi.spyOn(hub, "getLiveById").mockImplementation((id: string) =>
      id === "live-j" ? liveJ : undefined,
    );
    let releaseI!: () => void;
    vi.spyOn(hub, "acquireById").mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          releaseI = () =>
            resolve(
              new ClaudeSdkSession(id, {
                seam: async () => fakeSeam(),
                agentType: "assistant",
              }),
            );
        }),
    );

    void connection.handle({
      type: "loadSession",
      id: "stored-i",
    } as ClientMessage);
    await settle();
    const before = liveJ.state().thinkingLevel;
    expect(before).not.toBe("high");

    // I is storage-backed, so this one really does wait for a harness — the
    // wide window the reader navigates in.
    void connection.handle({
      type: "setThinkingLevel",
      level: "high",
    } as ClientMessage);
    await settle();
    void connection.handle({
      type: "loadSession",
      id: "live-j",
    } as ClientMessage);
    await settle();
    releaseI();
    await settle();

    // Unlike a prompt — which is the user's words and runs where they typed it
    // — a control change is about the session ON SHOW. The reader left, so it
    // applies to neither: never to J, and I is no longer theirs to configure.
    expect(liveJ.state().thinkingLevel).toBe(before);
  });

  test("a harness opened by someone else upgrades a reader's view too", async () => {
    const sent: ServerMessage[] = [];
    const connection = new Connection(fakeSocket(sent));
    storedSession("stored-c");
    hub.register(connection);
    try {
      void connection.handle({
        type: "loadSession",
        id: "stored-c",
      } as ClientMessage);
      await settle();
      expect(
        (connection as unknown as { viewing: unknown }).viewing,
      ).toBeInstanceOf(ViewSession);

      // Something with no browser behind it — a queued peer message, a
      // workflow step — opens the harness and prompts.
      const driver = new ClaudeSdkSession("stored-c", {
        seam: async () => fakeSeam(),
        agentType: "assistant",
      });
      vi.spyOn(hub, "getLiveById").mockReturnValue(driver);
      const { ensureRuntimeSessionWithRuntime } =
        await import("./session/runtimePrompt.ts");
      ensureRuntimeSessionWithRuntime(sessionRuntime, driver);
      await settle();

      expect(sessionRuntime.get("stored-c")?.isDetached).toBe(false);
      expect((connection as unknown as { viewing: unknown }).viewing).toBe(
        driver,
      );
    } finally {
      hub.unregister(connection);
    }
  });
});
