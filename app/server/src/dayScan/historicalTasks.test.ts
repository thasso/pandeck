import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  sourceKey,
  upsertMeetingMinutesRecord,
} from "../meetingMinutesProcessed.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  sweepCompletedTaskArchive,
  TASK_AUTO_ARCHIVE_AFTER_MS,
} from "../tasks.ts";
import { createPaCollector } from "./collectors/pa.ts";
import { getDayState } from "./dayState.ts";
import { localDayWindow } from "./dayWindow.ts";
import type { DayCollectContext } from "./types.ts";

const DATE = "2026-07-13";
const SOURCE_URL = "https://docs.example.test/meeting/retention";

/** Historical Task identity survives the live Backlog's retention lifecycle. */
test("auto-archived Tasks remain in historical PA facts and meeting-day links", async () => {
  const createdAt = localDayWindow(DATE).startMs + 10 * 60 * 60 * 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
  const completed = createTask({
    title: "Historical completed action",
    status: "done",
    externalLinks: [{ url: SOURCE_URL, type: "source", source: "unknown" }],
    source: { createdBy: "user" },
  });
  const archivedDue = createTask({
    title: "Archived work is not currently due",
    status: "todo",
    dueDate: DATE,
    source: { createdBy: "user" },
  });
  clock.mockRestore();

  try {
    const archived = sweepCompletedTaskArchive(
      createdAt + TASK_AUTO_ARCHIVE_AFTER_MS + 1,
    );
    assert.ok(archived.includes(completed.id), "retention archived the Task");
    archiveTask(archivedDue.id);

    const collector = createPaCollector({
      kbStore: {
        history: async () => [],
      } as unknown as KnowledgeBaseStore,
    });
    const output = await collector.collect({
      date: DATE,
      window: localDayWindow(DATE),
      runId: "historical-task-regression",
      identities: {},
      prior: null,
      cache: {},
    } as DayCollectContext);

    assert.ok(
      output.facts.some(
        (fact) =>
          fact.kind === "task-created" && fact.data?.taskId === completed.id,
      ),
      "historical backfill retained the auto-archived Task creation",
    );
    assert.equal(
      output.facts.some(
        (fact) =>
          fact.kind === "task-due" && fact.data?.taskId === archivedDue.id,
      ),
      false,
      "archived Tasks do not reappear as current due work",
    );

    upsertMeetingMinutesRecord({
      key: sourceKey({ sourceLink: SOURCE_URL }),
      sourceLink: SOURCE_URL,
      sourceTitle: "Retention review",
      sourceDate: DATE,
      scannedAt: new Date(createdAt).toISOString(),
      outcome: "actions_found",
      actionCount: 1,
      taskIds: [completed.id],
    });
    const state = await getDayState(DATE);
    assert.deepEqual(state.sources[0]?.tasks, [
      {
        id: completed.id,
        title: completed.title,
        status: "done",
      },
    ]);
    assert.deepEqual(state.tasks, state.sources[0]?.tasks);
  } finally {
    clock.mockRestore();
    deleteTask(archivedDue.id);
    deleteTask(completed.id);
  }
});
