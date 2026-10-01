// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
  WorktreeRetireRefusalKind,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
} from "@assistant/shared";

/**
 * Retire's escalation loop, in its new home.
 *
 * Delivery is verified by FETCHING the base and comparing against that exact
 * commit, so nothing the browser can see stands in for it — a base branch
 * missing locally may still be on the remote. The dialog therefore offers force
 * only as the answer to the refusal that verification actually produced, and
 * only when force can answer it at all: a session gate is not escalatable, and
 * remembering one would leave a checkbox that overrides nothing.
 *
 * The outcome is held to the same standard: force and keeping the branch both
 * SKIP containment, so the sentence must report what the run did rather than
 * the verification the happy path would have performed.
 *
 * And the rule this hook exists to hold, which its inbox ancestor got for free
 * from a per-worktree map: consent is bound to ONE worktree id. The panel this
 * now lives in survives navigation, so an unguarded refusal would appear under
 * the next branch and enable a forced retirement there.
 */

const retires: { id: string; input: WorktreeRetireRequest }[] = [];
const toasts: string[] = [];
let response: WorktreeRetireResponse;

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showToast: (message: string) => toasts.push(message),
}));

vi.mock("../../lib/worktrees.ts", () => ({
  retireWorktree: async (id: string, input: WorktreeRetireRequest) => {
    retires.push({ id, input });
    return response;
  },
}));

const { useWorktreeRetire } = await import("./useWorktreeRetire.tsx");

function worktreeRecord(id: string, branch: string): WorktreeRecord {
  return {
    id,
    projectId: "pa",
    mainRepoRoot: "/repo",
    path: `/worktrees/${id}`,
    branch,
    baseBranch: "gone-base",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const WORKTREE = worktreeRecord("wt-1", "feat/orphan");
const OTHER = worktreeRecord("wt-2", "feat/other");

/** A base branch missing locally: exactly the state that must NOT become force. */
const STATUS: WorktreeGitStatus = {
  worktreeId: "wt-1",
  branch: "feat/orphan",
  head: "abc1234",
  dirty: false,
  filesChanged: 0,
  untracked: 0,
  additions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  upstream: { ahead: 1, behind: 0, name: "origin/feat/orphan" },
  merged: false,
  baseUnresolved: true,
  updatedAt: 0,
};

function retired(
  partial: Partial<Extract<WorktreeRetireResponse, { status: "retired" }>> = {},
): WorktreeRetireResponse {
  return {
    worktreeId: "wt-1",
    status: "retired",
    branch: "feat/orphan",
    baseBranch: "gone-base",
    branchDeleted: true,
    settledSessions: 1,
    deliveryVerified: true,
    ...partial,
  };
}

function refusal(
  kind: WorktreeRetireRefusalKind,
  message: string,
): WorktreeRetireResponse {
  return {
    worktreeId: "wt-1",
    status: "refused",
    branch: "feat/orphan",
    baseBranch: "gone-base",
    refusal: message,
    refusalKind: kind,
  };
}

/** The inspector's seam: one "Retire…" control plus the hook's dialog. */
function RetireHost({
  worktree,
  sessions = [],
  sessionsFresh = true,
}: {
  worktree: WorktreeRecord;
  sessions?: SessionListItem[];
  sessionsFresh?: boolean;
}) {
  const retire = useWorktreeRetire({
    worktree,
    status: worktree.id === "wt-1" ? STATUS : undefined,
    sessions,
    sessionsFresh,
    merged: false,
  });
  return (
    <>
      <button type="button" onClick={retire.open}>
        Retire…
      </button>
      {retire.dialog}
    </>
  );
}

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  retires.length = 0;
  toasts.length = 0;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

async function mount(worktree: WorktreeRecord = WORKTREE): Promise<void> {
  await act(async () => {
    root = createRoot(host);
    root.render(<RetireHost worktree={worktree} />);
  });
}

async function show(worktree: WorktreeRecord): Promise<void> {
  await act(async () => root!.render(<RetireHost worktree={worktree} />));
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`no button matching ${String(label)}`);
  return found;
}

function checkbox(label: RegExp): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find((element) =>
    label.test(element.textContent ?? ""),
  );
  const input = found?.querySelector("input[type=checkbox]");
  if (!(input instanceof HTMLInputElement))
    throw new Error(`no checkbox labelled ${String(label)}`);
  return input;
}

