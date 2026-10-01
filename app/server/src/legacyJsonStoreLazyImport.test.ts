/**
 * The legacy card stores import on their first read, not only from boot — so a
 * script or a read that beats boot still sees every card. Its own file: the
 * "first read" is once per process.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDb, withDbTransaction } from "./db/index.ts";
import { LegacyStoreUnavailableError } from "./legacyJsonStoreImport.ts";
import { openPullRequestCards } from "./pullRequestCards.ts";
import { approvalForId } from "./pendingApprovals.ts";

afterAll(() => closeDb());

const CARDS = join(DATA_DIR, "pull-request-cards.json");
const APPROVALS = join(DATA_DIR, "pending-approvals.json");

test("the first read outside a transaction imports; one inside a caller's transaction refuses", () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    CARDS,
    JSON.stringify({
      cards: [
        {
          card: {
            renderKind: "pullRequest",
            id: "lazy",
            sessionId: "s1",
            status: "open",
            createdAt: 1,
            updatedAt: 1,
            title: "t",
            headBranch: "f",
            baseBranch: "main",
            warnings: [],
          },
          context: {},
        },
      ],
    }),
  );
  writeFileSync(
    APPROVALS,
    JSON.stringify({
      approvals: [
        {
          card: {
            renderKind: "approval",
            id: "lazy-approval",
            sessionId: "s1",
            kind: "commit",
            status: "rejected",
            title: "t",
            createdAt: 1,
            body: { kind: "commit", message: "m", files: [] },
          },
          context: {},
        },
      ],
    }),
  );

  // A rollback around the import would undo rows whose file is already gone,
  // and reading as empty would let the caller act on records it cannot see.
  withDbTransaction(() => {
    assert.throws(() => openPullRequestCards(), LegacyStoreUnavailableError);
    assert.throws(
      () => approvalForId("lazy-approval"),
      LegacyStoreUnavailableError,
    );
  });
  assert.ok(existsSync(CARDS));
  assert.ok(existsSync(APPROVALS));

  assert.deepEqual(
    openPullRequestCards().map((card) => card.id),
    ["lazy"],
  );
  assert.equal(approvalForId("lazy-approval")?.status, "rejected");
  assert.equal(existsSync(CARDS), false);
  assert.equal(existsSync(APPROVALS), false);
});
