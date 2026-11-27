import { describe, expect, it } from "vitest";
import type { MessageTarget } from "./protocol.ts";
import {
  PA_OBJECT_TYPES,
  isPaObjectType,
  paObjectHref,
  paObjectTypeLabel,
  parsePaObjectLink,
} from "./objectLinks.ts";

/**
 * A Schedule is a first-class `pa://` object (Task-1500). As every other
 * object type, a `{ type: "schedule" }` target without an id names the
 * collection: the home of its list failure (Task-1513); with an id, the one
 * Schedule a refused write is about.
 */
describe("the Schedule message target", () => {
  it("names the collection without an id and one Schedule with one", () => {
    const collection: MessageTarget = { type: "schedule" };
    expect(collection).toEqual({ type: "schedule" });
    const member: MessageTarget = { type: "schedule", id: "sch_1" };
    expect(member).toEqual({ type: "schedule", id: "sch_1" });
  });

  it("is a known object-link type with its own route and label", () => {
    expect(PA_OBJECT_TYPES).toContain("schedule");
    expect(isPaObjectType("schedule")).toBe(true);
    expect(paObjectTypeLabel("schedule")).toBe("Schedule");
    const link = parsePaObjectLink("pa://schedule/sch_1");
    expect(link).toEqual({
      uri: "pa://schedule/sch_1",
      objectType: "schedule",
      knownType: true,
      id: "sch_1",
    });
    expect(paObjectHref(link!)).toBe("/schedules/sch_1");
  });
});
