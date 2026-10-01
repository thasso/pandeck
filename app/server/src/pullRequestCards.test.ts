import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type {
  DisplayMessage,
  PullRequestCard,
  TaskSummary,
} from "@assistant/shared";
import { closeDb, getDb } from "./db/index.ts";
import { pullRequestCardStore } from "./db/pullRequestCardStore.ts";
import {
  beginPullRequestCardObservation,
  cardsForSession,
  choosingTaskSessionIds,
  createPullRequestCard,
  hasChoosingTaskCard,
  patchPullRequestCard,
  patchPullRequestCardObservation,
  pullRequestCardById,
  pullRequestCardLinksByPullRequest,
  pullRequestCardRecord,
  pullRequestSummariesBySession,
  resetPullRequestCardsStoreForTests,
  setPullRequestCardBroadcastForTests,
  subscribeChoosingTaskCardChanges,
  withPullRequestCardBlocks,
} from "./pullRequestCards.ts";

const context = {
  repoRoot: "/tmp/repo",
  sessionKind: "developer" as const,
  sessionId: "session-1",
  headBranch: "feature",
  baseBranch: "main",
  draft: false,
};

afterEach(() => {
  resetPullRequestCardsStoreForTests();
  setPullRequestCardBroadcastForTests(null);
});

test("a created card is readable back by id and by session", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
    },
    context,
  );

  assert.equal(pullRequestCardById(card.id)?.number, 42);
  assert.deepEqual(
    cardsForSession("session-1").map((c) => c.id),
    [card.id],
  );
  assert.deepEqual(cardsForSession("other-session"), []);
});

test("patching updates the card in place and bumps updatedAt", async () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-1",
      status: "creating",
      title: "feature",
      headBranch: "feature",
      baseBranch: "main",
    },
    context,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));

  const updated = patchPullRequestCard(card.id, {
    status: "open",
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
  });

  assert.equal(updated.status, "open");
  assert.equal(updated.number, 7);
  assert.ok(updated.updatedAt > card.updatedAt);
  assert.equal(pullRequestCardById(card.id)?.number, 7);
});

test("patchPullRequestCard throws for an unknown card", () => {
  assert.throws(
    () => patchPullRequestCard("nope", { status: "failed" }),
    /not found/,
  );
});

test("a card survives reopening the database (persistence)", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-2",
      status: "open",
      title: "Persisted",
      headBranch: "feature",
      baseBranch: "main",
      provider: "forgejo",
      number: 9,
    },
    { ...context, sessionId: "session-2" },
  );

  // A new connection holds nothing this process remembered, so this doubles
  // as the "does it survive a restart" check without restarting the process.
  closeDb();
  assert.equal(pullRequestCardById(card.id)?.number, 9);
  assert.equal(
    pullRequestSummariesBySession().get("session-2")?.number,
    9,
    "a reopened database rebuilds the session index",
  );
  const record = pullRequestCardRecord(card.id);
  assert.equal(record?.context.repoRoot, "/tmp/repo");
});

test("broadcasts fire on create and on patch", () => {
  const broadcasts: string[] = [];
  setPullRequestCardBroadcastForTests((card) => broadcasts.push(card.status));

  const card = createPullRequestCard(
    {
      sessionId: "session-3",
      status: "creating",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
    },
    context,
  );
  patchPullRequestCard(card.id, { status: "open" });

  assert.deepEqual(broadcasts, ["creating", "open"]);
});

test("the session index narrows a card to what a row states", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-4",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      body: ["A long drafted body a row must never carry."],
      warnings: ["noisy"],
      // The heaviest thing a card carries, and the clearest thing a row must
      // not: partial on purpose, since the summary may not read any of it.
      linkedTask: {
        id: "342",
        title: "Show PR-card indicators",
        status: "doing",
      } as TaskSummary,
    },
    { ...context, sessionId: "session-4" },
  );
  patchPullRequestCard(card.id, {
    ci: { state: "failure", total: 3 },
    review: { changesRequested: true },
    conflicts: true,
  });

  assert.deepEqual(pullRequestSummariesBySession().get("session-4"), {
    status: "open",
    number: 42,
    ci: { state: "failure", total: 3 },
    review: { changesRequested: true },
    conflicts: true,
  });
  assert.equal(pullRequestSummariesBySession().get("nobody"), undefined);
});

