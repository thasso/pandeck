import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildMeetAttendanceFacts,
  callTitle,
  type CodelessMeetSlot,
} from "./meetAttendance.ts";
import type { MeetConferenceAttendance } from "../../googleWorkspaceLinking.ts";

/** A conference record as `findMyMeetAttendanceForDay` reports it. */
function conference(
  over: Partial<MeetConferenceAttendance> = {},
): MeetConferenceAttendance {
  return {
    meetingCode: "abc-defg-hij",
    meetingUri: "https://meet.google.com/abc-defg-hij",
    startTime: "2026-07-28T08:00:00.000Z",
    endTime: "2026-07-28T08:34:00.000Z",
    conferenceSeconds: 34 * 60,
    participants: [],
    participantsRead: true,
    selfAttended: false,
    selfSeconds: null,
    selfStart: null,
    selfEnd: null,
    selfSessions: 0,
    ...over,
  };
}

function build(
  conferences: MeetConferenceAttendance[],
  opts: {
    identityResolved?: boolean;
    titles?: Array<[string, string]>;
    codelessSlots?: CodelessMeetSlot[];
  } = {},
) {
  return buildMeetAttendanceFacts({
    conferences,
    titleByCode: new Map(opts.titles ?? []),
    ...(opts.codelessSlots !== undefined
      ? { codelessSlots: opts.codelessSlots }
      : {}),
    observedAt: "2026-07-28T20:00:00.000Z",
    identityResolved: opts.identityResolved ?? true,
  });
}

// The Task-224 regression: an accepted sprint planning whose conference really
// ran, with participant records for three colleagues and NO session for me.
const productPlanning = conference({
  meetingCode: "aaa-bbbb-ccc",
  meetingUri: "https://meet.google.com/aaa-bbbb-ccc",
  startTime: "2026-07-28T08:00:00.000Z",
  endTime: "2026-07-28T08:34:00.000Z",
  conferenceSeconds: 34 * 60,
  participants: [
    { name: "Riley Chen", seconds: 34 * 60, sessions: 1, self: false },
    { name: "Taylor Kim", seconds: 30 * 60, sessions: 1, self: false },
    { name: "Morgan Blake", seconds: 31 * 60, sessions: 2, self: false },
  ],
});

// The overlapping meeting I really was in (10:02–12:24 Berlin).
const engineeringSync = conference({
  meetingCode: "ddd-eeee-fff",
  meetingUri: "https://meet.google.com/ddd-eeee-fff",
  startTime: "2026-07-28T08:00:00.000Z",
  endTime: "2026-07-28T10:24:00.000Z",
  conferenceSeconds: 144 * 60,
  participants: [
    { name: "Alice Example", seconds: 142 * 60, sessions: 1, self: true },
    { name: "Jordan Lee", seconds: 140 * 60, sessions: 1, self: false },
  ],
  selfAttended: true,
  selfSeconds: 142 * 60,
  selfStart: "2026-07-28T08:02:00.000Z",
  selfEnd: "2026-07-28T10:24:00.000Z",
  selfSessions: 1,
});

test("accepted + occurred without a session of mine is NOT own/attended work", () => {
  const [fact] = build([productPlanning], {
    titles: [["aaa-bbbb-ccc", "Product Planning"]],
  });
  assert.ok(fact);
  assert.deepEqual(
    fact.tags,
    ["meet", "unconfirmed-attendance"],
    "never own/attended: acceptance and a conference are not my attendance",
  );
  assert.equal(fact.data?.attendanceBasis, "unconfirmed-no-self-session");
  assert.equal(fact.data?.attendanceConfirmed, false);
  assert.equal(fact.data?.attendedSeconds, null, "no duration to log");
  assert.equal(
    fact.data?.conferenceSeconds,
    34 * 60,
    "the conference's own length is kept, as the conference's",
  );
  assert.equal(
    fact.data?.meetParticipants,
    undefined,
    "other people's attendance is not presented as mine",
  );
  assert.equal(fact.data?.participantCount, 3);
  assert.equal(fact.title, "Product Planning");
});

test("a session of mine confirms attendance with MY present time", () => {
  const [fact] = build([engineeringSync], {
    titles: [["ddd-eeee-fff", "Weekly Engineering Sync"]],
  });
  assert.ok(fact);
  assert.deepEqual(fact.tags, ["own", "attended", "meet"]);
  assert.equal(fact.data?.attendanceBasis, "self-matched");
  assert.equal(fact.data?.attendanceConfirmed, true);
  assert.equal(
    fact.data?.attendedSeconds,
    142 * 60,
    "my time, not the conference's",
  );
  assert.equal(fact.data?.conferenceSeconds, 144 * 60);
  assert.equal(fact.data?.selfStart, "2026-07-28T08:02:00.000Z");
  assert.ok(
    Array.isArray(fact.data?.meetParticipants),
    "who was there travels for my own meeting",
  );
});

test("a matched participant with no session is still unconfirmed", () => {
  const [fact] = build([
    conference({
      participants: [
        { name: "Alice Example", seconds: null, sessions: 0, self: true },
      ],
    }),
  ]);
  assert.equal(fact?.data?.attendanceBasis, "unconfirmed-no-self-session");
  assert.ok(!fact?.tags?.includes("attended"));
});

