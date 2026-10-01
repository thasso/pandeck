// @vitest-environment jsdom
/**
 * The background-work surfaces ([Task-486](pa://task/486)): the registry route,
 * the owning session's inspector section, the session card's separate chip, and
 * the Settings card.
 *   pnpm --filter @assistant/web test src/components/backgroundWorkUi.test.tsx
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  BackgroundWorkItemSummary,
  SessionArtifact,
  SessionBackgroundActivity,
  SessionListItem,
} from "@assistant/shared";
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  normalizeBackgroundWorkSettings,
} from "@assistant/shared";
import { ActiveSessionCard } from "./ActiveSessionCard.tsx";
import { BackgroundProcessesSettingsSection } from "./BackgroundProcessesSettingsSection.tsx";
import { BackgroundTasksPage } from "./BackgroundTasksPage.tsx";
import { BackgroundWorkSection } from "./BackgroundWorkSection.tsx";
import { BackgroundWorkLedge } from "./BackgroundWorkLedge.tsx";
import {
  classifySessionStatus,
  buildSessionInbox,
  tierForStatus,
  type SessionInboxCard,
  type SessionInboxItem,
} from "../lib/sessionInbox.ts";

const NOW = 1_800_000_000_000;

/** The session cards of a shaped list; the inbox also carries run items. */
function cards(items: SessionInboxItem[]): SessionInboxCard[] {
  return items.flatMap((item) => (item.kind === "session" ? [item.card] : []));
}

