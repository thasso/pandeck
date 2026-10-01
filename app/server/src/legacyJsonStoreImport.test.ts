/**
 * The one-time move of `pull-request-cards.json` and `pending-approvals.json`
 * into SQLite: what is imported, what is kept, and what a crash or a bad file
 * leaves behind. The user's file is never deleted, only renamed.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { ApprovalCard, PullRequestCard } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { closeDb, getDb } from "./db/index.ts";
import { pullRequestCardStore } from "./db/pullRequestCardStore.ts";
import {
  importLegacyJsonStore,
  type LegacyImportOutcome,
} from "./legacyJsonStoreImport.ts";
import {
  cardsForSession,
  choosingTaskSessionIds,
  importLegacyPullRequestCards,
  openPullRequestCards,
  pullRequestCardRecord,
  pullRequestSummariesBySession,
  resetPullRequestCardsStoreForTests,
} from "./pullRequestCards.ts";
import {
  approvalForId,
  approvalGrantsForSession,
  approvalsForSession,
  hasPendingApproval,
  importLegacyApprovals,
  pendingApprovalSessionIds,
} from "./pendingApprovals.ts";

const CARDS = join(DATA_DIR, "pull-request-cards.json");
const APPROVALS = join(DATA_DIR, "pending-approvals.json");

afterAll(() => closeDb());

beforeEach(() => {
  resetPullRequestCardsStoreForTests();
  getDb().exec(
    "DELETE FROM approvals; DELETE FROM approval_grants; DELETE FROM legacy_file_imports",
  );
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of readdirSync(DATA_DIR))
    if (/^(pull-request-cards|pending-approvals)\.json/.test(name))
      rmSync(join(DATA_DIR, name));
});

/** The outcome of an import that completed, narrowed for its counts. */
function done(
  outcome: LegacyImportOutcome,
): Extract<LegacyImportOutcome, { kind: "imported" }> {
  assert.equal(outcome.kind, "imported", JSON.stringify(outcome));
  return outcome as Extract<LegacyImportOutcome, { kind: "imported" }>;
}

/** Files next to the store that are copies of it: backups or quarantines. */
function kept(path: string): string[] {
  const base = path.split("/").at(-1)!;
  return readdirSync(DATA_DIR)
    .filter((name) => name.startsWith(`${base}.`))
    .sort();
}

function card(
  id: string,
  sessionId: string,
  status: PullRequestCard["status"],
  createdAt: number,
  extra: Partial<PullRequestCard> = {},
): PullRequestCard {
  return {
    renderKind: "pullRequest",
    id,
    sessionId,
    status,
    createdAt,
    updatedAt: createdAt,
    title: id,
    headBranch: "feature",
    baseBranch: "main",
    warnings: [],
    ...extra,
  };
}

const context = (sessionId: string) => ({
  repoRoot: "/tmp/repo",
  sessionKind: "developer",
  sessionId,
  headBranch: "feature",
  baseBranch: "main",
  draft: false,
});

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}

