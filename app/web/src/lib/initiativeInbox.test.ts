import { describe, expect, it } from "vitest";
import type { InitiativeSummary, SessionListItem } from "@assistant/shared";
import {
  buildInitiativeInbox,
  INITIATIVE_DISCLOSURE_ROWS,
  initiativeInInbox,
  initiativeItemKey,
  initiativeSettleRevision,
  mergeNeedsYou,
  needsYouEntryId,
} from "./initiativeInbox.ts";
import { buildSessionInbox } from "./sessionInbox.ts";

const NOW = 1_800_000_000_000;

function initiative(
  id: string,
  extra: Partial<InitiativeSummary> = {},
): InitiativeSummary {
  return {
    id,
    title: `Initiative ${id}`,
    state: "active",
    progress: { total: 4, done: 1, doing: 1, startable: 1, blocked: 1 },
    sessionIds: [],
    sessionCount: 0,
    createdAt: NOW - 1_000 + Number(id),
    updatedAt: NOW,
    ...extra,
  };
}

function session(id: string, extra: Partial<SessionListItem> = {}) {
  return {
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    createdAt: NOW,
    updatedAt: NOW,
    messageCount: 1,
    ...extra,
  } as SessionListItem;
}

const outcome = (
  state: "paused" | "done",
  revision: number,
  settledRevision: number,
) => ({
  state,
  attention: { revision, settledRevision, kind: state, at: NOW },
});

const ids = (items: { initiative: InitiativeSummary }[]) =>
  items.map((item) => item.initiative.id);

describe("initiativeInbox", () => {
  it("puts active work in its block and unsettled outcomes in Needs you", () => {
    expect(initiativeInInbox(initiative("1"))).toBe(true);
    expect(initiativeSettleRevision(initiative("1"))).toBeUndefined();
    // Active with a stale pending pause: shown, no Settle, not an outcome.
    const activeAgain = initiative("2", {
      attention: { revision: 2, settledRevision: 1, kind: "paused", at: NOW },
    });
    expect(initiativeSettleRevision(activeAgain)).toBeUndefined();
    // Paused with nothing ever raised (a branch-era row): not an item.
    expect(initiativeInInbox(initiative("5", { state: "paused" }))).toBe(false);

    const inbox = buildInitiativeInbox(
      [
        initiative("1"),
        activeAgain,
        initiative("3", outcome("paused", 3, 2)),
        initiative("4", outcome("done", 1, 1)),
        initiative("6", outcome("done", 1, 0)),
      ],
      [],
    );
    expect(ids(inbox.active)).toEqual(["2", "1"]);
    expect(ids(inbox.outcomes)).toEqual(["6", "3"]);
    expect(inbox.outcomes.map((item) => item.settleRevision)).toEqual([1, 3]);
  });

  it("orders outcomes into Needs you on the creation scale of everything else", () => {
    const asking = session("asking", {
      createdAt: NOW - 500,
      awaitingInput: true,
      attention: "question",
    });
    const view = buildSessionInbox([asking]);
    expect(view.needsYou).toHaveLength(1);
    const inbox = buildInitiativeInbox(
      [
        initiative("1", { ...outcome("paused", 1, 0), createdAt: NOW - 900 }),
        initiative("2", { ...outcome("done", 1, 0), createdAt: NOW - 100 }),
      ],
      [],
    );
    expect(
      mergeNeedsYou(view.needsYou, inbox.outcomes).map(needsYouEntryId),
    ).toEqual(["initiative:2", "asking", "initiative:1"]);
    // Nothing to merge leaves Needs you exactly as built.
    expect(mergeNeedsYou(view.needsYou, []).map(needsYouEntryId)).toEqual([
      "asking",
    ]);
  });

  it("lists at most five sessions, those needing the user first, then newest", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      session(`s${index}`, { createdAt: NOW - index * 1_000 }),
    );
    // The two oldest need the user: one asks, one failed.
    rows[6] = session("s6", {
      createdAt: NOW - 6_000,
      awaitingInput: true,
      attention: "question",
    });
    rows[7] = session("s7", {
      createdAt: NOW - 7_000,
      lastError: { at: NOW - 7_000, message: "boom" },
    });
    const all = rows.map((row) => row.id);
    const [item] = buildInitiativeInbox(
      [
        initiative("9", {
          sessionIds: [...all, "not-held", "archived"],
          sessionCount: 57,
        }),
      ],
      [...rows, session("archived", { archived: true })],
    ).active;
    expect(item!.sessions.map((card) => card.session.id)).toEqual([
      "s6",
      "s7",
      "s0",
      "s1",
      "s2",
    ]);
    expect(item!.sessions).toHaveLength(INITIATIVE_DISCLOSURE_ROWS);
    expect(item!.more, "57 qualify, 5 shown").toBe(52);
  });

  it("counts every unlisted session in more, and never invents one", () => {
    const build = (
      sessionIds: string[],
      sessionCount: number,
      held: string[],
    ) =>
      buildInitiativeInbox(
        [initiative("9", { sessionIds, sessionCount })],
        held.map((id) => session(id)),
      ).active[0]!;
    const two = build(["a", "b", "x", "y"], 57, ["a", "b"]);
    expect(two.sessions).toHaveLength(2);
    expect(two.more).toBe(55);
    const none = build(["x", "y"], 57, []);
    expect(none.sessions).toHaveLength(0);
    expect(none.more).toBe(57);
    const all = build(["a", "b", "c"], 3, ["a", "b", "c"]);
    expect(all.more, "no false more row").toBe(0);
  });

  it("keys every rendered field, so a summary change repaints the card", () => {
    const [base] = buildInitiativeInbox([initiative("1")], []).active;
    const key = initiativeItemKey(base!, NOW);
    const variants: Partial<InitiativeSummary>[] = [
      { title: "Renamed" },
      { progress: { total: 4, done: 2, doing: 1, startable: 1, blocked: 1 } },
      { progress: { total: 4, done: 1, doing: 1, startable: 0, blocked: 1 } },
      { progress: { total: 4, done: 1, doing: 1, startable: 1, blocked: 2 } },
      { nextMilestone: { id: "8", title: "Beta" } },
      { sessionCount: 3 },
      outcome("paused", 1, 0),
    ];
    for (const variant of variants) {
      const inbox = buildInitiativeInbox([initiative("1", variant)], []);
      const [changed] = [...inbox.active, ...inbox.outcomes];
      expect(initiativeItemKey(changed!, NOW)).not.toBe(key);
    }
  });
});