test("a session's row states the card that is still moving", () => {
  // The NUMBER is the discriminator here because it is what a row shows: the
  // summary carries no card id, having no reader for one.
  const card = (
    sessionId: string,
    status: "open" | "failed" | "merged",
    number: number,
  ) =>
    createPullRequestCard(
      {
        sessionId,
        status,
        number,
        title: status,
        headBranch: "f",
        baseBranch: "main",
      },
      { ...context, sessionId },
    );

  card("session-5", "merged", 1);
  const live = card("session-5", "open", 2);
  assert.deepEqual(
    pullRequestSummariesBySession().get("session-5"),
    { status: "open", number: 2 },
    "a live card outranks the terminal one, whatever their order",
  );

  // Terminal on both sides: the newest one speaks, so a re-run `/pr` that also
  // failed does not leave the first failure on the row.
  card("session-6", "failed", 3);
  card("session-6", "merged", 4);
  assert.deepEqual(pullRequestSummariesBySession().get("session-6"), {
    status: "merged",
    number: 4,
  });

  // And a card that LEAVES the live rung hands the row to nothing older: it is
  // still the newest card the session has.
  patchPullRequestCard(live.id, { status: "closed" });
  assert.deepEqual(pullRequestSummariesBySession().get("session-5"), {
    status: "closed",
    number: 2,
  });
});

test("the session index is rebuilt after every write", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-7",
      status: "creating",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
    },
    { ...context, sessionId: "session-7" },
  );
  assert.equal(
    pullRequestSummariesBySession().get("session-7")?.status,
    "creating",
  );
  // Each write marks its session stale, and the next read refreshes it.
  patchPullRequestCard(card.id, { status: "open", number: 7 });
  assert.deepEqual(pullRequestSummariesBySession().get("session-7"), {
    status: "open",
    number: 7,
  });
});

test("only a patch that changes the ROW asks for a session-list rebuild", () => {
  const rows: boolean[] = [];
  setPullRequestCardBroadcastForTests((_card, rowChanged) =>
    rows.push(rowChanged),
  );

  const card = createPullRequestCard(
    {
      sessionId: "session-8",
      status: "open",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
      number: 5,
    },
    { ...context, sessionId: "session-8" },
  );
  // What the watcher does on a quiet poll: patch the card with what it already
  // said. The row cannot have moved, so the list must not be rebuilt for it.
  patchPullRequestCard(card.id, { ci: { state: "success", total: 2 } });
  patchPullRequestCard(card.id, { ci: { state: "success", total: 2 } });
  patchPullRequestCard(card.id, { ci: { state: "failure", total: 2 } });
  // A card the session's row does not state moves nothing either.
  const superseded = createPullRequestCard(
    {
      sessionId: "session-8",
      status: "merged",
      title: "old",
      headBranch: "other",
      baseBranch: "main",
      number: 4,
    },
    { ...context, sessionId: "session-8" },
  );
  patchPullRequestCard(superseded.id, { warnings: ["cosmetic"] });

  assert.deepEqual(rows, [true, true, false, true, false, false]);
});

test("a choosing-task card marks its session as blocked on a Task pick", () => {
  const choosing = createPullRequestCard(
    {
      sessionId: "session-9",
      status: "choosing-task",
      title: "Which Task?",
      headBranch: "feature",
      baseBranch: "main",
    },
    { ...context, sessionId: "session-9" },
  );
  createPullRequestCard(
    {
      sessionId: "session-10",
      status: "open",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
      number: 3,
    },
    { ...context, sessionId: "session-10" },
  );

  assert.equal(hasChoosingTaskCard("session-9"), true);
  assert.equal(hasChoosingTaskCard("session-10"), false);
  assert.deepEqual([...choosingTaskSessionIds()], ["session-9"]);

  // Answering the prompt takes the session out of the set, exactly like an
  // approval leaving `pending`.
  patchPullRequestCard(choosing.id, { status: "creating" });
  assert.equal(hasChoosingTaskCard("session-9"), false);
  assert.deepEqual([...choosingTaskSessionIds()], []);
});

