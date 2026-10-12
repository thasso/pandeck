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
import { DialogProvider } from "./common/dialogs.tsx";

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

/** The "…" menu's actions, read by opening it. */
function menuLabels(): string[] {
  const trigger = container!.querySelector<HTMLButtonElement>(
    'button[aria-label="More run actions"]',
  );
  if (!trigger) return [];
  act(() => trigger.click());
  const labels = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].map((item) => (item.textContent ?? "").trim());
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  return labels;
}

/** Run one of the "…" menu's actions. */
function clickMenuItem(label: string): void {
  act(() =>
    container!
      .querySelector<HTMLButtonElement>(
        'button[aria-label="More run actions"]',
      )!
      .click(),
  );
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((node) => (node.textContent ?? "").trim() === label);
  expect(item, `no “${label}” menu item`).toBeDefined();
  act(() => item!.click());
}

/** Answer the confirmation the control just raised, not the control again. */
function clickInDialog(label: string): void {
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog, "no dialog open").not.toBeNull();
  click(label, dialog!);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  window.localStorage.clear();
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(document.body.textContent).toContain("Review needs a decision");
  expect(
    document.body.textContent!.toLowerCase().split("review needs a decision")
      .length - 1,
  ).toBe(1);
  // The last review in one line: verdict, reviewed commit, and that it is old.
  expect(document.body.textContent).toContain(
    "revise · abcdef12 · 1 finding · outdated",
  );
  expect(document.body.textContent).toContain("Fix round 2 of 3");
  // The evidence is folded until the reader opens it.
  expect(document.body.textContent).not.toContain(
    "retry path is still unguarded",
  );
  click("Review");
  click("Why this plan");
  // The reviewer's own words, which used to reach nothing but its transcript.
  expect(document.body.textContent).toContain("retry path is still unguarded");
  expect(document.body.textContent).toContain(
    "major src/retry.ts:22 — guard the retry path",
  );
  // Where the findings live durably, and what the fix round left on them.
  expect(document.body.textContent).toContain(
    "Review threads on the worktree: 1 resolved, 1 answered, 0 open.",
  );
  expect(document.body.textContent).toContain("the helper name reads oddly");
  expect(document.body.textContent).toContain("Protocol and UI changes");
  // The coordinator's post-review call, which the user would otherwise have to
  // open its session to read.
  expect(document.body.textContent).toContain("took another review pass");
  expect(document.body.textContent).toContain("deserves a second reader");
  expect(document.body.textContent).toContain("the migration");
  // Opening a section is remembered for the next run's card.
  expect(window.localStorage.getItem("workflow-run-review")).toBe("open");
  click("Resume");
  click("Retry");
  expect(resume).toHaveBeenCalledWith("7");
  // No repeated attempts to warn about, so Retry acts straight away.
  expect(retry).toHaveBeenCalledWith("7");
  // Cancelling a run is guarded, and the guard is the app's own dialog: it has
  // to be answered, and declining runs nothing.
  clickMenuItem("Cancel run…");
  await settled();
  clickInDialog("Keep running");
  await settled();
  expect(cancel).not.toHaveBeenCalled();
  clickMenuItem("Cancel run…");
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
        onAnswerCommitCheck={() => {}}
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
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  // The headline only says the run waits; the box says why and what now.
  expect(document.body.textContent).toContain(
    "Paused. Retry once the cause is fixed, or cancel the run.",
  );
  expect(document.body.textContent).toContain("Rebase conflict");
  expect(document.body.textContent).toContain("docs/reference/web-diff.md");
  expect(document.body.textContent).toContain("run branch was restored");
  expect(document.body.textContent).toContain("then Retry");

  // Without a conflict to list, the box is the stopped step's own words.
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
                "commit-sync phase blocked: the pre-commit hook rejected the change",
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(document.body.textContent).toContain("Commit and sync blocked");
  // The box names the step, so its summary drops the step's own prefix.
  expect(document.body.textContent).toContain(
    "The pre-commit hook rejected the change",
  );
  expect(document.body.textContent).not.toContain("phase blocked");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  // The count is said once, in the box; the headline only says the run waits.
  expect(document.body.textContent).not.toContain("attempt 3");
  expect(document.body.textContent).toContain(
    "The last 3 attempts ended the same way.",
  );
  // Discouraged, never refused: a declined confirmation runs nothing, and the
  // user who repaired the condition outside the run can still say yes.
  click("Retry again");
  await settled();
  expect(document.body.textContent).toContain("Retry anyway?");
  expect(document.body.textContent).toContain("ended with the same result");
  expect(document.body.textContent).toContain(
    "Retry re-runs the same assignment",
  );
  // Never a promise that the outcome is fixed — but also never a false reason
  // for it: the executor REUSES the role's session whenever it is still
  // resolvable, so a retry does not get fresh eyes, only another attempt.
  expect(document.body.textContent).toContain(
    "remembers the attempt that stopped",
  );
  expect(document.body.textContent).not.toContain("fresh session");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(
    document.body
      .textContent!.toLowerCase()
      .split("the reviewer rejected this head").length - 1,
  ).toBe(1);
  expect(document.body.textContent).not.toContain("Review failed");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(document.body.textContent).toContain("Pull request#12");
  const link = container!.querySelector("a");
  expect(link?.textContent).toBe("#12");
  expect(link?.getAttribute("href")).toBe("https://example.test/pull/12");
  clickMenuItem("Open live PR card");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(document.body.textContent).toContain("Merged pull request #12.");
  // No delivery state on the card — an older server, or a card the run cannot
  // read — offers no control rather than one whose refusal it cannot predict.
  expect(document.body.textContent).not.toContain("Clean up");
  expect(container!.querySelector("a")?.textContent).toBe("#12");
  // A finished run can still be followed to its PR card, and nothing else.
  expect(menuLabels()).toEqual(["Open live PR card"]);
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(document.body.textContent).not.toContain("Resume");
  // Authorized by the user, through the app's own dialog: the confirming button
  // repeats the control's name, so the answer says what it starts.
  clickMenuItem("Rebase and re-review");
  await settled();
  expect(document.body.textContent).toContain("send through review again?");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });
  // Where the run is working right now, named by its role.
  click("Implementer session");
  expect(open).toHaveBeenCalledWith("impl");
  open.mockClear();
  click("Sessions (1)");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  click("Sessions (2)");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });

  click("Review");
  expect(document.body.textContent).toContain(
    "Shortened here — the reviewer session has the full review.",
  );
});

