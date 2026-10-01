import { applyPatch } from "@assistant/shared";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorkflowRunCard as CardProjection,
  WorkflowRunSummary,
} from "@assistant/shared";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";
import { DialogProvider } from "./ui/dialog.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const run: WorkflowRunSummary = {
  id: "7",
  taskId: "370",
  recipeId: "code-delivery",
  recipeVersion: 4,
  branch: "t370-card",
  lifecycle: "paused",
  lifecycleReason: "review needs a decision",
  limits: { maxIterations: 3, maxReviewPasses: 1 },
  createdAt: 1,
  updatedAt: 2,
};

const card: CardProjection = {
  runId: "7",
  phase: "review",
  iterationsUsed: 1,
  workPlan: {
    complexity: "high",
    implementer: {
      provider: "openai-codex",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
      family: "gpt",
    },
    reviewer: {
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "medium",
      family: "claude",
    },
    rationale: "Protocol and UI changes need two independent checks.",
  },
  reviewDecision: {
    decision: "review-again",
    afterPass: 1,
    rationale: "The protocol change deserves a second reader.",
    focus: ["the migration"],
    reviewer: {
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "medium",
      family: "claude",
    },
  },
  latestAssessment: {
    verdict: "revise",
    headCommit: "abcdef123456",
    stale: true,
    summary: "Close, but the retry path is still unguarded.",
    findings: [
      {
        severity: "major",
        text: "guard the retry path",
        path: "src/retry.ts",
        line: 22,
        commentId: "thread-1",
      },
    ],
    observations: ["the helper name reads oddly"],
  },
  reviewSet: {
    id: "set-1",
    findingCount: 2,
    resolvedCount: 1,
    disputedCount: 1,
    openCount: 0,
  },
  nextAction: "review needs a decision",
  mergeDecisionReady: false,
  canRebaseAndReview: false,
  canRetry: true,
  canResume: true,
};

/** Settle the promise a `dialogs.confirm(...)` handler is awaiting. */
async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(label: string, scope: ParentNode = container!): void {
  const button = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, `no “${label}” button`).toBeDefined();
  act(() => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Answer the confirmation the control just raised, not the control again. */
function clickInDialog(label: string): void {
  const dialog = container!.querySelector('[role="dialog"]');
  expect(dialog, "no dialog open").not.toBeNull();
  click(label, dialog!);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

it("keeps pause reason and stale reviewed commit visible and wires controls", async () => {
  const resume = vi.fn();
  const retry = vi.fn();
  const cancel = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={run}
          card={card}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={resume}
          onRetry={retry}
          onCancel={cancel}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).toContain("review needs a decision");
  expect(
    container!.textContent!.split("review needs a decision").length - 1,
  ).toBe(1);
  expect(container!.textContent).toContain("abcdef12");
  expect(container!.textContent).toContain("outdated — workspace moved");
  // The reviewer's own words, which used to reach nothing but its transcript.
  expect(container!.textContent).toContain("retry path is still unguarded");
  expect(container!.textContent).toContain(
    "[major] src/retry.ts:22 — guard the retry path",
  );
  // Where the findings live durably, and what the fix round left on them.
  expect(container!.textContent).toContain("2 anchored findings");
  expect(container!.textContent).toContain("1 answered and left open");
  expect(container!.textContent).toContain("the helper name reads oddly");
  expect(container!.textContent).toContain("iteration 2 of 3");
  expect(container!.textContent).toContain("Protocol and UI changes");
  // The coordinator's post-review call, which the user would otherwise have to
  // open its session to read.
  expect(container!.textContent).toContain("another review pass");
  expect(container!.textContent).toContain("deserves a second reader");
  expect(container!.textContent).toContain("the migration");
  click("Resume");
  click("Retry");
  expect(resume).toHaveBeenCalledWith("7");
  // No repeated attempts to warn about, so Retry acts straight away.
  expect(retry).toHaveBeenCalledWith("7");
  // Cancelling a run is guarded, and the guard is the app's own dialog: it has
  // to be answered, and declining runs nothing.
  click("Cancel");
  await settled();
  clickInDialog("Keep running");
  await settled();
  expect(cancel).not.toHaveBeenCalled();
  click("Cancel");
  await settled();
  clickInDialog("Cancel run");
  await settled();
  expect(cancel).toHaveBeenCalledWith("7");
});

it("defaults late-bound worktree cleanup on and keeps cleanup choices independent", () => {
  const remove = vi.fn();
  const renderCard = (currentRun: WorkflowRunSummary) => (
    <DialogProvider>
      <WorkflowRunCard
        run={currentRun}
        card={card}
        sessions={[]}
        onOpenSession={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
        onCancel={() => {}}
        onDelete={remove}
        onRebaseAndReview={() => {}}
        onAnswerCeiling={() => {}}
      />
    </DialogProvider>
  );

  // The server publishes a run before provisioning attaches its worktree. The
  // same mounted card must pick up the default when that later broadcast lands.
  act(() => root!.render(renderCard(run)));
  act(() =>
    root!.render(
      renderCard({
        ...run,
        lifecycle: "cancelled",
        lifecycleReason: "cancelled by user",
        worktreeId: "wt-7",
      }),
    ),
  );

  click("Delete run…");
  const checkboxes = [
    ...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes.every((checkbox) => checkbox.checked)).toBe(true);
  act(() => checkboxes[0]!.click());
  clickInDialog("Delete run");
  expect(remove).toHaveBeenCalledWith("7", {
    deleteWorktree: false,
    archiveSessions: true,
  });
});

it("shows the stopped step's own reason beside the generic pause banner", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{
            ...run,
            lifecycleReason: "commit-sync step 168 ended as blocked",
          }}
          card={applyPatch(card, {
            phase: "commit-sync",
            latestAssessment: undefined,
            nextAction: "commit-sync step 168 ended as blocked",
            blockedReason: {
              phase: "commit-sync",
              status: "blocked",
              summary:
                "run rebase blocked: the rebase conflicted and was aborted",
              rebaseConflict: {
                files: ["docs/reference/web-diff.md"],
                baseBranch: "main",
                restored: true,
              },
            },
          })}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).toContain("Commit and sync blocked");
  expect(container!.textContent).toContain("the rebase conflicted");
  expect(container!.textContent).toContain("docs/reference/web-diff.md");
  expect(container!.textContent).toContain("run branch was restored");
  expect(container!.textContent).toContain("then Retry");
});

