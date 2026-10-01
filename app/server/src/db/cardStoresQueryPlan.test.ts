/**
 * The pull-request card and approval stores left their whole-file JSON because
 * every read parsed and every write rewrote the whole history (a 1.7 MB file on
 * every watcher poll). These tests hold the SQLite replacement to what it was
 * for: `EXPLAIN QUERY PLAN` over the EXACT statements the facades export shows
 * each one searching an index, and a recorder on the connection shows the hot
 * paths — a watcher poll, showing a session, a card update, a session-list
 * build — issue only those statements.
 *   pnpm --filter @assistant/server test src/db/cardStoresQueryPlan.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "vitest";

const { getDb, closeDb } = await import("./index.ts");
const { PULL_REQUEST_CARD_SQL } = await import("./pullRequestCardStore.ts");
const { APPROVAL_SQL } = await import("./approvalStore.ts");
const cards = await import("../pullRequestCards.ts");
const approvals = await import("../pendingApprovals.ts");

afterAll(() => closeDb());

beforeEach(() => {
  cards.resetPullRequestCardsStoreForTests();
  getDb().exec("DELETE FROM approvals; DELETE FROM approval_grants");
  cards.setPullRequestCardBroadcastForTests(() => {});
  approvals.setApprovalBroadcastForTests(
    () => {},
    () => {},
  );
});

function planText(sql: string): string {
  const params = Array.from(sql.matchAll(/\?/g), () => "x");
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join("\n");
}

/**
 * A plan reads a bounded set of rows when every table access is a SEARCH, or a
 * scan of the partial pending-approvals index — which holds only pending rows,
 * almost always none.
 */
function assertBounded(name: string, sql: string): void {
  const plan = planText(sql);
  for (const line of plan.split("\n")) {
    if (!/\b(SCAN|SEARCH)\b/.test(line)) continue;
    assert.ok(
      /^SEARCH /.test(line) ||
        /USING (COVERING )?INDEX approvals_pending_idx/.test(line),
      `${name} must not scan a table:\n${plan}`,
    );
  }
}

test("every card statement searches an index", () => {
  for (const [name, sql] of Object.entries(PULL_REQUEST_CARD_SQL))
    if (!/^\s*INSERT/.test(sql)) assertBounded(name, sql);
});

test("every approval and grant statement searches an index", () => {
  for (const [name, sql] of Object.entries(APPROVAL_SQL))
    if (!/^\s*INSERT/.test(sql)) assertBounded(name, sql);
});

/** Every SQL string prepared on the connection while `run` executes. */
function statementsDuring(run: () => void): string[] {
  const db = getDb();
  const prepare = db.prepare.bind(db);
  const seen: string[] = [];
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

const context = {
  repoRoot: "/tmp/repo",
  sessionKind: "developer" as const,
  sessionId: "s-hot",
  headBranch: "feature",
  baseBranch: "main",
  draft: false,
};

const TARGETED = new Set<string>([
  ...Object.values(PULL_REQUEST_CARD_SQL),
  ...Object.values(APPROVAL_SQL),
  "PRAGMA data_version",
]);

function seedHistory(): string {
  // History the hot paths must not touch: other sessions' settled cards.
  for (let i = 0; i < 40; i += 1) {
    const old = cards.createPullRequestCard(
      {
        sessionId: `s-old-${i}`,
        status: "open",
        title: `old ${i}`,
        headBranch: `b${i}`,
        baseBranch: "main",
      },
      { ...context, sessionId: `s-old-${i}` },
    );
    cards.patchPullRequestCard(old.id, { status: "merged" });
  }
  return cards.createPullRequestCard(
    {
      sessionId: "s-hot",
      status: "open",
      title: "hot",
      headBranch: "feature",
      baseBranch: "main",
      provider: "forgejo",
      number: 7,
    },
    context,
  ).id;
}

test("a watcher poll, a card update, a session show and a list build issue only targeted statements", () => {
  const id = seedHistory();
  approvals.createApproval({
    sessionId: "s-hot",
    kind: "commit",
    title: "t",
    body: { kind: "commit", message: "wip", files: ["a.ts"] },
    supersedes: () => true,
  });
  // The index's one full build, before anything is measured.
  cards.pullRequestSummariesBySession();

  const seen = statementsDuring(() => {
    // Watcher: sweep, then one poll with a provider answer that changes nothing.
    cards.openPullRequestCards();
    const record = cards.pullRequestCardRecord(id)!;
    const token = cards.beginPullRequestCardObservation(id);
    cards.patchPullRequestCardObservation(id, token, {
      status: record.card.status,
    });
    // A real card update.
    cards.patchPullRequestCard(id, { actionMessage: "working" });
    // Showing the session.
    approvals.approvalsForSession("s-hot");
    approvals.approvalGrantsForSession("s-hot");
    cards.cardsForSession("s-hot");
    // A session-list build after that write.
    cards.pullRequestSummariesBySession();
    cards.choosingTaskSessionIds();
    approvals.pendingApprovalSessionIds();
  });
  const stray = seen.filter((sql) => !TARGETED.has(sql));
  assert.deepEqual(stray, [], "every statement is a targeted one");
  assert.ok(seen.length > 0);
});

const CARD_TABLES = /\b(pull_request_cards|approvals|approval_grants)\b/;

test("delivery and the workflow run list read the card table only through targeted statements; the whole-table reads are one statement each", async () => {
  const id = seedHistory();
  cards.patchPullRequestCard(id, { worktreeId: "wt-hot", busyAction: "merge" });
  const { workflowRunListMessage } = await import("../workflowRuns.ts");
  cards.pullRequestSummariesBySession();

  const seen = statementsDuring(() => {
    assert.equal(cards.pullRequestCardsForWorktree("wt-hot").length, 1);
    workflowRunListMessage();
  }).filter((sql) => CARD_TABLES.test(sql));
  assert.ok(seen.includes(PULL_REQUEST_CARD_SQL.byWorktree));
  assert.deepEqual(
    seen.filter((sql) => !TARGETED.has(sql)),
    [],
  );

  // Boot's interrupted-action sweep and the inventory's join span every card
  // by design — in ONE statement, never one per card.
  for (const run of [
    () => assert.equal(cards.pullRequestCardsWithBusyAction().length, 1),
    () => cards.pullRequestCardLinksByPullRequest(),
  ]) {
    const scans = statementsDuring(run).filter((sql) => CARD_TABLES.test(sql));
    assert.equal(scans.length, 1, scans.join("\n"));
  }
});
