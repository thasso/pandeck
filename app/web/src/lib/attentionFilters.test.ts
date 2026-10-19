import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { buildSessionInbox, inboxItemId } from "./sessionInbox.ts";
import {
  attentionFilterCount,
  attentionHistoryMatches,
  attentionProjectsBySession,
  DEFAULT_ATTENTION_FILTERS,
  filterAttentionInbox,
  groupAttentionByProject,
  normalizeAttentionFilters,
} from "./attentionFilters.ts";

function session(
  partial: Partial<SessionListItem> & { id: string },
): SessionListItem {
  return {
    harness: "pi",
    agentType: "assistant",
    title: partial.id,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    ...partial,
  };
}

function apply(
  sessions: SessionListItem[],
  filters = DEFAULT_ATTENTION_FILTERS,
  limit = 20,
  currentId?: string,
  keepIds = new Set<string>(),
) {
  const inbox = buildSessionInbox(sessions, {
    settledLimit: Number.MAX_SAFE_INTEGER,
  });
  return filterAttentionInbox(
    inbox,
    filters,
    attentionProjectsBySession(sessions, null),
    limit,
    currentId,
    keepIds,
  );
}

describe("Attention filters and grouping", () => {
  it("normalizes stored preferences and excludes grouping from the filter count", () => {
    const filters = normalizeAttentionFilters({
      project: { kind: "project", projectId: " p " },
      statuses: ["working", "unknown", "working"],
      byProject: true,
    });
    expect(filters).toEqual({
      project: { kind: "project", projectId: "p" },
      statuses: ["working"],
      byProject: true,
    });
    expect(attentionFilterCount(filters)).toBe(2);
    expect(
      attentionFilterCount({ ...DEFAULT_ATTENTION_FILTERS, byProject: true }),
    ).toBe(0);
  });

  it("keeps Needs-you separate and filters statuses without mutating global counts", () => {
    const sessions = [
      session({ id: "waiting", attention: "approval" }),
      session({ id: "working", isStreaming: true }),
      session({ id: "idle" }),
    ];
    const inbox = buildSessionInbox(sessions);
    const view = filterAttentionInbox(
      inbox,
      { ...DEFAULT_ATTENTION_FILTERS, statuses: ["working"] },
      attentionProjectsBySession(sessions, null),
      20,
      undefined,
      new Set(),
    );
    expect(view.needsYou).toEqual([]);
    expect(view.active.map(inboxItemId)).toEqual(["working"]);
    expect(inbox.needsYou.map(inboxItemId)).toEqual(["waiting"]);
    expect(inbox.active).toHaveLength(2);
  });

  it("keeps a pending exit despite a changed status filter", () => {
    const view = apply(
      [session({ id: "leaving" })],
      { ...DEFAULT_ATTENTION_FILTERS, statuses: ["working"] },
      20,
      undefined,
      new Set(["leaving"]),
    );
    expect(view.active.map(inboxItemId)).toEqual(["leaving"]);
  });

  it("filters history before paging and includes a matching routed row beyond the page", () => {
    const sessions = [
      session({ id: "other", projectId: "q", settledAt: 50 }),
      session({ id: "first", projectId: "p", settledAt: 40 }),
      session({ id: "second", projectId: "p", settledAt: 30 }),
      session({ id: "routed", projectId: "p", settledAt: 20 }),
    ];
    const view = apply(
      sessions,
      {
        ...DEFAULT_ATTENTION_FILTERS,
        project: { kind: "project", projectId: "p" },
      },
      1,
      "routed",
    );
    expect(view.settled.map((row) => row.id)).toEqual(["first", "routed"]);
    expect(view.settledTotal).toBe(3);
    expect(view.settledHidden).toBe(1);
  });

  it("distinguishes archived from settled history and supports Unassigned", () => {
    const row = session({ id: "archived", archived: true });
    const projects = attentionProjectsBySession([row], null);
    const filters = {
      ...DEFAULT_ATTENTION_FILTERS,
      project: { kind: "unassigned" } as const,
      statuses: ["archived"] as const,
    };
    expect(
      attentionHistoryMatches(
        row,
        "archived",
        { ...filters, statuses: [...filters.statuses] },
        projects,
      ),
    ).toBe(true);
    expect(
      attentionHistoryMatches(
        row,
        "settled",
        { ...filters, statuses: [...filters.statuses] },
        projects,
      ),
    ).toBe(false);
  });

  it("groups in registry order, preserves within-Project order, and puts Unassigned last", () => {
    const rows = [
      { id: "b1", projectId: "b" },
      { id: "u", projectId: null },
      { id: "a1", projectId: "a" },
      { id: "unknown", projectId: "unknown" },
      { id: "b2", projectId: "b" },
    ];
    const groups = groupAttentionByProject(rows, (row) => row.projectId, [
      "a",
      "b",
    ]);
    expect(
      groups.map((group) => [
        group.projectId,
        group.items.map((row) => row.id),
      ]),
    ).toEqual([
      ["a", ["a1"]],
      ["b", ["b1", "b2"]],
      ["unknown", ["unknown"]],
      [null, ["u"]],
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "b1",
      "u",
      "a1",
      "unknown",
      "b2",
    ]);
  });
});
