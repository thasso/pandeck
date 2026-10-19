// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PendingQuestionLedge,
  pendingQuestionsLedgeKey,
} from "./PendingQuestionLedge.tsx";

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

function flow(index: number) {
  return { requestId: `question-${index}`, title: `Decision ${index}` };
}

function mount(
  questions: ReturnType<typeof flow>[],
  onRevealQuestion: () => void,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <PendingQuestionLedge
        questions={questions}
        onRevealQuestion={onRevealQuestion}
      />,
    ),
  );
  return [...container.querySelectorAll("button")];
}

describe("PendingQuestionLedge", () => {
  it("names each pending flow and jumps to the one clicked", () => {
    const reveal = vi.fn();
    const buttons = mount([flow(1), flow(2)], reveal);

    expect(buttons.map((button) => button.textContent)).toEqual([
      "AnswerDecision 1Show question",
      "AnswerDecision 2Show question",
    ]);
    act(() => buttons[1]!.click());
    expect(reveal).toHaveBeenCalledWith("question-2");
  });

  it("folds a pile-up behind one line that names every flow once opened", () => {
    const reveal = vi.fn();
    const buttons = mount(
      [flow(1), flow(2), flow(3), flow(4), flow(5)],
      reveal,
    );

    expect(buttons).toHaveLength(4);
    expect(buttons[3]!.textContent).toBe("Show 2 more waiting");
    act(() => buttons[3]!.click());

    const opened = [...container!.querySelectorAll("button")];
    expect(opened).toHaveLength(5);
    act(() => opened[4]!.click());
    expect(reveal).toHaveBeenCalledWith("question-5");
  });

  it("keys the strip on what it draws", () => {
    const a = [{ ...flow(1), createdAt: 1 }];
    const b = [{ ...flow(1), createdAt: 2 }];
    expect(pendingQuestionsLedgeKey(a)).toBe(pendingQuestionsLedgeKey(b));
    expect(pendingQuestionsLedgeKey(a)).not.toBe(
      pendingQuestionsLedgeKey([flow(1), flow(2)]),
    );
  });
});
