// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { ActiveSessionCard } from "./ActiveSessionCard.tsx";
import {
  classifySessionStatus,
  tierForStatus,
  type SessionCardRelations,
  type SessionInboxCard,
} from "../lib/sessionInbox.ts";

const NOW = 1_800_000_000_000;

function card(
  partial: Partial<SessionListItem> & { id: string },
): SessionInboxCard {
  const session = {
    harness: "pi",
    agentType: "assistant",
    title: partial.id,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    ...partial,
  } as SessionListItem;
  const status = classifySessionStatus(session);
  return { session, status, tier: tierForStatus(status) };
}

function markup(
  partial: Partial<SessionListItem> & { id: string },
  density: "tight" | "comfortable" = "tight",
  extraRelations: SessionCardRelations = {},
): string {
  return renderToStaticMarkup(
    <ActiveSessionCard
      card={card(partial)}
      now={NOW}
      active={false}
      relations={{
        projectId: "pa",
        projectKey: "PA",
        worktreeBranch: "feature/x",
        taskId: "338",
        taskTitle: "Scrolling",
        ...extraRelations,
      }}
      worktreeDirty={false}
      density={density}
      onOpen={() => {}}
      onSettle={() => {}}
      onRename={() => {}}
      onArchive={() => {}}
      onDelete={() => {}}
      onOpenProject={() => {}}
      onOpenTask={() => {}}
      onOpenWorktree={() => {}}
    />,
  );
}

/**
 * An idle card is the one that gets rendered ~30 times in a scrolling sidebar,
 * so what it does NOT emit is the point (Task-338). These are assertions about
 * the markup rather than about compositing: the 3D properties and the second
 * face arrive with the turn.
 */
describe("ActiveSessionCard at rest", () => {
  it("carries no 3D rendering context until the card is turned", () => {
    const idle = markup({ id: "a" });
    expect(idle).not.toContain("perspective:900px");
    expect(idle).not.toContain("transform-style:preserve-3d");
    expect(idle).not.toContain("backface-visibility:hidden");
  });

  it("does not render the actions face until the card is turned", () => {
    const idle = markup({ id: "a" });
    expect(idle).not.toContain("Actions for");
    expect(idle).not.toContain("Close session actions");
    // The front's own controls are always there — nothing here is hover-only.
    expect(idle).toContain("Session actions");
    expect(idle).toContain("Settle");
  });

  it("stays at the resting element count, without the face's share", () => {
    // Measured: 47 elements at rest, 82 with the face mounted — the five action
    // tiles and the close gutter are 35 of them, 43% of the card's DOM, on
    // every idle row in the sidebar. A guard rail, not a benchmark: the ceiling
    // is well under the with-face count, so it fails if the face comes back to
    // rest and tolerates ordinary edits to the front.
    const elements = (html: string) => (html.match(/<[a-z]/g) ?? []).length;
    expect(elements(markup({ id: "a" }))).toBeLessThan(60);
  });
});

describe("ActiveSessionCard lines", () => {
  it("keeps a quiet session's permanent status line and states its age", () => {
    const quiet = markup({ id: "a" });
    expect(quiet).not.toContain("Waiting for your next prompt");
    expect(quiet).not.toContain("rounded-full");
    expect(quiet).toContain("min-h-5");
    expect(quiet).toContain(">1m</span>");
    // The spoken label still states a status.
    expect(quiet).toContain("— Idle");
  });

  it("keeps every live signal on the permanent middle line", () => {
    expect(markup({ id: "a", queuedWork: true })).toContain(
      "Queued work is waiting to run",
    );
    expect(markup({ id: "a", unread: true })).toContain("Unread response");
    const working = markup({ id: "a", isStreaming: true });
    expect(working).toContain("Working");
    expect(working).not.toMatch(/Working \d/);
    expect(
      markup({ id: "a", lastError: { at: NOW - 1_000, message: "boom" } }),
    ).toContain("boom");
  });

  it("keeps worktree and Task actions off the front face", () => {
    const html = markup({ id: "a", worktreeId: "wt" });
    expect(html).not.toContain('aria-label="Open worktree"');
    expect(html).not.toContain('aria-label="Open Scrolling"');
    expect(html).not.toContain('title="Open feature/x"');
    // The branch is the one context item that shortens instead of dropping.
    expect(html).toContain(
      '<span class="flex min-w-0 items-center gap-1 max-w-max flex-1 basis-0" title="feature/x"',
    );
    expect(html).toContain(
      '<span class="flex min-w-0 items-center gap-1 shrink-0" title="Scrolling"',
    );
    // The Project has no back-face action, so its item stays the front target.
    expect(html).toContain('title="Open PA"');
  });
});