it("says what another retry would do, without repeating the banner's count", async () => {
  const retry = vi.fn();
  // As the server projects it: `nextAction` IS the recipe's pause reason, so the
  // banner and the next action carry the identical sentence with the count in it.
  const reason =
    "commit-sync step 168 ended as blocked; attempt 3 with the same result";
  const repeated = applyPatch(card, {
    phase: "commit-sync" as const,
    latestAssessment: undefined,
    nextAction: reason,
    blockedReason: {
      phase: "commit-sync" as const,
      status: "blocked" as const,
      summary: "run rebase blocked: the rebase conflicted and was aborted",
    },
    repeatedAttempts: 3,
  });
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycleReason: reason }}
          card={repeated}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={retry}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  // The count is the banner's; this line carries only what the banner cannot.
  expect(container!.textContent!.split("attempt 3").length - 1).toBe(1);
  expect(container!.textContent).toContain("Retry re-runs the same assignment");
  // Never a promise that the outcome is fixed — but also never a false reason
  // for it: the executor REUSES the role's session whenever it is still
  // resolvable, so a retry does not get fresh eyes, only another attempt.
  expect(container!.textContent).toContain("repaired outside the run");
  expect(container!.textContent).not.toContain("fresh session");
  // Discouraged, never refused: a declined confirmation runs nothing, and the
  // user who repaired the condition outside the run can still say yes.
  click("Retry again");
  await settled();
  expect(container!.textContent).toContain("Retry anyway?");
  expect(container!.textContent).toContain("ended with the same result");
  clickInDialog("Cancel");
  await settled();
  expect(retry).not.toHaveBeenCalled();
  click("Retry again");
  await settled();
  clickInDialog("Retry");
  await settled();
  expect(retry).toHaveBeenCalledWith("7");
});

it("never repeats the pause sentence the banner or next action already shows", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={applyPatch(run, { lifecycleReason: undefined })}
          card={applyPatch(card, {
            latestAssessment: undefined,
            nextAction: "the reviewer rejected this head",
            blockedReason: {
              phase: "review",
              status: "failed",
              summary: "the reviewer rejected this head",
            },
          })}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(
    container!.textContent!.split("the reviewer rejected this head").length - 1,
  ).toBe(1);
  expect(container!.textContent).not.toContain("Review failed");
});

