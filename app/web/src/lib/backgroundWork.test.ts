/**
 * The background-work projections ([Task-486](pa://task/486)): what the registry
 * route and the session inspector show, and what a session card's chip says.
 *   pnpm --filter @assistant/web test src/lib/backgroundWork.test.ts
 */
import { describe, expect, it } from "vitest";
import type {
  BackgroundWorkItemSummary,
  SessionBackgroundActivity,
  SessionListItem,
} from "@assistant/shared";
import {
  backgroundActivityChip,
  backgroundActivityKey,
  backgroundActivityText,
  backgroundWorkAgeLabel,
  backgroundWorkBackendLabel,
  backgroundWorkCommandDetail,
  backgroundWorkDeadlineLabel,
  backgroundWorkEvidenceFacts,
  backgroundWorkHostLabel,
  backgroundWorkKindLabel,
  backgroundWorkOutcomeDetail,
  backgroundWorkListView,
  backgroundWorkRowKey,
  backgroundWorkStateBadge,
  backgroundWorkStopDisabledReason,
  globalBackgroundActivity,
  isActiveBackgroundWork,
  BACKGROUND_WORK_PAGE_SIZE,
} from "./backgroundWork.ts";

const NOW = 1_800_000_000_000;

function item(
  partial: Partial<BackgroundWorkItemSummary> & { id: string },
): BackgroundWorkItemSummary {
  return {
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    state: "running",
    stopState: "none",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    startedAt: NOW - 600_000,
    deadlineAt: NOW + 1_800_000,
    settingsGeneration: 7,
    ...partial,
  };
}

function activity(
  partial: Partial<SessionBackgroundActivity> = {},
): SessionBackgroundActivity {
  return {
    activeCount: 2,
    shellCount: 1,
    monitorCommandCount: 1,
    monitorWebsocketCount: 0,
    startingCount: 0,
    stoppingCount: 0,
    oldestStartedAt: NOW - 480_000,
    ...partial,
  };
}

function session(
  partial: Partial<SessionListItem> & { id: string },
): SessionListItem {
  return {
    harness: "pi",
    agentType: "assistant",
    title: partial.id,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    ...partial,
  } as SessionListItem;
}

describe("state and activity classification", () => {
  it("treats reserved-but-not-executing work as active", () => {
    expect(
      isActiveBackgroundWork(item({ id: "a", state: "pending-launch" })),
    ).toBe(true);
    expect(isActiveBackgroundWork(item({ id: "b", state: "running" }))).toBe(
      true,
    );
    for (const state of [
      "completed",
      "failed",
      "not-started",
      "stopped",
      "lost",
    ] as const)
      expect(isActiveBackgroundWork(item({ id: state, state }))).toBe(false);
  });

  it("never draws an unconfirmed Stop as a finished row", () => {
    const requested = item({ id: "a", stopState: "requested" });
    expect(backgroundWorkStateBadge(requested)).toEqual({
      label: "Stopping",
      tone: "warning",
    });
    const unconfirmed = item({
      id: "b",
      stopState: "unconfirmed",
      stopAttempts: 2,
    });
    expect(backgroundWorkStateBadge(unconfirmed)).toEqual({
      label: "Stop unconfirmed",
      tone: "warning",
    });
    // Still active, so Stop stays offered — the row is not terminal.
    expect(backgroundWorkStopDisabledReason(unconfirmed)).toBeUndefined();
  });

  it("labels each terminal state with its own outcome", () => {
    expect(
      backgroundWorkStateBadge(item({ id: "a", state: "completed" })),
    ).toEqual({ label: "Completed", tone: "success" });
    expect(backgroundWorkStateBadge(item({ id: "b", state: "lost" }))).toEqual({
      label: "Lost",
      tone: "danger",
    });
    expect(
      backgroundWorkStopDisabledReason(item({ id: "c", state: "stopped" })),
    ).toBe("This work has already finished.");
  });

  it("states both backends and every kind", () => {
    expect(backgroundWorkBackendLabel(item({ id: "a" }))).toBe("PA process");
    expect(
      backgroundWorkBackendLabel(item({ id: "b", backend: "claude-query" })),
    ).toBe("Claude query");
    expect(backgroundWorkKindLabel(item({ id: "c", kind: "shell" }))).toBe(
      "Shell",
    );
    expect(
      backgroundWorkKindLabel(item({ id: "d", kind: "monitor-command" })),
    ).toBe("Command monitor");
    expect(
      backgroundWorkKindLabel(item({ id: "e", kind: "monitor-websocket" })),
    ).toBe("WebSocket monitor");
    expect(
      backgroundWorkKindLabel(
        item({ id: "f", kind: "shell", intent: "service" }),
      ),
    ).toBe("Shell · service");
  });
});