test("pull-request cards import in file order, with their context, and the file is kept as a backup", () => {
  const records = [
    {
      card: card("a", "s1", "merged", 10, { number: 1 }),
      context: context("s1"),
    },
    // Same millisecond as the next one: file order decides which is newer.
    {
      card: card("b", "s1", "open", 20, { number: 2, draft: true }),
      context: context("s1"),
    },
    {
      card: card("c", "s1", "closed", 20, { number: 3 }),
      context: context("s1"),
    },
    { card: card("d", "s2", "choosing-task", 5), context: context("s2") },
    {
      card: card("e", "s2", "open", 30, { number: 4, worktreeId: "wt" }),
      context: context("s2"),
    },
  ];
  const text = writeJson(CARDS, { version: 1, cards: records });

  const result = done(importLegacyPullRequestCards());
  assert.equal(result.imported, 5);
  assert.equal(result.invalid + result.duplicates + result.existing, 0);
  assert.equal(existsSync(CARDS), false);
  const backups = kept(CARDS);
  assert.equal(backups.length, 1);
  assert.match(
    backups[0]!,
    /^pull-request-cards\.json\.imported-\d+(-\d+)?\.bak$/,
  );
  assert.equal(readFileSync(join(DATA_DIR, backups[0]!), "utf8"), text);

  for (const record of records)
    assert.deepEqual(pullRequestCardRecord(record.card.id), record);
  assert.deepEqual(
    cardsForSession("s1").map((c) => c.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    openPullRequestCards().map((c) => c.id),
    ["b", "e"],
  );
  // A live card outranks a newer terminal one; within a rung the later wins.
  assert.deepEqual(pullRequestSummariesBySession().get("s1"), {
    status: "open",
    number: 2,
    draft: true,
  });
  assert.deepEqual(pullRequestSummariesBySession().get("s2"), {
    status: "open",
    number: 4,
  });
  assert.deepEqual([...choosingTaskSessionIds()], ["s2"]);
});

test("a crash after the import committed but before the rename only renames on the next boot", () => {
  const text = writeJson(CARDS, {
    version: 1,
    cards: [{ card: card("a", "s1", "open", 1), context: context("s1") }],
  });
  assert.equal(done(importLegacyPullRequestCards()).imported, 1);
  // The same bytes back in place: what a crash between commit and rename leaves.
  writeFileSync(CARDS, text);

  const again = done(importLegacyPullRequestCards());
  assert.equal(again.imported, 0);
  assert.ok(again.backup);
  assert.equal(existsSync(CARDS), false);
  assert.equal(pullRequestCardStore.forSession("s1").length, 1);
  // Two renames, likely inside one millisecond: neither backup replaced the other.
  assert.equal(kept(CARDS).length, 2);
});

test("a crash inside the import commits nothing and leaves the file for the next boot", () => {
  const text = writeJson(CARDS, { cards: [] });
  const outcome = importLegacyJsonStore(CARDS, () => ({
    records: 2,
    invalid: 0,
    duplicates: 0,
    write() {
      pullRequestCardStore.insert({
        card: card("half", "s1", "open", 1),
        context: {},
      });
      throw new Error("power cut");
    },
  }));
  assert.equal(outcome.kind, "failed");
  assert.equal(pullRequestCardStore.get("half"), undefined);
  assert.equal(readFileSync(CARDS, "utf8"), text);
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS n FROM legacy_file_imports").get()?.n,
    0,
  );
});

test("a later file adds its new records and never overwrites a stored one", () => {
  writeJson(CARDS, {
    cards: [{ card: card("a", "s1", "open", 1), context: context("s1") }],
  });
  importLegacyPullRequestCards();
  // An older build run in between writes a fresh file of its own.
  writeJson(CARDS, {
    cards: [
      { card: card("a", "s1", "failed", 1), context: context("s1") },
      { card: card("z", "s9", "open", 2), context: context("s9") },
    ],
  });
  const result = done(importLegacyPullRequestCards());
  assert.equal(result.imported, 1);
  assert.equal(result.existing, 1);
  assert.equal(pullRequestCardRecord("a")?.card.status, "open");
  assert.equal(pullRequestCardRecord("z")?.card.status, "open");
  assert.equal(kept(CARDS).length, 2);
});

test("the first of two records sharing an id wins, and the repeat and a record without an id or session stay in the backup", () => {
  const text = writeJson(CARDS, {
    cards: [
      { card: card("a", "s1", "open", 1), context: context("s1") },
      { card: card("a", "s1", "merged", 2), context: context("s1") },
      { card: { id: "no-session" } },
      null,
      "junk",
    ],
  });
  const result = done(importLegacyPullRequestCards());
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 3);
  assert.equal(pullRequestCardRecord("a")?.card.status, "open");
  // The backup is the file as it was: both records sharing the id are in it.
  assert.equal(readFileSync(result.backup!, "utf8"), text);
});

test("an unparsable file is quarantined, not deleted, and imports nothing", () => {
  writeFileSync(CARDS, "{ truncated");
  const result = importLegacyPullRequestCards();
  assert.equal(result.kind, "quarantined");
  const target = result.kind === "quarantined" ? result.target : "";
  assert.match(target, /pull-request-cards\.json\.corrupt-\d+\.json$/);
  assert.equal(readFileSync(target, "utf8"), "{ truncated");
  assert.equal(existsSync(CARDS), false);
  assert.deepEqual(openPullRequestCards(), []);
});

test("a file that is not a store object is quarantined; an object without records imports none", () => {
  for (const shape of ["null", "[]", "42"]) {
    writeFileSync(APPROVALS, shape);
    assert.equal(importLegacyApprovals().kind, "quarantined", shape);
  }
  // The file store read `{}` as an empty store, and so does the import.
  writeJson(CARDS, {});
  const result = done(importLegacyPullRequestCards());
  assert.equal(result.imported, 0);
  assert.ok(result.backup);
});

test("no file means no import and nothing to report", () => {
  assert.deepEqual(importLegacyPullRequestCards(), { kind: "absent" });
  assert.deepEqual(importLegacyApprovals(), { kind: "absent" });
});

function approval(
  id: string,
  sessionId: string,
  status: ApprovalCard["status"],
  extra: Partial<ApprovalCard> = {},
): ApprovalCard {
  return {
    renderKind: "approval",
    id,
    sessionId,
    kind: "commit",
    status,
    title: id,
    createdAt: 1,
    body: { kind: "commit", message: "m", files: ["a.ts"] },
    ...extra,
  } as ApprovalCard;
}

