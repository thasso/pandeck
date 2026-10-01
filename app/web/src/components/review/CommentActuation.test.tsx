// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageHeader } from "../PageHeader.tsx";
import { Inspector } from "../shell/Inspector.tsx";
import { DockAction } from "../shell/ObjectDock.tsx";
import {
  RoutePrimaryActionProvider,
  type RoutePrimaryAction,
} from "../shell/RoutePrimaryAction.tsx";
import {
  CommentActuationProvider,
  usePublishCommentActuation,
} from "./CommentActuation.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

function Publisher({
  canComment,
  onComment,
  onSubmitReview,
  pendingCount = 3,
}: {
  canComment: boolean;
  onComment: () => void;
  onSubmitReview: () => void;
  pendingCount?: number | undefined;
}) {
  // Deliberately publish fresh closures: the channel must stabilize these rather
  // than feeding a provider render back into the active surface forever.
  usePublishCommentActuation({
    canComment,
    onComment: () => onComment(),
    pendingCount,
    onSubmitReview: () => onSubmitReview(),
  });
  return null;
}

/** The object's own action, as `App` publishes it for the route. */
const primaryAction: RoutePrimaryAction = {
  label: "Start session with this object",
  icon: <span>+</span>,
  onRun: () => primaryRuns.push(1),
};
let primaryRuns: number[] = [];

async function renderChrome({
  canComment,
  onComment,
  onSubmitReview,
  pendingCount,
  primary = null,
}: {
  canComment: boolean;
  onComment: () => void;
  onSubmitReview: () => void;
  pendingCount?: number;
  primary?: RoutePrimaryAction | null;
}) {
  primaryRuns = [];
  await act(async () =>
    reactRoot.render(
      <RoutePrimaryActionProvider action={primary}>
        <CommentActuationProvider>
          <Publisher
            canComment={canComment}
            onComment={onComment}
            onSubmitReview={onSubmitReview}
            pendingCount={pendingCount}
          />
          <PageHeader title="Surface" />
          <Inspector
            relations={[]}
            actions={[
              {
                key: "start-session",
                primary: true,
                label: "Start session with this object",
                onRun: () => {},
              },
            ]}
          />
        </CommentActuationProvider>
      </RoutePrimaryActionProvider>,
    ),
  );
}

it("keeps armed comment controls in the page header, not the desktop inspector", async () => {
  const onComment = vi.fn();
  const onSubmitReview = vi.fn();
  await renderChrome({ canComment: false, onComment, onSubmitReview });

  const addButtons = [
    ...container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Add comment"]',
    ),
  ];
  expect(addButtons).toHaveLength(1);
  expect(addButtons[0]!.disabled).toBe(true);
  expect(addButtons[0]!.hasAttribute("data-comment-actuation")).toBe(true);
  expect(addButtons[0]!.parentElement?.title).toBe("Select text to comment");

  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add comment",
    ),
  ).toBeUndefined();

  await renderChrome({ canComment: true, onComment, onSubmitReview });
  const armedHeaderAdd = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add comment"]',
  )!;
  const pointerDown = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    armedHeaderAdd.dispatchEvent(pointerDown);
    armedHeaderAdd.click();
  });
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(onComment).toHaveBeenCalledOnce();

  const submitButtons = [
    ...container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Submit review"]',
    ),
  ];
  expect(submitButtons).toHaveLength(1);
  expect(submitButtons[0]!.textContent).toContain("3");
  await act(async () => submitButtons[0]!.click());
  expect(onSubmitReview).toHaveBeenCalledOnce();
});

// The header's primary SLOT: the object's own action, and the review while one
// is waiting to go. One slot, so the panel lists the primary again only when the
// slot is not showing it.
it("gives the header's slot to the object, and to the review once one is waiting", async () => {
  const onSubmitReview = vi.fn();
  await renderChrome({
    canComment: true,
    onComment: vi.fn(),
    onSubmitReview,
    pendingCount: 0,
    primary: primaryAction,
  });

  // Nothing pending: the slot is the object's action, and Submit is nowhere —
  // the batch is derived, so an empty one would send nothing at all.
  expect(
    container.querySelector('button[aria-label^="Submit review"]'),
  ).toBeNull();
  const start = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Start session with this object"]',
  )!;
  await act(async () => start.click());
  expect(primaryRuns).toHaveLength(1);
  // And the panel does not offer it a second time.
  expect(
    [...container.querySelectorAll("button")].filter(
      (button) =>
        button.textContent?.trim() === "Start session with this object",
    ),
  ).toHaveLength(0);

  // Comments waiting: the slot becomes the review, badged with the count.
  await renderChrome({
    canComment: true,
    onComment: vi.fn(),
    onSubmitReview,
    pendingCount: 2,
    primary: primaryAction,
  });
  const submit = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Submit review"]',
  )!;
  expect(submit.textContent).toContain("2");
  expect(
    container.querySelector(
      'button[aria-label="Start session with this object"]',
    ),
  ).toBeNull();
  await act(async () => submit.click());
  expect(onSubmitReview).toHaveBeenCalledOnce();
  // The slot is the review's now; the object action is secondary and belongs
  // to the page-header overflow, never the desktop inspector.
  expect(
    [...container.querySelectorAll("button")].filter(
      (button) =>
        button.textContent?.trim() === "Start session with this object",
    ),
  ).toHaveLength(0);
});

it("keeps the desktop inspector free of actions when no primary chrome is published", async () => {
  await renderChrome({
    canComment: true,
    onComment: vi.fn(),
    onSubmitReview: vi.fn(),
    pendingCount: 0,
    primary: null,
  });

  // Secondary actions still publish to the wide header overflow rather than
  // reclaiming a section inside the inspector.
  const inspectorStart = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === "Start session with this object",
  );
  expect(inspectorStart).toHaveLength(0);
});

it("renders disabled tooltips and pending badges in dock controls", async () => {
  const onRun = vi.fn();
  await act(async () =>
    reactRoot.render(
      <>
        <DockAction
          icon={<span>C</span>}
          label="Add comment"
          onRun={onRun}
          disabled
          disabledReason="Select text to comment"
          commentActuation
        />
        <DockAction
          icon={<span>S</span>}
          label="Submit review"
          onRun={onRun}
          badge={4}
          commentActuation
        />
        <DockAction
          icon={<span>E</span>}
          label="Submit empty review"
          onRun={onRun}
          badge={0}
        />
      </>,
    ),
  );

  const controls = container.querySelectorAll<HTMLButtonElement>("button");
  expect(controls[0]!.disabled).toBe(true);
  expect(controls[0]!.parentElement?.title).toBe("Select text to comment");
  expect(controls[1]!.textContent).toContain("4");
  expect(controls[1]!.hasAttribute("data-comment-actuation")).toBe(true);
  // A count is news; a zero is not. The action stays, the badge does not.
  expect(controls[2]!.textContent).toBe("E");
  const pointerDown = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    controls[1]!.dispatchEvent(pointerDown);
    controls[1]!.click();
  });
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(onRun).toHaveBeenCalledOnce();
});