describe("the outcome under the title", () => {
  it("keeps a summary that says something the title does not", () => {
    expect(
      backgroundWorkOutcomeDetail({
        label: "Run the gate",
        outcomeSummary: "Exited with code 2",
      }),
    ).toBe("Exited with code 2");
  });

  it("drops the job's own title off the front of the summary", () => {
    expect(
      backgroundWorkOutcomeDetail({
        label: "Sleep 30 seconds",
        outcomeSummary: "Sleep 30 seconds · Claude reported separate output.",
      }),
    ).toBe("Claude reported separate output.");
  });

  it("stays silent about a clean exit the success mark already showed", () => {
    expect(
      backgroundWorkOutcomeDetail({
        label: "Build web bundle",
        status: "completed",
        outcomeSummary: "Exited with code 0",
      }),
    ).toBeUndefined();
    expect(
      backgroundWorkOutcomeDetail({
        label: "Build web bundle",
        status: "completed",
        outcomeSummary: "Exited with code 0 · 12 output byte(s) dropped",
      }),
    ).toBe("Exited with code 0 · 12 output byte(s) dropped");
  });

  it("keeps that sentence on a status the success mark never claimed", () => {
    // Only a PA-supervised process derives `completed` FROM exit 0. A Claude
    // task reports a provider status, so a failed one keeps every word it has.
    for (const status of ["failed", "stopped", "lost", "activity"]) {
      expect(
        backgroundWorkOutcomeDetail({
          label: "Build web bundle",
          status,
          outcomeSummary: "Exited with code 0",
        }),
      ).toBe("Exited with code 0");
    }
  });

  it("does not mistake a lexical prefix for a repeated title", () => {
    expect(
      backgroundWorkOutcomeDetail({
        label: "Test",
        outcomeSummary: "Tests failed",
      }),
    ).toBe("Tests failed");
  });

  it("has nothing to say when the summary IS the title", () => {
    expect(
      backgroundWorkOutcomeDetail({
        label: "Sleep 30 seconds",
        outcomeSummary: "Sleep 30 seconds",
      }),
    ).toBeUndefined();
    expect(
      backgroundWorkOutcomeDetail({ label: "Sleep 30 seconds" }),
    ).toBeUndefined();
  });
});

describe("the command under the title", () => {
  it("is omitted when the title already is the whole one-line command", () => {
    expect(
      backgroundWorkCommandDetail({ label: "pnpm test", command: "pnpm test" }),
    ).toBeUndefined();
    expect(backgroundWorkCommandDetail({ label: "Shell" })).toBeUndefined();
  });

  it("is shown under a description, for a multi-line script, and when cut", () => {
    expect(
      backgroundWorkCommandDetail({
        label: "Start dev server",
        description: "Start dev server",
        command: "pnpm dev",
      }),
    ).toBe("pnpm dev");
    expect(
      backgroundWorkCommandDetail({
        label: "cd app",
        command: "cd app\npnpm build",
      }),
    ).toBe("cd app\npnpm build");
    expect(
      backgroundWorkCommandDetail({
        label: "pnpm test",
        command: "pnpm test",
        commandTruncated: true,
      }),
    ).toBe("pnpm test");
  });

  it("is part of the row's content key and of the search", () => {
    const plain = item({ id: "a" });
    const withCommand = item({ id: "a", command: "pnpm dev" });
    expect(backgroundWorkRowKey(plain, NOW)).not.toBe(
      backgroundWorkRowKey(withCommand, NOW),
    );
    expect(
      backgroundWorkListView([withCommand, plain], {
        filter: "all",
        query: "pnpm dev",
      }).rows.map((row) => row.id),
    ).toEqual(["a"]);
  });
});

