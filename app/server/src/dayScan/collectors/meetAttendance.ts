import {
  isGoogleConfigured,
  getGoogleToolConfig,
  ensureGoogleAccessToken,
} from "../../googleSettings.ts";
import { getCalendarEvents } from "../../calendarService.ts";
import {
  findMyMeetAttendanceForDay,
  getMeetSelfIdentity,
  readMeetLink,
  type MeetConferenceAttendance,
  type MeetSelfIdentity,
} from "../../googleWorkspaceLinking.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

/** Build "Meet call with A, B" from the OTHER (non-self) attendees. */
export function callTitle(
  participants: Array<{ name: string | null; self: boolean }>,
): string {
  const others = participants
    .filter((p) => !p.self && p.name)
    .map((p) => p.name!) as string[];
  if (others.length === 0) return "Meet call";
  const shown = others.slice(0, 3).join(", ");
  return `Meet call with ${shown}${others.length > 3 ? ` +${others.length - 3}` : ""}`;
}

/**
 * Why a conference is (not) MY attendance. Only `self-matched` — a participant
 * SESSION for the configured user — is attendance (Task 224); every
 * `unconfirmed-*` basis says the conference happened but my presence is NOT
 * evidenced, and each names the reason so the report can degrade honestly.
 */
type MeetAttendanceBasis =
  | "self-matched"
  | "unconfirmed-no-self-session"
  | "unconfirmed-identity-unavailable"
  | "unconfirmed-participants-unavailable";

function meetAttendanceBasis(
  conference: MeetConferenceAttendance,
  identityResolved: boolean,
): MeetAttendanceBasis {
  if (conference.selfAttended) return "self-matched";
  if (!identityResolved) return "unconfirmed-identity-unavailable";
  if (!conference.participantsRead)
    return "unconfirmed-participants-unavailable";
  return "unconfirmed-no-self-session";
}

function overlapSeconds(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): number {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const start = Math.max(
    new Date(aStart).getTime(),
    new Date(bStart).getTime(),
  );
  const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return 0;
  return Math.round((end - start) / 1000);
}

/**
 * Confirmed self-attendance elsewhere that overlaps this conference: CONFLICT
 * evidence, not proof of absence (Task 224). Being demonstrably in another call
 * makes "I was in this one too" less likely, but people do juggle two calls, so
 * it only ever accompanies the missing self-session — it never decides alone.
 */
function conflictsFor(
  conference: MeetConferenceAttendance,
  confirmed: MeetConferenceAttendance[],
  titleOf: (conference: MeetConferenceAttendance) => string,
): Array<{ title: string; start: string | null; end: string | null }> {
  const out: Array<{
    title: string;
    start: string | null;
    end: string | null;
  }> = [];
  for (const other of confirmed) {
    if (other === conference) continue;
    const seconds = overlapSeconds(
      conference.startTime,
      conference.endTime,
      other.selfStart ?? other.startTime,
      other.selfEnd ?? other.endTime,
    );
    if (seconds < 60) continue;
    out.push({
      title: titleOf(other),
      start: other.selfStart ?? other.startTime,
      end: other.selfEnd ?? other.endTime,
    });
  }
  return out;
}

/** A calendar meeting held over Meet whose LINK carries no code (nickname/lookup). */
export interface CodelessMeetSlot {
  title: string;
  start: string | null;
  end: string | null;
}

/**
 * Titles for conferences no Meet CODE could correlate: a `meet.google.com/lookup/…`
 * or `g.co/meet/<nickname>` event has no code to key on, so the only correlation
 * left is TIME. Paired one-to-one and only when unambiguous — a conference
 * overlapping exactly one such slot and vice versa — so a title is never guessed
 * between two candidates. Without this a nickname meeting stays an anonymous "Meet
 * call with …" and the digest lists it BOTH as attended and as calendar-only.
 */
