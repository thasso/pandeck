// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingDocumentComment } from "./chatCommentPrompt.ts";
import {
  addPendingComment,
  moveTrayToOutbox,
  outboxStorageKey,
  readPendingComments,
  subscribePendingComments,
  trayStorageKey,
  updatePendingComment,
  writePendingComments,
} from "./pendingCommentStore.ts";

const TRAY = trayStorageKey("file:/tmp/example/plan.md");
const OTHER_TRAY = trayStorageKey("kb:kb-notes");
const DRAFT = "assistant.composerDraft.session:s1";
const OUTBOX = outboxStorageKey(DRAFT);

function note(id: string, body = `note ${id}`): PendingDocumentComment {
  return {
    id,
    anchor: {
      kind: "document",
      document: { kind: "hostFile", path: "/tmp/example/plan.md" },
    },
    body,
    createdAt: "2026-08-20T14:00:00.000Z",
  };
}

function ids(key: string): string[] {
  return readPendingComments(key).map((comment) => comment.id);
}

/** Write a record the way another tab would: straight to storage, no notify. */
function writeFromOtherTab(listKey: string, comment: PendingDocumentComment) {
  Storage.prototype.setItem.call(
    window.localStorage,
    `${listKey}#${comment.id}`,
    JSON.stringify({ order: Date.now() + 1_000, comment }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("pending comment store", () => {
  it("moves a tray to the end of a composer outbox and empties the tray", async () => {
    writePendingComments(OUTBOX, [note("existing")]);
    writePendingComments(TRAY, [note("a"), note("b")]);
    const outbox = vi.fn();
    const tray = vi.fn();
    const stopOutbox = subscribePendingComments(OUTBOX, outbox);
    const stopTray = subscribePendingComments(TRAY, tray);

    expect(await moveTrayToOutbox(TRAY, DRAFT)).toEqual({ moved: 2 });

    expect(ids(OUTBOX)).toEqual(["existing", "a", "b"]);
    expect(ids(TRAY)).toEqual([]);
    expect(outbox).toHaveBeenCalled();
    expect(tray).toHaveBeenCalled();
    stopOutbox();
    stopTray();
  });

  it("keeps two trays moved into one outbox at the same moment", async () => {
    writePendingComments(TRAY, [note("a")]);
    writePendingComments(OTHER_TRAY, [note("b")]);
    // The other tab lands ITS move while this one is writing: with one
    // record per comment neither write can replace the other's.
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      setItem.call(this, key, value);
      if (key === `${OUTBOX}#a`) writeFromOtherTab(OUTBOX, note("b"));
    });
    expect(await moveTrayToOutbox(TRAY, DRAFT)).toEqual({ moved: 1 });
    vi.restoreAllMocks();

    expect(ids(OUTBOX).sort()).toEqual(["a", "b"]);
    expect(ids(TRAY)).toEqual([]);
  });

  it("keeps the tray when storage refuses the outbox write", async () => {
    writePendingComments(TRAY, [note("a")]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(await moveTrayToOutbox(TRAY, DRAFT)).toHaveProperty("error");
    vi.restoreAllMocks();

    expect(ids(TRAY)).toEqual(["a"]);
    expect(ids(OUTBOX)).toEqual([]);
  });

  it("reports a tray it could not clear, and a repeat move adds nothing", async () => {
    writePendingComments(TRAY, [note("a")]);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const result = await moveTrayToOutbox(TRAY, DRAFT);
    vi.restoreAllMocks();

    expect(result).toHaveProperty("error");
    expect(ids(OUTBOX)).toEqual(["a"]);
    expect(ids(TRAY)).toEqual(["a"]);
    // Sending again rewrites the same outbox record rather than a second one.
    expect(await moveTrayToOutbox(TRAY, DRAFT)).toEqual({ moved: 1 });
    expect(ids(OUTBOX)).toEqual(["a"]);
    expect(ids(TRAY)).toEqual([]);
  });

  it("never overwrites an outbox edit when a stranded move is retried", async () => {
    writePendingComments(TRAY, [note("a", "original")]);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await moveTrayToOutbox(TRAY, DRAFT);
    vi.restoreAllMocks();
    // The reader edits it in the composer before sending the tray again.
    await updatePendingComment(OUTBOX, "a", "edited in the composer");

    expect(await moveTrayToOutbox(TRAY, DRAFT)).toEqual({ moved: 1 });
    expect(readPendingComments(OUTBOX).map((comment) => comment.body)).toEqual([
      "edited in the composer",
    ]);
    expect(ids(TRAY)).toEqual([]);
  });

  it("keeps a comment added to the tray while its move was writing", async () => {
    writePendingComments(TRAY, [note("a")]);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      setItem.call(this, key, value);
      if (key === `${OUTBOX}#a`) writeFromOtherTab(TRAY, note("late"));
    });
    await moveTrayToOutbox(TRAY, DRAFT);
    vi.restoreAllMocks();

    expect(ids(TRAY)).toEqual(["late"]);
    expect(ids(OUTBOX)).toEqual(["a"]);
  });

  it("compares an edit against storage, not against what was last rendered", async () => {
    addPendingComment(TRAY, note("a", "first"));
    // Another tab edits it; no event has reached this one yet.
    writeFromOtherTab(TRAY, note("a", "theirs"));
    expect(
      await updatePendingComment(TRAY, "a", "mine", "first"),
    ).toMatchObject({
      status: "conflict",
      current: { body: "theirs" },
    });
    expect(readPendingComments(TRAY)[0]?.body).toBe("theirs");

    expect(await updatePendingComment(TRAY, "a", "mine", "theirs")).toEqual({
      status: "saved",
    });
    expect(readPendingComments(TRAY)[0]?.body).toBe("mine");

    window.localStorage.removeItem(`${TRAY}#a`);
    expect(await updatePendingComment(TRAY, "a", "again", "mine")).toEqual({
      status: "missing",
    });
  });

  it("runs every read-then-write inside the cross-tab lock", async () => {
    const held: string[] = [];
    let inside = false;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (name: string, operation: () => unknown) => {
          held.push(name);
          inside = true;
          try {
            return await operation();
          } finally {
            inside = false;
          }
        },
      },
    });
    const setItem = Storage.prototype.setItem;
    const unlockedWrites: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (!inside) unlockedWrites.push(key);
      setItem.call(this, key, value);
    });
    try {
      addPendingComment(TRAY, note("a", "first"));
      await updatePendingComment(TRAY, "a", "second", "first");
      await moveTrayToOutbox(TRAY, DRAFT);
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
    expect(held).toEqual([
      "assistant.pendingComments",
      "assistant.pendingComments",
    ]);
    // Only the append ran unlocked: it writes a key no one else writes.
    expect(unlockedWrites).toEqual([`${TRAY}#a`]);
    expect(ids(OUTBOX)).toEqual(["a"]);
  });

  it("reads an older client's outbox array and migrates it on the next write", async () => {
    window.localStorage.setItem(
      OUTBOX,
      JSON.stringify([note("old-1"), note("old-2"), { id: "bad" }]),
    );
    expect(ids(OUTBOX)).toEqual(["old-1", "old-2"]);

    addPendingComment(OUTBOX, note("new"));
    expect(window.localStorage.getItem(OUTBOX)).toBeNull();
    expect(ids(OUTBOX)).toEqual(["old-1", "old-2", "new"]);
  });

  it("re-reads a list when another tab writes one of its records", async () => {
    const listener = vi.fn();
    const stop = subscribePendingComments(TRAY, listener);
    writeFromOtherTab(TRAY, note("remote"));
    window.dispatchEvent(
      new StorageEvent("storage", { key: `${TRAY}#remote` }),
    );
    expect(listener).toHaveBeenCalled();
    expect(ids(TRAY)).toEqual(["remote"]);
    stop();
  });
});