// The two surfaces own their ticker (`useElapsedNow`), so the clock is
// pinned here rather than passed in: a static render runs no effects, so the
// hook's initial `Date.now()` is the only reading that matters.
beforeAll(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterAll(() => {
  vi.restoreAllMocks();
});

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

function cardOf(row: SessionListItem): SessionInboxCard {
  const status = classifySessionStatus(row);
  return { session: row, status, tier: tierForStatus(status) };
}

function cardMarkup(row: SessionListItem): string {
  return renderToStaticMarkup(
    <ActiveSessionCard
      card={cardOf(row)}
      now={NOW}
      active={false}
      relations={{}}
      onOpen={() => {}}
      onSettle={() => {}}
      onRename={() => {}}
      onArchive={() => {}}
      onDelete={() => {}}
    />,
  );
}

function pageMarkup(
  items: BackgroundWorkItemSummary[],
  sessions: SessionListItem[] = [session({ id: "owner-a", title: "Builder" })],
  anchoredId?: string,
): string {
  return renderToStaticMarkup(
    <BackgroundTasksPage
      items={items}
      sessions={sessions}
      {...(anchoredId ? { anchoredId } : {})}
      stopPending={new Set<string>()}
      onStop={() => {}}
      onStopAllForOwner={() => {}}
      onOpenSession={() => {}}
    />,
  );
}

describe("the session card's background chip", () => {
  it("shows a distinct chip on an idle session and no Working spinner", () => {
    const markup = cardMarkup(
      session({ id: "owner-a", backgroundActivity: activity() }),
    );
    expect(markup).toContain("Background 2 · 8m");
    // The provider Working badge (with its spinner) belongs to a turn; this
    // session has none.
    expect(markup).not.toContain("Working");
    expect(markup).toContain("2 background processes running");
  });

  it("keeps a concurrent provider run and background work apart", () => {
    const markup = cardMarkup(
      session({
        id: "owner-a",
        isStreaming: true,
        runStartedAt: NOW - 12_000,
        backgroundActivity: activity(),
      }),
    );
    // Both are visible, and each keeps its own label.
    expect(markup).toContain("Working");
    expect(markup).not.toContain("Working 12s");
    expect(markup).toContain("Background 2 · 8m");
  });

  it("shows a retained host with no items left", () => {
    const markup = cardMarkup(
      session({
        id: "owner-a",
        backgroundActivity: activity({
          activeCount: 0,
          shellCount: 0,
          monitorCommandCount: 0,
          retainedHost: true,
        }),
      }),
    );
    expect(markup).toContain("Background host");
  });

  it("lifts an otherwise quiet card into the working tier without a status", () => {
    const view = buildSessionInbox([
      session({ id: "owner-a", backgroundActivity: activity() }),
      session({ id: "idle" }),
    ]);
    const busy = cards(view.active).find(
      (card) => card.session.id === "owner-a",
    );
    expect(busy?.tier).toBe("working");
    // The STATUS is untouched: nothing here fabricates a run.
    expect(busy?.status).toBe("quiet");
    expect(busy?.session.isStreaming).toBeUndefined();
    expect(
      cards(view.active).find((card) => card.session.id === "idle")?.tier,
    ).toBe("active");
  });

  it("blocks Settle while work is running, with the shared wording", () => {
    const view = buildSessionInbox([
      session({ id: "owner-a", backgroundActivity: activity() }),
    ]);
    expect(cards(view.active)[0]?.settleBlocked).toBe(
      "it still has 2 background processes running.",
    );
  });
});

describe("the registry route", () => {
  it("renders Claude and pi rows with their own backend and kind", () => {
    const markup = pageMarkup([
      item({ id: "pi-1" }),
      item({
        id: "claude-1",
        ownerSessionId: "owner-b",
        backend: "claude-query",
        kind: "monitor-websocket",
        label: "watch ws://build",
        host: { id: "h1", state: "live" },
      }),
    ]);
    expect(markup).toContain("PA process");
    expect(markup).toContain("Claude query");
    expect(markup).toContain("Shell");
    expect(markup).toContain("WebSocket monitor");
    expect(markup).toContain("Retained host: live");
  });

  it("shows the command under the title only when the title does not say it all", () => {
    const plain = pageMarkup([
      item({ id: "one-line", command: "pnpm run build" }),
    ]);
    // The title IS the command: printing it again under itself says nothing.
    expect(plain).toContain("pnpm run build");
    expect(plain).not.toContain("Show the whole command");
    const described = pageMarkup([
      item({
        id: "described",
        label: "Build the web bundle",
        description: "Build the web bundle",
        command: "cd app/web\npnpm run build",
        commandTruncated: true,
      }),
    ]);
    expect(described).toContain("Build the web bundle");
    // Collapsed: the first line, and the affordance that there is more.
    expect(described).toContain("cd app/web");
    expect(described).toContain('aria-expanded="false"');
    expect(described).toContain("Show the whole command");
  });

  it("stands alone on a direct reload: it needs only the topic rows", () => {
    // No session list at all — a cold direct load of /background-tasks has the
    // registry snapshot before it has anything else.
    const markup = pageMarkup([item({ id: "a" })], []);
    expect(markup).toContain("pnpm run build");
    expect(markup).toContain("Open owning session");
    expect(markup).toContain("1 running");
  });

  it("bounds the page and offers the rest rather than dropping it", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ id: `i${i}`, updatedAt: NOW - i * 1_000 }),
    );
    const markup = pageMarkup(many);
    expect(markup).toContain("Show 5 more");
    expect(markup).toContain("30 running");
  });

  it("offers Stop-all only for owners with work still running", () => {
    const live = pageMarkup([item({ id: "a" })]);
    expect(live).toContain("Stop all in Builder");
    const done = pageMarkup([
      item({ id: "a", state: "completed", terminalAt: NOW - 1_000 }),
    ]);
    expect(done).not.toContain("Stop all in");
  });

  it("keeps Stop available when new admissions are disabled", () => {
    // Admission state is a server decision about NEW work; it never removes a
    // control over work that is already running.
    const markup = pageMarkup([item({ id: "a" })]);
    expect(markup).toContain("Stop pnpm run build");
    expect(markup).not.toContain('disabled=""');
  });

  it("shows no raw path, vendor id or OS id", () => {
    const markup = pageMarkup(
      [
        item({
          id: "a",
          state: "completed",
          terminalAt: NOW - 1_000,
          exitCode: 0,
          evidence: {
            artifactId: "art_7f3",
            capturedBytes: 2_048,
            originalBytes: 2_048,
          },
        }),
      ],
      [session({ id: "owner-a", title: "Builder" })],
      "a",
    );
    expect(markup).not.toContain("art_7f3");
    expect(markup).not.toContain("/tmp/");
    expect(markup).not.toContain("session-artifacts");
    expect(markup).toContain("Output captured");
  });

  it("anchors a linked item so it is visible even after it finished", () => {
    const markup = pageMarkup(
      [item({ id: "done", state: "completed", terminalAt: NOW - 1_000 })],
      [session({ id: "owner-a", title: "Builder" })],
      "done",
    );
    expect(markup).toContain('data-background-item="done"');
  });

  it("offers its filters as a keyboard-reachable tablist with a search field", () => {
    const markup = pageMarkup([item({ id: "a" })]);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Filter background work"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain("Search background work");
  });

  it("carries a phone back control to the screen it came from", () => {
    const markup = renderToStaticMarkup(
      <BackgroundTasksPage
        items={[item({ id: "a" })]}
        sessions={[]}
        stopPending={new Set<string>()}
        onStop={() => {}}
        onStopAllForOwner={() => {}}
        onOpenSession={() => {}}
        back={{ label: "Sessions", onClick: () => {} }}
      />,
    );
    expect(markup).toContain('aria-label="Back to Sessions"');
  });

  it("gives every row a list id so a phone restores its reading position", () => {
    const markup = pageMarkup([item({ id: "a" }), item({ id: "b" })]);
    expect(markup).toContain('data-list-row-id="a"');
    expect(markup).toContain('data-list-row-id="b"');
  });
});