describe("age and the frozen deadline", () => {
  it("counts a running item forward and a terminal one to where it stopped", () => {
    expect(backgroundWorkAgeLabel(item({ id: "a" }), NOW)).toBe("10m");
    const done = item({
      id: "b",
      state: "completed",
      startedAt: NOW - 600_000,
      terminalAt: NOW - 300_000,
    });
    expect(backgroundWorkAgeLabel(done, NOW)).toBe("5m");
    expect(backgroundWorkDeadlineLabel(done, NOW)).toBe("—");
  });

  it("says a passed deadline is overdue rather than claiming it terminalized", () => {
    const overdue = item({ id: "a", deadlineAt: NOW - 120_000 });
    expect(backgroundWorkDeadlineLabel(overdue, NOW)).toBe("overdue by 2m");
    expect(isActiveBackgroundWork(overdue)).toBe(true);
    expect(backgroundWorkDeadlineLabel(item({ id: "b" }), NOW)).toBe(
      "30m left",
    );
  });
});

describe("the retained host epoch", () => {
  it("shows a Stop-all it could not complete as a wait, not a close", () => {
    const waiting = item({
      id: "a",
      backend: "claude-query",
      host: { id: "h1", state: "live", stopAllRequestedAt: NOW - 5_000 },
    });
    expect(backgroundWorkHostLabel(waiting)).toBe("Retained host: closing");
    expect(
      backgroundWorkHostLabel(
        item({ id: "b", host: { id: "h1", state: "live" } }),
      ),
    ).toBe("Retained host: live");
    expect(backgroundWorkHostLabel(item({ id: "c" }))).toBeUndefined();
  });
});

describe("evidence", () => {
  it("shows bounded capture metadata and never an artifact id or a path", () => {
    const facts = backgroundWorkEvidenceFacts(
      item({
        id: "a",
        state: "completed",
        exitCode: 0,
        terminalAt: NOW,
        outcomeSummary: "build ok",
        evidence: {
          artifactId: "art_secret",
          capturedBytes: 65_536,
          originalBytes: 4_194_304,
          truncated: true,
          text: true,
        },
      }),
    );
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("art_secret");
    expect(facts).toContainEqual({
      label: "Output captured",
      value: "64 KB of 4.0 MB (truncated)",
    });
    expect(facts).toContainEqual({ label: "Exit code", value: "0" });
  });

  it("states a refusal's bounded reason and no content", () => {
    const facts = backgroundWorkEvidenceFacts(
      item({
        id: "a",
        state: "completed",
        terminalAt: NOW,
        evidence: {
          refusalReason: "output was not valid UTF-8 text",
          capturedBytes: 12,
        },
      }),
    );
    expect(facts).toContainEqual({
      label: "Output not captured",
      value: "output was not valid UTF-8 text",
    });
    expect(facts.some((fact) => fact.label === "Output captured")).toBe(false);
  });
});

