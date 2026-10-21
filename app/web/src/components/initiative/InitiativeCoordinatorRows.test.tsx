// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { hostedLabsSummary } from "../../../component-preview/fixtures/initiatives.ts";
import { InitiativeCoordinatorRows } from "./InitiativeCoordinatorRows.tsx";

function session(
  id: string,
  partial: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    ...partial,
  } as SessionListItem;
}

function render(items: SessionListItem[]): string {
  return renderToStaticMarkup(
    <InitiativeCoordinatorRows
      initiative={hostedLabsSummary({
        sessionIds: [],
        sessionCount: 0,
        coordinatorSessionIds: ["child"],
      })}
      members={[]}
      worktrees={[]}
      sessions={{ items, runs: [], cards: {}, selectedId: null }}
      density="tight"
      onNavigate={() => {}}
    />,
  );
}

describe("InitiativeCoordinatorRows with a recorded coordinator", () => {
  it("lists the recorded session itself, not its spawn root", () => {
    const html = render([
      session("parent"),
      session("child", {
        spawnedBySessionId: "parent",
        spawnOwnership: "coordinator",
      }),
    ]);
    expect(html).toContain('aria-label="Coordinating session: child"');
    expect(html).not.toContain('aria-label="Coordinating session: parent"');
    expect(html).not.toContain("related session details");
  });

  it("still lists it when its spawn parent is not loaded", () => {
    const html = render([
      session("child", {
        spawnedBySessionId: "parent",
        spawnOwnership: "coordinator",
      }),
    ]);
    expect(html).toContain('aria-label="Coordinating session: child"');
    expect(html).not.toContain("related session details");
  });

  it("says details are missing when the recorded session is not loaded", () => {
    expect(render([])).toContain("related session details");
  });
});
