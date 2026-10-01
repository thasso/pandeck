import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskComment } from "@assistant/shared";
import { TaskComments, taskCommentCount } from "./TaskComments.tsx";
import { ready } from "../lib/loadState.ts";

function comment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: "c1",
    taskId: "42",
    author: { kind: "user", name: "Alice" },
    body: "Kicked this off.",
    createdAt: Date.parse("2026-07-07T10:00:00.000Z"),
    ...overrides,
  };
}

describe("TaskComments", () => {
  it("renders an empty state with a composer", () => {
    const html = renderToStaticMarkup(
      <TaskComments
        state={ready([])}
        onRetry={() => {}}
        onAddComment={() => {}}
      />,
    );
    expect(html).toContain("No activity yet");
    expect(html).toContain("Add a comment");
  });

  it("renders Markdown and links agent authors back to their sessions", () => {
    const html = renderToStaticMarkup(
      <TaskComments
        state={ready([
          comment(),
          comment({
            id: "c2",
            author: { kind: "agent", name: "Assistant", sessionId: "s1" },
            body: "## Finding\n\nInvestigated the **cause**.",
          }),
        ])}
        onRetry={() => {}}
        onAddComment={() => {}}
      />,
    );
    expect(html).toContain("Kicked this off.");
    expect(html).toContain("<h2>Finding</h2>");
    expect(html).toContain("Investigated the <strong>cause</strong>.");
    expect(html).toContain("Alice");
    expect(html).toContain("Assistant");
    // Author kind and the per-comment collapse affordance are accessible.
    expect(html).toContain("Agent");
    expect(html).toContain('href="/sessions/s1"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("counts comments for the section summary", () => {
    expect(taskCommentCount(undefined)).toBe(0);
    expect(taskCommentCount([comment(), comment({ id: "c2" })])).toBe(2);
  });
});
