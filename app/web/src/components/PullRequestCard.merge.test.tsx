// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  PullRequestCard as PullRequestCardData,
  PullRequestCardActionOptions,
} from "@assistant/shared";
import { PullRequestCard } from "./PullRequestCard.tsx";

/**
 * What one MERGE click actually asks for. The rest of the card renders
 * statically (`PullRequestCard.test.tsx`); this needs a real DOM because the
 * point is the payload after the user has TOGGLED something — the branch
 * opt-out is per merge, so it only exists as click state.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const card: PullRequestCardData = {
  renderKind: "pullRequest",
  id: "pr_1",
  sessionId: "session-1",
  status: "open",
  createdAt: 0,
  updatedAt: 0,
  provider: "github",
  number: 42,
  title: "Add /pr",
  headBranch: "feature",
  baseBranch: "main",
  worktreeId: "wt-1",
  warnings: [],
  repositoryCapabilities: {
    defaultBranch: "main",
    mergeMethods: ["squash", "merge", "rebase"],
    canClose: true,
  },
};

interface Click {
  action: string;
  options?: PullRequestCardActionOptions;
}

/** Render ONE card; a test that needs another shape passes the whole card. */
function render(subject: PullRequestCardData = card): Click[] {
  const clicks: Click[] = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <PullRequestCard
        pullRequest={subject}
        onAction={(_cardId, action, options) =>
          clicks.push({ action, ...(options !== undefined ? { options } : {}) })
        }
      />,
    );
  });
  return clicks;
}

/**
 * The element whose text is exactly `label`. Exact, because the method button
 * "Merge commit" and the merge ACTION button "Merge" sit in the same row: a
 * substring match would click the wrong one and the test would pass on it.
 */
function find<T extends Element>(selector: string, label: string): T {
  const match = [...container!.querySelectorAll(selector)].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `nothing matching ${selector} labelled ${label}`).toBeDefined();
  return match as T;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("merges with the chosen method and deletes the remote branch by default", () => {
  const clicks = render();
  click(find("button", "Merge commit"));
  click(find("button", "Merge"));
  expect(clicks).toEqual([
    { action: "merge", options: { mergeMethod: "merge", deleteBranch: true } },
  ]);
});

// The opt-out has to REACH the server: a checkbox that only changes the card's
// own wording would delete the branch anyway.
it("carries the opt-out into the merge click and says so first", () => {
  const clicks = render();
  const checkbox = find<HTMLLabelElement>(
    "label",
    "Delete remote branch",
  ).querySelector("input")!;
  expect(checkbox.checked).toBe(true);
  click(checkbox);
  expect(checkbox.checked).toBe(false);
  expect(container!.textContent).toContain(
    "The remote branch feature is KEPT after the merge",
  );

  click(find("button", "Merge"));
  expect(clicks).toEqual([
    {
      action: "merge",
      options: { mergeMethod: "squash", deleteBranch: false },
    },
  ]);
});

// The picker states what the REPOSITORY allows, not the shared vocabulary: a
// repository that turned squashing off must not offer a squash button at all.
it("offers only the repository's supported merge methods", () => {
  render({
    ...card,
    repositoryCapabilities: {
      defaultBranch: "main",
      mergeMethods: ["merge", "rebase"],
    },
  });
  const labels = [...container!.querySelectorAll("button")].map((button) =>
    (button.textContent ?? "").trim(),
  );
  expect(labels).toContain("Merge commit");
  expect(labels).toContain("Rebase");
  expect(labels).not.toContain("Squash");
});

// Unknown capabilities offer NOTHING: a guessed method is a merge the backend
// refuses, or worse, one the project did not want.
it("offers no method and no merge while the capabilities are unknown", () => {
  const { repositoryCapabilities: _unknown, ...withoutCapabilities } = card;
  const clicks = render(withoutCapabilities);
  expect(container!.textContent).toContain("Merge methods are not known yet");
  const merge = find<HTMLButtonElement>("button", "Merge");
  expect(merge.disabled).toBe(true);
  click(merge);
  expect(clicks).toEqual([]);
});

// A method that stops being supported while the card is open must not survive
// as a stale selection.
it("invalidates a selected method the repository no longer allows", () => {
  const clicks = render();
  click(find("button", "Rebase"));
  act(() => {
    root!.render(
      <PullRequestCard
        pullRequest={{
          ...card,
          repositoryCapabilities: {
            defaultBranch: "main",
            mergeMethods: ["squash"],
          },
        }}
        onAction={(_cardId, action, options) =>
          clicks.push({ action, ...(options !== undefined ? { options } : {}) })
        }
      />,
    );
  });
  click(find("button", "Merge"));
  expect(clicks).toEqual([
    { action: "merge", options: { mergeMethod: "squash", deleteBranch: true } },
  ]);
});