test("an unresolvable identity or unreadable participant list degrades honestly", () => {
  // No `userinfo.profile` scope: we cannot self-match at all — that is not absence.
  const [noIdentity] = build([productPlanning], {
    identityResolved: false,
  });
  assert.equal(
    noIdentity?.data?.attendanceBasis,
    "unconfirmed-identity-unavailable",
  );
  assert.ok(
    !noIdentity?.tags?.includes("attended"),
    "never claimed as attended",
  );

  const [unreadable] = build([conference({ participantsRead: false })]);
  assert.equal(
    unreadable?.data?.attendanceBasis,
    "unconfirmed-participants-unavailable",
  );
  assert.ok(!unreadable?.tags?.includes("attended"));
});

test("overlapping confirmed attendance travels as conflict evidence", () => {
  const facts = build([productPlanning, engineeringSync], {
    titles: [
      ["aaa-bbbb-ccc", "Product Planning"],
      ["ddd-eeee-fff", "Weekly Engineering Sync"],
    ],
  });
  const unconfirmed = facts.find((f) => f.id === "meet:aaa-bbbb-ccc");
  const confirmed = facts.find((f) => f.id === "meet:ddd-eeee-fff");
  assert.deepEqual(unconfirmed?.data?.conflictingSelfAttendance, [
    {
      title: "Weekly Engineering Sync",
      start: "2026-07-28T08:02:00.000Z",
      end: "2026-07-28T10:24:00.000Z",
    },
  ]);
  assert.equal(
    confirmed?.data?.conflictingSelfAttendance,
    undefined,
    "confirmed attendance carries no conflict of its own",
  );
  // Overlap alone never decides: the unconfirmed meeting is unconfirmed because
  // no session of mine exists, not because another meeting overlapped it.
  const [alone] = build([productPlanning]);
  assert.equal(alone?.data?.attendanceBasis, "unconfirmed-no-self-session");
  assert.equal(alone?.data?.conflictingSelfAttendance, undefined);
});

test("two overlapping conferences can both be confirmed when I was in both", () => {
  const second = conference({
    meetingCode: "sec-onda-llq",
    startTime: "2026-07-28T09:00:00.000Z",
    endTime: "2026-07-28T09:30:00.000Z",
    conferenceSeconds: 30 * 60,
    participants: [
      { name: "Alice Example", seconds: 10 * 60, sessions: 2, self: true },
    ],
    selfAttended: true,
    selfSeconds: 10 * 60,
    selfStart: "2026-07-28T09:00:00.000Z",
    selfEnd: "2026-07-28T09:30:00.000Z",
    selfSessions: 2,
  });
  const facts = build([engineeringSync, second]);
  assert.equal(
    facts.filter((f) => f.tags?.includes("attended")).length,
    2,
    "session evidence in both, so both are mine",
  );
  assert.deepEqual(
    facts.map((f) => f.data?.attendedSeconds),
    [142 * 60, 10 * 60],
    "each keeps its own present time",
  );
});

test("callTitle names the OTHER attendees for an ad-hoc Meet call", () => {
  assert.equal(
    callTitle([
      { name: "Me", self: true },
      { name: "Jordan", self: false },
    ]),
    "Meet call with Jordan",
  );
  assert.equal(
    callTitle([
      { name: "Me", self: true },
      { name: "A", self: false },
      { name: "B", self: false },
      { name: "C", self: false },
      { name: "D", self: false },
    ]),
    "Meet call with A, B, C +1",
  );
});

test("callTitle degrades to a plain label when no other attendees are named", () => {
  assert.equal(callTitle([{ name: "Me", self: true }]), "Meet call");
  assert.equal(callTitle([{ name: null, self: false }]), "Meet call");
});

test("a conference no code can correlate takes its title from an unambiguous overlapping slot", () => {
  // A `g.co/meet/<nickname>` event has no code to key on, so the conference would
  // stay an anonymous "Meet call with …" — and the digest would then list the same
  // meeting BOTH as attended and as calendar-only (Task-224 review 2, finding 1).
  const [fact] = build([engineeringSync], {
    codelessSlots: [
      {
        title: "Weekly Engineering Sync",
        start: "2026-07-28T08:00:00.000Z",
        end: "2026-07-28T10:00:00.000Z",
      },
    ],
  });
  assert.equal(fact?.title, "Weekly Engineering Sync");
  assert.equal(fact?.data?.calendarTitle, "Weekly Engineering Sync");
});

test("time correlation is refused when it would be a guess", () => {
  const slots: CodelessMeetSlot[] = [
    {
      title: "Kickoff",
      start: "2026-07-28T08:00:00.000Z",
      end: "2026-07-28T09:00:00.000Z",
    },
    {
      title: "Design review",
      start: "2026-07-28T08:30:00.000Z",
      end: "2026-07-28T09:30:00.000Z",
    },
  ];
  // Two candidate slots for one conference: no title rather than the wrong one.
  const [ambiguous] = build([engineeringSync], { codelessSlots: slots });
  assert.equal(ambiguous?.title, "Meet call with Jordan Lee");
  assert.equal(ambiguous?.data?.calendarTitle, null);

  // A code-correlated title always wins over time.
  const [byCode] = build([engineeringSync], {
    titles: [["ddd-eeee-fff", "Weekly Engineering Sync"]],
    codelessSlots: [
      {
        title: "Some other meeting",
        start: "2026-07-28T08:00:00.000Z",
        end: "2026-07-28T10:00:00.000Z",
      },
    ],
  });
  assert.equal(byCode?.title, "Weekly Engineering Sync");

  // No overlap at all: no title.
  const [elsewhere] = build([engineeringSync], {
    codelessSlots: [
      {
        title: "Evening sync",
        start: "2026-07-28T18:00:00.000Z",
        end: "2026-07-28T19:00:00.000Z",
      },
    ],
  });
  assert.equal(elsewhere?.data?.calendarTitle, null);
});