describe("the session inspector section", () => {
  function sectionMarkup(
    items: BackgroundWorkItemSummary[],
    over: {
      activity?: SessionBackgroundActivity;
      protectedTurnWait?: boolean;
      artifacts?: SessionArtifact[];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <BackgroundWorkSection
        sessionId="owner-a"
        items={items}
        {...(over.activity ? { activity: over.activity } : {})}
        {...(over.artifacts ? { artifacts: over.artifacts } : {})}
        stopPending={new Set<string>()}
        onStop={() => {}}
        onStopAll={() => {}}
        onOpenRegistry={() => {}}
        {...(over.protectedTurnWait ? { protectedTurnWait: true } : {})}
      />,
    );
  }

  it("shows active work with kind, backend, age, deadline and Stop", () => {
    const markup = sectionMarkup([item({ id: "a" })], {
      activity: activity(),
    });
    expect(markup).toContain("Background work");
    expect(markup).toContain("Shell");
    expect(markup).toContain("PA process");
    expect(markup).toContain("10m");
    expect(markup).toContain("30m left");
    expect(markup).toContain("Stop pnpm run build");
  });

  it("shows recent work and its completion facts", () => {
    const markup = sectionMarkup(
      [
        item({
          id: "done",
          state: "failed",
          terminalAt: NOW - 30_000,
          exitCode: 2,
          terminalReason: "the command exited non-zero",
        }),
      ],
      {
        activity: activity({
          activeCount: 0,
          shellCount: 0,
          monitorCommandCount: 0,
          retainedHost: true,
        }),
      },
    );
    expect(markup).toContain("Recent");
    expect(markup).toContain("Failed");
    expect(markup).toContain("the command exited non-zero");
  });

  it("states the shared Settle/delete blocker and points at the registry", () => {
    const markup = sectionMarkup([item({ id: "a" })], {
      activity: activity(),
    });
    expect(markup).toContain("it still has 2 background processes running.");
    expect(markup).toContain("Settling and deleting this session are blocked");
    expect(markup).toContain("Open the background registry");
  });

  it("links retained output through the authenticated artifact API only", () => {
    const evidence = {
      artifactId: "art_7f3",
      capturedBytes: 65_536,
      originalBytes: 262_144,
      truncated: true,
      text: true,
    };
    const finished = item({
      id: "done",
      state: "completed",
      terminalAt: NOW - 1_000,
      evidence,
    });
    // Without the owning session's drawer there is no URL to give, and the id
    // is never rendered as a substitute.
    const unresolved = sectionMarkup([finished]);
    expect(unresolved).toContain("64 KB of 256 KB (truncated)");
    expect(unresolved).not.toContain("Open captured output");
    expect(unresolved).not.toContain("art_7f3");

    const resolved = sectionMarkup([finished], {
      artifacts: [
        {
          id: "art_7f3",
          sessionId: "owner-a",
          kind: "file",
          label: "build log",
          name: "build.log",
          mimeType: "text/plain",
          size: 65_536,
          createdAt: NOW - 1_000,
          url: "/api/session-artifacts/owner-a/tool-output/bg/build.log",
        },
      ],
    });
    // Read inline on demand (closed at rest, so nothing is fetched), with the
    // file itself always one link away through the authenticated artifact API.
    expect(resolved).toContain("Output · 64 KB · truncated");
    expect(resolved).toContain("Open the captured output file");
    expect(resolved).toContain("/api/session-artifacts/owner-a/");
    expect(resolved).not.toContain("Loading output");
    // The link is the ONLY way to the body: no content is inlined.
    expect(resolved).not.toContain("art_7f3&quot;");
  });

  it("shows a refusal's bounded reason and offers no link at all", () => {
    const markup = sectionMarkup([
      item({
        id: "refused",
        state: "completed",
        terminalAt: NOW - 1_000,
        evidence: { refusalReason: "output was not valid UTF-8 text" },
      }),
    ]);
    expect(markup).toContain("output was not valid UTF-8 text");
    expect(markup).not.toContain("Open captured output");
  });

  it("shows the protected-turn wait instead of claiming the host closed", () => {
    const markup = sectionMarkup([item({ id: "a" })], {
      activity: activity(),
      protectedTurnWait: true,
    });
    expect(markup).toContain("Stop-all is waiting");
    expect(markup).toContain("Your turn is never");
  });

  it("shows Recent on a cold load whose history is entirely terminal", () => {
    // No `activity` at all — the session owns nothing nonterminal, which is
    // exactly what a cold direct load of finished work looks like. The section
    // must still render its history rather than claiming the session never had
    // any (`backgroundInspectorSubscribes` is what gets the rows here).
    const markup = sectionMarkup([
      item({
        id: "old-1",
        state: "completed",
        terminalAt: NOW - 3_600_000,
        exitCode: 0,
      }),
      item({
        id: "old-2",
        state: "stopped",
        terminalAt: NOW - 7_200_000,
        terminalReason: "stopped-by-owner",
      }),
    ]);
    expect(markup).toContain("Recent");
    expect(markup).toContain("Completed");
    expect(markup).toContain("Stopped");
    // And it is honest about the present: nothing is running.
    expect(markup).toContain("Nothing is running right now.");
  });

  it("renders nothing for a session that owns no background work", () => {
    expect(sectionMarkup([])).toBe("");
  });
});