it("links the provider PR and opens the existing live PR card", () => {
  const open = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={applyPatch(run, {
            lifecycle: "active",
            lifecycleReason: undefined,
          })}
          card={{
            ...card,
            phase: "delivery",
            canRetry: false,
            pullRequest: {
              cardId: "pr-12",
              sessionId: "impl",
              number: 12,
              url: "https://example.test/pull/12",
            },
          }}
          sessions={[]}
          onOpenSession={open}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  const link = container!.querySelector("a");
  expect(link?.textContent).toContain("Pull request #12");
  expect(link?.getAttribute("href")).toBe("https://example.test/pull/12");
  click("Open live PR card");
  expect(open).toHaveBeenCalledWith("impl");
});

it("keeps a completed run inspectable with its separate follow-ups", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={applyPatch(run, {
            lifecycle: "completed",
            lifecycleReason: undefined,
            endedAt: 3,
          })}
          card={{
            ...card,
            phase: "merge",
            canRetry: false,
            nextAction: "Run complete",
            pullRequest: {
              cardId: "pr-12",
              sessionId: "impl",
              number: 12,
              url: "https://example.test/pull/12",
            },
          }}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).toContain("completed");
  expect(container!.textContent).toContain("Pull request merged");
  // No delivery state on the card — an older server, or a card the run cannot
  // read — offers no control rather than one whose refusal it cannot predict.
  expect(container!.textContent).not.toContain("Clean up");
  // Answering the Task is still the user's own, separate choice.
  expect(container!.textContent).toContain("Task's own status");
  expect(container!.textContent).toContain("Pull request #12");
  expect(container!.textContent).not.toContain("Cancel");
});

it("offers user-authorized rebase and re-review for an observed conflict", async () => {
  const rebase = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{
            ...run,
            lifecycleReason: "pull request #12 conflicts with its base",
          }}
          card={{
            ...card,
            phase: "observe",
            canRetry: false,
            canRebaseAndReview: true,
            // What the server projects alongside it: a conflict is answered
            // through Rebase and re-review, not by resuming into it again.
            canResume: false,
            nextAction: "pull request #12 conflicts with its base",
          }}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={rebase}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).not.toContain("Resume");
  // Authorized by the user, through the app's own dialog: the confirming button
  // repeats the control's name, so the answer says what it starts.
  click("Rebase and re-review");
  await settled();
  expect(container!.textContent).toContain("send through review again?");
  clickInDialog("Rebase and re-review");
  await settled();
  expect(rebase).toHaveBeenCalledWith("7");
});

it("opens live role sessions through screen navigation", () => {
  const open = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={applyPatch(run, {
            lifecycle: "active",
            lifecycleReason: undefined,
          })}
          card={{
            ...card,
            activity: "running",
            implementerSessionId: "impl",
            canRetry: false,
          }}
          sessions={[
            {
              id: "impl",
              harness: "pi",
              agentType: "developer",
              title: "Implement it",
              createdAt: 1,
              updatedAt: 1,
              messageCount: 1,
              isStreaming: true,
            },
          ]}
          onOpenSession={open}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });
  click("ImplementerImplement it");
  expect(open).toHaveBeenCalledWith("impl");
  expect(container!.querySelector("a[href]")).toBeNull();
});

it("links every mandatory review pass, not only the newest one", () => {
  const open = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={applyPatch(run, {
            lifecycle: "active",
            lifecycleReason: undefined,
          })}
          card={{
            ...card,
            canRetry: false,
            reviewerSessions: [
              { pass: 1, sessionId: "review-1" },
              { pass: 2, sessionId: "review-2" },
            ],
          }}
          sessions={[]}
          onOpenSession={open}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  click("Reviewer 1review-1");
  expect(open).toHaveBeenCalledWith("review-1");
  click("Reviewer 2review-2");
  expect(open).toHaveBeenCalledWith("review-2");
});

it("says when the card shortened the review instead of hiding it", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={run}
          card={{
            ...card,
            latestAssessment: {
              verdict: "revise",
              headCommit: "abcdef123456",
              stale: false,
              findings: [{ severity: "minor", text: "one" }],
              truncated: true,
            },
          }}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).toContain("Shortened for this card");
});

