import { localDayBoundsMs } from "@assistant/shared/zonedTime";
import { defineAgentTool } from "../../mcp/tool.ts";
import { userTimeZone } from "../../userProfile.ts";

type CurrentTimeParams = {
  timeZone?: string;
};

const currentTimeParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeZone: {
      type: "string",
      description: "IANA timezone; default: the user's zone.",
    },
  },
} as const;

const currentTimeTool = defineAgentTool<CurrentTimeParams>({
  name: "current_time",
  label: "Current Time",
  description:
    "The current date/time with timezone information. Call it before answering any relative-time question (today, tomorrow, this week).",
  parameters: currentTimeParamsSchema,
  async execute(params) {
    const now = new Date();
    const timeZone = userTimeZone();
    const requestedTimeZone = cleanTimeZone(params.timeZone) ?? timeZone;
    const serverTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const payload = {
      epochMs: now.getTime(),
      isoUtc: now.toISOString(),
      serverTimeZone,
      requested: localParts(now, requestedTimeZone),
      user:
        requestedTimeZone === timeZone ? undefined : localParts(now, timeZone),
      guidance:
        "Use requested.rfc3339 as the current local time for relative date/range calculations. For 'rest of today', use requested.rfc3339 as from and requested.endOfDayRfc3339 as to.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const assistantTimeTools = [currentTimeTool];

function cleanTimeZone(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    throw new Error(`Invalid IANA timezone: ${trimmed}`);
  }
}

/** The wall clock at `date` in `timeZone`, with the offset in force at that instant. */
function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  const timeText = `${parts.hour}:${parts.minute}:${parts.second}`;
  const offset = timeZoneOffset(date, timeZone);
  return {
    dateText,
    timeText,
    offset,
    rfc3339: `${dateText}T${timeText}${offset}`,
  };
}

function localParts(date: Date, timeZone: string) {
  const now = wallClock(date, timeZone);
  // The day's own bounds, each with ITS offset: a DST day starts and ends at
  // different offsets, and a zone may even skip midnight (Havana starts the
  // day at 01:00), so neither is "the date at 00:00 with the current offset".
  const { startMs, endMs } = localDayBoundsMs(now.dateText, timeZone);
  return {
    timeZone,
    date: now.dateText,
    time: now.timeText,
    localDateTime: `${now.dateText}T${now.timeText}`,
    utcOffset: now.offset,
    rfc3339: now.rfc3339,
    startOfDayRfc3339: wallClock(new Date(startMs), timeZone).rfc3339,
    endOfDayRfc3339: wallClock(new Date(endMs - 1000), timeZone).rfc3339,
  };
}

function timeZoneOffset(date: Date, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(
    /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/,
  );
  if (!match?.groups?.sign) return "+00:00";
  const hours = (match.groups.hours ?? "0").padStart(2, "0");
  const minutes = match.groups.minutes ?? "00";
  return `${match.groups.sign}${hours}:${minutes}`;
}
