/**
 * A session opened only to be READ is released once nobody reads it: the last
 * view of a detached runtime session to detach disposes it after the grace,
 * a view back inside the grace keeps it, a session with a harness bound is its
 * harness store's to release, and a view after release reopens the log and
 * shows exactly what it showed before.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/session/viewRelease.test.ts`
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ServerMessage, SessionState } from "@assistant/shared";
import { attachRuntimeView } from "./attach.ts";
import type { AdapterEvent, PromptableAdapter } from "./adapters/contract.ts";
import { SessionLogStore } from "./log/store.ts";
import { SessionRuntime, VIEW_RELEASE_GRACE_MS } from "./runtime/runtime.ts";

let counter = 0;
const freshId = () => `view-release-${Date.now()}-${counter++}`;

/** A session with a durable transcript on disk, written through its own log. */
function seed(store: SessionLogStore, id: string): void {
  const log = store.open(id);
  log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: `question for ${id}` }],
  });
  log.append({
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: `answer for ${id}` }],
  });
  store.evict(id);
}

function view(runtime: SessionRuntime, id: string) {
  const sent: ServerMessage[] = [];
  const handle = attachRuntimeView(
    runtime,
    id,
    undefined,
    { send: (message) => sent.push(message) },
    {
      buildState: () => ({ sessionId: id }) as SessionState,
      buildContextInfo: () => ({}) as never,
    },
  );
  const snapshot = sent.find((message) => message.type === "snapshot");
  assert.ok(snapshot?.type === "snapshot", "the view sent its snapshot");
  return { handle, timeline: snapshot.snapshot.timeline };
}

/** A harness adapter that does nothing; only its binding matters here. */
function harnessAdapter(): PromptableAdapter {
  return {
    provider: "claude-sdk",
    capabilities: {
      fork: "none",
      compact: false,
      steer: false,
      attachments: false,
    },
    subscribe: (_listener: (event: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "claude-sdk" }),
    prompt: () => Promise.reject(new Error("not driven here")),
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  } as unknown as PromptableAdapter;
}

let store: SessionLogStore;
let runtime: SessionRuntime;

beforeEach(() => {
  vi.useFakeTimers();
  store = new SessionLogStore();
  runtime = new SessionRuntime(store);
});

afterEach(async () => {
  await runtime.dispose();
  vi.useRealTimers();
});

describe("detached views", () => {
  test("the last view to detach releases the session after the grace, not before", () => {
    const id = freshId();
    seed(store, id);
    const first = view(runtime, id);
    const second = view(runtime, id);
    const live = runtime.get(id);

    first.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS * 2);
    assert.equal(runtime.get(id), live, "one view still holds it");

    second.handle.detach();
    // Detaching twice is one release, not two.
    second.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS - 1);
    assert.equal(runtime.get(id), live, "still inside the grace");
    assert.ok(store.residentIds().includes(id));

    vi.advanceTimersByTime(1);
    assert.equal(runtime.get(id), undefined, "released after the grace");
    assert.equal(store.residentIds().includes(id), false, "its log with it");
  });

  test("a view back inside the grace keeps the same session", () => {
    const id = freshId();
    seed(store, id);
    view(runtime, id).handle.detach();
    const live = runtime.get(id);

    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS / 2);
    const back = view(runtime, id);
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS * 2);
    assert.equal(runtime.get(id), live, "the re-view cancelled the release");

    back.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    assert.equal(runtime.get(id), undefined);
  });

  test("a view after release reopens the log and shows the same transcript", () => {
    const id = freshId();
    seed(store, id);
    const before = view(runtime, id);
    before.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    assert.equal(runtime.get(id), undefined);

    const after = view(runtime, id);
    assert.deepEqual(after.timeline, before.timeline);
    assert.equal(after.timeline.length, 2);
    after.handle.detach();
  });

  test("a session opened for one read and never viewed is released too", () => {
    const id = freshId();
    seed(store, id);
    runtime.openForView(id).contextInfo();
    assert.ok(runtime.get(id));
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    assert.equal(runtime.get(id), undefined);
  });

  test("a view arriving while the release is disposing opens a fresh session with the same content", async () => {
    const id = freshId();
    seed(store, id);
    const before = view(runtime, id);
    before.handle.detach();
    const released = runtime.get(id)!;

    // Fire the release and view again in the same tick, before its dispose has
    // settled: the new view must get a live session of its own, whole.
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    const during = view(runtime, id);
    const reopened = runtime.get(id);
    assert.ok(reopened);
    assert.notEqual(reopened, released);
    assert.deepEqual(during.timeline, before.timeline);
    await Promise.resolve();
    assert.equal(runtime.get(id), reopened, "the old dispose left it alone");
    during.handle.detach();
  });

  test("a view still held on a disposed instance cannot release its successor", () => {
    const id = freshId();
    seed(store, id);
    const old = view(runtime, id);
    // Disposed from under the view (a delete does this), then reopened.
    void runtime.disposeSession(id);
    const current = view(runtime, id);
    const reopened = runtime.get(id);
    assert.ok(reopened);

    // The OLD instance's last view lets go: its count is its own, so nothing
    // arms for the reopened session, which still has a view of its own.
    old.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS * 2);
    assert.equal(runtime.get(id), reopened);

    current.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    assert.equal(runtime.get(id), undefined);
  });
});

