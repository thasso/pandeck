import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_SLOTS } from "../../hooks/useSidebarSection.ts";
import { NAV_BAR_PADDING, planNavSlots } from "./navOverflow.ts";

/** A fixed fixture, so the math is tested independently of the shipped order. */
const SECTIONS = [
  "sessions",
  "tasks",
  "worktrees",
  "projects",
  "knowledge",
  "reports",
  "usage",
  "settings",
] as const;
type Section = (typeof SECTIONS)[number];

const plan = (width: number, activeId: Section = "sessions") =>
  planNavSlots<Section>({ width, sectionIds: SECTIONS, activeId });

describe("planNavSlots", () => {
  it("keeps only the active pill and one slot at the minimum sidebar width", () => {
    expect(plan(220)).toEqual({
      visible: ["sessions", "tasks"],
      overflow: [
        "worktrees",
        "projects",
        "knowledge",
        "reports",
        "usage",
        "settings",
      ],
    });
  });

  it("shows the active pill and two slots at the default sidebar width", () => {
    expect(plan(256)).toEqual({
      visible: ["sessions", "tasks", "worktrees"],
      overflow: ["projects", "knowledge", "reports", "usage", "settings"],
    });
  });

  it("fits every section without a More control on a phone-width overlay", () => {
    expect(plan(390)).toEqual({ visible: [...SECTIONS], overflow: [] });
  });

  it("fits every section on a widened panel", () => {
    expect(plan(500)).toEqual({ visible: [...SECTIONS], overflow: [] });
  });

  it("keeps the active section visible in its configured position when it would otherwise overflow", () => {
    expect(plan(256, "usage")).toEqual({
      visible: ["sessions", "tasks", "usage"],
      overflow: ["worktrees", "projects", "knowledge", "reports", "settings"],
    });
  });

  it("honors a reordered list", () => {
    expect(
      planNavSlots<Section>({
        width: 256,
        sectionIds: [
          "knowledge",
          "reports",
          "sessions",
          "tasks",
          "worktrees",
          "projects",
          "usage",
          "settings",
        ],
        activeId: "sessions",
      }),
    ).toEqual({
      visible: ["knowledge", "reports", "sessions"],
      overflow: ["tasks", "worktrees", "projects", "usage", "settings"],
    });
  });

  it("degrades to the active pill plus More when no slot fits", () => {
    expect(plan(120)).toEqual({
      visible: ["sessions"],
      overflow: [
        "tasks",
        "worktrees",
        "projects",
        "knowledge",
        "reports",
        "usage",
        "settings",
      ],
    });
    expect(plan(0)).toEqual({
      visible: ["sessions"],
      overflow: [
        "tasks",
        "worktrees",
        "projects",
        "knowledge",
        "reports",
        "usage",
        "settings",
      ],
    });
  });

  it("reserves no pill width for an active section outside the list", () => {
    const twoSections = ["sessions", "tasks"] as const;
    expect(
      planNavSlots<"sessions" | "tasks" | "settings">({
        width: 36 + NAV_BAR_PADDING,
        sectionIds: [...twoSections],
        activeId: "settings",
      }),
    ).toEqual({ visible: [], overflow: ["sessions", "tasks"] });
  });

  it("adds no More control at the exact width where the last slot fits", () => {
    // 4 sections: pill + 3 slots + 3 gaps = 104 + 108 + 6 = 218 (+ padding).
    const four = ["sessions", "tasks", "worktrees", "projects"] as const;
    const exact = 218 + NAV_BAR_PADDING;
    expect(
      planNavSlots({ width: exact, sectionIds: four, activeId: "sessions" })
        .overflow,
    ).toEqual([]);
    // One px below, More appears and claims a slot's worth of width itself, so
    // two sections fold at once. Inherent to any overflow control.
    expect(
      planNavSlots({ width: exact - 1, sectionIds: four, activeId: "sessions" })
        .overflow,
    ).toEqual(["worktrees", "projects"]);
  });
});

describe("the shipped default order", () => {
  // The bar carries the app-level actions as well as the sections, so what a phone
  // shows without opening the card is worth pinning: adding a slot silently pushes
  // something out of the row, and there it reads as missing rather than as folded.
  //
  // 374px, not 390: on a phone the bar is a `BottomCard` header, and the card's side
  // gutter costs about what the removed More trigger gave back — so the row shows the
  // same seven slots it did with a trigger, and what the card buys is the gesture.
  it("shows seven of its ten slots in the phone's bottom card", () => {
    const plan = planNavSlots({
      width: 374,
      sectionIds: [...DEFAULT_NAV_SLOTS],
      activeId: "sessions",
      reserveMore: false,
    });
    expect(plan.visible).toEqual([
      "new-session",
      "assistant",
      "sessions",
      "tasks",
      "pull-requests",
      "projects",
      "knowledge",
    ]);
    expect(plan.overflow).toEqual(["settings", "usage", "background-tasks"]);
  });

  it("gives one of those slots up when a wide layout reserves a More trigger", () => {
    const withTrigger = planNavSlots({
      width: 374,
      sectionIds: [...DEFAULT_NAV_SLOTS],
      activeId: "sessions",
    });
    expect(withTrigger.visible).toHaveLength(6);
  });

  it("keeps the active section visible even when it would have folded", () => {
    const plan = planNavSlots({
      width: 390,
      sectionIds: [...DEFAULT_NAV_SLOTS],
      activeId: "settings",
    });
    expect(plan.visible).toContain("settings");
  });
});