it("uses a slider to raise by N even at the start-form maximum", () => {
  const answers: [string, string, unknown][] = [];
  const gate = (maxReviewPasses: number): CardProjection => ({
    ...card,
    phase: "ceiling-decision",
    ceilingDecision: {
      blocked: "review-passes",
      wanted: "buy fresh eyes on the fix at abc1234",
      allowedChoices: ["raise", "deliver", "cancel"],
      ceilings: { maxIterations: 3, maxReviewPasses },
      spent: { iterations: 2, reviewPasses: maxReviewPasses, sessions: 4 },
      headCarriesDiscoveryReview: false,
      suggestedRaise: 2,
    },
  });
  const render = (projection: CardProjection) =>
    act(() => {
      root!.render(
        <DialogProvider>
          <WorkflowRunCard
            run={{ ...run, lifecycle: "paused" }}
            card={projection}
            sessions={[]}
            onOpenSession={() => {}}
            onPause={() => {}}
            onResume={() => {}}
            onRetry={() => {}}
            onCancel={() => {}}
            onDelete={() => {}}
            onRebaseAndReview={() => {}}
            onAnswerCeiling={(runId, choice, limits) =>
              answers.push([runId, choice, limits])
            }
          />
        </DialogProvider>,
      );
    });

  // Below the start-form bound: the raise is offered and names the next
  // number.
  render(gate(2));
  const text = () => container!.textContent ?? "";
  expect(text()).toMatch(/reached its review-pass ceiling/);
  expect(text()).toMatch(/would ship work no review pass has accepted/);
  const raise = () =>
    [...container!.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Allow "),
    );
  expect(raise(), "the raise is offered").toBeDefined();
  // The control starts where the run's own history points, not at one. A run
  // needing four more passes used to be four separate interruptions, each
  // granting a decision the user had already made.
  expect(raise()?.textContent).toBe("Allow 2 more");
  act(() => {
    raise()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(answers).toEqual([
    ["7", "raise", { mode: "raise-by", amounts: { maxReviewPasses: 2 } }],
  ]);

  // AT that bound the raise stays on offer with the next number: the bound
  // guards the start form against a typo, while this gate is the user's
  // explicit decision to let the run continue.
  answers.length = 0;
  render(gate(5));
  const slider = container!.querySelector<HTMLInputElement>(
    'input[aria-label="Additional review passes"]',
  );
  expect(slider, "the raise amount uses a slider").not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(slider, "4");
    slider!.dispatchEvent(new Event("input", { bubbles: true }));
    slider!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(raise()?.textContent).toBe("Allow 4 more");
  act(() => {
    raise()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(answers).toEqual([
    ["7", "raise", { mode: "raise-by", amounts: { maxReviewPasses: 4 } }],
  ]);
  expect(
    [...container!.querySelectorAll("button")].some(
      (button) => button.textContent === "Deliver as it stands",
    ),
    "the other choices remain",
  ).toBe(true);
});

/** Render one projection against a paused run, with recorded callbacks. */
function renderPaused(
  projection: CardProjection,
  calls: { resume: string[]; cancel: string[]; ceiling: string[] } = {
    resume: [],
    cancel: [],
    ceiling: [],
  },
): typeof calls {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycle: "paused" }}
          card={projection}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={(runId) => calls.resume.push(runId)}
          onRetry={() => {}}
          onCancel={(runId) => calls.cancel.push(runId)}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={(_runId, choice) => calls.ceiling.push(choice)}
        />
      </DialogProvider>,
    );
  });
  return calls;
}

const hasButton = (label: string): boolean =>
  [...container!.querySelectorAll("button")].some(
    (button) => button.textContent === label,
  );

it("offers Resume only when the server says it would move the run", () => {
  // The "control that cannot complete" case: a pause the recipe re-derives from
  // the same history — a `fail` verdict is the reachable one — comes straight
  // back the instant Resume is pressed. The server decides; the card obeys.
  renderPaused({ ...card, canResume: false, canRetry: false });
  expect(hasButton("Resume"), "no Resume on a settled pause").toBe(false);
  expect(hasButton("Cancel"), "cancel is still the way out").toBe(true);

  const calls = renderPaused({ ...card, canResume: true, canRetry: false });
  expect(hasButton("Resume")).toBe(true);
  click("Resume");
  expect(calls.resume).toEqual(["7"]);
});