describe("sessions with a harness bound", () => {
  test("their views never release them", () => {
    const id = freshId();
    seed(store, id);
    const session = runtime.createSession(id, harnessAdapter());
    const release = runtime.retainView(session);
    release();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS * 10);
    assert.equal(runtime.get(id), session, "the harness store owns it");
  });

  test("a detached session that gets its harness during the grace is kept", () => {
    const id = freshId();
    seed(store, id);
    view(runtime, id).handle.detach();
    const session = runtime.get(id)!;
    session.rebindAdapter(harnessAdapter());
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS * 2);
    assert.equal(runtime.get(id), session);
  });

  test("releasing the harness disposes a bound session and leaves a reader's detached one", async () => {
    const bound = freshId();
    const detached = freshId();
    seed(store, bound);
    seed(store, detached);
    runtime.createSession(bound, harnessAdapter());
    const reader = view(runtime, detached);

    await runtime.releaseHarness(bound);
    await runtime.releaseHarness(detached);
    assert.equal(runtime.get(bound), undefined);
    assert.ok(runtime.get(detached), "the reader's view still has its session");
    reader.handle.detach();
  });
});

describe("reading a session that is not live", () => {
  test("fork and edit reads leave no log resident, whatever they find", () => {
    const source = freshId();
    const child = freshId();
    seed(store, source);
    const shown = view(runtime, source);
    shown.handle.detach();
    vi.advanceTimersByTime(VIEW_RELEASE_GRACE_MS);
    assert.equal(runtime.get(source), undefined, "no longer viewed");

    const entries = store.open(source).serverEntries();
    store.evict(source);
    const [prompt, answer] = entries;
    assert.ok(prompt && answer);
    assert.equal(runtime.forkAnchors(source, answer.id).entryFound, true);
    assert.equal(runtime.canForkLogAt(source, answer.id), true);
    assert.equal(
      runtime.entryText(source, prompt.id),
      `question for ${source}`,
    );
    assert.equal(runtime.forkCutEntryId(source, "missing"), undefined);
    const forked = runtime.forkLog(source, child, answer.id);
    assert.equal(forked?.length, 2);
    assert.equal(runtime.forkLog(source, freshId(), "missing"), undefined);
    assert.deepEqual(store.residentIds(), [], "every read dropped its log");

    // The child's copy was written through: opening it reads it back whole.
    const opened = view(runtime, child);
    assert.equal(opened.timeline.length, 2);
    opened.handle.detach();
  });

  test("a read of a live session keeps the log its session owns", () => {
    const id = freshId();
    seed(store, id);
    const shown = view(runtime, id);
    const entries = store.open(id).serverEntries();
    runtime.entryText(id, entries[0]!.id);
    assert.ok(store.residentIds().includes(id));
    shown.handle.detach();
  });
});

describe("prompt admissions", () => {
  test("count as busy until released", () => {
    const id = freshId();
    assert.equal(runtime.isBusy(id), false);
    const first = runtime.admitPrompt(id);
    const second = runtime.admitPrompt(id);
    first();
    first();
    assert.equal(runtime.isBusy(id), true);
    second();
    assert.equal(runtime.isBusy(id), false);
  });
});