function titlesByTimeCorrelation(
  conferences: MeetConferenceAttendance[],
  slots: CodelessMeetSlot[],
): Map<MeetConferenceAttendance, string> {
  const pairs: Array<[MeetConferenceAttendance, CodelessMeetSlot]> = [];
  for (const conference of conferences) {
    if (conference.meetingCode === null && conference.startTime === null)
      continue;
    for (const slot of slots) {
      const seconds = overlapSeconds(
        conference.startTime,
        conference.endTime,
        slot.start,
        slot.end,
      );
      if (seconds >= 60) pairs.push([conference, slot]);
    }
  }
  const out = new Map<MeetConferenceAttendance, string>();
  for (const [conference, slot] of pairs) {
    const conferenceCandidates = pairs.filter(([c]) => c === conference).length;
    const slotCandidates = pairs.filter(([, s]) => s === slot).length;
    if (conferenceCandidates === 1 && slotCandidates === 1)
      out.set(conference, slot.title);
  }
  return out;
}

/**
 * Pure: the day's Meet conference records → facts. CONFIRMED attendance (a
 * participant session for me) is tagged `own`/`attended` and carries my present
 * time, who was there, and how long each person stayed. An UNCONFIRMED
 * conference is still recorded — it happened, and the calendar invitation may be
 * accepted — but it is NOT my work: no `own`/`attended` tag, no `attendedSeconds`
 * (the conference duration is the CONFERENCE's, never mine), no participant
 * names (the attendee carve-out covers my OWN meetings), and any overlapping
 * confirmed attendance travels as conflict evidence.
 */
export function buildMeetAttendanceFacts({
  conferences,
  titleByCode,
  codelessSlots = [],
  observedAt,
  identityResolved,
}: {
  conferences: MeetConferenceAttendance[];
  titleByCode: Map<string, string>;
  /** Meet-linked calendar meetings with no code in their link, for time correlation. */
  codelessSlots?: CodelessMeetSlot[];
  observedAt: string;
  identityResolved: boolean;
}): DaySourceFact[] {
  const confirmed = conferences.filter((c) => c.selfAttended);
  const titledByTime = titlesByTimeCorrelation(
    conferences.filter(
      (c) => !c.meetingCode || !titleByCode.has(c.meetingCode),
    ),
    codelessSlots,
  );
  const calendarTitleOf = (
    conference: MeetConferenceAttendance,
  ): string | null =>
    (conference.meetingCode ? titleByCode.get(conference.meetingCode) : null) ??
    titledByTime.get(conference) ??
    null;
  const titleOf = (conference: MeetConferenceAttendance): string =>
    calendarTitleOf(conference) ??
    (conference.selfAttended
      ? callTitle(conference.participants)
      : "Meet conference");
  const facts: DaySourceFact[] = [];
  for (const conf of conferences) {
    const basis = meetAttendanceBasis(conf, identityResolved);
    const attended = basis === "self-matched";
    const calendarTitle = calendarTitleOf(conf);
    const id = conf.meetingCode ?? conf.startTime ?? `${facts.length}`;
    const conflicts = attended ? [] : conflictsFor(conf, confirmed, titleOf);
    facts.push({
      id: `meet:${id}`,
      kind: "meet-call",
      occurredAt: conf.startTime,
      observedAt,
      title: titleOf(conf),
      links: conf.meetingUri ? [conf.meetingUri] : [],
      data: {
        meetingCode: conf.meetingCode,
        meetingUri: conf.meetingUri,
        start: conf.startTime,
        end: conf.endTime,
        attendanceBasis: basis,
        attendanceConfirmed: attended,
        // MY present time — only ever set from my own participant sessions.
        attendedSeconds: attended ? conf.selfSeconds : null,
        selfStart: attended ? conf.selfStart : null,
        selfEnd: attended ? conf.selfEnd : null,
        selfSessions: conf.selfSessions,
        conferenceSeconds: conf.conferenceSeconds,
        calendarTitle,
        ...(attended
          ? { meetParticipants: conf.participants }
          : { participantCount: conf.participants.length }),
        ...(conflicts.length > 0
          ? { conflictingSelfAttendance: conflicts }
          : {}),
      },
      tags: attended
        ? ["own", "attended", "meet"]
        : ["meet", "unconfirmed-attendance"],
    });
  }
  return facts;
}

