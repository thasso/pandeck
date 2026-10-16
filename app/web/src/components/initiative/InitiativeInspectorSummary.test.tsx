// @vitest-environment jsdom
/**
 * The Initiative's object panel while no Task is selected: its flat facts are
 * the inspector's one fact layout (`InspectorFacts`), the title and the hint
 * around them (F050).
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeInspectorSummary.test.tsx
 */
import { describe, expect, it } from "vitest";
import { mount } from "../../test/mount.tsx";
import { hostedLabsSummary } from "../../../component-preview/fixtures/initiatives.ts";
import { InitiativeInspectorSummary } from "./InitiativeInspectorSummary.tsx";

describe("InitiativeInspectorSummary", () => {
  it("states State, Progress and Sessions as the inspector's facts (F050)", () => {
    const summary = hostedLabsSummary({ sessionCount: 2 });
    const { container } = mount(
      <InitiativeInspectorSummary summary={summary} />,
    );
    const facts = container.querySelector(".property-list")!;
    expect(facts, "the inspector's facts").not.toBeNull();
    const labels = [...facts.children]
      .filter((_, index) => index % 2 === 0)
      .map((label) => label.textContent);
    expect(labels).toEqual(["State", "Progress", "Sessions"]);
    const value = (label: string) =>
      facts.children[labels.indexOf(label) * 2 + 1]!;
    expect(value("State").textContent).toBe("Active");
    // The progress line keeps its bar and its counts.
    expect(value("Progress").querySelector('[role="progressbar"]')).not.toBe(
      null,
    );
    expect(value("Progress").textContent).toContain(
      `${summary.progress.done}/${summary.progress.total} done`,
    );
    expect(value("Sessions").textContent).toBe("2 on its Tasks");
    // The title and the hint are not facts.
    expect(facts.textContent).not.toContain(summary.title);
    expect(container.textContent).toContain(summary.title);
    expect(container.textContent).toContain(
      "Select a Task on the map or in the list to see it here.",
    );
  });

  it("says when no session works on it", () => {
    const { container } = mount(
      <InitiativeInspectorSummary
        summary={hostedLabsSummary({ sessionCount: 0 })}
      />,
    );
    const facts = container.querySelector(".property-list");
    expect(facts, "the inspector's facts").not.toBeNull();
    expect(facts!.children[5]?.textContent).toBe("None");
  });
});
