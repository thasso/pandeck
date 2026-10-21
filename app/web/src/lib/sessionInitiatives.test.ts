import { describe, expect, it } from "vitest";
import type { InitiativeSummary } from "@assistant/shared";
import {
  initiativesBySession,
  sessionInitiativeKey,
  sessionInitiativeLabel,
} from "./sessionInitiatives.ts";

function summary(
  id: string,
  partial: Partial<InitiativeSummary> = {},
): InitiativeSummary {
  return {
    id,
    title: `Initiative ${id}`,
    state: "active",
    progress: { total: 8, done: 3, doing: 1, startable: 2, blocked: 1 },
    sessionIds: [],
    sessionCount: 0,
    coordinatorSessionIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("initiativesBySession", () => {
  it("marks recorded coordinators and members, coordinator first", () => {
    const map = initiativesBySession([
      summary("1", { sessionIds: ["member", "both"] }),
      summary("2", { coordinatorSessionIds: ["coord", "both"] }),
    ]);
    expect(map.get("coord")).toEqual({
      id: "2",
      title: "Initiative 2",
      coordinator: true,
      done: 3,
      total: 8,
      others: [],
    });
    expect(map.get("member")?.coordinator).toBe(false);
    // Coordinating one and working on another: the coordinator role leads.
    expect(map.get("both")).toMatchObject({
      id: "2",
      coordinator: true,
      others: ["Initiative-1 Initiative 1"],
    });
    expect(map.has("nobody")).toBe(false);
  });

  it("counts one Initiative once when it both records and lists a session", () => {
    const map = initiativesBySession([
      summary("1", { sessionIds: ["s"], coordinatorSessionIds: ["s"] }),
    ]);
    expect(map.get("s")).toMatchObject({ coordinator: true, others: [] });
  });
});

describe("sessionInitiativeLabel", () => {
  it("says the role, the progress a coordinator draws, and the rest", () => {
    const [coordinator] = initiativesBySession([
      summary("4", { coordinatorSessionIds: ["s"] }),
      summary("5", { sessionIds: ["s"] }),
    ]).values();
    expect(sessionInitiativeLabel(coordinator!)).toBe(
      "Coordinating Initiative-4 Initiative 4: 3 of 8 Tasks done; also Initiative-5 Initiative 5",
    );
    const [member] = initiativesBySession([
      summary("5", { sessionIds: ["s"] }),
    ]).values();
    expect(sessionInitiativeLabel(member!)).toBe(
      "Part of Initiative-5 Initiative 5",
    );
  });

  it("keys every rendered field", () => {
    const relation = initiativesBySession([
      summary("4", { coordinatorSessionIds: ["s"] }),
    ]).get("s")!;
    expect(sessionInitiativeKey(relation)).not.toBe(
      sessionInitiativeKey({ ...relation, done: relation.done + 1 }),
    );
    expect(sessionInitiativeKey(undefined)).toBe("");
  });
});
