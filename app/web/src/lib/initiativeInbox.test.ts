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
  planInitiativeInboxDrop,
  type NeedsYouEntry,
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
    // Every Initiative arrives with unsettled activity (docs/initiatives.md).
    attention: { revision: 1, settledRevision: 0, kind: "activity", at: NOW },
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
  it("lists unsettled Initiatives of any state: active in the working set, outcomes in Needs you", () => {
    expect(initiativeInInbox(initiative("1"))).toBe(true);
    expect(initiativeSettleRevision(initiative("1"))).toBe(1);
    const settled = initiative("8", {
      attention: { revision: 3, settledRevision: 3, kind: "activity", at: NOW },
    });
    expect(initiativeInInbox(settled), "a settled one leaves").toBe(false);
    // Active again after an unsettled pause: Settle takes the pending revision.
    const activeAgain = initiative("2", {
      attention: { revision: 2, settledRevision: 1, kind: "paused", at: NOW },
    });
    expect(initiativeSettleRevision(activeAgain)).toBe(2);
    // Paused with nothing ever raised: not an item.
    const { attention: _never, ...unraised } = initiative("5", {
      state: "paused",
    });
    expect(initiativeInInbox(unraised)).toBe(false);

    const inbox = buildInitiativeInbox(
      [
        initiative("1"),
        activeAgain,
        settled,
        // A manual position overrides creation time.
        initiative("7", { inboxPosition: NOW - 5_000 }),
        initiative("3", outcome("paused", 3, 2)),
        initiative("4", outcome("done", 1, 1)),
        initiative("6", outcome("done", 1, 0)),
      ],
      [],
    );
    expect(ids(inbox.active)).toEqual(["2", "1", "7"]);
    expect(inbox.active.map((item) => item.settleRevision)).toEqual([2, 1, 1]);
    expect(ids(inbox.outcomes)).toEqual(["6", "3"]);
    expect(inbox.outcomes.map((item) => item.settleRevision)).toEqual([1, 3]);
  });

  it("keeps the manual position when newer activity raises the item again", () => {
    const placed = { inboxPosition: NOW - 5_000 };
    const before = buildInitiativeInbox(
      [initiative("1", placed), initiative("2")],
      [],
    );
    const after = buildInitiativeInbox(
      [
        initiative("1", {
          ...placed,
          attention: {
            revision: 9,
            settledRevision: 1,
            kind: "activity",
            at: NOW + 1,
          },
          updatedAt: NOW + 1,
        }),
        initiative("2"),
      ],
      [],
    );
    expect(ids(before.active)).toEqual(["2", "1"]);
    expect(ids(after.active), "activity does not move it").toEqual(["2", "1"]);
    expect(after.active[1]!.settleRevision).toBe(9);
  });

  it("plans one mixed drop across a session, a run and an Initiative", () => {
    const inbox = buildInitiativeInbox(
      [initiative("1", { createdAt: NOW - 300 })],
      [],
    );
    const view = buildSessionInbox([
      session("newest", { createdAt: NOW - 100 }),
      session("oldest", { createdAt: NOW - 500 }),
    ]);
    const entries: NeedsYouEntry[] = mergeNeedsYou(view.active, inbox.active);
    expect(entries.map(needsYouEntryId)).toEqual([
      "newest",
      "initiative:1",
      "oldest",
    ]);
    // To the top: the Initiative takes the old top's number and that session
    // moves down, so one command carries both kinds.
    const plan = planInitiativeInboxDrop(entries, "initiative:1", "newest");
    expect(plan).toEqual([
      { kind: "initiative", id: "1", position: NOW - 100 },
      { kind: "session", id: "newest", position: expect.any(Number) },
    ]);
    const lowered = plan![1]!.position;
    expect(lowered).toBeLessThan(NOW - 100);
    expect(lowered).toBeGreaterThan(NOW - 500);
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
      {
        attention: {
          revision: 2,
          settledRevision: 0,
          kind: "activity",
          at: NOW,
        },
      },
      { inboxPosition: NOW - 9_000 },
    ];
    for (const variant of variants) {
      const inbox = buildInitiativeInbox([initiative("1", variant)], []);
      const [changed] = [...inbox.active, ...inbox.outcomes];
      expect(initiativeItemKey(changed!, NOW)).not.toBe(key);
    }
  });
});