function forceCheckbox(): HTMLInputElement | undefined {
  const label = [...document.querySelectorAll("label")].find((element) =>
    /I understand/.test(element.textContent ?? ""),
  );
  const input = label?.querySelector("input[type=checkbox]");
  return input instanceof HTMLInputElement ? input : undefined;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

it("retires unforced first, then escalates from the refusal it produced", async () => {
  response = refusal(
    "delivery",
    "gone-base could not be refreshed, so delivery of feat/orphan cannot be verified.",
  );
  await mount();

  // First attempt: the browser knows the base is missing locally and says
  // nothing about it — the fetch has not run, so there is nothing to consent to.
  await click(button(/Retire…/));
  expect(forceCheckbox()).toBeUndefined();
  await click(button(/Retire worktree/));
  expect(retires).toEqual([
    { id: "wt-1", input: { deleteBranch: true, force: false } },
  ]);

  // The refusal stays on the dialog that asked for it rather than becoming a
  // toast over a surface the user can still act on (`docs/messaging.md`).
  expect(toasts).toEqual([]);
  expect(document.body.textContent).toContain("could not be refreshed");
  expect(button(/Retire worktree/).disabled).toBe(true);
  const consent = forceCheckbox();
  if (!consent) throw new Error("no consent checkbox after a delivery refusal");
  await click(consent);
  await click(button(/Retire worktree/));
  expect(retires[1]).toEqual({
    id: "wt-1",
    input: { deleteBranch: true, force: true },
  });
});

it("never offers force as an answer to a session gate", async () => {
  response = refusal(
    "sessions",
    "Retiring this worktree settles the sessions working in it, but a session is still running.",
  );
  await mount();

  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  expect(retires).toHaveLength(1);
  // Stated, but never escalatable: force overrides no running session.
  expect(document.body.textContent).toContain("a session is still running");
  expect(forceCheckbox()).toBeUndefined();
  expect(button(/Retire worktree/).disabled).toBe(false);
});

it("never offers force for a checkout another user owns", async () => {
  response = refusal(
    "permissions",
    "/wt/feat-orphan/.pnpm-store belongs to uid 0, so this server cannot delete it. Nothing was removed — hand it back with sudo chown -R $(id -u):$(id -g) /wt/feat-orphan.",
  );
  await mount();

  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  expect(retires).toHaveLength(1);
  // The refusal is shown with its fix, but consent buys nothing: no answer this
  // app can give makes another user's files deletable.
  expect(document.body.textContent).toContain("belongs to uid 0");
  expect(forceCheckbox()).toBeUndefined();
});

it("never carries one worktree's consent to another", async () => {
  response = refusal("delivery", "feat/orphan is not contained in gone-base.");
  await mount();
  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  expect(forceCheckbox()).toBeDefined();

  // Navigate to another worktree. Its dialog is fresh: no quoted refusal, no
  // consent checkbox, and therefore no way to force a retirement here on the
  // strength of a check that ran on a different branch.
  await show(OTHER);
  expect(document.body.textContent).not.toContain("not contained in gone-base");
  await click(button(/Retire…/));
  expect(document.body.textContent).not.toContain("not contained in gone-base");
  expect(forceCheckbox()).toBeUndefined();
  await click(button(/Retire worktree/));
  expect(retires.at(-1)).toEqual({
    id: "wt-2",
    input: { deleteBranch: true, force: false },
  });
});

it("shows a transport failure inline and lets it buy no force", async () => {
  const failing = vi
    .spyOn(await import("../../lib/worktrees.ts"), "retireWorktree")
    .mockRejectedValueOnce(new Error("the server is unreachable"));
  await mount();
  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  expect(failing).toHaveBeenCalled();
  expect(toasts).toEqual([]);
  expect(document.body.textContent).toContain("the server is unreachable");
  // Nothing was verified, so nothing may be consented past.
  expect(forceCheckbox()).toBeUndefined();
  failing.mockRestore();
});

it("reports what the retirement actually did, never the check it skipped", async () => {
  response = retired();
  await mount();
  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  // The one sanctioned toast: the checkout and its surfaces are gone, so the
  // outcome has no object left to sit on — and it names what it happened to.
  expect(toasts.at(-1)).toContain("after verifying delivery into gone-base");

  // Forced, which takes a delivery refusal to reach: force is a decision to
  // skip the check, so the outcome says exactly that.
  response = refusal("delivery", "feat/orphan is not contained in gone-base.");
  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  response = retired({ deliveryVerified: false });
  await click(checkbox(/retire anyway/));
  await click(button(/Retire worktree/));
  expect(retires.at(-1)?.input.force).toBe(true);
  expect(toasts.at(-1)).toContain("WITHOUT verifying delivery into gone-base");

  // Unforced yet unverified — the pending branch-cleanup retry. It skipped
  // nothing, so it must not be described as having skipped the check, and it is
  // no evidence the branch was undelivered either.
  response = retired({ deliveryVerified: false });
  await click(button(/Retire…/));
  await click(button(/Retire worktree/));
  expect(retires.at(-1)?.input.force).toBe(false);
  expect(toasts.at(-1)).toContain("without a confirmed delivery check against");

  // Branch kept: nothing was discarded, so there is no delivery claim to make.
  response = retired({ branchDeleted: false, deliveryVerified: false });
  await click(button(/Retire…/));
  await click(checkbox(/Also delete the branch/));
  await click(button(/Retire worktree/));
  expect(toasts.at(-1)).toBe(
    "Removed the feat/orphan checkout and kept the local branch, settled 1 session.",
  );
});

it("states a session COUNT only from a current-episode list", () => {
  // The act is never gated on this — the server recounts under the removal hold
  // and that recount is what protects a running session. The NUMBER is consent
  // text, so a count taken from previous-episode rows would promise something
  // the run then contradicts.
  const linked = [
    { id: "s-1", worktreeId: "wt-1", isStreaming: false },
    { id: "s-2", worktreeId: "wt-1", isStreaming: false },
  ] as unknown as SessionListItem[];

  act(() => {
    root = createRoot(host);
    root.render(<RetireHost worktree={WORKTREE} sessions={linked} />);
  });
  act(() => {
    button(/Retire…/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("It settles 2 sessions");

  // Same rows, list no longer authoritative: no number at all.
  act(() =>
    root!.render(
      <RetireHost
        worktree={WORKTREE}
        sessions={linked}
        sessionsFresh={false}
      />,
    ),
  );
  expect(document.body.textContent).not.toContain("It settles 2 sessions");
  expect(document.body.textContent).toContain(
    "It settles the sessions working here",
  );

  // And a stale list that happens to hold NONE must not say "0" either.
  act(() =>
    root!.render(
      <RetireHost worktree={WORKTREE} sessions={[]} sessionsFresh={false} />,
    ),
  );
  expect(document.body.textContent).not.toContain("It settles 0 sessions");
  expect(document.body.textContent).toContain(
    "It settles the sessions working here",
  );
});
