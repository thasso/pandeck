import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAV_SLOTS,
  normalizeNavSlots,
  type NavSlot,
} from "./useSidebarSection.ts";

describe("normalizeNavSlots", () => {
  it("migrates a stored `worktrees` entry to Pull Requests IN PLACE", () => {
    // The section was replaced, not removed. A user who put it third has
    // arranged their bar, and dropping the entry would move the replacement to
    // its default position — behind More on a phone, where it reads as gone.
    const stored: string[] = [
      "new-session",
      "worktrees",
      "sessions",
      "assistant",
      "tasks",
      "projects",
      "knowledge",
      "settings",
      "usage",
      "background-tasks",
    ];
    expect(normalizeNavSlots(stored)[1]).toBe("pull-requests");
    expect(normalizeNavSlots(stored)).not.toContain(
      "worktrees" as unknown as NavSlot,
    );
  });

  it("does not duplicate a bar that already holds both ids", () => {
    const order = normalizeNavSlots(["worktrees", "pull-requests"]);
    expect(order.filter((slot) => slot === "pull-requests")).toHaveLength(1);
  });

  it("drops the removed calendar slot from stored navigation", () => {
    const order = normalizeNavSlots(["sessions", "calendar", "tasks"]);
    expect(order).not.toContain("calendar");
    expect(order).toHaveLength(DEFAULT_NAV_SLOTS.length);
  });

  it("still drops a genuinely unknown slot", () => {
    const order = normalizeNavSlots(["sessions", "nonsense", "tasks"]);
    expect(order).not.toContain("nonsense" as unknown as NavSlot);
    expect(order).toHaveLength(DEFAULT_NAV_SLOTS.length);
  });

  it("completes a partial order at the DEFAULT position, not the end", () => {
    // A slot the user has never seen must not be born behind More.
    const order = normalizeNavSlots(["settings"]);
    expect(order).toHaveLength(DEFAULT_NAV_SLOTS.length);
    expect(order[0]).toBe("new-session");
  });

  it("survives a corrupted value without hiding the navigation", () => {
    expect(normalizeNavSlots(null)).toEqual([...DEFAULT_NAV_SLOTS]);
    expect(normalizeNavSlots("worktrees")).toEqual([...DEFAULT_NAV_SLOTS]);
  });
});