it("uses a slider to raise by N even at the start-form maximum", async () => {
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
    act(async () => {
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
            onAnswerCommitCheck={() => {}}
          />
        </DialogProvider>,
      );
    });

  // Below the start-form bound: the raise is offered and names the next
  // number.
  await render(gate(2));
  const text = () => document.body.textContent ?? "";
  expect(text()).toContain("Review-pass limit reached");
  expect(text()).toContain(
    "Delivering as it stands ships work no review pass has accepted.",
  );
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
  await render(gate(5));
  const slider = container!.querySelector<HTMLElement>(
    'input[type="range"][aria-label="Additional review passes"]',
  );
  expect(slider, "the raise amount uses a slider").not.toBeNull();
  expect(slider!.getAttribute("aria-valuenow")).toBe("2");
  for (let step = 0; step < 2; step++) {
    await act(async () => {
      slider!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }
  expect(slider!.getAttribute("aria-valuenow")).toBe("4");
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
          onAnswerCommitCheck={() => {}}
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
  expect(menuLabels(), "cancel is still the way out").toContain("Cancel run…");

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
  expect(document.body.textContent).toMatch(/[Cc]ancelling/);
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
  expect(document.body.textContent).toContain(
    "Commit or discard the stray work",
  );
  expect(hasButton("Deliver as it stands"), "there is no commit").toBe(false);
  expect(hasButton("Resume"), "the gate is answered, not resumed").toBe(false);
  click("Look again");
  expect(calls.ceiling).toEqual(["re-evaluate"]);
});

it("asks before cancelling a run waiting at the ceiling gate", async () => {
  // The gate offers no Cancel of its own: the menu's is the one way out, and
  // it asks first rather than ending the run on one tap.
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
  expect(hasButton("Cancel run")).toBe(false);
  clickMenuItem("Cancel run…");
  await settled();
  expect(
    calls.cancel,
    "nothing happens until the question is answered",
  ).toEqual([]);
  clickInDialog("Cancel run");
  await settled();
  expect(calls.cancel).toEqual(["7"]);
  expect(calls.ceiling).toEqual([]);
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
  expect(document.body.textContent).not.toContain("Look again");
  expect(document.body.textContent).toContain("Extend the run");
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
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(document.body.textContent).toContain(
    "No fix rounds · 0 of 2 review passes",
  );
  expect(document.body.textContent).not.toContain("Fix round");
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
          onAnswerCommitCheck={() => {}}
          onMerge={merge}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });

  // The user never has to leave the Task for the decision the run stopped for.
  expect(document.body.textContent).toContain("Ready to merge");
  // Deleting the remote branch is the default, and the card says so before the
  // click rather than after it.
  expect(document.body.textContent).toContain(
    "Completes the run and deletes the remote branch.",
  );

  // Only the methods the repository allows.
  act(() =>
    container!
      .querySelector<HTMLButtonElement>('[aria-label="Merge method"]')!
      .click(),
  );
  const options = () => [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  expect(options().map((option) => option.textContent?.trim())).toEqual([
    "Squash",
    "Merge commit",
  ]);
  act(() =>
    options()
      .find((option) => option.textContent?.trim() === "Merge commit")!
      .click(),
  );
  click("Merge");
  expect(merge).toHaveBeenCalledWith("7", {
    mergeMethod: "merge",
    deleteBranch: true,
  });

  const keepBranch = [
    ...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ][0]!;
  act(() => keepBranch.click());
  expect(document.body.textContent).toContain(
    "Completes the run and keeps the remote branch.",
  );
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
          onAnswerCommitCheck={() => {}}
          onMerge={() => {}}
          onCleanUp={cleanUp}
        />
      </DialogProvider>,
    );
  });

  // What the one click does, in full: this is the click that ends the run's
  // presence in the Sessions inbox, so it may not be a surprise.
  expect(document.body.textContent).toContain(
    "Removes the worktree and local branch, and settles the run.",
  );
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
          onAnswerCommitCheck={() => {}}
          onMerge={() => {}}
          onCleanUp={cleanUp}
        />
      </DialogProvider>,
    );
  });
  expect(document.body.textContent).toContain("does not contain t370-card yet");
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
          onAnswerCommitCheck={() => {}}
          onMerge={() => {}}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });

  expect(document.body.textContent).toContain(
    "this run still waits for its Settle in the Sessions inbox",
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
          onAnswerCommitCheck={() => {}}
          onMerge={() => {}}
          onCleanUp={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(document.body.textContent).not.toContain("waits for its Settle");
  expect(document.body.textContent).toContain("The checkout was cleaned up.");
});

