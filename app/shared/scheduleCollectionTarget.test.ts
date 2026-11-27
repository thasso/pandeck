import { describe, expect, it } from "vitest";
import type { MessageTarget } from "./protocol.ts";
import {
  PA_OBJECT_TYPES,
  isPaObjectType,
  paObjectTypeLabel,
  parsePaObjectLink,
} from "./objectLinks.ts";

/**
 * The Schedules collection is a message target only as the home of its own
 * list failure (Task-1513). It is NOT a `pa://` object type: Schedule links,
 * their parsing, labels and routes are Task-1500's.
 */
describe("the Schedule collection target", () => {
  it("names the collection, with no member", () => {
    const target: MessageTarget = { type: "schedule" };
    expect(target).toEqual({ type: "schedule" });
    // @ts-expect-error A Schedule target names the collection, never one Schedule.
    const member: MessageTarget = { type: "schedule", id: "sch_1" };
    expect(member.type).toBe("schedule");
  });

  it("leaves the object-link vocabulary unchanged", () => {
    expect(PA_OBJECT_TYPES).toEqual([
      "knowledge",
      "task",
      "project",
      "session",
      "worktree",
      "approval",
      "initiative",
    ]);
    expect(isPaObjectType("schedule")).toBe(false);
    expect(paObjectTypeLabel("schedule")).toBe("Object");
    expect(parsePaObjectLink("pa://schedule/sch_1")).toEqual({
      uri: "pa://schedule/sch_1",
      objectType: "schedule",
      knownType: false,
      id: "sch_1",
    });
  });
});