test("a superseded choosing-task card still asks the user", () => {
  createPullRequestCard(
    {
      sessionId: "session-11",
      status: "choosing-task",
      title: "Which Task?",
      headBranch: "feature",
      baseBranch: "main",
    },
    { ...context, sessionId: "session-11" },
  );
  // A newer run takes over the ROW, but the older prompt is still unanswered.
  createPullRequestCard(
    {
      sessionId: "session-11",
      status: "open",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
      number: 9,
    },
    { ...context, sessionId: "session-11" },
  );

  assert.equal(
    pullRequestSummariesBySession().get("session-11")?.status,
    "open",
  );
  assert.equal(hasChoosingTaskCard("session-11"), true);
});

test("answering a card the row does not state still rebuilds the session list", () => {
  const rows: boolean[] = [];
  const choosing = createPullRequestCard(
    {
      sessionId: "session-13",
      status: "choosing-task",
      title: "Which Task?",
      headBranch: "feature",
      baseBranch: "main",
    },
    { ...context, sessionId: "session-13" },
  );
  // The newer card owns the row from here on, so the summary cannot move when
  // the older prompt is answered — but the row's attention badge does.
  createPullRequestCard(
    {
      sessionId: "session-13",
      status: "open",
      title: "x",
      headBranch: "feature",
      baseBranch: "main",
      number: 11,
    },
    { ...context, sessionId: "session-13" },
  );
  setPullRequestCardBroadcastForTests((_card, rowChanged) =>
    rows.push(rowChanged),
  );

  patchPullRequestCard(choosing.id, { status: "creating" });

  // A pi or idle session has no live subscription to fall back on, so this is
  // the ONLY thing that takes "Pick task" off its inbox row.
  assert.deepEqual(rows, [true]);
});

test("the attention seam fires only when the Task-pick answer changes", () => {
  const changes: string[] = [];
  const unsubscribe = subscribeChoosingTaskCardChanges((sessionId) =>
    changes.push(sessionId),
  );

  try {
    const card = createPullRequestCard(
      {
        sessionId: "session-12",
        status: "choosing-task",
        title: "Which Task?",
        headBranch: "feature",
        baseBranch: "main",
      },
      { ...context, sessionId: "session-12" },
    );
    // Neither of these changes whether a human is being asked something.
    patchPullRequestCard(card.id, { warnings: ["cosmetic"] });
    const second = createPullRequestCard(
      {
        sessionId: "session-12",
        status: "choosing-task",
        title: "Which Task, again?",
        headBranch: "feature",
        baseBranch: "main",
      },
      { ...context, sessionId: "session-12" },
    );
    // Answering the first one leaves the second still asking, so the session is
    // still blocked and the seam stays quiet.
    patchPullRequestCard(card.id, { status: "creating" });
    assert.equal(hasChoosingTaskCard("session-12"), true);
    assert.deepEqual(changes, ["session-12"]);

    // Only the LAST prompt resolving clears the session — and that DOES fire.
    patchPullRequestCard(second.id, { status: "creating" });
    assert.equal(hasChoosingTaskCard("session-12"), false);
    assert.deepEqual(changes, ["session-12", "session-12"]);
  } finally {
    unsubscribe();
  }
});

test("withPullRequestCardBlocks anchors a card right after its source tool call", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-4",
      sourceToolCallId: "tool-1",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
    },
    context,
  );

  const base: DisplayMessage[] = [
    {
      id: "a1",
      role: "assistant",
      blocks: [
        {
          kind: "tool",
          toolId: "tool-1",
          name: "/pr",
          args: {},
          output: "",
          isError: false,
          done: true,
        },
      ],
      createdAt: new Date(card.createdAt - 1_000).toISOString(),
    },
    {
      id: "u2",
      role: "user",
      blocks: [{ kind: "text", text: "thanks" }],
      createdAt: new Date(card.createdAt + 1_000).toISOString(),
    },
  ];

  const result = withPullRequestCardBlocks(base, "session-4");
  assert.deepEqual(
    result.map((m) => m.id),
    ["a1", `pull-request-card-${card.id}`, "u2"],
  );
});

