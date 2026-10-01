/**
 * A legacy card store that cannot be read, or cannot be moved aside, is NOT
 * imported: its records are only in the file, so the store refuses reads rather
 * than reading as empty (no grants would otherwise read as none), and it retries
 * instead of counting the migration done. `node:fs` is wrapped so each failure
 * can be switched on.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const faults = vi.hoisted(() => ({
  open: undefined as string | undefined,
  rename: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string) =>
    Object.assign(new Error(`${code}: injected`), { code });
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      if (faults.open && String(args[0]).includes(faults.open))
        throw fail("EACCES");
      return fs.openSync(...args);
    }) as typeof fs.openSync,
    renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
      if (faults.rename && String(args[0]).includes(faults.rename))
        throw fail("EPERM");
      return fs.renameSync(...args);
    }) as typeof fs.renameSync,
  };
});

const { DATA_DIR } = await import("./config.ts");
const { closeDb } = await import("./db/index.ts");
const { LegacyStoreUnavailableError } =
  await import("./legacyJsonStoreImport.ts");
const cards = await import("./pullRequestCards.ts");
const approvals = await import("./pendingApprovals.ts");

const CARDS = join(DATA_DIR, "pull-request-cards.json");
const APPROVALS = join(DATA_DIR, "pending-approvals.json");

afterEach(() => {
  faults.open = undefined;
  faults.rename = undefined;
});
afterAll(() => closeDb());

function card(id: string) {
  return {
    renderKind: "pullRequest",
    id,
    sessionId: "s1",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    title: id,
    headBranch: "f",
    baseBranch: "main",
    warnings: [],
  };
}

test("an unreadable file is a failed import: the store refuses reads until a restart imports it", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CARDS, JSON.stringify({ cards: [{ card: card("c1") }] }));
  faults.open = "pull-request-cards.json";

  const outcome = cards.importLegacyPullRequestCards();
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.reason : "", /EACCES/);
  assert.throws(
    () => cards.openPullRequestCards(),
    LegacyStoreUnavailableError,
  );
  assert.ok(existsSync(CARDS));

  // Fixed on disk, but no in-process retry: the store stays unavailable (and
  // every client's notice stays true) until the next boot's import.
  faults.open = undefined;
  assert.throws(() => cards.openPullRequestCards(), /restart the server/);
  assert.equal(cards.importLegacyPullRequestCards().kind, "imported");
  assert.deepEqual(
    cards.openPullRequestCards().map((c) => c.id),
    ["c1"],
  );
  assert.equal(existsSync(CARDS), false);
});

test("a corrupt file that cannot be moved aside is reported as not moved, and the store refuses reads", () => {
  writeFileSync(APPROVALS, "{ truncated");
  faults.rename = "pending-approvals.json";

  const outcome = approvals.importLegacyApprovals();
  assert.equal(outcome.kind, "failed");
  assert.match(
    outcome.kind === "failed" ? outcome.reason : "",
    /could not be moved aside: EPERM/,
  );
  assert.ok(existsSync(APPROVALS), "left exactly where it was");
  assert.throws(
    () => approvals.approvalGrantsForSession("s1"),
    LegacyStoreUnavailableError,
  );

  faults.rename = undefined;
  assert.equal(approvals.importLegacyApprovals().kind, "quarantined");
  assert.deepEqual(approvals.approvalGrantsForSession("s1"), []);
});

test("an imported file that cannot be renamed still completes: its records are in SQLite", () => {
  writeFileSync(CARDS, JSON.stringify({ cards: [{ card: card("c2") }] }));
  faults.rename = "pull-request-cards.json";
  const outcome = cards.importLegacyPullRequestCards();
  assert.equal(outcome.kind, "imported");
  assert.equal(outcome.kind === "imported" ? outcome.backup : "x", undefined);
  assert.ok(cards.pullRequestCardById("c2"));
  assert.ok(
    existsSync(CARDS),
    "the next boot finds it recorded and renames it",
  );

  faults.rename = undefined;
  const again = cards.importLegacyPullRequestCards();
  assert.equal(again.kind === "imported" ? again.imported : -1, 0);
  assert.equal(existsSync(CARDS), false);
});
