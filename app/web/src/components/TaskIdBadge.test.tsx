import { applyPatch, type Patch } from "@assistant/shared";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { BacklogFocusList } from "./BacklogFocusList.tsx";
import { BacklogInboxList } from "./BacklogInboxList.tsx";
import type { Task } from "../lib/backlogTree.ts";

function task(overrides: Patch<Task> = {}): Task {
  return applyPatch(
    {
      id: "124",
      title: "Ship the id column",
      status: "todo",
      source: { createdBy: "user" },
      createdAt: Date.parse("2026-07-30T09:00:00.000Z"),
      updatedAt: Date.parse("2026-07-30T09:00:00.000Z"),
    },
    overrides,
  );
}

const noop = () => {};

describe("TaskIdBadge", () => {
  it("prints the id the way it is spoken and the canonical form as a tooltip", () => {
    const html = renderToStaticMarkup(<TaskIdBadge id="124" />);
    expect(html).toContain("#124");
    expect(html).toContain('title="Task-124"');
  });

  it("is the row's link to the Task where the host navigates", () => {
    // The id is the handle you copy or open in a tab, so it carries a real
    // `href` — and stays plain text on a surface that cannot navigate.
    const linked = renderToStaticMarkup(
      <TaskIdBadge id="124" onNavigate={noop} />,
    );
    expect(linked).toContain('href="/tasks/124"');
    expect(renderToStaticMarkup(<TaskIdBadge id="124" />)).not.toContain(
      "href",
    );
  });

  it("shows the id on every Focus row, with and without other facts to state", () => {
    const html = renderToStaticMarkup(
      <BacklogFocusList
        tasks={[
          task(),
          task({ id: "7", title: "Bare row", scheduledFor: "2026-07-31" }),
        ]}
        today="2026-07-31"
        projectsById={new Map()}
        sessionById={new Map()}
        showProjectBadge
        selectedId={null}
        onOpen={noop}
        onCycle={noop}
        onAcceptSuggestion={noop}
        onDismissSuggestion={noop}
        density="comfortable"
      />,
    );
    expect(html).toContain("#124");
    expect(html).toContain("#7");
  });

  it("shows the id on Inbox rows", () => {
    const html = renderToStaticMarkup(
      <BacklogInboxList
        tasks={[task({ triagedAt: undefined })]}
        projectsById={new Map()}
        showProjectBadge
        selectedId={null}
        onOpen={noop}
        onCycle={noop}
        onDismiss={noop}
        density="comfortable"
      />,
    );
    expect(html).toContain("#124");
  });
});
