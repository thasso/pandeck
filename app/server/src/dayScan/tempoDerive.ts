import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  upsertProposal,
  type UpsertProposalInput,
} from "../db/tempoPlanStore.ts";
import { findContactByName } from "../contacts.ts";
import { canonicalMeetCode, readMeetLink } from "../googleWorkspaceLinking.ts";
import { userTimeZone } from "../userProfile.ts";
import { dailySummaryEntryPath } from "./dayState.ts";
import {
  activityForIssue,
  matchAreaRoute,
  matchTempoProfile,
  readTempoProfile,
  roundDuration,
  type TempoProfile,
} from "./tempoProfile.ts";
import type { DaySourceFact, DaySourceSnapshot } from "./types.ts";

/**
 * Deterministic Tempo proposal derivation (plan § Tempo logging assistant +
 * routing ladder). No model tokens: attended calendar meetings are routed to a
 * Jira issue via a precedence ladder — explicit ticket key in the title →
 * learned title→issue mapping → participant/area routing (Meet participants →
 * contacts → area → the profile's area route). Declined events are excluded,
 * and tentative/needs-action are never auto-proposed. An unrouted meeting
 * produces nothing — routing is the only source of an issue key, so an empty
 * profile is safe.
 *
 * ATTENDANCE EVIDENCE (Task 224). Acceptance is not attendance, and neither is
 * "the conference ran": a meeting held over GOOGLE MEET is proposed ONLY when a
 * participant session of MINE was found for it, and then with MY present time —
 * never the scheduled slot and never the conference's length. An accepted Meet
 * meeting with no session of mine yields NOTHING (the regression: an accepted
 * sprint planning whose 34-minute conference ran while the user was in another
 * call) — whether that meeting's link carries a Meet code or is a nickname/lookup
 * link, since the conference record's own window is the same evidence. One confirmed
 * conference is credited to at most one calendar slot, so a standing link reused
 * twice in a day never logs the same minutes twice.
 * Meetings that cannot HAVE Meet session evidence — no conference at all, or a
 * Zoom/Teams/other-provider link — still derive from the accepted calendar slot
 * and are marked `attendance:calendar-only` so the proposal shows what it rests
 * on.
 */

/** First `KEY-123`-shaped Jira issue key in the text, uppercased. Null if none. */
export function parseIssueKey(text: string): string | null {
  const match = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/);
  return match ? match[0].toUpperCase() : null;
}

type MeetingRouteBasis = "explicit-key" | "title-mapping" | "participant-area";

export interface MeetingRoute {
  issueKey: string;
  activityKey: string | null;
  basis: MeetingRouteBasis;
  profitCenter?: string;
}

/**
 * Pure routing ladder for one meeting. `participantAreas` are the responsibility
 * areas resolved from the meeting's participants (via contacts) by the caller.
 * Returns null when nothing yields an issue key (safe: no proposal).
 */
export function routeMeeting(
  title: string,
  profile: TempoProfile,
  participantAreas: string[],
): MeetingRoute | null {
  const key = parseIssueKey(title);
  if (key)
    return {
      issueKey: key,
      activityKey: activityForIssue(profile, key),
      basis: "explicit-key",
    };

  const mapping = matchTempoProfile(profile, title);
  if (mapping)
    return {
      issueKey: mapping.issueKey,
      activityKey: mapping.activityKey,
      basis: "title-mapping",
    };

  for (const area of participantAreas) {
    const route = matchAreaRoute(profile, area);
    if (route) {
      return {
        issueKey: route.issueKey,
        activityKey:
          route.activityKey ?? activityForIssue(profile, route.issueKey),
        basis: "participant-area",
        ...(route.profitCenter ? { profitCenter: route.profitCenter } : {}),
      };
    }
  }
  return null;
}