describe("the registry list view", () => {
  const rows = [
    item({ id: "run-old", updatedAt: NOW - 600_000 }),
    item({ id: "run-new", updatedAt: NOW - 10_000 }),
    item({
      id: "done",
      state: "completed",
      terminalAt: NOW - 5_000,
      updatedAt: NOW - 5_000,
    }),
    item({
      id: "other-owner",
      ownerSessionId: "owner-b",
      label: "tail -f server log",
      kind: "monitor-command",
      backend: "claude-query",
    }),
  ];

  it("splits active from recent and sorts active first, newest first", () => {
    const all = backgroundWorkListView(rows, { filter: "all" });
    expect(all.rows.map((row) => row.id)).toEqual([
      "run-new",
      "other-owner",
      "run-old",
      "done",
    ]);
    expect(all.activeTotal).toBe(3);
    expect(
      backgroundWorkListView(rows, { filter: "recent" }).rows,
    ).toHaveLength(1);
  });

  it("pages without ever losing a running row off the end", () => {
    const many = Array.from({ length: BACKGROUND_WORK_PAGE_SIZE + 5 }, (_, i) =>
      item({ id: `i${i}`, updatedAt: NOW - i * 1_000 }),
    );
    const page = backgroundWorkListView(many, { filter: "active" });
    expect(page.rows).toHaveLength(BACKGROUND_WORK_PAGE_SIZE);
    expect(page.hidden).toBe(5);
    expect(page.total).toBe(BACKGROUND_WORK_PAGE_SIZE + 5);
    const wider = backgroundWorkListView(many, {
      filter: "active",
      limit: BACKGROUND_WORK_PAGE_SIZE * 2,
    });
    expect(wider.rows).toHaveLength(BACKGROUND_WORK_PAGE_SIZE + 5);
    expect(wider.hidden).toBe(0);
  });

  it("keeps a pinned row on the page the cutoff would have hidden it from", () => {
    // The must-fix case: 30 active rows plus the terminal row a deep link
    // named. Without the pin the target sorts to position 31 and is simply
    // absent from a direct reload's first page.
    const many = [
      ...Array.from({ length: 30 }, (_, i) =>
        item({ id: `i${i}`, updatedAt: NOW - i * 1_000 }),
      ),
      item({
        id: "linked",
        state: "completed",
        terminalAt: NOW - 900_000,
        updatedAt: NOW - 900_000,
      }),
    ];
    const unpinned = backgroundWorkListView(many, { filter: "all" });
    expect(unpinned.rows.some((row) => row.id === "linked")).toBe(false);
    expect(unpinned.pinnedOutOfPage).toBe(false);

    const pinned = backgroundWorkListView(many, {
      filter: "all",
      pinnedId: "linked",
    });
    expect(pinned.rows.some((row) => row.id === "linked")).toBe(true);
    expect(pinned.pinnedOutOfPage).toBe(true);
    // Appended, not reordered: the reader's list does not jump around it.
    expect(pinned.rows.at(-1)?.id).toBe("linked");
    expect(pinned.total).toBe(31);
    // It is on screen, so "show more" must not offer it again.
    expect(pinned.hidden).toBe(unpinned.hidden - 1);
  });

  it("does not duplicate a pinned row that was already on the page", () => {
    const view = backgroundWorkListView(rows, {
      filter: "all",
      pinnedId: "run-new",
    });
    expect(view.rows.filter((row) => row.id === "run-new")).toHaveLength(1);
    expect(view.pinnedOutOfPage).toBe(false);
  });

  it("ignores a pinned id the registry does not hold", () => {
    const view = backgroundWorkListView(rows, {
      filter: "all",
      pinnedId: "no-such-row",
    });
    expect(view.pinnedOutOfPage).toBe(false);
    expect(view.rows).toHaveLength(4);
  });

  it("matches the label and the owning session's title", () => {
    const titles = new Map([["owner-b", "Deploy watch"]]);
    expect(
      backgroundWorkListView(rows, {
        filter: "all",
        query: "tail",
      }).rows.map((row) => row.id),
    ).toEqual(["other-owner"]);
    expect(
      backgroundWorkListView(rows, {
        filter: "all",
        query: "deploy",
        ownerTitles: titles,
      }).rows.map((row) => row.id),
    ).toEqual(["other-owner"]);
  });

  it("scopes to one owner for the inspector", () => {
    const view = backgroundWorkListView(rows, {
      filter: "all",
      ownerSessionId: "owner-b",
    });
    expect(view.total).toBe(1);
    expect(view.rows[0]?.id).toBe("other-owner");
  });
});

