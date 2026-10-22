/**
 * The knowledge link migration's Task rewrite commits with its Task stamps and
 * their Initiative fan-out, or not at all. A failed fan-out leaves the
 * descriptions as they were and the migration unrecorded, so the next boot
 * finds them still to rewrite. Its own database: completion is recorded once
 * per database, so this cannot follow `knowledgeLinkMigration.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "kb-link-migration-retry-test-"));
process.env.ASSISTANT_CWD = tmp;

const { migrateKnowledgeLinks } = await import("./knowledgeLinkMigration.ts");
const { KnowledgeBaseStore } = await import("./knowledgeBaseStore.ts");
const { createTask, readTask, taskRevision } = await import("./tasks.ts");
const { createInitiative, initiativeStateTopic } =
  await import("./initiatives.ts");
const { failInitiativeFanOut, recordStateReports } =
  await import("./test/stateReports.ts");
const { DATA_DIR } = await import("./config.ts");
const { closeDb } = await import("./db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("a failed Task fan-out rolls the rewrite back, and the next run completes it", async () => {
  const store = new KnowledgeBaseStore(join(DATA_DIR, "knowledge"));
  await store.commitChanges(
    [
      {
        op: "write",
        path: "projects/acme/index.md",
        content: "---\nkb:\n  id: kb-acme\n  title: Acme\n---\nThe plan.\n",
      },
    ],
    { actor: { kind: "system", name: "seed" }, reason: "seed" },
  );
  const description = "Background: pa://knowledge/kb-acme";
  const id = createTask({
    title: "Ship Acme",
    description,
    source: { createdBy: "user" },
  }).id;
  const iid = String(
    createInitiative({ title: "Acme", taskIds: [id] }).initiative.id,
  );
  const initiativeRevision = () =>
    initiativeStateTopic.revisions([iid]).get(iid)!.revision;
  const t0 = taskRevision(id)!;
  const i0 = initiativeRevision();

  const fault = new Error("injected fan-out failure");
  const restore = failInitiativeFanOut(fault, { callThrough: true });
  const failed = recordStateReports();
  try {
    await assert.rejects(
      migrateKnowledgeLinks(store),
      (error) => error === fault,
    );
  } finally {
    failed.stop();
    restore();
  }
  assert.equal(readTask(id)?.description, description);
  assert.equal(taskRevision(id), t0);
  assert.equal(initiativeRevision(), i0);
  assert.deepEqual(failed.reports, []);

  // Not recorded: the next run migrates rather than answering null.
  const retried = recordStateReports();
  let summary: Awaited<ReturnType<typeof migrateKnowledgeLinks>>;
  try {
    summary = await migrateKnowledgeLinks(store);
  } finally {
    retried.stop();
  }
  assert.equal(summary?.tasks, 1);
  assert.equal(
    readTask(id)?.description,
    "Background: pa://knowledge/projects/acme/index.md",
  );
  assert.ok(taskRevision(id)! > t0);
  assert.ok(initiativeRevision() > i0);
  assert.deepEqual(
    retried.reports.map((report) => [report.topic, report.ids]),
    [
      ["tasks", [id]],
      ["initiatives", [iid]],
    ],
  );

  assert.equal(await migrateKnowledgeLinks(store), null);
});
