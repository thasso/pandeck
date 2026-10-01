// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PullRequestInventoryItem,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";

/**
 * The pull request panel inside the SHELL's chrome — the two contracts the
 * panel alone cannot show.
 *
 * On a wide layout its actions are published to the page header's `…` menu,
 * and the primary slot is the route host's: without a worktree the disabled
 * Start session row must reach the menu (it carries the reason to create one),
 * and with a worktree it must NOT — the header's primary slot draws it, and
 * listing it again would be the same button twice. On a phone the dock sheet
 * collapses on act, which unmounts this panel: the rows whose outcome lives in
 * it (a dialog, a busy state, a hand-off) keep it open.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/pullRequestsApi.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Held open: these cases are about what the click does to the chrome, not
  // what the server answers.
  checkoutPullRequestFromView: () => new Promise<never>(() => {}),
}));

const { PullRequestInspector } = await import("../objectInspectors.tsx");
const { InspectorChromeProvider } = await import("../shell/Inspector.tsx");
const { RoutePrimaryActionProvider, useRouteSecondaryActions } =
  await import("../shell/RoutePrimaryAction.tsx");
const { ready } = await import("../../lib/loadState.ts");

function pr(
  patch: Partial<PullRequestInventoryItem> = {},
): PullRequestInventoryItem {
  return {
    projectId: "pa",
    provider: "forgejo",
    repositoryKey: "acme/pa",
    repoWebUrl: "https://forge/acme/pa",
    number: 7,
    url: "https://forge/acme/pa/pulls/7",
    title: "Add the Pull Requests view",
    headBranch: "pull-requests",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    mergeable: true,
    capabilities: {
      defaultBranch: "main",
      mergeMethods: ["squash"],
      canDeleteBranchOnMerge: true,
    },
    sessionIds: [],
    taskIds: [],
    ...patch,
  };
}

/** What the wide header's menu would draw, as the host publishes it. */
let published: { key: string; disabled?: boolean | undefined }[] = [];
function MenuProbe() {
  published = useRouteSecondaryActions().map((action) => ({
    key: action.key,
    disabled: action.disabled,
  }));
  return null;
}

let host: HTMLDivElement;
let root: Root | undefined;
let acted = 0;

beforeEach(() => {
  published = [];
  acted = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("open", () => null);
});

afterEach(() => {
  try {
    act(() => root?.unmount());
  } finally {
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
  }
});

function panel(item: PullRequestInventoryItem) {
  return (
    <PullRequestInspector
      state={ready(item)}
      projects={[]}
      joins={{
        worktrees: { rows: [] as WorktreeRecord[], fresh: true },
        sessions: { rows: [] as SessionListItem[], fresh: true },
        tasks: { rows: [] as TaskSummary[], fresh: true },
      }}
      openers={{
        onOpenTask: () => {},
        onOpenProject: () => {},
        onOpenSession: () => {},
        onOpenWorktree: () => {},
        onOpenKnowledge: () => {},
      }}
      onStartSession={() => {}}
      onReview={() => {}}
      onReload={() => {}}
    />
  );
}

/** A wide layout: a route host, and the panel under the desktop tab bar. */
async function renderWide(
  item: PullRequestInventoryItem,
  primary: boolean,
): Promise<void> {
  await act(async () => {
    root?.render(
      <RoutePrimaryActionProvider
        action={
          primary
            ? { label: "Start session", icon: null, onRun: () => {} }
            : null
        }
      >
        <MenuProbe />
        <InspectorChromeProvider header={false} desktopTabs>
          {panel(item)}
        </InspectorChromeProvider>
      </RoutePrimaryActionProvider>,
    );
  });
}

/** A phone: the object dock, which collapses when a row acts. */
async function renderDock(item: PullRequestInventoryItem): Promise<void> {
  await act(async () => {
    root?.render(
      <InspectorChromeProvider
        header={false}
        onAct={() => {
          acted += 1;
        }}
      >
        {panel(item)}
      </InspectorChromeProvider>,
    );
  });
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`no button matching ${String(label)}`);
  return found;
}

async function click(label: RegExp): Promise<void> {
  await act(async () => {
    button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/* ------------------------------- the wide menu ----------------------------- */

it("publishes the disabled session action to the header menu while no worktree exists", async () => {
  await renderWide(pr(), false);
  expect(published.map((action) => action.key)).toEqual([
    "start-session",
    "review",
    "checkout",
    "merge",
    "open-external",
  ]);
  expect(published[0]?.disabled).toBe(true);
  // Nothing is drawn in the panel itself: the menu holds it all.
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

it("leaves the session action to the primary slot once the route publishes it", async () => {
  await renderWide(pr({ worktreeId: "wt-1" }), true);
  expect(published.map((action) => action.key)).toEqual([
    "review",
    "checkout",
    "merge",
    "open-external",
  ]);
});

/* -------------------------------- the dock --------------------------------- */

it("keeps the dock open for the rows whose outcome lives in the panel", async () => {
  await renderDock(pr({ worktreeId: "wt-1" }));

  // A hand-off in flight, a busy row, a dialog: each would be destroyed by the
  // collapse the dock performs on an ordinary act.
  await click(/Review in a session/);
  await click(/Update worktree/);
  await click(/Merge & clean up/);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click(/Open on Forgejo/);
  expect(acted).toBe(0);

  // Starting the session navigates, and the dock gets out of the way.
  await click(/Start session in worktree/);
  expect(acted).toBe(1);
});