test("withPullRequestCardBlocks falls back to timestamp order without a source tool call", () => {
  const card = createPullRequestCard(
    {
      sessionId: "session-5",
      status: "open",
      title: "Add /pr",
      headBranch: "feature",
      baseBranch: "main",
    },
    context,
  );
  const base: DisplayMessage[] = [
    {
      id: "before",
      role: "user",
      blocks: [{ kind: "text", text: "go" }],
      createdAt: new Date(card.createdAt - 1_000).toISOString(),
    },
    {
      id: "after",
      role: "user",
      blocks: [{ kind: "text", text: "later" }],
      createdAt: new Date(card.createdAt + 1_000).toISOString(),
    },
  ];

  const result = withPullRequestCardBlocks(base, "session-5");
  assert.deepEqual(
    result.map((m) => m.id),
    ["before", `pull-request-card-${card.id}`, "after"],
  );
});

// The inventory's join reader: keyed by REPOSITORY and number, read out of the
// card's own pull-request URL. Two cards for the same pull request answer once
// each; a card that never reached a pull request, or whose URL proves no
// repository, contributes nothing rather than joining on its number alone.
test("card links are indexed per repository pull request", () => {
  const acme = "https://git.example/acme/repo/pulls/7";
  const other = "https://git.example/other/repo/pulls/7";
  const shipIt = {
    id: "task-1",
    title: "Ship it",
    status: "doing",
  } as TaskSummary;
  const card = (
    sessionId: string,
    extra: Partial<Parameters<typeof createPullRequestCard>[0]>,
  ) =>
    createPullRequestCard(
      {
        sessionId,
        status: "open",
        title: "Add /pr",
        headBranch: "feature",
        baseBranch: "main",
        ...extra,
      },
      context,
    );

  card("session-a", {
    provider: "github",
    number: 7,
    url: acme,
    linkedTask: shipIt,
  });
  card("session-b", {
    provider: "github",
    number: 7,
    url: acme,
    linkedTask: shipIt,
  });
  // Another repository's #7 — a separate pull request, separate join.
  card("session-other-repo", { provider: "github", number: 7, url: other });
  // No pull request yet, and one whose URL proves no repository.
  card("session-c", { status: "creating" });
  card("session-d", { provider: "github", number: 7, url: "not-a-url" });

  const links = pullRequestCardLinksByPullRequest();

  assert.deepEqual(
    [...links.keys()],
    ["github#acme/repo#7", "github#other/repo#7"],
  );
  assert.deepEqual(links.get("github#acme/repo#7"), {
    sessionIds: ["session-a", "session-b"],
    taskIds: ["task-1"],
  });
  assert.deepEqual(links.get("github#other/repo#7"), {
    sessionIds: ["session-other-repo"],
    taskIds: [],
  });
});

