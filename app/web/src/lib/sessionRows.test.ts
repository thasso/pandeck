import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import {
  backlogSessionsKey,
  sameSessionRowProps,
  sessionRowKey,
} from "./sessionRows.ts";

function row(patch: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s1",
    title: "Session one",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    ...patch,
  } as SessionListItem;
}

describe("sessionRowKey", () => {
  it("is stable across rebroadcast copies of the same row", () => {
    const at = Date.now() - 5 * 60_000;
    expect(sessionRowKey(row({ updatedAt: at }))).toBe(
      sessionRowKey(row({ updatedAt: at })),
    );
  });

  it("changes for every field the row renders", () => {
    const at = Date.now() - 5 * 60_000;
    const base = sessionRowKey(row({ updatedAt: at }));
    const variants: Array<Partial<SessionListItem>> = [
      { id: "s2" },
      { title: "Other" },
      { titleGenerationPending: true },
      { updatedAt: at - 3 * 60 * 60_000 },
      { harness: "claude-sdk" },
      { agentType: "developer" },
      { isStreaming: true },
      { awaitingInput: true },
      { unread: true },
      { archived: true },
      { taskProgress: { todo: 1, doing: 2, done: 3 } },
    ];
    for (const patch of variants) {
      expect(
        sessionRowKey(row({ updatedAt: at, ...patch })),
        JSON.stringify(patch),
      ).not.toBe(base);
    }
  });
});

describe("backlogSessionsKey", () => {
  const base = [row({ id: "a", isStreaming: true }), row({ id: "b" })];

  it("ignores what no Backlog row reads", () => {
    // Unread and `updatedAt` move on the ~4x/second rebroadcast; keying on them
    // would rebuild ~220 Task rows for nothing.
    expect(
      backlogSessionsKey([
        row({ id: "a", isStreaming: true, unread: true, updatedAt: 999 }),
        row({ id: "b", updatedAt: 42 }),
      ]),
    ).toBe(backlogSessionsKey(base));
  });

  it("separates the fields so a title cannot forge another session's row", () => {
    // The title is free text, so a flat concatenation could let one session's
    // title spell out a second row and two different lists answer the same key.
    expect(
      backlogSessionsKey([row({ id: "a", title: "x b" }), row({ id: "c" })]),
    ).not.toBe(
      backlogSessionsKey([row({ id: "a", title: "x" }), row({ id: "b c" })]),
    );
  });

  it("changes for every fact a Backlog row does read", () => {
    const variants: SessionListItem[][] = [
      // A session that STOPPED, and one that started.
      [row({ id: "a" }), row({ id: "b" })],
      [
        row({ id: "a", isStreaming: true }),
        row({ id: "b", isStreaming: true }),
      ],
      // Gone: the row must stop offering to open it. This is the case the old
      // running-ids-only key missed — an idle session deleted out of the list
      // left the gutter pointing at a dead route.
      [row({ id: "a", isStreaming: true })],
      // Arrived, archived, moved to a worktree.
      [...base, row({ id: "c" })],
      [row({ id: "a", isStreaming: true }), row({ id: "b", archived: true })],
      [row({ id: "a", isStreaming: true }), row({ id: "b", worktreeId: "wt" })],
      // Auto-titled after arriving untitled: a Workflow Run's role-session
      // button names the session by its title and falls back to the raw id, so
      // a key blind to this showed an id for the whole run.
      [
        row({ id: "a", isStreaming: true }),
        row({ id: "b", title: "Reviewer" }),
      ],
    ];
    for (const variant of variants) {
      expect(backlogSessionsKey(variant), JSON.stringify(variant)).not.toBe(
        backlogSessionsKey(base),
      );
    }
  });
});

describe("sameSessionRowProps", () => {
  it("treats a fresh row object with identical content as equal", () => {
    const at = Date.now() - 60_000;
    const onActivate = () => {};
    expect(
      sameSessionRowProps(
        { session: row({ updatedAt: at }), active: true, onActivate },
        { session: row({ updatedAt: at }), active: true, onActivate },
      ),
    ).toBe(true);
  });

  it("re-renders when any other prop changes by identity", () => {
    const at = Date.now() - 60_000;
    const session = row({ updatedAt: at });
    expect(
      sameSessionRowProps(
        { session, active: true },
        { session, active: false },
      ),
    ).toBe(false);
    expect(
      sameSessionRowProps(
        { session, onActivate: () => {} },
        { session, onActivate: () => {} },
      ),
    ).toBe(false);
  });

  it("re-renders when a prop is added or removed", () => {
    const session = row();
    expect(
      sameSessionRowProps(
        { session, active: true } as Record<string, unknown> & {
          session: SessionListItem;
        },
        { session } as Record<string, unknown> & { session: SessionListItem },
      ),
    ).toBe(false);
  });

  it("re-renders when the row content changes", () => {
    const at = Date.now() - 60_000;
    expect(
      sameSessionRowProps(
        { session: row({ updatedAt: at }) },
        { session: row({ updatedAt: at, isStreaming: true }) },
      ),
    ).toBe(false);
  });
});
