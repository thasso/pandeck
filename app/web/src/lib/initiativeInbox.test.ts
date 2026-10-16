import { describe, expect, it } from "vitest";
import type { InitiativeSummary, SessionListItem } from "@assistant/shared";
import {
  buildInitiativeInbox,
  initiativeInInbox,
  initiativeItemKey,
  initiativeSettleRevision,
} from "./initiativeInbox.ts";

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

describe("initiativeInbox", () => {
  it("keeps active work and unsettled outcomes, and settles only outcomes", () => {
    expect(initiativeInInbox(initiative("1"))).toBe(true);
    expect(initiativeSettleRevision(initiative("1"))).toBeUndefined();
    // Active with a stale pending pause: shown, no Settle.
    const activeAgain = initiative("2", {
      attention: { revision: 2, settledRevision: 1, kind: "paused", at: NOW },
    });
    expect(initiativeInInbox(activeAgain)).toBe(true);
    expect(initiativeSettleRevision(activeAgain)).toBeUndefined();

    expect(
      initiativeSettleRevision(initiative("3", outcome("paused", 3, 2))),
    ).toBe(3);
    expect(
      initiativeSettleRevision(initiative("4", outcome("done", 1, 1))),
    ).toBeUndefined();
    expect(initiativeInInbox(initiative("4", outcome("done", 1, 1)))).toBe(
      false,
    );
    // Paused with nothing ever raised has nothing to show or settle.
    expect(initiativeInInbox(initiative("5", { state: "paused" }))).toBe(false);
  });

  it("orders newest first and lists the sessions this browser holds, counting the rest", () => {
    const items = buildInitiativeInbox(
      [
        initiative("9", {
          sessionIds: ["a", "gone", "archived", "b"],
          sessionCount: 60,
        }),
        initiative("10", outcome("done", 1, 0)),
        initiative("2"),
        initiative("11", outcome("paused", 1, 1)),
      ],
      [session("a"), session("b"), session("archived", { archived: true })],
    );
    expect(items.map((item) => item.initiative.id)).toEqual(["10", "9", "2"]);
    const nine = items[1]!;
    expect(nine.sessions.map((card) => card.session.id)).toEqual(["a", "b"]);
    expect(nine.more).toBe(58);
    expect(items[0]!.settleRevision).toBe(1);
  });

  it("keys every rendered field, so a summary change repaints the card", () => {
    const [base] = buildInitiativeInbox([initiative("1")], []);
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
      const [changed] = buildInitiativeInbox([initiative("1", variant)], []);
      expect(initiativeItemKey(changed!, NOW)).not.toBe(key);
    }
  });
});