const legacyJiraFailure = approval("legacy", "s1", "failed", {
  kind: "jiraIssue",
  decision: "approved",
  error:
    "All 1 Jira change(s) failed: add link Relates OPS-96↔OPS-95: permission denied",
  body: {
    kind: "jiraIssue",
    jiraHost: "example.atlassian.net",
    items: [
      {
        clientId: "c1",
        issueKey: "",
        operation: "create",
        createProjectKey: "OPS",
        createIssueType: "Sub-task",
        createSummary: "Test",
        fieldChanges: [],
      },
    ],
  },
} as Partial<ApprovalCard>);

test("approvals import with their context and grants, reconciled as the file store read them", () => {
  const records = [
    { card: approval("p1", "s1", "pending"), context: { cwd: "/w" } },
    {
      card: approval("p2", "s2", "pending", { autoApproved: true }),
      context: {},
    },
    { card: approval("x1", "s1", "executed"), context: {} },
    { card: legacyJiraFailure, context: {} },
  ];
  const grants = [
    { sessionId: "s1", key: "k2", grantedAt: 5, sourceApprovalId: "x1" },
    { sessionId: "s1", key: "k1", grantedAt: 6, sourceApprovalId: "x1" },
    { sessionId: "s2", key: "k1", grantedAt: 7, sourceApprovalId: "p2" },
  ];
  writeJson(APPROVALS, { version: 1, approvals: records, grants });

  const result = done(importLegacyApprovals());
  assert.equal(result.imported, 7);
  assert.equal(existsSync(APPROVALS), false);
  assert.equal(kept(APPROVALS).length, 1);

  assert.deepEqual(
    approvalsForSession("s1").map((c) => c.id),
    ["p1", "x1", "legacy"],
  );
  assert.deepEqual(approvalForId("p1"), records[0]!.card);
  // Grants keep their grant order, not their key order.
  assert.deepEqual(approvalGrantsForSession("s1"), [
    { key: "k2", grantedAt: 5, sourceApprovalId: "x1" },
    { key: "k1", grantedAt: 6, sourceApprovalId: "x1" },
  ]);
  // An auto-approved pending card blocks nobody.
  assert.deepEqual([...pendingApprovalSessionIds()], ["s1"]);
  assert.equal(hasPendingApproval("s2"), false);

  // The reconciled card is what was stored, not just what a read shows.
  const row = getDb()
    .prepare("SELECT card_json FROM approvals WHERE id = 'legacy'")
    .get() as { card_json: string };
  const stored = JSON.parse(row.card_json) as ApprovalCard;
  assert.equal(stored.status, "executed");
  assert.equal(stored.resultSummary, "Created OPS-96 with warnings");
  assert.deepEqual(approvalForId("legacy"), stored);
});

test("an approval without a body is left in the backup instead of failing the import", () => {
  writeJson(APPROVALS, {
    approvals: [
      {
        card: {
          ...approval("nb", "s1", "failed", { decision: "approved" }),
          body: undefined,
        },
        context: {},
      },
      { card: approval("ok", "s1", "executed"), context: {} },
    ],
  });
  const result = done(importLegacyApprovals());
  assert.equal(result.imported, 1);
  assert.equal(result.invalid, 1);
  assert.equal(approvalForId("ok")?.status, "executed");
});

test("a store written before grants existed imports its cards and no grants", () => {
  writeJson(APPROVALS, {
    version: 1,
    approvals: [{ card: approval("p1", "s1", "rejected"), context: {} }],
  });
  assert.equal(done(importLegacyApprovals()).imported, 1);
  assert.deepEqual(approvalGrantsForSession("s1"), []);
  assert.equal(approvalForId("p1")?.status, "rejected");
});

/** A plan inserting the cards the parsed file names, as the domain plans do. */
function cardPlan(onWrite: () => void = () => {}) {
  return (parsed: unknown) => {
    const cards = (parsed as { cards: Array<{ card: PullRequestCard }> }).cards;
    return {
      records: cards.length,
      invalid: 0,
      duplicates: 0,
      write() {
        onWrite();
        return cards.filter((r) =>
          pullRequestCardStore.insert({ card: r.card, context: {} }),
        ).length;
      },
    };
  };
}

const markers = () =>
  (
    getDb().prepare("SELECT COUNT(*) AS n FROM legacy_file_imports").get() as {
      n: number;
    }
  ).n;