it("announces a cancellation in flight and withdraws every control", () => {
  // The server withdraws them all — Resume, Retry and rebase-and-review are
  // each refused while a cancellation settles — so the card must not render
  // any of them. Cancel itself stays: asking twice is harmless.
  renderPaused({
    ...card,
    cancelRequested: true,
    canResume: false,
    canRetry: false,
    canRebaseAndReview: false,
  });
  expect(container!.textContent).toMatch(/[Cc]ancelling/);
  expect(hasButton("Resume"), "a cancellation is not undone by Resume").toBe(
    false,
  );
  expect(hasButton("Retry"), "nor by retrying the stopped tail").toBe(false);
  expect(hasButton("Rebase and re-review")).toBe(false);
});

it("offers Look again where the workspace is what refused", () => {
  const calls = renderPaused({
    ...card,
    phase: "ceiling-decision",
    canResume: false,
    ceilingDecision: {
      blocked: "iterations",
      wanted: "deliver abc1234",
      allowedChoices: ["raise", "re-evaluate", "cancel"],
      ceilings: { maxIterations: 3, maxReviewPasses: 2 },
      spent: { iterations: 3, reviewPasses: 1, sessions: 4 },
      headCarriesDiscoveryReview: false,
      suggestedRaise: 2,
    },
  });
  expect(container!.textContent).toContain("Commit or discard the stray work");
  expect(hasButton("Deliver as it stands"), "there is no commit").toBe(false);
  expect(hasButton("Resume"), "the gate is answered, not resumed").toBe(false);
  click("Look again");
  expect(calls.ceiling).toEqual(["re-evaluate"]);
});

it("asks before cancelling from the ceiling gate, like the footer does", async () => {
  // Same irreversible action as the footer's Cancel, so it asks the same
  // question first rather than ending the run on one tap.
  const calls = renderPaused({
    ...card,
    phase: "ceiling-decision",
    canResume: false,
    ceilingDecision: {
      blocked: "iterations",
      wanted: "answer the findings",
      allowedChoices: ["raise", "deliver", "cancel"],
      ceilings: { maxIterations: 3, maxReviewPasses: 2 },
      spent: { iterations: 3, reviewPasses: 1, sessions: 4 },
      headCarriesDiscoveryReview: true,
      suggestedRaise: 2,
    },
  });
  click("Cancel run");
  expect(
    calls.ceiling,
    "nothing happens until the question is answered",
  ).toEqual([]);
  clickInDialog("Cancel run");
  await act(async () => {});
  expect(calls.ceiling).toEqual(["cancel"]);
});

it("does not advise Look again on a gate that has no such choice", () => {
  // Nothing to ship and nothing to re-read: the advice would name a control
  // that does not render.
  renderPaused({
    ...card,
    phase: "ceiling-decision",
    canResume: false,
    ceilingDecision: {
      blocked: "iterations",
      wanted: "answer the findings",
      allowedChoices: ["raise", "cancel"],
      ceilings: { maxIterations: 3, maxReviewPasses: 2 },
      spent: { iterations: 3, reviewPasses: 1, sessions: 4 },
      headCarriesDiscoveryReview: false,
      suggestedRaise: 2,
    },
  });
  expect(container!.textContent).not.toContain("Look again");
  expect(container!.textContent).toContain("Extend the run");
});

it("counts no iteration when the run may spend no fix rounds", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{
            ...run,
            lifecycle: "active",
            limits: { maxIterations: 0, maxReviewPasses: 2 },
          }}
          card={{ ...card, iterationsUsed: 0 }}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(container!.textContent).toContain("no fix rounds");
  expect(container!.textContent).not.toContain("iteration 0 of 0");
});

