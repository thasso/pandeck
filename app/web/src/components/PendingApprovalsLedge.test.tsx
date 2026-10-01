// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCard } from "@assistant/shared";
import { PendingApprovalsLedge } from "./PendingApprovalsLedge.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function card(index: number): ApprovalCard {
  return {
    renderKind: "approval",
    id: `appr_${index}`,
    sessionId: "s1",
    kind: "commit",
    status: "pending",
    title: `Merge #${index} into main`,
    createdAt: index,
    body: { kind: "commit", message: "wip", files: ["a.ts"] },
  } as ApprovalCard;
}

function mount(cards: ApprovalCard[], onRevealApproval: () => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <PendingApprovalsLedge
        cards={cards}
        onRevealApproval={onRevealApproval}
      />,
    ),
  );
  return [...container.querySelectorAll("button")];
}

describe("PendingApprovalsLedge", () => {
  it("names each waiting card and jumps to the one clicked", () => {
    const reveal = vi.fn();
    const buttons = mount([card(1), card(2)], reveal);

    expect(buttons.map((button) => button.textContent)).toEqual([
      "ApproveMerge #1 into mainShow card",
      "ApproveMerge #2 into mainShow card",
    ]);
    act(() => buttons[1]!.click());
    expect(reveal).toHaveBeenCalledWith("appr_2");
  });

  it("folds a pile-up behind one line that names every card once opened", () => {
    const reveal = vi.fn();
    const buttons = mount(
      [card(1), card(2), card(3), card(4), card(5)],
      reveal,
    );

    expect(buttons).toHaveLength(4);
    expect(buttons[3]!.textContent).toBe("Show 2 more waiting");
    act(() => buttons[3]!.click());

    const opened = [...container!.querySelectorAll("button")];
    expect(opened).toHaveLength(5);
    act(() => opened[4]!.click());
    expect(reveal).toHaveBeenCalledWith("appr_5");
  });
});