test("a file replaced during the import rolls that attempt back and imports only the replacement", () => {
  writeJson(CARDS, { cards: [{ card: card("first", "s1", "open", 1) }] });
  let writes = 0;
  const replacement = writeJsonTo(`${CARDS}.tmp`, {
    cards: [{ card: card("second", "s1", "open", 2) }],
  });
  const outcome = done(
    importLegacyJsonStore(
      CARDS,
      cardPlan(() => {
        // A restore landing mid-import: a NEW inode at the path.
        if ((writes += 1) === 1) renameSync(`${CARDS}.tmp`, CARDS);
      }),
    ),
  );
  assert.equal(writes, 2);
  assert.equal(pullRequestCardStore.get("first"), undefined, "rolled back");
  assert.ok(pullRequestCardStore.get("second"));
  assert.equal(markers(), 1, "only the committed snapshot is recorded");
  // What was renamed aside is the replacement, byte for byte.
  assert.equal(readFileSync(outcome.backup!, "utf8"), replacement);
});

test("a record whose status changes during the import ends in its NEW state", () => {
  writeJson(CARDS, { cards: [{ card: card("same", "s1", "open", 1) }] });
  let writes = 0;
  done(
    importLegacyJsonStore(
      CARDS,
      cardPlan(() => {
        // Same inode, different bytes: the file store's own writeFileSync.
        if ((writes += 1) === 1)
          writeJson(CARDS, {
            cards: [{ card: card("same", "s1", "merged", 1) }],
          });
      }),
    ),
  );
  // `OR IGNORE` would have kept "open" had the first snapshot committed.
  assert.equal(pullRequestCardStore.get("same")?.card.status, "merged");
  assert.equal(existsSync(CARDS), false);
});

test("a file that keeps changing commits nothing, stays in place, and the import reports it failed", () => {
  writeJson(CARDS, { cards: [] });
  let n = 0;
  const outcome = importLegacyJsonStore(
    CARDS,
    cardPlan(() => {
      writeJson(CARDS, {
        cards: [{ card: card(`c${(n += 1)}`, "s1", "open", n) }],
      });
    }),
  );
  assert.equal(outcome.kind, "failed");
  assert.equal(n, 3, "every attempt ran, and each rolled back");
  for (const id of ["c1", "c2", "c3"])
    assert.equal(pullRequestCardStore.get(id), undefined, id);
  assert.equal(markers(), 0);
  assert.ok(existsSync(CARDS), "left for the next attempt");
});

test("a file changed after the commit stays in place for the next boot, which adds only new ids", () => {
  const original = card("kept", "s1", "open", 1);
  writeJson(CARDS, { cards: [{ card: original }] });
  let writes = 0;
  const outcome = done(
    importLegacyJsonStore(
      CARDS,
      cardPlan(() => {
        writes += 1;
      }),
    ),
  );
  assert.ok(outcome.backup);
  // The window after the commit, simulated: a new file at the path.
  writeJson(CARDS, {
    cards: [
      { card: card("kept", "s1", "merged", 1) },
      { card: card("new", "s1", "open", 2) },
    ],
  });
  done(importLegacyPullRequestCards());
  assert.equal(pullRequestCardRecord("kept")?.card.status, "open");
  assert.ok(pullRequestCardRecord("new"));
  assert.equal(writes, 1);
});

test("an unexpected error while importing is a failed outcome, never a throw", () => {
  writeJson(CARDS, { cards: [] });
  const outcome = importLegacyJsonStore(CARDS, () => {
    throw new Error("a plan that cannot cope");
  });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.reason : "", /cannot cope/);
  assert.ok(existsSync(CARDS));
});

test("an approval reconciliation cannot read is invalid, and the rest imports", () => {
  writeJson(APPROVALS, {
    approvals: [
      {
        // Passes the record check, but its Jira body has no items.
        card: approval("bad-jira", "s1", "failed", {
          kind: "jiraIssue",
          decision: "approved",
          error: "x",
          body: { kind: "jiraIssue" } as never,
        }),
        context: {},
      },
      {
        // Items that are not objects: reconciliation itself throws on these.
        card: approval("worse-jira", "s1", "failed", {
          kind: "jiraIssue",
          decision: "approved",
          error: "add link Relates OPS-1↔OPS-2",
          body: { kind: "jiraIssue", items: [null] } as never,
        }),
        context: {},
      },
      { card: approval("fine", "s1", "executed"), context: {} },
    ],
  });
  const result = done(importLegacyApprovals());
  assert.equal(result.imported, 2);
  assert.equal(result.invalid, 1);
  assert.equal(approvalForId("bad-jira")?.status, "failed");
  assert.equal(approvalForId("fine")?.status, "executed");
});

function writeJsonTo(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return text;
}