/**
 * Google Meet ATTENDANCE (Task 173) — a dedicated source so attendance is
 * captured for EVERY conference the user was in, not only accepted calendar
 * meetings: an ad-hoc call from a Slack-shared link has no calendar event, but
 * `conferenceRecords.list` still returns it because the user participated. For
 * each conference it records WHO attended and for how long, self-matches the
 * connected user for their own present time (needs the `userinfo.profile` scope),
 * and correlates the meeting code to a calendar event for a nice title/context.
 *
 * Attendance requires MY participant session (Task 224): a listed conference
 * record is not proof I joined — the list surfaced a sprint planning the user had
 * accepted but never attended. Only self-matched conferences become `own`/
 * `attended` facts with a duration for time logging; the rest are recorded as
 * unconfirmed. Best-effort: a missing Meet scope or a transient error degrades to
 * `partial` and never blocks the day.
 *
 * Privacy: attendee display names + present durations for MY OWN (self-matched)
 * conferences are an explicit committed-fact carve-out (see dayScan CLAUDE.md) —
 * names + durations only, never emails or content.
 */
export const meetAttendanceCollector: DaySourceCollector = {
  key: "meet-attendance",
  label: "Meet attendance",
  readiness() {
    return isGoogleConfigured()
      ? { ready: true }
      : {
          ready: false,
          reason: "unconfigured",
          detail: "Google Workspace is not connected",
        };
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const accessToken = await ensureGoogleAccessToken(getGoogleToolConfig());
    let self: MeetSelfIdentity | undefined;
    const identity = await getMeetSelfIdentity(accessToken);
    if (identity.userId || identity.displayName) self = identity;

    // Correlate Meet codes → scheduled calendar titles (nice names for the ones
    // that DO have an event); ad-hoc calls simply have no match. `meetingUrl` is
    // the event's first conference link of ANY provider, so only a real Meet code
    // may key the map — and a Meet link that carries no code (nickname/lookup) is
    // collected separately for time correlation.
    const titleByCode = new Map<string, string>();
    const codelessSlots: CodelessMeetSlot[] = [];
    try {
      const calendar = await getCalendarEvents({
        from: ctx.window.startIso,
        to: ctx.window.endIso,
      });
      for (const event of calendar.events) {
        if (!event.title || event.allDay) continue;
        const link = readMeetLink(event.meetingUrl);
        if (!link.isMeet) continue;
        if (link.code) titleByCode.set(link.code, event.title);
        else
          codelessSlots.push({
            title: event.title,
            start: event.start,
            end: event.end,
          });
      }
    } catch {
      // Title correlation is best-effort; fall back to participant-derived names.
    }

    let conferences;
    try {
      conferences = await findMyMeetAttendanceForDay({
        accessToken,
        fromIso: ctx.window.startIso,
        toIso: ctx.window.endIso,
        ...(self !== undefined ? { self } : {}),
      });
    } catch (err) {
      ctx.cache.writeJson(ctx.date, "meet-attendance-raw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        result: "partial",
        facts: [],
        notes: [
          "Meet conference records could not be read (missing Meet scope or a transient error); attendance is unavailable this run.",
        ],
      };
    }

    const identityResolved = Boolean(self);
    const facts = buildMeetAttendanceFacts({
      conferences,
      titleByCode,
      codelessSlots,
      observedAt: new Date().toISOString(),
      identityResolved,
    });
    const selfMatched = conferences.filter((c) => c.selfAttended).length;
    ctx.cache.writeJson(ctx.date, "meet-attendance-raw", {
      conferences: conferences.length,
      selfMatched,
      selfResolved: identityResolved,
    });
    // Without the profile scope we cannot self-match at all, so no conference can
    // be confirmed: report `partial` rather than let silence read as "attended
    // nothing" or leave every meeting unconfirmed without saying why.
    const unresolvedIdentity = !identityResolved && conferences.length > 0;
    return {
      result: unresolvedIdentity ? "partial" : "complete",
      facts,
      ...(unresolvedIdentity
        ? {
            notes: [
              "The connected Google account's identity could not be resolved (missing `userinfo.profile` scope — reconnect Google), so Meet attendance could not be confirmed for any conference this day.",
            ],
          }
        : {}),
      completeness: {
        conferences: conferences.length,
        selfMatched,
        unconfirmed: conferences.length - selfMatched,
        selfIdentity: identityResolved ? "resolved" : "unavailable",
      },
    };
  },
};