describe("the composer's background ledge", () => {
  function ledgeMarkup(
    items: BackgroundWorkItemSummary[],
    over: { open?: boolean; activity?: SessionBackgroundActivity } = {},
  ): string {
    return renderToStaticMarkup(
      <BackgroundWorkLedge
        sessionId="owner-a"
        activity={over.activity ?? activity()}
        items={items}
        open={over.open ?? false}
        onToggle={() => {}}
        stopPending={new Set<string>()}
        onStop={() => {}}
        onStopAll={() => {}}
        onOpenRegistry={() => {}}
      />,
    );
  }

  it("rests as one line that counts this session's work and subscribes nothing", () => {
    const markup = ledgeMarkup([]);
    expect(markup).toContain("2 background processes running");
    expect(markup).toContain("8m");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Stop all");
  });

  it("opens into this session's active rows with Stop, Stop-all and a registry link", () => {
    const markup = ledgeMarkup(
      [
        item({ id: "mine", command: "pnpm dev", label: "pnpm dev" }),
        item({ id: "theirs", ownerSessionId: "owner-b", label: "not mine" }),
        item({ id: "done", state: "completed", terminalAt: NOW - 1_000 }),
      ],
      { open: true },
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Stop pnpm dev");
    expect(markup).not.toContain("not mine");
    expect(markup).toContain("Open in the background registry");
    expect(markup).toContain("Stop all background work in this session");
    // A finished row is history, and history lives elsewhere.
    expect(markup.match(/data-background-item=/g)?.length).toBe(1);
  });

  it("says the rows are on their way while the topic has not answered yet", () => {
    expect(ledgeMarkup([], { open: true })).toContain("Loading the rows");
  });

  it("names a retained host with nothing running", () => {
    expect(
      ledgeMarkup([], {
        open: true,
        activity: activity({ activeCount: 0, retainedHost: true }),
      }),
    ).toContain("retained background host");
  });
});

describe("the Background processes settings card", () => {
  function settingsMarkup(
    over: Partial<AppSettings["backgroundWork"]> = {},
  ): string {
    const settings = {
      backgroundWork: normalizeBackgroundWorkSettings({
        ...DEFAULT_BACKGROUND_WORK_SETTINGS,
        ...over,
      }),
    } as AppSettings;
    return renderToStaticMarkup(
      <BackgroundProcessesSettingsSection
        settings={settings}
        onUpdate={() => {}}
      />,
    );
  }

  it("offers exactly the shared ranges and defaults", () => {
    const markup = settingsMarkup();
    const ranges = BACKGROUND_WORK_SETTINGS_RANGES;
    expect(markup).toContain(`min="${ranges.ownerSessionCap.min}"`);
    expect(markup).toContain(`max="${ranges.ownerSessionCap.max}"`);
    expect(markup).toContain(`min="${ranges.taskLifetimeMinutes.min}"`);
    expect(markup).toContain(`max="${ranges.taskLifetimeMinutes.max}"`);
    expect(markup).toContain(`min="${ranges.claudeEmptyHostGraceSeconds.min}"`);
    expect(markup).toContain(`max="${ranges.claudeEmptyHostGraceSeconds.max}"`);
    expect(markup).toContain("the default is 7");
    expect(markup).toContain("the default is 60");
    expect(markup).toContain("the default is 30");
  });

  it("clamps a stored value at either end of its range", () => {
    const low = settingsMarkup({
      ownerSessionCap: 0,
      taskLifetimeMinutes: 1,
      claudeEmptyHostGraceSeconds: -10,
    });
    expect(low).toContain('value="1"');
    expect(low).toContain('value="5"');
    expect(low).toContain('value="0"');
    const high = settingsMarkup({
      ownerSessionCap: 99,
      taskLifetimeMinutes: 99_999,
      claudeEmptyHostGraceSeconds: 9_999,
    });
    expect(high).toContain('value="20"');
    expect(high).toContain('value="1440"');
    expect(high).toContain('value="300"');
  });

  it("states the frozen-value, PA-enforced and no-resume facts", () => {
    const markup = settingsMarkup();
    expect(markup).toContain("disabling is not a kill switch");
    expect(markup).toContain("never evicts an owner that already holds a slot");
    expect(markup).toContain("moves no existing deadline");
    expect(markup).toContain("BEFORE Claude runs a background tool");
    expect(markup).toContain("not a setting on your Claude account");
    expect(markup).toContain("Nothing resumes after a server restart");
    expect(markup).toContain("governs later admissions only");
  });
});