it("puts a refused commit to the user, and asks before committing over it", async () => {
  const answers: [string, string][] = [];
  const renderCheck = (blockers: CardProjection["commitCheckDecision"]) =>
    act(() => {
      root!.render(
        <DialogProvider>
          <WorkflowRunCard
            run={{ ...run, lifecycleReason: "the commit check refused" }}
            card={applyPatch(card, {
              phase: "commit-sync",
              canResume: false,
              canRetry: false,
              implementerSessionId: "impl",
              commitCheckDecision: blockers,
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
            onAnswerCommitCheck={(runId, choice) =>
              answers.push([runId, choice])
            }
          />
        </DialogProvider>,
      );
    });

  renderCheck({
    blockers: [
      { kind: "unrelated", file: "notes.txt", reason: "not part of the task" },
    ],
    allowedChoices: ["send-to-implementer", "commit-anyway"],
    autoFixSpent: false,
    changedBySessionId: "impl",
  });
  expect(document.body.textContent).toContain(
    "Paused until you decide what happens to the refused commit.",
  );
  expect(document.body.textContent).toContain("Commit refused");
  expect(document.body.textContent).toContain("Unrelated change · notes.txt");
  expect(document.body.textContent).toContain("not part of the task");
  expect(document.body.textContent).toContain("implementer's session");

  click("Send back for a fix");
  expect(answers).toEqual([["7", "send-to-implementer"]]);

  // Committing over the check cannot be taken back, so it asks first.
  answers.length = 0;
  click("Commit anyway");
  await settled();
  clickInDialog("Cancel");
  await settled();
  expect(answers).toEqual([]);
  click("Commit anyway");
  await settled();
  clickInDialog("Commit anyway");
  await settled();
  expect(answers).toEqual([["7", "commit-anyway"]]);

  // A secret is never committed over: the server withholds the choice and the
  // card says why.
  renderCheck({
    blockers: [{ kind: "secret", file: ".env", reason: "an API key" }],
    allowedChoices: ["send-to-implementer"],
    autoFixSpent: true,
  });
  expect(document.body.textContent).toContain("Commit refused again");
  expect(document.body.textContent).toContain("A secret must not be committed");
  expect(hasButton("Commit anyway")).toBe(false);
  expect(hasButton("Send back for a fix")).toBe(true);
});

it("names each role's model, thinking level and account", () => {
  act(() => {
    root!.render(
      <DialogProvider>
        <WorkflowRunCard
          run={run}
          card={applyPatch(card, {
            workPlan: {
              ...card.workPlan!,
              implementer: {
                ...card.workPlan!.implementer,
                credentialProfileId: "cp-work",
              },
            },
          })}
          sessions={[]}
          accountNames={{ "cp-work": "Work account" }}
          onOpenSession={() => {}}
          onPause={() => {}}
          onResume={() => {}}
          onRetry={() => {}}
          onCancel={() => {}}
          onDelete={() => {}}
          onRebaseAndReview={() => {}}
          onAnswerCeiling={() => {}}
          onAnswerCommitCheck={() => {}}
        />
      </DialogProvider>,
    );
  });
  expect(document.body.textContent).toContain(
    "Implementergpt-5.6 · High · Work account",
  );
  // A role without a stored account names none.
  expect(document.body.textContent).toContain("Reviewersonnet · Medium");
});