function localHm(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "09:00";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function eventId(factId: string): string {
  return factId.startsWith("cal:") ? factId.slice("cal:".length) : factId;
}

/** Field tuple for "already logged" dedup against existing personal worklogs. */
function tuple(
  issueKey: string,
  date: string,
  startTime: string,
  durationSeconds: number,
): string {
  return `${issueKey.toUpperCase()}|${date}|${startTime}|${durationSeconds}`;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** One conference the configured user is CONFIRMED to have attended (session-backed). */
interface ConfirmedSelfAttendance {
  /** Canonical Meet code, when the conference could be identified by code. */
  code: string | null;
  /** My own present time (union of my sessions); null when not measurable. */
  seconds: number | null;
  /** My presence window, for matching a conference to a calendar slot. */
  start: string | null;
  end: string | null;
}

/**
 * A conference that RAN on the day WITHOUT a session of mine: NEGATIVE evidence.
 * We looked at who was in it and I was not there, so no unidentified conference of
 * mine may be credited to the meeting it belongs to (Task 224: this is the sprint
 * planning itself). Carries every key that can tie it to a calendar slot — its code,
 * its window and the calendar title the collector correlated — because a slot whose
 * link is a nickname/lookup URL has NO code to match on.
 */
interface UnconfirmedConference {
  code: string | null;
  start: string | null;
  end: string | null;
  calendarTitle: string | null;
}

/** The day's Meet attendance evidence: what backs my time, and what argues against it. */
export interface MeetAttendanceEvidence {
  confirmed: ConfirmedSelfAttendance[];
  /** Conferences that ran without me — see `UnconfirmedConference`. */
  unconfirmed: UnconfirmedConference[];
  /** Codes of conferences I DID attend — those slots are identified, not guesses. */
  confirmedCodes: Set<string>;
}

/**
 * The Meet attendance evidence in the day's `meet-attendance` snapshot. Only facts
 * the collector tagged `attended` back a duration — an unconfirmed conference
 * carries no `attendedSeconds` and must never reach a proposal (Task 224) — but the
 * unconfirmed records are kept in full, because "this conference ran without me" is
 * what stops an unidentified conference of mine from being credited to that
 * meeting's slot. `data.meetingCode` is read with the code reader, never the URL one,
 * so every form the collector could have committed compares equal.
 */
export function readMeetAttendanceEvidence(
  meetFacts: DaySourceFact[],
): MeetAttendanceEvidence {
  const confirmed: ConfirmedSelfAttendance[] = [];
  const unconfirmed: UnconfirmedConference[] = [];
  const confirmedCodes = new Set<string>();
  for (const fact of meetFacts) {
    const data = fact.data ?? {};
    const code = canonicalMeetCode(
      typeof data.meetingCode === "string" ? data.meetingCode : null,
    );
    if (!fact.tags?.includes("attended")) {
      unconfirmed.push({
        code,
        start: typeof data.start === "string" ? data.start : null,
        end: typeof data.end === "string" ? data.end : null,
        calendarTitle:
          typeof data.calendarTitle === "string" ? data.calendarTitle : null,
      });
      continue;
    }
    if (code) confirmedCodes.add(code);
    confirmed.push({
      code,
      seconds:
        typeof data.attendedSeconds === "number" ? data.attendedSeconds : null,
      start: typeof data.selfStart === "string" ? data.selfStart : null,
      end: typeof data.selfEnd === "string" ? data.selfEnd : null,
    });
  }
  return { confirmed, unconfirmed, confirmedCodes };
}

const NO_MEET_EVIDENCE: MeetAttendanceEvidence = {
  confirmed: [],
  unconfirmed: [],
  confirmedCodes: new Set(),
};

function overlapMs(
  aStart: string | null,
  aEnd: string | null,
  bStart: string,
  bEnd: string,
): number {
  if (!aStart || !aEnd) return 0;
  const from = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
  const to = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return to - from;
}

/** One accepted, timed calendar slot a proposal may come from. */
interface MeetingSlot {
  fact: DaySourceFact;
  start: string;
  end: string;
  /**
   * The meeting is held over GOOGLE MEET, so it NEEDS a session of mine. False for
   * an in-person meeting or another provider's link, where no session can exist.
   */
  overMeet: boolean;
  /** Its Meet code; null for a Meet link that carries none (nickname/lookup). */
  meetCode: string | null;
}

/**
 * Did a conference that ran WITHOUT me belong to this slot? Codes decide when both
 * sides have one; otherwise — a nickname/lookup slot, or a record whose space read
 * failed — the record's own window and correlated title decide, which is the same
 * evidence keyed the only other way it can be (Task 224 review 3). Without this
 * parity a code-less slot passed the code guard VACUOUSLY and could be handed 2h22m
 * of another meeting.
 */
function ranWithoutMe(
  slot: MeetingSlot,
  unconfirmed: UnconfirmedConference[],
): boolean {
  const slotTitle = slot.fact.title?.trim().toLowerCase();
  return unconfirmed.some((record) => {
    if (record.code && slot.meetCode) return record.code === slot.meetCode;
    if (
      slotTitle &&
      record.calendarTitle &&
      record.calendarTitle.trim().toLowerCase() === slotTitle
    )
      return true;
    return overlapMs(record.start, record.end, slot.start, slot.end) >= 60_000;
  });
}

/**
 * Credit each confirmed conference of mine to AT MOST ONE calendar slot.
 *
 * Identity first: conferences and slots that both know their code are matched by
 * code, so an identified conference is never up for grabs by time. Only what is
 * left over — my conference whose space read failed, or a slot whose link carries no
 * code — is matched by TIME, and that path is deliberately timid, because time
 * overlap is exactly how Task-224's regression happened:
 *
 * - a slot a conference of the SAME day ran WITHOUT me at is never eligible (that
 *   record IS evidence I was not there) — matched by code, else by the record's
 *   window/title, so a code-less slot is protected exactly like a coded one;
 * - a slot whose code was already identified by a conference of mine is not
 *   eligible either (its time is accounted for);
 * - and ambiguity credits NOTHING: a conference eligible for two slots, or a slot
 *   two conferences could claim, is left alone, since we cannot tell which meeting I
 *   was in.
 *
 * Within one code, the best-matching slot wins (most overlap with my presence
 * window, then earliest start), so a standing link reused twice in a day never logs
 * the same minutes twice.
 */
function assignAttendance(
  slots: MeetingSlot[],
  evidence: MeetAttendanceEvidence,
): Map<DaySourceFact, ConfirmedSelfAttendance> {
  const assigned = new Map<DaySourceFact, ConfirmedSelfAttendance>();
  const claim = (
    attendance: ConfirmedSelfAttendance,
    candidates: MeetingSlot[],
  ): boolean => {
    const free = candidates.filter((slot) => !assigned.has(slot.fact));
    if (free.length === 0) return false;
    const best = free.sort(
      (a, b) =>
        overlapMs(attendance.start, attendance.end, b.start, b.end) -
          overlapMs(attendance.start, attendance.end, a.start, a.end) ||
        new Date(a.start).getTime() - new Date(b.start).getTime(),
    )[0]!;
    assigned.set(best.fact, attendance);
    return true;
  };

  const unmatched: ConfirmedSelfAttendance[] = [];
  for (const attendance of evidence.confirmed) {
    if (!attendance.code) {
      unmatched.push(attendance);
      continue;
    }
    const byCode = slots.filter((slot) => slot.meetCode === attendance.code);
    if (!claim(attendance, byCode)) unmatched.push(attendance);
  }

  // Time phase, over what identity could not settle. Eligibility is computed for
  // every leftover conference FIRST, so ambiguity can be judged from both sides.
  const eligibleFor = new Map<ConfirmedSelfAttendance, MeetingSlot[]>();
  for (const attendance of unmatched) {
    eligibleFor.set(
      attendance,
      slots.filter(
        (slot) =>
          slot.overMeet &&
          !assigned.has(slot.fact) &&
          // Negative evidence: a conference of this meeting ran and I was not in it.
          !ranWithoutMe(slot, evidence.unconfirmed) &&
          // Already identified by a conference of mine: its time is accounted for.
          !(slot.meetCode && evidence.confirmedCodes.has(slot.meetCode)) &&
          overlapMs(attendance.start, attendance.end, slot.start, slot.end) >=
            60_000,
      ),
    );
  }
  for (const [attendance, eligible] of eligibleFor) {
    if (eligible.length !== 1) continue; // two candidate meetings: credit neither
    const slot = eligible[0]!;
    const contenders = [...eligibleFor.values()].filter((candidates) =>
      candidates.includes(slot),
    ).length;
    if (contenders === 1) claim(attendance, eligible);
  }
  return assigned;
}

/**
 * Pure: derive candidate proposal rows from calendar facts via the routing
 * ladder. `areasByTitle` maps a normalized meeting title to the responsibility
 * areas resolved from its participants (empty when unknown); `evidence` is the day's
 * Meet attendance evidence (`readMeetAttendanceEvidence`). The chosen routing basis
 * is recorded as a `basis:<kind>` evidence marker, the attendance evidence as
 * `attendance:self-session` / `attendance:calendar-only`.
 */
export function deriveTempoProposals(
  calendarFacts: DaySourceFact[],
  profile: TempoProfile,
  date: string,
  areasByTitle: Map<string, string[]> = new Map(),
  evidence: MeetAttendanceEvidence = NO_MEET_EVIDENCE,
): UpsertProposalInput[] {
  const timeZone = userTimeZone();
  const slots: MeetingSlot[] = [];
  for (const fact of calendarFacts) {
    const data = fact.data ?? {};
    if (data.allDay) continue;
    if (data.selfResponse !== "accepted") continue; // declined/tentative/needs-action never auto-propose
    const start = typeof data.start === "string" ? data.start : null;
    const end = typeof data.end === "string" ? data.end : null;
    if (!start || !end) continue;
    const durationMs = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
    // ONLY a Google Meet meeting can be evidenced by a participant session.
    // `meetingUrl` is the first conference link found anywhere on the event, so it
    // may be Zoom/Teams — those meetings stay calendar-only, exactly like a
    // meeting with no conference at all. A Meet link with no code in it (nickname or
    // lookup) still needs a session of mine, found by time.
    const link = readMeetLink(
      typeof data.meetingUrl === "string" ? data.meetingUrl : null,
    );
    slots.push({
      fact,
      start,
      end,
      overMeet: link.isMeet,
      meetCode: link.code,
    });
  }

  const assigned = assignAttendance(slots, evidence);
  const rows: UpsertProposalInput[] = [];
  for (const slot of slots) {
    const { fact, start, end } = slot;
    // A meeting held over Meet must be backed by a session of MINE, and is logged
    // with MY present time — the scheduled slot and the conference's own length
    // are never my attendance.
    let seconds = Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 1000,
    );
    let attendanceBasis = "calendar-only";
    if (slot.overMeet) {
      const mine = assigned.get(fact);
      if (!mine || mine.seconds === null) continue;
      seconds = mine.seconds;
      attendanceBasis = "self-session";
    }

    const title = fact.title ?? "";
    const route = routeMeeting(
      title,
      profile,
      areasByTitle.get(normalizeTitle(title)) ?? [],
    );
    if (!route) continue; // unrouted meeting: no issue key, so nothing to propose
    rows.push({
      id: `tempo:${date}:${eventId(fact.id)}`,
      date,
      issueKey: route.issueKey,
      startTime: localHm(start, timeZone),
      durationSeconds: roundDuration(profile, seconds),
      activityKey: route.activityKey,
      description: fact.title ?? "Meeting",
      evidence: [
        ...(fact.links ?? []),
        `basis:${route.basis}`,
        `attendance:${attendanceBasis}`,
      ],
    });
  }
  return rows;
}

function participantName(participant: unknown): string | null {
  if (!participant || typeof participant !== "object") return null;
  const record = participant as { name?: unknown; displayName?: unknown };
  const name = record.name ?? record.displayName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Build a normalized-title → responsibility-areas map from the day's
 * `meet-attendance` snapshot: each conference's participant display names are
 * matched to contacts, and their `areas` unioned. Only conferences I attended
 * carry names (Task 224), so an unconfirmed meeting's attendees never route my
 * time. Empty for a meeting whose participants are unknown or unmatched (routing
 * then falls through safely).
 */
export function areasByMeetingTitle(
  meetFacts: DaySourceFact[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const fact of meetFacts) {
    const title = fact.title;
    if (!title) continue;
    const rawParticipants = fact.data?.meetParticipants;
    const participants: unknown[] = Array.isArray(rawParticipants)
      ? rawParticipants
      : [];
    const areas = new Set<string>();
    for (const participant of participants) {
      const displayName = participantName(participant);
      if (!displayName) continue;
      const contact = findContactByName(displayName);
      if (contact)
        for (const area of contact.areas) areas.add(area.toLowerCase());
    }
    if (areas.size > 0) out.set(normalizeTitle(title), [...areas]);
  }
  return out;
}

async function readSnapshot(
  store: KnowledgeBaseStore,
  date: string,
  key: string,
): Promise<DaySourceSnapshot | null> {
  try {
    return JSON.parse(
      await store.readEntryFile(
        `${dailySummaryEntryPath(date)}/assets/sources/${key}.json`,
      ),
    ) as DaySourceSnapshot;
  } catch {
    return null;
  }
}

export interface TempoDeriveResult {
  derived: number;
  persisted: number;
  /** Skipped because a matching personal worklog already exists (already logged). */
  alreadyLogged: number;
}

/**
 * Derive + persist the day's Tempo proposals from committed collection facts.
 * Rows already covered by an existing personal worklog (field-tuple match) are
 * skipped; `upsertProposal` preserves any `user-edited`/`dropped`/in-flight row.
 * Deterministic and model-free — safe to run as part of collection.
 */
export async function deriveAndPersistTempoProposals(
  store: KnowledgeBaseStore,
  date: string,
): Promise<TempoDeriveResult> {
  const calendar = await readSnapshot(store, date, "calendar");
  if (!calendar) return { derived: 0, persisted: 0, alreadyLogged: 0 };
  const profile = await readTempoProfile(store);
  const meet = await readSnapshot(store, date, "meet-attendance");
  const areasByTitle = areasByMeetingTitle(meet?.facts ?? []);
  const rows = deriveTempoProposals(
    calendar.facts,
    profile,
    date,
    areasByTitle,
    readMeetAttendanceEvidence(meet?.facts ?? []),
  );

  // Existing personal worklogs for the day → dedup tuples ("already logged").
  const tempo = await readSnapshot(store, date, "tempo");
  const logged = new Set<string>();
  for (const fact of tempo?.facts ?? []) {
    const data = fact.data ?? {};
    const issueKey = typeof data.issueKey === "string" ? data.issueKey : null;
    const startDate =
      typeof data.startDate === "string" ? data.startDate : date;
    const startTime =
      typeof data.startTime === "string" ? data.startTime.slice(0, 5) : "";
    const seconds = typeof data.seconds === "number" ? data.seconds : 0;
    if (issueKey) logged.add(tuple(issueKey, startDate, startTime, seconds));
  }

  let persisted = 0;
  let alreadyLogged = 0;
  for (const row of rows) {
    if (
      logged.has(
        tuple(row.issueKey, row.date, row.startTime ?? "", row.durationSeconds),
      )
    ) {
      alreadyLogged += 1;
      continue;
    }
    upsertProposal(row);
    persisted += 1;
  }
  return { derived: rows.length, persisted, alreadyLogged };
}
