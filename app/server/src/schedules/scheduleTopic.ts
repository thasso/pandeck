/**
 * The `schedules` topic's read half (`docs/state-sync.md`, `docs/schedules.md`).
 * Every live Schedule is a member, `done` ones included; only a tombstone
 * leaves, as a delete at its delete's revision. Occurrence history is a
 * separate read and never travels on the topic.
 */
import type { ServerMessage } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { scheduleStore } from "../db/scheduleStore.ts";
import type { StateTopicDescriptor } from "../stateTopicKernel.ts";

export const scheduleStateTopic = {
  topic: "schedules",
  revisions: (ids) => scheduleStore.revisionsFor(ids),
  summary: (id) => scheduleStore.get(id),
  snapshot: (seq) => ({
    type: "scheduleList",
    items: scheduleStore.list(),
    seq,
    revisions: scheduleStore.digest(),
  }),
  digest: () => scheduleStore.digest(),
  batchMax: 200,
} satisfies StateTopicDescriptor<
  "schedules",
  ScheduleSummary,
  Extract<ServerMessage, { type: "scheduleList" }>
>;
