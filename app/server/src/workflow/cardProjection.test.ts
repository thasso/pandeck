import { describe, expect, it } from "vitest";
import type { WorkflowJsonValue, WorkflowStepStatus } from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import {
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
} from "./codeDeliveryRecipe.ts";
import {
  ASSESSMENT_CONTRACT_ID,
  COMMIT_SYNC_RESULT_CONTRACT_ID,
  IMPLEMENTATION_RESULT_CONTRACT_ID,
  PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID,
  PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID,
} from "./resultContracts.ts";
import {
  canProjectWorkflowRunCard,
  workflowRunCardOf,
} from "./cardProjection.ts";

const TEST_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-test",
  thinkingLevel: "medium",
  credentialProfileId: "profile-1",
  family: "gpt",
} as const;
const ROLE_SETS = {
  implementer: [TEST_MODEL],
  reviewer: [TEST_MODEL],
  fixer: [],
  verdict: [],
};

function run(patch: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: 7,
    taskId: 370,
    recipeId: CODE_DELIVERY_RECIPE_ID,
    recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
    worktreeId: "wt-7",
    branch: "t370-workflow-card",
    lifecycle: "active",
    maxIterations: 3,
    maxReviewPasses: 1,
    config: { coordinator: TEST_MODEL, roles: ROLE_SETS },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function step(
  id: number,
  payload: WorkflowJsonValue,
  patch: Partial<WorkflowStepRow> = {},
): WorkflowStepRow {
  return {
    id,
    runId: 7,
    kind: "agent",
    payload,
    status: "completed",
    attempt: 1,
    createdAt: id,
    updatedAt: id,
    ...patch,
  };
}

function result(
  contractId: string,
  payload: WorkflowJsonValue,
  status: WorkflowStepStatus = "completed",
): Partial<WorkflowStepRow> {
  return {
    status,
    result: {
      status: "completed",
      summary: "done",
      contractId,
      payload,
      submittedAt: 2,
    },
  };
}

describe("workflowRunCardOf", () => {
  it("projects only the exact code-delivery recipe version it understands", () => {
    expect(canProjectWorkflowRunCard(run())).toBe(true);
    expect(canProjectWorkflowRunCard(run({ recipeId: "another-recipe" }))).toBe(
      false,
    );
    expect(
      canProjectWorkflowRunCard(
        run({ recipeVersion: CODE_DELIVERY_RECIPE_VERSION + 1 }),
      ),
    ).toBe(false);
    expect(() =>
      workflowRunCardOf(run({ recipeId: "another-recipe" }), []),
    ).toThrow(/no Workflow Run card projection is registered/);
  });

  it("projects phase, activity, role sessions, iterations, and stale review evidence", () => {
    const history = [
      step(
        1,
        {
          role: "implementer",
          objective: "implement",
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "impl-1" },
          ...result(IMPLEMENTATION_RESULT_CONTRACT_ID, {}),
        },
      ),
      step(
        2,
        { operation: "commit-sync", idempotencyKey: "same-key" },
        {
          kind: "host-operation",
          ...result(COMMIT_SYNC_RESULT_CONTRACT_ID, {
            baseCommit: "aaa",
            headCommit: "bbb",
          }),
        },
      ),
      step(
        3,
        {
          role: "reviewer",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "review-1" },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "revise",
            headCommit: "older",
            findings: [{ severity: "major", text: "fix it" }],
            observations: ["naming reads oddly"],
          }),
        },
      ),
      step(
        4,
        {
          role: "implementer",
          objective: "revise",
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        {
          status: "running",
          executor: { kind: "session", id: "impl-2" },
        },
      ),
    ];

    expect(workflowRunCardOf(run(), history)).toEqual({
      runId: "7",
      phase: "implement",
      activity: "running",
      implementerSessionId: "impl-2",
      reviewerSessions: [{ pass: 1, sessionId: "review-1" }],
      iterationsUsed: 1,
      latestAssessment: {
        verdict: "revise",
        headCommit: "older",
        stale: true,
        summary: "done",
        findings: [{ severity: "major", text: "fix it" }],
        observations: ["naming reads oddly"],
      },
      nextAction: "Working: implementation",
      mergeDecisionReady: false,
      canRebaseAndReview: false,
      canRetry: false,
      // An ACTIVE run has nothing to resume.
      canResume: false,
    });
  });

  it("normalizes legacy string findings while reading persisted assessments", () => {
    const card = workflowRunCardOf(run(), [
      step(
        1,
        {
          role: "reviewer",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "review-1" },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "revise",
            headCommit: "bbb",
            findings: ["legacy finding"],
          }),
        },
      ),
    ]);
    expect(card.latestAssessment?.findings).toEqual([
      { severity: "major", text: "legacy finding" },
    ]);
  });

  it("rolls up the published review set with what the fix round left on it", () => {
    const reviewed = [
      step(
        1,
        {
          role: "reviewer",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "review-1" },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "revise",
            headCommit: "bbb",
            reviewSetId: "set-1",
            findings: [
              {
                severity: "major",
                text: "fix the race",
                path: "src/lock.ts",
                line: 12,
                commentId: "thread-1",
              },
              {
                severity: "minor",
                text: "rename the helper",
                path: "src/lock.ts",
                line: 40,
                commentId: "thread-2",
              },
              { severity: "minor", text: "no anchor, no thread" },
            ],
          }),
        },
      ),
    ];

    // Before a fix round, every published finding is simply unanswered.
    expect(workflowRunCardOf(run(), reviewed).reviewSet).toEqual({
      id: "set-1",
      findingCount: 2,
      resolvedCount: 0,
      disputedCount: 0,
      openCount: 2,
    });

    const fixed = [
      ...reviewed,
      step(
        2,
        {
          role: "implementer",
          objective: "revise",
          reviewSetId: "set-1",
          resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "fix-1" },
          ...result(IMPLEMENTATION_RESULT_CONTRACT_ID, {
            reviewSetId: "set-1",
            resolutions: [
              { commentId: "thread-1", state: "resolved" },
              {
                commentId: "thread-2",
                state: "disputed",
                response: "the name matches the caller",
              },
            ],
          }),
        },
      ),
    ];
    expect(workflowRunCardOf(run(), fixed).reviewSet).toEqual({
      id: "set-1",
      findingCount: 2,
      resolvedCount: 1,
      disputedCount: 1,
      openCount: 0,
    });

    // A passing verdict publishes an approving set of its own. The card must
    // keep showing what the answered findings came to rather than that set's
    // zeroes — the finished run is exactly where a reader looks for them.
    const judged = [
      ...fixed,
      step(
        3,
        {
          role: "verdict",
          objective: "verdict",
          reviewSetId: "set-1",
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "verdict-1" },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "pass",
            headCommit: "ccc",
            reviewSetId: "set-2",
            findings: [],
          }),
        },
      ),
    ];
    const card = workflowRunCardOf(run(), judged);
    expect(card.latestAssessment?.verdict).toBe("pass");
    expect(card.reviewSet).toEqual({
      id: "set-1",
      findingCount: 2,
      resolvedCount: 1,
      disputedCount: 1,
      openCount: 0,
    });
  });

  it("projects an open ceiling gate, and answers it instead of resuming", () => {
    const gate = step(
      9,
      {
        decision: "raise-ceilings",
        blocked: "iterations",
        wanted: "answer the findings raised against bbb",
        allowedChoices: ["raise", "deliver", "cancel"],
        reviewedHeadCommit: "bbb",
        spent: { iterations: 3, reviewPasses: 1, sessions: 4 },
        headCarriesDiscoveryReview: true,
      },
      { kind: "user-decision", status: "running" },
    );
    const card = workflowRunCardOf(run({ lifecycle: "paused" }), [gate]);

    expect(card.ceilingDecision).toEqual({
      blocked: "iterations",
      wanted: "answer the findings raised against bbb",
      allowedChoices: ["raise", "deliver", "cancel"],
      // The RUN's current ceilings, not the ones the gate was opened with: a
      // raise that already landed must not be offered again as if it had not.
      ceilings: { maxIterations: 3, maxReviewPasses: 1 },
      spent: { iterations: 3, reviewPasses: 1, sessions: 4 },
      headCarriesDiscoveryReview: true,
      // This fixture predates the gate carrying a suggestion, so the control
      // starts where it always did. A row written before the field exists must
      // still project something the slider can use.
      suggestedRaise: 1,
    });
    expect(card.canResume, "the gate is answered, not resumed").toBe(false);
  });

  it("projects a cancellation in flight and stops offering Resume", () => {
    const card = workflowRunCardOf(
      run({ lifecycle: "paused", cancelRequestedAt: 5 }),
      [
        step(
          1,
          { role: "implementer", objective: "implement" },
          { status: "running", executor: { kind: "session", id: "impl-1" } },
        ),
      ],
    );
    expect(card.cancelRequested).toBe(true);
    expect(card.canResume, "a cancellation is not undone by Resume").toBe(
      false,
    );
  });

  it("offers no control at all while a cancellation is settling", () => {
    // Every control, not just Resume: the engine refuses Retry and
    // rebase-and-review while a cancellation is pending, so a card offering
    // them renders buttons that can only fail. Durable, not a flicker — boot
    // logs and moves on when settling fails, leaving this exact state.
    const failed = step(
      1,
      { role: "implementer", objective: "implement" },
      {
        status: "failed",
        executor: { kind: "session", id: "impl-1" },
        ...result(IMPLEMENTATION_RESULT_CONTRACT_ID, {}, "failed"),
      },
    );
    const conflicted = step(
      2,
      {
        condition: "pull-request-ready",
        cardId: "pr-12",
        reviewedHeadCommit: "bbb",
      },
      {
        kind: "wait",
        ...result(PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID, {
          outcome: "base-conflict",
          headCommit: "bbb",
          reason: "conflicts with base",
        }),
      },
    );

    const stopped = run({ lifecycle: "paused" });
    expect(workflowRunCardOf(stopped, [failed]).canRetry).toBe(true);
    expect(
      workflowRunCardOf({ ...stopped, cancelRequestedAt: 5 }, [failed])
        .canRetry,
      "Retry is withdrawn while the cancellation settles",
    ).toBe(false);

    expect(workflowRunCardOf(stopped, [conflicted]).canRebaseAndReview).toBe(
      true,
    );
    expect(
      workflowRunCardOf({ ...stopped, cancelRequestedAt: 5 }, [conflicted])
        .canRebaseAndReview,
      "and so is rebase-and-review",
    ).toBe(false);
  });

  it("counts the re-check's settlement snapshot, not what it set out to do", () => {
    // Once the author has re-checked, the card counts what the SERVER READ BACK
    // off the threads — settlement is best-effort per thread, so a resolution
    // that failed leaves the thread open and the card has to keep saying open.
    // Deriving the counts from the assessment instead would announce a
    // transition that never landed.
    const discovery = step(
      1,
      {
        role: "reviewer",
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        resultContract: ASSESSMENT_CONTRACT_ID,
      },
      {
        executor: { kind: "session", id: "review-1" },
        ...result(ASSESSMENT_CONTRACT_ID, {
          verdict: "revise",
          headCommit: "bbb",
          reviewSetId: "set-1",
          findings: [
            {
              severity: "major",
              text: "fix the race",
              path: "src/lock.ts",
              line: 12,
              commentId: "thread-1",
            },
            {
              severity: "minor",
              text: "rename the helper",
              path: "src/lock.ts",
              line: 40,
              commentId: "thread-2",
            },
          ],
        }),
      },
    );
    const fix = step(
      2,
      {
        role: "implementer",
        objective: "revise",
        reviewSetId: "set-1",
        resultContract: IMPLEMENTATION_RESULT_CONTRACT_ID,
      },
      {
        executor: { kind: "session", id: "fix-1" },
        ...result(IMPLEMENTATION_RESULT_CONTRACT_ID, {
          reviewSetId: "set-1",
          resolutions: [
            { commentId: "thread-1", state: "resolved" },
            {
              commentId: "thread-2",
              state: "disputed",
              response: "the name matches the caller",
            },
          ],
        }),
      },
    );
    // The author accepts both answers — but only one thread actually closed.
    const reCheck = step(
      3,
      {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: "set-1",
        resultContract: ASSESSMENT_CONTRACT_ID,
      },
      {
        executor: { kind: "session", id: "review-1" },
        ...result(ASSESSMENT_CONTRACT_ID, {
          verdict: "pass",
          headCommit: "ccc",
          reviewSetId: "set-1",
          findings: [],
          settlement: [
            { commentId: "thread-1", state: "resolved" },
            { commentId: "thread-2", state: "open" },
          ],
        }),
      },
    );

    expect(
      workflowRunCardOf(run(), [discovery, fix, reCheck]).reviewSet,
    ).toEqual({
      id: "set-1",
      findingCount: 2,
      resolvedCount: 1,
      disputedCount: 0,
      openCount: 1,
    });
  });

  it("links the newest session of every review pass", () => {
    const reviewStep = (
      id: number,
      pass: number,
      sessionId: string,
    ): WorkflowStepRow =>
      step(
        id,
        {
          role: "reviewer",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          reviewPass: pass,
          maxReviewPasses: 2,
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: sessionId },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "pass",
            headCommit: "bbb",
            findings: [],
          }),
        },
      );

    // Pass 1 was retried in a replacement session; both passes stay reachable.
    const card = workflowRunCardOf(run({ maxReviewPasses: 2 }), [
      reviewStep(1, 1, "review-1a"),
      reviewStep(2, 1, "review-1b"),
      reviewStep(3, 2, "review-2"),
    ]);
    expect(card.reviewerSessions).toEqual([
      { pass: 1, sessionId: "review-1b" },
      { pass: 2, sessionId: "review-2" },
    ]);
  });

  it("bounds the reviewer's prose and says so rather than hiding it", () => {
    const findings = [
      { severity: "nit" as const, text: "last by severity" },
      { severity: "critical" as const, text: "first by severity" },
      ...Array.from({ length: 23 }, (_, index) => ({
        severity: "minor" as const,
        text: `finding ${index}`,
      })),
    ];

    const card = workflowRunCardOf(run(), [
      step(
        1,
        {
          role: "reviewer",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "review-1" },
          ...result(ASSESSMENT_CONTRACT_ID, {
            verdict: "revise",
            headCommit: "bbb",
            findings,
            observations: ["x".repeat(400)],
          }),
        },
      ),
    ]);

    expect(card.latestAssessment?.findings).toHaveLength(20);
    expect(card.latestAssessment?.findings[0]).toEqual({
      severity: "critical",
      text: "first by severity",
    });
    expect(card.latestAssessment?.observations?.[0]).toHaveLength(301);
    expect(card.latestAssessment?.truncated).toBe(true);
  });

  it("projects the accepted work plan and rationale", () => {
    const plan = step(
      1,
      {
        role: "coordinator",
        objective: "plan",
        roles: ROLE_SETS,
        maxReviewPasses: 2,
        resultContract: "work-plan",
      },
      {
        executor: { kind: "session", id: "coordinator-1" },
        ...result("work-plan", {
          complexity: "high",
          implementer: TEST_MODEL,
          reviewer: TEST_MODEL,
          rationale: "touches protocol and UI",
        }),
      },
    );
    expect(
      workflowRunCardOf(run({ maxReviewPasses: 2 }), [plan]),
    ).toMatchObject({
      phase: "plan",
      coordinatorSessionId: "coordinator-1",
      workPlan: {
        complexity: "high",
        rationale: "touches protocol and UI",
        implementer: {
          provider: "openai-codex",
          modelId: "gpt-test",
          thinkingLevel: "medium",
        },
      },
    });
  });

  it("shows the decision the run carried out, never the runtime it refused", () => {
    const decisionStep = (
      id: number,
      payload: WorkflowJsonValue,
    ): WorkflowStepRow =>
      step(
        id,
        {
          role: "coordinator",
          objective: "review-decision",
          roles: ROLE_SETS,
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          completedReviewPass: 1,
          maxReviewPasses: 2,
          resultContract: "review-decision",
        },
        {
          executor: { kind: "session", id: "coordinator-1" },
          ...result("review-decision", payload),
        },
      );

    const nextPassStep = (id: number): WorkflowStepRow =>
      step(
        id,
        {
          role: "reviewer",
          objective: "review",
          commitRange: { baseCommit: "aaa", headCommit: "bbb" },
          reviewPass: 2,
          maxReviewPasses: 2,
          reviewer: TEST_MODEL,
          focus: ["the migration"],
          resultContract: ASSESSMENT_CONTRACT_ID,
        },
        {
          executor: { kind: "session", id: "review-2" },
          predecessorId: id - 1,
        },
      );

    const accepted = workflowRunCardOf(run({ maxReviewPasses: 2 }), [
      decisionStep(1, {
        decision: "review-again",
        reviewer: TEST_MODEL,
        focus: ["the migration"],
        rationale: "large diff, one pass is thin",
      }),
      nextPassStep(2),
    ]);
    expect(accepted.reviewDecision).toEqual({
      decision: "review-again",
      afterPass: 1,
      rationale: "large diff, one pass is thin",
      focus: ["the migration"],
      reviewer: {
        provider: "openai-codex",
        modelId: "gpt-test",
        thinkingLevel: "medium",
        family: "gpt",
      },
    });

    // A reviewer outside the allowlist is not what the run did: the pass
    // happened on the run's own choice, and THAT is what the card states. The
    // refused runtime never reaches it, and the rationale stays the
    // coordinator's own words about the choice it made.
    const refused = workflowRunCardOf(run({ maxReviewPasses: 2 }), [
      decisionStep(3, {
        decision: "review-again",
        reviewer: { ...TEST_MODEL, modelId: "not-allowed" },
        rationale: "wants a model the run never authorized",
      }),
      nextPassStep(4),
    ]);
    expect(refused.reviewDecision).toEqual({
      decision: "review-again",
      afterPass: 1,
      rationale: "wants a model the run never authorized",
      focus: ["the migration"],
      reviewer: {
        provider: "openai-codex",
        modelId: "gpt-test",
        thinkingLevel: "medium",
        family: "gpt",
      },
    });
  });

  it("shows what the run did with a decision, not what was answered", () => {
    const decision = step(
      1,
      {
        role: "coordinator",
        objective: "review-decision",
        roles: ROLE_SETS,
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        completedReviewPass: 1,
        maxReviewPasses: 2,
        resultContract: "review-decision",
      },
      {
        executor: { kind: "session", id: "coordinator-1" },
        ...result("review-decision", {
          decision: "review-again",
          rationale: "wants a second reader",
        }),
      },
    );
    // The allowlist is only half the run's authority: a replacement coordinator
    // session can consume the last slot, so an allowlist-clean request for
    // another pass still ends at the delivery gate. The card describes THAT —
    // the run delivered — with the coordinator's own words beside it.
    const gate = step(
      2,
      {
        operation: "delivery-gate",
        idempotencyKey: "wf7:delivery-gate:1",
        reviewedHeadCommit: "bbb",
      },
      { kind: "host-operation" },
    );
    expect(
      workflowRunCardOf(run({ maxReviewPasses: 2 }), [decision, gate])
        .reviewDecision,
    ).toMatchObject({
      decision: "deliver",
      afterPass: 1,
      rationale: "wants a second reader",
    });

    const nextPass = step(
      3,
      {
        role: "reviewer",
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        reviewPass: 2,
        maxReviewPasses: 2,
        resultContract: ASSESSMENT_CONTRACT_ID,
      },
      { executor: { kind: "session", id: "review-2" } },
    );
    expect(
      workflowRunCardOf(run({ maxReviewPasses: 2 }), [decision, nextPass])
        .reviewDecision,
    ).toMatchObject({ decision: "review-again", afterPass: 1 });
  });

  it("shows a routed fix as the run carried it out, not as answered", () => {
    // The contract accepts every discriminant for every question, so a
    // coordinator can answer "deliver" to "who fixes this". The recipe routes
    // it anyway; the card must say so rather than telling the user the
    // opposite of what the run is doing.
    const decision = step(
      1,
      {
        role: "coordinator",
        objective: "review-decision",
        question: "route-fix",
        roles: { fixer: [TEST_MODEL] },
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        assessmentStepId: 0,
        completedReviewPass: 1,
        maxReviewPasses: 2,
        resultContract: "review-decision",
      },
      {
        executor: { kind: "session", id: "coordinator-1" },
        ...result("review-decision", {
          decision: "deliver",
          rationale: "answered the wrong question",
        }),
      },
    );
    const fix = step(
      2,
      {
        role: "implementer",
        objective: "revise",
        reviewedCommit: "bbb",
        findings: [{ severity: "major", text: "guard it" }],
        resultContract: "implementation-result",
      },
      { executor: { kind: "session", id: "impl-1" }, predecessorId: 1 },
    );
    expect(
      workflowRunCardOf(run({ maxReviewPasses: 2 }), [decision, fix])
        .reviewDecision,
    ).toMatchObject({
      decision: "fix",
      assignee: "implementer",
      rationale: "answered the wrong question",
    });

    // The same holds for the answer the ALLOWLIST refuses: naming a fixer the
    // run never authorized still routes the findings, to the implementer, and
    // the card describes that rather than dropping the entry.
    const unauthorized = step(
      3,
      {
        role: "coordinator",
        objective: "review-decision",
        question: "route-fix",
        roles: { fixer: [TEST_MODEL] },
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        assessmentStepId: 0,
        completedReviewPass: 1,
        maxReviewPasses: 2,
        resultContract: "review-decision",
      },
      {
        executor: { kind: "session", id: "coordinator-1" },
        ...result("review-decision", {
          decision: "fix",
          assignee: "fixer",
          fixer: { ...TEST_MODEL, modelId: "not-allowed" },
          rationale: "wants a fixer the run never authorized",
        }),
      },
    );
    const routedToImplementer = step(
      4,
      {
        role: "implementer",
        objective: "revise",
        reviewedCommit: "bbb",
        findings: [{ severity: "major", text: "guard it" }],
        resultContract: "implementation-result",
      },
      { executor: { kind: "session", id: "impl-1" }, predecessorId: 3 },
    );
    const projected = workflowRunCardOf(run({ maxReviewPasses: 2 }), [
      unauthorized,
      routedToImplementer,
    ]).reviewDecision;
    expect(projected).toMatchObject({
      decision: "fix",
      assignee: "implementer",
      rationale: "wants a fixer the run never authorized",
    });
    expect(projected?.fixer).toBeUndefined();
  });

  it("shows the focus a fix round was actually given", () => {
    // The card is the only surface where the coordinator's decision reaches the
    // user, and on a routing question the focus is the part of it that changed
    // what an agent did. Read from the round the run appended, like everything
    // else here, so a focus the payload never carried is never shown.
    const decision = step(
      1,
      {
        role: "coordinator",
        objective: "review-decision",
        question: "route-fix",
        roles: { fixer: [TEST_MODEL] },
        commitRange: { baseCommit: "aaa", headCommit: "bbb" },
        assessmentStepId: 0,
        completedReviewPass: 1,
        maxReviewPasses: 2,
        resultContract: "review-decision",
      },
      {
        executor: { kind: "session", id: "coordinator-1" },
        ...result("review-decision", {
          decision: "fix",
          assignee: "fixer",
          fixer: TEST_MODEL,
          focus: ["the lock is missing on every retry path"],
          rationale: "a targeted correction",
        }),
      },
    );
    const fix = step(
      2,
      {
        role: "implementer",
        objective: "revise",
        reviewedCommit: "bbb",
        findings: [{ severity: "major", text: "guard it" }],
        fixer: TEST_MODEL,
        focus: ["the lock is missing on every retry path"],
        resultContract: "implementation-result",
      },
      { executor: { kind: "session", id: "impl-1" }, predecessorId: 1 },
    );
    expect(
      workflowRunCardOf(run({ maxReviewPasses: 2 }), [decision, fix])
        .reviewDecision,
    ).toMatchObject({
      decision: "fix",
      assignee: "fixer",
      focus: ["the lock is missing on every retry path"],
    });
  });

  it("links publication to the existing live PR card without copying its state", () => {
    const publication = step(
      9,
      {
        operation: "publish-pull-request",
        reviewedHeadCommit: "bbb",
        idempotencyKey: "wf7:publish-pull-request:8",
      },
      {
        kind: "host-operation",
        ...result(PUBLISH_PULL_REQUEST_RESULT_CONTRACT_ID, {
          outcome: "published",
          reviewedHeadCommit: "bbb",
          cardId: "pr-12",
          sessionId: "impl-1",
          provider: "github",
          number: 12,
          url: "https://example.test/pull/12",
        }),
      },
    );

    expect(workflowRunCardOf(run(), [publication])).toMatchObject({
      phase: "delivery",
      pullRequest: {
        cardId: "pr-12",
        sessionId: "impl-1",
        number: 12,
        url: "https://example.test/pull/12",
      },
    });
    expect(workflowRunCardOf(run(), [publication])).not.toHaveProperty(
      "pullRequest.ci",
    );
  });

  it("projects merge readiness and the conflict recovery action from the terminal wait", () => {
    const ready = step(
      10,
      {
        condition: "pull-request-ready",
        cardId: "pr-12",
        reviewedHeadCommit: "bbb",
      },
      {
        kind: "wait",
        ...result(PULL_REQUEST_OBSERVATION_RESULT_CONTRACT_ID, {
          outcome: "ready",
          headCommit: "bbb",
        }),
      },
    );
    const mergeDecision = step(
      11,
      {
        decision: "merge-pull-request",
        cardId: "pr-12",
        reviewedHeadCommit: "bbb",
        allowedChoices: ["merge", "cancel"],
      },
      { kind: "user-decision", status: "running" },
    );
    expect(
      workflowRunCardOf(
        run({ lifecycle: "paused", lifecycleReason: "merge decision ready" }),
        [ready, mergeDecision],
      ),
    ).toMatchObject({
      phase: "merge",
      mergeDecisionReady: true,
      canRebaseAndReview: false,
    });

    ready.result!.payload = {
      outcome: "base-conflict",
      headCommit: "bbb",
      reason: "conflicts with base",
    };
    expect(
      workflowRunCardOf(
        run({ lifecycle: "paused", lifecycleReason: "conflicts with base" }),
        [ready],
      ),
    ).toMatchObject({
      mergeDecisionReady: false,
      canRebaseAndReview: true,
    });
  });

  it("shows provisioning and the recipe's next action before any step exists", () => {
    expect(workflowRunCardOf(run(), [])).toMatchObject({
      phase: "starting",
      iterationsUsed: 0,
      nextAction: "Next: planning",
      canRetry: false,
    });
  });

  it("keeps the recipe's would-be action and offers retry only for a failed tail", () => {
    const failed = step(
      1,
      { role: "implementer", objective: "implement" },
      { status: "failed" },
    );
    expect(
      workflowRunCardOf(
        run({ lifecycle: "paused", lifecycleReason: "paused by user" }),
        [failed],
      ),
    ).toMatchObject({
      nextAction: "implement step 1 ended as failed",
      canRetry: true,
    });
  });

  it("never announces a step a paused run will not take", () => {
    // Run 39 ([Task-441](pa://task/441)): the store REFUSED the step the recipe
    // decided, so the card claimed to be waiting on a step that does not exist.
    // What is true is the persisted pause reason.
    const refused =
      "workflow step agent payload is 17372 chars, over the 16000 limit";
    expect(
      workflowRunCardOf(
        run({ lifecycle: "paused", lifecycleReason: refused }),
        [],
      ).nextAction,
    ).toBe(refused);
    // The same for a run paused while a step of its own is still open.
    expect(
      workflowRunCardOf(
        run({ lifecycle: "paused", lifecycleReason: refused }),
        [
          step(
            1,
            { role: "implementer", objective: "implement" },
            { status: "running" },
          ),
        ],
      ).nextAction,
    ).toBe(refused);
  });

  it("projects the stopped tail's own words, which the pause reason never says", () => {
    const blocked = step(
      1,
      { operation: "commit-sync", idempotencyKey: "key-1" },
      {
        kind: "host-operation",
        status: "blocked",
        result: {
          status: "blocked",
          summary:
            "  run rebase blocked: the rebase conflicted and was aborted  ",
          payload: {
            rebaseConflict: {
              files: ["docs/reference/web-diff.md"],
              truncated: false,
              baseBranch: "main",
              originalHead: "a".repeat(40),
            },
          },
          submittedAt: 2,
        },
      },
    );
    const paused = run({
      lifecycle: "paused",
      lifecycleReason: "commit-sync step 1 ended as blocked",
    });
    expect(workflowRunCardOf(paused, [blocked]).blockedReason).toEqual({
      phase: "commit-sync",
      status: "blocked",
      summary: "run rebase blocked: the rebase conflicted and was aborted",
      rebaseConflict: {
        files: ["docs/reference/web-diff.md"],
        baseBranch: "main",
        restored: true,
      },
    });

    // A list broadcast carries a bounded copy; the step keeps the full text.
    const long = "x".repeat(400);
    const cut = workflowRunCardOf(paused, [
      step(1, blocked.payload, {
        ...blocked,
        result: { ...blocked.result!, summary: long },
      }),
    ]).blockedReason;
    expect(cut?.summary).toBe(`${"x".repeat(300)}…`);
  });

  it("does not claim a failed repair was restored without host verification", () => {
    const repair = step(
      2,
      {
        role: "implementer",
        objective: "repair-rebase",
        files: ["conflict.ts"],
        truncated: true,
        baseBranch: "main",
        originalHead: "a".repeat(40),
        resultContract: "implementation-result",
      },
      {
        status: "blocked",
        result: {
          status: "blocked",
          summary: "could not resolve safely",
          submittedAt: 2,
        },
      },
    );
    const paused = run({ lifecycle: "paused", lifecycleReason: "blocked" });
    expect(workflowRunCardOf(paused, [repair]).blockedReason).toMatchObject({
      rebaseConflict: {
        files: ["conflict.ts"],
        baseBranch: "main",
        restored: false,
        truncated: true,
      },
    });

    repair.result!.payload = {
      rebaseRepairSafety: {
        verified: true,
        restored: true,
        originalHead: "a".repeat(40),
      },
    };
    expect(workflowRunCardOf(paused, [repair]).blockedReason).toMatchObject({
      rebaseConflict: { restored: true },
    });
  });

  it("says whose words a stopped tail carries after an automatic triage", () => {
    const failedOperation = {
      operation: "commit-sync",
      phase: "commit-sync",
      stepId: 1,
      status: "failed",
      summary: "push rejected: non-fast-forward",
      attempts: 2,
      idempotencyKey: "wf1:commit-sync:1",
    };
    const failed = step(
      1,
      { operation: "commit-sync", idempotencyKey: "wf1:commit-sync:1" },
      {
        kind: "host-operation",
        status: "failed",
        result: {
          status: "failed",
          summary: "push rejected: non-fast-forward",
          submittedAt: 2,
        },
      },
    );
    const triage = step(
      2,
      {
        role: "implementer",
        objective: "triage-operation",
        failedOperation,
        resultContract: "implementation-result",
      },
      {
        status: "blocked",
        predecessorId: 1,
        result: {
          status: "blocked",
          summary: "the remote tip is a head this run never recorded",
          submittedAt: 2,
        },
      },
    );
    const paused = run({ lifecycle: "paused", lifecycleReason: "blocked" });

    // Stopped ON the triage: the summary is the agent's diagnosis, and without
    // host evidence the card does not claim Git was left as it was found.
    expect(
      workflowRunCardOf(paused, [failed, triage]).blockedReason,
    ).toMatchObject({
      operationTriage: {
        phase: "commit-sync",
        stoppedOn: "triage",
        restored: false,
      },
    });
    triage.result!.payload = {
      operationTriageSafety: {
        verified: true,
        restored: true,
        originalHead: "a".repeat(40),
      },
    };
    expect(
      workflowRunCardOf(paused, [failed, triage]).blockedReason,
    ).toMatchObject({ operationTriage: { restored: true } });

    // Stopped on the operation the triage handed back: its budget is spent, so
    // the card still names the triage — but the summary is the host's error.
    const completed = step(2, triage.payload, {
      status: "completed",
      predecessorId: 1,
      result: {
        status: "completed",
        summary: "the remote tip is a head this run never recorded",
        contractId: "implementation-result",
        payload: {},
        submittedAt: 2,
      },
    });
    const again = step(
      3,
      { operation: "commit-sync", idempotencyKey: "wf1:commit-sync:2" },
      {
        kind: "host-operation",
        status: "failed",
        predecessorId: 2,
        result: {
          status: "failed",
          summary: "push rejected: non-fast-forward",
          submittedAt: 2,
        },
      },
    );
    expect(
      workflowRunCardOf(paused, [failed, completed, again]).blockedReason,
    ).toMatchObject({
      operationTriage: {
        phase: "commit-sync",
        stoppedOn: "operation",
        restored: true,
      },
    });
  });

  it("projects no blocked reason for a tail that is still open or silent", () => {
    const paused = run({
      lifecycle: "paused",
      lifecycleReason: "dispatch failed",
    });
    // A dispatch failure leaves the step pending: nothing wrote a result.
    expect(
      workflowRunCardOf(paused, [
        step(
          1,
          { role: "implementer", objective: "implement" },
          {
            status: "pending",
          },
        ),
      ]),
    ).toMatchObject({ canRetry: false });
    expect(
      workflowRunCardOf(paused, [
        step(
          1,
          { role: "implementer", objective: "implement" },
          {
            status: "pending",
          },
        ),
      ]).blockedReason,
    ).toBeUndefined();
    // A failed tail whose executor never recorded a summary says nothing more.
    expect(
      workflowRunCardOf(paused, [
        step(
          1,
          { role: "implementer", objective: "implement" },
          {
            status: "failed",
          },
        ),
      ]).blockedReason,
    ).toBeUndefined();
  });

  it("collapses a chain of identical retries into the attempt count", () => {
    const blocked = (id: number, summary: string, predecessorId?: number) =>
      step(
        id,
        { operation: "commit-sync", idempotencyKey: "wf15:commit-sync:164" },
        {
          kind: "host-operation",
          status: "blocked",
          ...(predecessorId !== undefined ? { predecessorId } : {}),
          result: { status: "blocked", summary, submittedAt: 2 },
        },
      );
    const conflicted = "run rebase blocked: the rebase conflicted";
    const paused = run({
      lifecycle: "paused",
      lifecycleReason: "commit-sync step 3 ended as blocked",
    });

    // A first block is simply the block: "attempt 1" would be noise.
    expect(
      workflowRunCardOf(paused, [blocked(1, conflicted)]),
    ).not.toHaveProperty("repeatedAttempts");
    expect(
      workflowRunCardOf(paused, [
        blocked(1, conflicted),
        blocked(2, conflicted, 1),
        blocked(3, conflicted, 2),
      ]).repeatedAttempts,
    ).toBe(3);
    // Three rows, one number: the card never has to show the chain to read it.
    expect(
      workflowRunCardOf(paused, [
        blocked(1, conflicted),
        blocked(2, conflicted, 1),
        blocked(3, "run rebase blocked: the checkout is dirty", 2),
      ]),
    ).not.toHaveProperty("repeatedAttempts");
  });
});