describe("ActiveSessionCard density", () => {
  it("grows the inline Settle and actions targets on a phone", () => {
    const tight = markup({ id: "a", worktreeId: "wt" });
    const comfortable = markup({ id: "a", worktreeId: "wt" }, "comfortable");
    expect(tight).toContain("size-6");
    expect(tight).not.toContain("size-8");
    expect(comfortable).toContain("size-8");
    expect(comfortable).not.toContain("size-6");
  });
});

describe("ActiveSessionCard delivery", () => {
  it("says nothing about a pull request for a session with no card", () => {
    expect(markup({ id: "a" })).not.toContain("pull request");
  });

  it("states the card's state and names it in the card's own label", () => {
    const html = markup({
      id: "a",
      pullRequest: {
        status: "open",
        number: 12,
        ci: { state: "failure", total: 3 },
      },
    });
    expect(html).toContain("CI failed");
    // The card is ONE `role="button"`: unnamed in its `aria-label`, the chip is
    // announced nowhere at all.
    expect(html).toContain("pull request: Checks failed · 3 checks · PR #12");
  });
});

describe("ActiveSessionCard clusters", () => {
  const child = (
    partial: Partial<SessionListItem> & { id: string },
  ): SessionInboxCard => card(partial);

  type Cluster = NonNullable<SessionInboxCard["cluster"]>;
  /** A cluster as the tests state it: no settled history, no live counts. */
  type ClusterInput = Omit<
    Cluster,
    "childrenWithSettled" | "settledCount" | "counts"
  > & {
    counts: Omit<Cluster["counts"], "running" | "jobs" | "services"> &
      Partial<Pick<Cluster["counts"], "running" | "jobs" | "services">>;
  };

  function clusterMarkup(
    input: ClusterInput | undefined,
    expanded = false,
  ): string {
    const base = card({ id: "root", title: "Coordinator" });
    const cluster: Cluster | undefined = input && {
      childrenWithSettled: input.children,
      settledCount: 0,
      ...input,
      counts: { running: 0, jobs: 0, services: 0, ...input.counts },
    };
    return renderToStaticMarkup(
      <ActiveSessionCard
        card={{ ...base, ...(cluster ? { cluster } : {}) }}
        now={NOW}
        active={false}
        relations={{}}
        clusterExpanded={expanded}
        onOpen={() => {}}
        onSettle={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onToggleCluster={() => {}}
      />,
    );
  }

  it("states the aggregate instead of the peers themselves", () => {
    const html = clusterMarkup({
      children: [child({ id: "a" }), child({ id: "b", isStreaming: true })],
      counts: { total: 2, working: 1, running: 1, waiting: 0, failed: 0 },
    });
    expect(html).toContain("2 sessions · 1 running");
    // The card, not the line, is what says whose peers these are.
    expect(html).not.toContain(">Coordinating");
    // The peers are the browser's rows to lay out; the card names none of them.
    expect(html).not.toContain(">a<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show the 2 coordinated sessions");
  });

  it("names the peer that needs the user and makes it its own target", () => {
    const asks = child({ id: "kid", title: "Reviewer", attention: "question" });
    const html = clusterMarkup({
      children: [asks],
      counts: { total: 1, working: 0, waiting: 1, failed: 0 },
      bubbled: asks,
    });
    expect(html).toContain("Answer in “Reviewer”");
    expect(html).toContain("Open “Reviewer”");
    // Announced too: the card's own label replaces everything inside it, and
    // the spoken form keeps the verb the line drops — there is no card to read
    // it from.
    expect(html).toContain("— coordinating 1 session · 1 waiting");
    // Answering is the only way through a question, so nothing offers to
    // dismiss it.
    expect(html).not.toContain("Dismiss");
  });

  it("never lets the peer that needs the user wrap off the status line", () => {
    const asks = child({ id: "kid", title: "Reviewer", attention: "question" });
    const host = document.createElement("div");
    host.innerHTML = clusterMarkup({
      children: [asks],
      counts: { total: 1, working: 0, waiting: 1, failed: 0 },
      bubbled: asks,
    });
    const bubble = host.querySelector('[aria-label="Answer in “Reviewer”"]');
    const toggle = host.querySelector('[aria-label^="Show the 1"]');
    // Both on the one status line, but only the toggle is inside the area
    // whose overflow wraps onto a hidden second line.
    expect(bubble?.closest(".session-card-status-line")).not.toBeNull();
    expect(
      toggle?.closest(".session-card-status-line .flex-wrap"),
    ).not.toBeNull();
    expect(bubble?.closest(".session-card-status-line .flex-wrap")).toBeNull();
  });

  it("shows peers at work as motion in the accent, not as a count alone", () => {
    const working = clusterMarkup({
      children: [child({ id: "a", isStreaming: true })],
      counts: { total: 1, working: 1, waiting: 0, failed: 0 },
    });
    // The coordinator itself is quiet — it carries no badge of its own — so the
    // fold is where the run has to be visible.
    expect(working).not.toContain("Working ");
    expect(working).toContain("animate-spin");
    expect(working).toContain('data-variant="secondary"');
    const idle = clusterMarkup({
      children: [child({ id: "a" })],
      counts: { total: 1, working: 0, waiting: 0, failed: 0 },
    });
    expect(idle).not.toContain("animate-spin");
    expect(idle).not.toContain('data-variant="secondary"');
  });

  it("states running turns and background jobs on the line, not only in the tooltip", () => {
    const html = clusterMarkup({
      children: [child({ id: "a", isStreaming: true }), child({ id: "b" })],
      counts: {
        total: 2,
        working: 2,
        running: 1,
        jobs: 3,
        waiting: 0,
        failed: 0,
      },
    });
    // A visible fact, so a quiet coordinator says whether its tree is moving:
    // icon and number inside the disclosure, the words in its label.
    expect(html).toContain(
      'aria-label="Show the 2 coordinated sessions — 1 running · 3 jobs"',
    );
    expect(html).toMatch(/<\/svg>1<\/span>/);
    expect(html).toMatch(/<\/svg>3<\/span>/);
    const quiet = clusterMarkup({
      children: [child({ id: "a" })],
      counts: { total: 1, working: 0, waiting: 0, failed: 0 },
    });
    expect(quiet).not.toContain("running");
    expect(quiet).not.toContain(" job");
  });

  it("offers to dismiss a peer failure the user has moved on from", () => {
    const broken = child({
      id: "kid",
      title: "Implementer",
      lastError: { at: NOW - 1_000, message: "boom" },
    });
    const html = clusterMarkup({
      children: [broken],
      counts: { total: 1, working: 0, waiting: 0, failed: 1 },
      bubbled: broken,
    });
    expect(html).toContain("Failed in “Implementer”");
    expect(html).toContain("Dismiss the failure in “Implementer”");
    expect(html).toContain("Dismiss — settle “Implementer”");
  });

  it("says nothing about a cluster on a session that spawned nothing", () => {
    const html = clusterMarkup(undefined);
    expect(html).not.toContain("coordinating");
    expect(html).not.toContain("coordinated session");
  });
});

describe("ActiveSessionCard worktree changes", () => {
  it("states the diff on the row and in the card's label without a pull request", () => {
    const html = markup({ id: "a" }, "tight", {
      worktreeAdditions: 12,
      worktreeDeletions: 3,
      worktreeAhead: 2,
    });
    expect(html).toContain(">+12<");
    expect(html).toMatch(
      /aria-label="Open [^"]*12 lines added, 3 removed, uncommitted · 2 commits ahead of base/,
    );
  });

  it("lets the pull request speak instead of the diff", () => {
    const html = markup(
      {
        id: "a",
        pullRequest: {
          status: "open",
          number: 12,
          ci: { state: "failure", total: 2 },
        },
      },
      "tight",
      { worktreeAdditions: 12 },
    );
    expect(html).not.toContain("lines added");
    expect(html).toContain(">#12<");
  });
});

