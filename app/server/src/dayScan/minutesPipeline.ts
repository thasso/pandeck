import { isGoogleConfigured } from "../googleSettings.ts";
import { createTask } from "../tasks.ts";
import { userTimeZone } from "../userProfile.ts";
import { gatherMeetingMinutesCandidates } from "../tools/google/googleMeetingMinutesDiscoveryTools.ts";
import {
  extractMinutesActions,
  loadMinutesSource,
} from "../tools/google/meetingMinutesScannerTools.ts";
import { DAY_SCAN_TASK_MARKER } from "./collectors/pa.ts";
import {
  setMinutesPipelineFactory,
  type MinutesDoc,
  type MinutesPipeline,
} from "./minutesRun.ts";
import type { MinutesCandidate } from "./minutes.ts";

/**
 * The live minutes pipeline (Task 138 follow-up): the credentialed Google
 * adapter behind the deterministic `curateMinutes` core. Discovery + one
 * content fetch per candidate (for the content-hash cache key) + the metered
 * scanner extraction + Task creation, all reusing the existing agent-tool
 * cores. Registered at startup via `installMinutesPipeline`; resolves to `null`
 * when Google Workspace is unconfigured, so the substage is simply skipped.
 */

/** Bound how many discovered docs we FETCH per run (curation caps processing separately). */
const MAX_DISCOVERED_DOCS = 20;

function localDate(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // en-CA renders ISO-like YYYY-MM-DD; the user's zone matches the day window.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function createTaskForCandidate(input: {
  candidate: MinutesCandidate;
  doc: MinutesDoc;
}): string {
  const { candidate, doc } = input;
  const task = createTask({
    title: candidate.title,
    description: [candidate.action, candidate.context]
      .filter(Boolean)
      .join("\n\n"),
    ...(candidate.dueDate != null ? { dueDate: candidate.dueDate } : {}),
    externalLinks: [
      {
        url: `${DAY_SCAN_TASK_MARKER}/${candidate.id}`,
        type: "source",
        source: "unknown",
        title: "Day scan",
      },
      ...(doc.sourceLink
        ? [
            {
              url: doc.sourceLink,
              type: "related" as const,
              source: "unknown" as const,
              title: "Meeting minutes",
            },
          ]
        : []),
    ],
    source: { createdBy: "agent" },
  });
  return task.id;
}

const pipeline: MinutesPipeline = {
  async discover({ date }) {
    const gathered = await gatherMeetingMinutesCandidates({
      date,
      processed: "include",
    });
    const docs: MinutesDoc[] = [];
    const timeZone = userTimeZone();
    for (const candidate of gathered.candidates.slice(0, MAX_DISCOVERED_DOCS)) {
      const sourceId = candidate.sourceIds.driveFileId
        ? `drive:${candidate.sourceIds.driveFileId}`
        : candidate.sourceIds.gmailThreadId
          ? `gmail:${candidate.sourceIds.gmailThreadId}`
          : null;
      if (!sourceId) continue; // calendar-only attachments without a Drive/Gmail id are not fetchable here
      let source: Awaited<ReturnType<typeof loadMinutesSource>>;
      try {
        source = await loadMinutesSource({
          title: candidate.title,
          sourceLink: candidate.sourceLink,
          sourceIds: candidate.sourceIds,
        });
      } catch {
        continue; // an unreadable source is skipped, never fails the run
      }
      const meetingDate = localDate(candidate.date, timeZone) ?? date;
      docs.push({
        sourceId,
        sourceLink: candidate.sourceLink || source.link,
        title: candidate.title || source.title,
        meetingDate,
        content: source.text,
        observedLate: meetingDate !== date,
      });
    }
    return docs;
  },
  extractor: {
    async extract(doc) {
      const { meetingSummary, actions } = await extractMinutesActions({
        title: doc.title,
        sourceLink: doc.sourceLink,
        date: doc.meetingDate,
        text: doc.content,
      });
      return { meetingSummary, actions };
    },
  },
  createTask: async (input) => createTaskForCandidate(input),
};

/** Register the live minutes pipeline (null when Google is unconfigured). Wired once at startup. */
export function installMinutesPipeline(): void {
  setMinutesPipelineFactory(() => (isGoogleConfigured() ? pipeline : null));
}