test("the incrementally refreshed session index equals a full rebuild after every write", () => {
  const ids: string[] = [];
  const steps: Array<() => void> = [
    () =>
      ids.push(
        createPullRequestCard(
          {
            sessionId: "p-a",
            status: "creating",
            title: "a1",
            headBranch: "f",
            baseBranch: "main",
          },
          context,
        ).id,
      ),
    () =>
      patchPullRequestCard(ids[0]!, { status: "open", number: 1, draft: true }),
    () =>
      ids.push(
        createPullRequestCard(
          {
            sessionId: "p-a",
            status: "choosing-task",
            title: "a2",
            headBranch: "f",
            baseBranch: "main",
          },
          context,
        ).id,
      ),
    () =>
      ids.push(
        createPullRequestCard(
          {
            sessionId: "p-b",
            status: "open",
            title: "b1",
            headBranch: "f",
            baseBranch: "main",
            number: 5,
          },
          context,
        ).id,
      ),
    () => patchPullRequestCard(ids[1]!, { status: "failed" }),
    () =>
      patchPullRequestCard(ids[0]!, {
        status: "merged",
        draft: undefined,
        ci: { state: "success" } as never,
      }),
    () => patchPullRequestCard(ids[2]!, { conflicts: true }),
    () => patchPullRequestCard(ids[2]!, { status: "closed" }),
  ];
  for (const step of steps) {
    step();
    const incremental = new Map(pullRequestSummariesBySession());
    closeDb(); // a new connection rebuilds the index from every row
    assert.deepEqual(new Map(pullRequestSummariesBySession()), incremental);
  }
  // Neither of p-a's cards is live any more, so the newer one states the row.
  assert.deepEqual(pullRequestSummariesBySession().get("p-a"), {
    status: "failed",
  });
  assert.deepEqual(pullRequestSummariesBySession().get("p-b"), {
    status: "closed",
    number: 5,
    conflicts: true,
  });
});

test("a patch that changes nothing writes nothing, and still reaches the card's viewers", () => {
  const changes = () =>
    (getDb().prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const broadcasts: Array<[string, boolean, boolean]> = [];
  setPullRequestCardBroadcastForTests((card, row, delivery) =>
    broadcasts.push([card.status, row, delivery]),
  );
  const card = createPullRequestCard(
    {
      sessionId: "noop",
      status: "open",
      title: "x",
      headBranch: "f",
      baseBranch: "main",
      number: 3,
    },
    { ...context, sessionId: "noop" },
  );
  broadcasts.length = 0;

  const before = changes();
  const same = patchPullRequestCard(card.id, { status: "open", number: 3 });
  assert.equal(changes(), before, "an unchanged card is not rewritten");
  assert.equal(same.updatedAt, card.updatedAt);
  assert.deepEqual(broadcasts, [["open", false, false]]);

  // The watcher's shape: a new token is real bookkeeping, a snapshot that
  // repeats the card is not.
  const token = beginPullRequestCardObservation(card.id);
  assert.equal(changes(), before + 1);
  assert.equal(pullRequestCardRecord(card.id)?.card.updatedAt, card.updatedAt);
  patchPullRequestCardObservation(card.id, token, { status: "open" });
  assert.equal(changes(), before + 1);
  assert.equal(broadcasts.length, 2);

  patchPullRequestCard(card.id, { actionMessage: "working" });
  assert.equal(changes(), before + 2);
});

test("the index stays equal to a full rebuild when a card moves session and legacy values are malformed", () => {
  // Shapes the retired file store could hold, and so rows its import wrote,
  // that no current write produces.
  const malformed = [
    {
      card: {
        id: "m1",
        sessionId: "m-a",
        status: "open",
        createdAt: "yesterday",
        number: "7",
        ci: "green",
        title: "m1",
      },
    },
    {
      card: {
        id: "m2",
        sessionId: "m-a",
        status: "weird",
        title: "m2",
        draft: 1,
      },
    },
    {
      card: {
        id: "m3",
        sessionId: "m-b",
        status: "merged",
        createdAt: 5,
        review: null,
        title: "m3",
      },
    },
  ];
  for (const { card } of malformed)
    pullRequestCardStore.insert({
      card: card as unknown as PullRequestCard,
      context: {},
    });
  const steps: Array<() => void> = [
    () => {},
    () => patchPullRequestCard("m1", { sessionId: "m-b" }),
    () => patchPullRequestCard("m3", { sessionId: "m-c", status: "open" }),
    () => patchPullRequestCard("m1", { sessionId: "m-a" }),
  ];
  for (const step of steps) {
    step();
    const incremental = new Map(pullRequestSummariesBySession());
    closeDb();
    assert.deepEqual(new Map(pullRequestSummariesBySession()), incremental);
  }
  assert.equal(pullRequestSummariesBySession().get("m-b"), undefined);
  assert.equal(pullRequestSummariesBySession().get("m-c")?.status, "open");
});