describe("the session card's chip", () => {
  it("names the count and the age of the oldest active item", () => {
    expect(backgroundActivityChip(activity(), NOW)).toBe("Background 2 · 8m");
    expect(backgroundActivityText(activity())).toBe(
      "2 background processes running",
    );
  });

  it("still shows a retained host with no items left", () => {
    const held = activity({
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      retainedHost: true,
    });
    expect(backgroundActivityChip(held, NOW)).toBe("Background host");
    expect(backgroundActivityText(held)).toBe(
      "Holds a retained background host",
    );
  });

  it("is absent when nothing is owned", () => {
    expect(backgroundActivityChip(undefined, NOW)).toBeUndefined();
    expect(
      backgroundActivityChip(
        activity({ activeCount: 0, shellCount: 0, monitorCommandCount: 0 }),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("names starting and stopping work for assistive technology", () => {
    expect(
      backgroundActivityText(activity({ startingCount: 1, stoppingCount: 1 })),
    ).toBe("2 background processes running, 1 starting, 1 stopping");
  });

  it("says which of the running processes are services", () => {
    expect(backgroundActivityText(activity({ serviceCount: 1 }))).toBe(
      "2 background processes running, 1 of them service",
    );
    expect(
      backgroundActivityText(
        activity({
          activeCount: 1,
          shellCount: 1,
          monitorCommandCount: 0,
          serviceCount: 1,
        }),
      ),
    ).toBe("1 background process running, a service");
  });

  it("keys on the rendered chip, so a tick that changes nothing is stable", () => {
    const card = activity();
    expect(backgroundActivityKey(card, NOW)).toBe(
      backgroundActivityKey(card, NOW + 900),
    );
    expect(backgroundActivityKey(card, NOW)).not.toBe(
      backgroundActivityKey(card, NOW + 120_000),
    );
    expect(backgroundActivityKey(undefined, NOW)).toBe("");
  });
});

describe("the global active count", () => {
  it("adds up session summaries without reading the registry", () => {
    const sessions = [
      session({ id: "a", backgroundActivity: activity() }),
      session({
        id: "b",
        backgroundActivity: activity({
          activeCount: 1,
          shellCount: 1,
          monitorCommandCount: 0,
        }),
      }),
      session({
        id: "c",
        backgroundActivity: activity({
          activeCount: 0,
          shellCount: 0,
          monitorCommandCount: 0,
          retainedHost: true,
        }),
      }),
      session({ id: "d" }),
    ];
    expect(globalBackgroundActivity(sessions)).toEqual({
      activeCount: 3,
      ownerCount: 3,
    });
    expect(globalBackgroundActivity([])).toEqual({
      activeCount: 0,
      ownerCount: 0,
    });
  });
});

describe("the row's content key", () => {
  it("moves when a rendered fact moves and holds still otherwise", () => {
    // Both rendered durations sit clear of a minute boundary, so half a second
    // changes no character on the row.
    const row = item({
      id: "a",
      startedAt: NOW - 615_000,
      deadlineAt: NOW + 1_845_000,
    });
    expect(backgroundWorkRowKey(row, NOW)).toBe(
      backgroundWorkRowKey(row, NOW + 500),
    );
    expect(backgroundWorkRowKey(row, NOW)).not.toBe(
      backgroundWorkRowKey(row, NOW + 120_000),
    );
    expect(backgroundWorkRowKey(row, NOW)).not.toBe(
      backgroundWorkRowKey({ ...row, stopState: "requested" }, NOW),
    );
    expect(backgroundWorkRowKey(row, NOW)).not.toBe(
      backgroundWorkRowKey({ ...row, host: { id: "h", state: "live" } }, NOW),
    );
  });

  it("cannot be forged by free text in a label", () => {
    const a = item({ id: "x", label: "build", ownerSessionId: "owner-a" });
    const b = item({ id: "x", label: "build owner-a", ownerSessionId: "" });
    expect(backgroundWorkRowKey(a, NOW)).not.toBe(backgroundWorkRowKey(b, NOW));
  });
});
