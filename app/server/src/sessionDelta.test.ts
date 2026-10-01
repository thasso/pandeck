import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ServerMessage, SessionListItem } from "@assistant/shared";
import { hub } from "./hub.ts";
import { sessionStore } from "./db/sessionStore.ts";

/**
 * A rebuild that only changed volatile row state must reach clients as
 * single-row updates, not as the whole list (~30 KB against production data, up
 * to ~4 times a second while agents stream).
 */
test("a volatile session change broadcasts as a row update, a structural one as the list", async () => {
  const messages: ServerMessage[] = [];
  const viewer = { send: (message: ServerMessage) => messages.push(message) };
  hub.register(viewer);
  try {
    const id = `delta-${Date.now()}`;
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: "Delta session",
      scope: "user",
      messageCount: 2,
    });
    await hub.broadcastSessions();
    // The row is new, so the id set changed: the whole list goes out.
    assert.ok(
      messages.some((message) => message.type === "sessions"),
      "a new session sends the full list",
    );

    messages.length = 0;
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: "Renamed while running",
      scope: "user",
    });
    await hub.broadcastSessions();

    const updates = messages.filter(
      (
        message,
      ): message is Extract<ServerMessage, { type: "sessionUpdated" }> =>
        message.type === "sessionUpdated",
    );
    assert.equal(
      messages.some((message) => message.type === "sessions"),
      false,
      "an unchanged id set must not resend the list",
    );
    assert.equal(updates.length, 1, "exactly the changed row");
    assert.equal((updates[0]!.session as SessionListItem).id, id);
    assert.equal(updates[0]!.session.title, "Renamed while running");

    // The archived COUNT only travels on a full list, so a change to it has to
    // force one even when this variant's row set is untouched — archiving drops
    // the row here (a set change), but a deletion elsewhere in the archive does
    // not.
    messages.length = 0;
    const archived = `delta-archived-${Date.now()}`;
    sessionStore.upsert({
      id: archived,
      harness: "pi",
      agentType: "assistant",
      title: "Archived elsewhere",
      scope: "user",
      messageCount: 2,
    });
    sessionStore.setArchived(archived, true);
    await hub.broadcastSessions();
    const counted = messages.filter(
      (message): message is Extract<ServerMessage, { type: "sessions" }> =>
        message.type === "sessions",
    );
    assert.equal(
      counted.length,
      1,
      "a changed archived count resends the list",
    );
    assert.ok(
      (counted[0]!.archivedSessionCount ?? 0) > 0,
      "and carries the new count",
    );
  } finally {
    hub.unregister(viewer);
  }
});

/**
 * A one-row refresh used to build the whole archived list (~74 ms on a
 * production copy) to send one row. It projects that row alone now, and the
 * row it sends must be the one a full build would.
 */
test("broadcastSessionUpdated projects only the named row", async () => {
  const active = `row-update-${Date.now()}`;
  const archived = `row-update-archived-${Date.now()}`;
  for (const id of [active, archived])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: `Row ${id}`,
      scope: "user",
      messageCount: 2,
    });
  sessionStore.setArchived(archived, true);
  const full = new Map(
    (await hub.listSessions({ includeArchived: true })).map((row) => [
      row.id,
      row,
    ]),
  );

  const plain: ServerMessage[] = [];
  const withArchive: ServerMessage[] = [];
  const plainViewer = { send: (message: ServerMessage) => plain.push(message) };
  const archiveViewer = {
    send: (message: ServerMessage) => withArchive.push(message),
    wantsArchivedSessions: () => true,
  };
  hub.register(plainViewer);
  hub.register(archiveViewer);
  const reads = vi.spyOn(sessionStore, "list");
  try {
    await hub.broadcastSessionUpdated(active);
    await hub.broadcastSessionUpdated(archived);

    assert.ok(reads.mock.calls.length > 0, "the rows were read from the store");
    for (const [opts] of reads.mock.calls)
      assert.ok(
        opts?.ids?.length === 1,
        "every store read is bounded to the one row",
      );
    const rows = (messages: ServerMessage[]) =>
      messages.flatMap((message) =>
        message.type === "sessionUpdated" ? [message.session] : [],
      );
    assert.deepEqual(
      rows(plain),
      [full.get(active)],
      "a viewer without the archive gets only the active row",
    );
    assert.deepEqual(
      rows(withArchive),
      [full.get(active), full.get(archived)],
      "the archive viewer gets both, exactly as a full build lists them",
    );
  } finally {
    reads.mockRestore();
    hub.unregister(plainViewer);
    hub.unregister(archiveViewer);
  }
});
