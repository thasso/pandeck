/**
 * The `scheduled prompts` delivery of a claimed Schedule occurrence
 * (`docs/schedules.md`, "Delivering into an existing session").
 */
import { formatScheduleDue } from "@assistant/shared/schedules";
import type { ScheduleOccurrenceRecord } from "../db/scheduleStore.ts";

/**
 * The model-only header line a delivered occurrence's prompt follows, from its
 * frozen input: the name as one line, the due time in the frozen zone.
 * `⏰ Scheduled prompt "PR CI check" · schedule \`sch_12\` · due Wed 25 Nov 15:45 Europe/Berlin`.
 * It travels as the turn's context block, never in the durable prompt text.
 */
export function scheduledPromptHeader(
  occurrence: Pick<
    ScheduleOccurrenceRecord,
    "scheduleId" | "name" | "dueAtMs" | "timeZone"
  >,
): string {
  const name = occurrence.name.replace(/\s+/g, " ").trim();
  const due = formatScheduleDue(occurrence.dueAtMs, occurrence.timeZone);
  return `⏰ Scheduled prompt "${name}" · schedule \`${occurrence.scheduleId}\` · due ${due} ${occurrence.timeZone}`;
}