it("merges the run's pull request from the Task, with the click's own choices", () => {
  const merge = vi.fn();
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, branch: "t370-card" }}
          card={applyPatch(card, {
            phase: "merge",
            mergeDecisionReady: true,
            canResume: false,
            nextAction: "waiting for your merge decision",
            pullRequest: {
              cardId: "pr-1",
              sessionId: "impl-1",
              number: 42,
              url: "https://example.test/pull/42",
              delivery: {
                canMerge: true,
                canCleanUp: false,
                settleStillNeeded: false,
                mergeMethods: ["squash", "merge"],
                defaultMergeMethod: "squash",
              },
            },
          })}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onMerge={merge}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });

  // The user never has to leave the Task for the decision the run stopped for.
  expect(container!.textContent).toContain("Merge below");
  // Only the methods the repository allows.
  expect(container!.textContent).not.toContain("Rebase");
  // Deleting the remote branch is the default, and the card says so before the
  // click rather than after it.
  expect(container!.textContent).toContain(
    "deletes the remote branch t370-card",
  );

  click("Merge commit");
  click("Merge");
  expect(merge).toHaveBeenCalledWith("7", {
    mergeMethod: "merge",
    deleteBranch: true,
  });

  const keepBranch = [
    ...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ][0]!;
  act(() => keepBranch.click());
  click("Merge");
  expect(merge).toHaveBeenLastCalledWith("7", {
    mergeMethod: "merge",
    deleteBranch: false,
  });
});

it("finishes a completed run with one cleanup that also settles it", () => {
  const cleanUp = vi.fn();
  const completed = applyPatch(card, {
    phase: "merge",
    canResume: false,
    canRetry: false,
    nextAction: "the run is complete",
    pullRequest: {
      cardId: "pr-1",
      sessionId: "impl-1",
      number: 42,
      url: "https://example.test/pull/42",
      delivery: {
        canMerge: false,
        canCleanUp: true,
        settleStillNeeded: false,
      },
    },
  });
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycle: "completed" }}
          card={completed}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onMerge={() => {}}
          onCleanUp={cleanUp}
        />
      </DialogProvider>,
    );
  });

  // What the one click does, in full: this is the click that ends the run's
  // presence in the Sessions inbox, so it may not be a surprise.
  expect(container!.textContent).toContain("settles every session");
  expect(container!.textContent).toContain("settles the run itself");
  click("Clean up");
  expect(cleanUp).toHaveBeenCalledWith("7");

  // A refusal is rendered where the button is, and the busy action comes from
  // the server rather than from a local guess.
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycle: "completed" }}
          card={applyPatch(completed, {
            pullRequest: {
              cardId: "pr-1",
              sessionId: "impl-1",
              number: 42,
              url: "https://example.test/pull/42",
              delivery: {
                canMerge: false,
                canCleanUp: true,
                settleStillNeeded: false,
                busyAction: "cleanup",
                error: "main does not contain t370-card yet.",
              },
            },
          })}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onMerge={() => {}}
          onCleanUp={cleanUp}
        />
      </DialogProvider>,
    );
  });
  expect(container!.textContent).toContain("does not contain t370-card yet");
  const button = [...container!.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === "Clean up",
  )!;
  expect(button.disabled).toBe(true);
});

function settledCleanupCard(settleStillNeeded: boolean) {
  return applyPatch(card, {
    phase: "merge",
    canResume: false,
    canRetry: false,
    nextAction: "the run is complete",
    pullRequest: {
      cardId: "pr-1",
      sessionId: "impl-1",
      number: 42,
      url: "https://example.test/pull/42",
      delivery: {
        canMerge: false,
        canCleanUp: false,
        cleanedUp: true,
        settleStillNeeded,
      },
    },
  });
}

it("states an unsettled run after cleanup, and nothing once it is settled", () => {
  // The checkout was retired but the run was not settled with it: no control is
  // left to render, and this is the only place saying the run is still sitting
  // in the Sessions inbox. It is a live CONDITION, so it has to disappear the
  // moment the run is settled — a remembered sentence would keep telling the
  // user to go and settle a run they already settled.
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycle: "completed" }}
          card={settledCleanupCard(true)}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onMerge={() => {}}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(container!.textContent).toContain(
    "still waiting for its Settle in the Sessions inbox",
  );
  expect(
    [...container!.querySelectorAll("button")].some(
      (item) => item.textContent?.trim() === "Clean up",
    ),
  ).toBe(false);

  // Settled from the inbox afterwards; the projection stops asking, and so
  // does the card — with no second success note left in its place.
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={{ ...run, lifecycle: "completed" }}
          card={settledCleanupCard(false)}
          sessions={[]}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onMerge={() => {}}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(container!.textContent).not.toContain("waiting for its Settle");
  expect(container!.textContent).toContain("The checkout was cleaned up.");
});