describe("ActiveSessionCard stall", () => {
  it("names the peer that owes a reply when the tree has stopped", () => {
    const reviewer = card({ id: "rev", title: "Reviewer" }).session;
    const base = card({ id: "root", title: "Coordinator" });
    const html = renderToStaticMarkup(
      <ActiveSessionCard
        card={{ ...base, stall: { peers: [reviewer], askers: [] } }}
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
    expect(html).toContain('aria-label="Stalled: No reply from “Reviewer”"');
    expect(html).toContain('title="Open “Reviewer”"');
    // The card's own spoken label says it too: its chip may be icon-only.
    expect(html).toContain("— stalled: No reply from “Reviewer”");
  });
});

describe("ActiveSessionCard stall chip fit", () => {
  it("truncates only the title, never the prefix or the count", () => {
    const long = (id: string) =>
      card({ id, title: "A very long reviewer title that cannot fit" }).session;
    const base = card({ id: "root", title: "Coordinator" });
    const html = renderToStaticMarkup(
      <ActiveSessionCard
        card={{
          ...base,
          stall: { peers: [long("a"), long("b"), long("c")], askers: [] },
        }}
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
    expect(html).toMatch(/shrink-0">No reply from<\/span>/);
    expect(html).toMatch(/min-w-0 truncate">“A very long reviewer title/);
    expect(html).toMatch(/shrink-0">\+2<\/span>/);
  });
});
