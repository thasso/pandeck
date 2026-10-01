import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { updateSettings } from "../settings.ts";
import {
  areasByMeetingTitle,
  readMeetAttendanceEvidence,
  deriveTempoProposals,
  parseIssueKey,
  routeMeeting,
} from "./tempoDerive.ts";
import {
  emptyTempoProfile,
  matchTempoProfile,
  roundDuration,
  upsertProfileMapping,
  type TempoProfile,
} from "./tempoProfile.ts";
import type { DaySourceFact } from "./types.ts";

// Fixture instants are written at +02:00 and their Tempo start times read as
// Berlin wall clock, so the profile pins that zone rather than the host's.
beforeAll(() => {
  updateSettings({
    profile: {
      displayName: "",
      timeZone: "Europe/Berlin",
      effectiveTimeZone: "",
    },
  });
});

function meeting(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Record<string, unknown> = {},
): DaySourceFact {
  return {
    id: `cal:${id}`,
    kind: "event",
    observedAt: "2026-07-13T10:00:00.000Z",
    title,
    data: { start, end, selfResponse: "accepted", ...extra },
  };
}

const profile: TempoProfile = {
  ...emptyTempoProfile(),
  defaultActivityKey: "MEET",
  mappings: [
    { titleMatch: "Weekly Sync", issueKey: "WEB-1", activityKey: "DEV" },
    { titleMatch: "1:1", issueKey: "HR-2" },
  ],
};

test("derivation proposes only accepted, mapped, timed meetings", () => {
  const rows = deriveTempoProposals(
    [
      meeting(
        "a",
        "Weekly Sync",
        "2026-07-13T09:00:00+02:00",
        "2026-07-13T10:00:00+02:00",
      ),
      meeting(
        "b",
        "Weekly Sync",
        "2026-07-13T11:00:00+02:00",
        "2026-07-13T12:00:00+02:00",
        { selfResponse: "tentative" },
      ), // not accepted
      meeting(
        "c",
        "Random unmapped",
        "2026-07-13T13:00:00+02:00",
        "2026-07-13T14:00:00+02:00",
      ), // unmapped
      meeting(
        "d",
        "1:1 with Chris",
        "2026-07-13T15:00:00+02:00",
        "2026-07-13T15:30:00+02:00",
      ),
      meeting(
        "e",
        "All hands",
        "2026-07-13T00:00:00+02:00",
        "2026-07-13T00:00:00+02:00",
        { allDay: true },
      ), // all-day/zero
    ],
    profile,
    "2026-07-13",
  );
  assert.deepEqual(rows.map((r) => r.issueKey).sort(), ["HR-2", "WEB-1"]);
  const sync = rows.find((r) => r.issueKey === "WEB-1")!;
  assert.equal(sync.startTime, "09:00");
  assert.equal(sync.durationSeconds, 3600);
  assert.equal(sync.activityKey, "DEV");
  assert.equal(sync.id, "tempo:2026-07-13:a");
  const oneOnOne = rows.find((r) => r.issueKey === "HR-2")!;
  assert.equal(
    oneOnOne.activityKey,
    "MEET",
    "falls back to the profile default activity",
  );
});

/** The `meet-attendance` snapshot fact for a conference, confirmed or not. */
function meetFact(
  code: string,
  over: { attended?: boolean; data?: Record<string, unknown> } = {},
): DaySourceFact {
  const attended = over.attended ?? false;
  return {
    id: `meet:${code}`,
    kind: "meet-call",
    observedAt: "2026-07-28T20:00:00.000Z",
    title: "Meeting",
    data: {
      meetingCode: code,
      attendanceBasis: attended
        ? "self-matched"
        : "unconfirmed-no-self-session",
      attendanceConfirmed: attended,
      ...over.data,
    },
    tags: attended
      ? ["own", "attended", "meet"]
      : ["meet", "unconfirmed-attendance"],
  };
}

test("a conference meeting without a session of mine proposes NOTHING (Task 224)", () => {
  // The regression: accepted, the conference ran 34 minutes, no session of mine.
  const calendarFacts = [
    meeting(
      "aaa-bbbb-ccc",
      "Weekly Sync",
      "2026-07-28T10:00:00+02:00",
      "2026-07-28T11:00:00+02:00",
      { meetingUrl: "https://meet.google.com/aaa-bbbb-ccc" },
    ),
  ];
  const evidence = readMeetAttendanceEvidence([
    meetFact("aaa-bbbb-ccc", { data: { conferenceSeconds: 34 * 60 } }),
  ]);
  assert.deepEqual(
    evidence.confirmed,
    [],
    "an unconfirmed conference backs no duration…",
  );
  assert.deepEqual(
    evidence.unconfirmed.map((c) => c.code),
    ["aaa-bbbb-ccc"],
    "…but the record is kept as negative evidence",
  );
  assert.deepEqual(
    deriveTempoProposals(
      calendarFacts,
      profile,
      "2026-07-28",
      new Map(),
      evidence,
    ),
    [],
    "neither the scheduled slot nor the conference length may be logged",
  );
  // No attendance evidence at all (Meet source missing/failed) is just as empty.
  assert.deepEqual(
    deriveTempoProposals(calendarFacts, profile, "2026-07-28"),
    [],
  );
});

test("a session of mine proposes MY present time, not the scheduled slot", () => {
  const rows = deriveTempoProposals(
    [
      meeting(
        "sync",
        "Weekly Sync",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T11:00:00+02:00",
        { meetingUrl: "https://meet.google.com/ddd-eeee-fff" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    readMeetAttendanceEvidence([
      meetFact("ddd-eeee-fff", {
        attended: true,
        data: {
          attendedSeconds: 42 * 60,
          selfStart: "2026-07-28T08:02:00.000Z",
          selfEnd: "2026-07-28T08:44:00.000Z",
          conferenceSeconds: 60 * 60,
        },
      }),
    ]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.durationSeconds, 42 * 60, "my present time");
  assert.ok(
    rows[0]?.evidence?.includes("attendance:self-session"),
    "the proposal records what its attendance rests on",
  );
});

test("a meeting with no conference still derives from the accepted slot, marked as such", () => {
  const rows = deriveTempoProposals(
    [
      meeting(
        "inperson",
        "Weekly Sync",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T11:00:00+02:00",
      ),
    ],
    profile,
    "2026-07-28",
  );
  assert.equal(rows.length, 1, "no conference can ever have session evidence");
  assert.equal(rows[0]?.durationSeconds, 3600);
  assert.ok(rows[0]?.evidence?.includes("attendance:calendar-only"));
});

test("a non-Meet conference (Zoom/Teams) stays calendar-only, it is not gated on Meet", () => {
  // `meetingUrl` is the first conference link found ANYWHERE on the event, so it
  // can be Zoom/Teams — and a Zoom passcode even looks like a Meet code. A Meet
  // participant session can never evidence these, so they keep proposing the slot.
  for (const meetingUrl of [
    "https://us02web.zoom.us/j/85512345678?pwd=abcdefghij",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcdefghij",
  ]) {
    const rows = deriveTempoProposals(
      [
        meeting(
          "online",
          "Weekly Sync",
          "2026-07-28T10:00:00+02:00",
          "2026-07-28T11:00:00+02:00",
          { meetingUrl },
        ),
      ],
      profile,
      "2026-07-28",
    );
    assert.equal(rows.length, 1, `${meetingUrl} must still propose its slot`);
    assert.equal(rows[0]?.durationSeconds, 3600, "the accepted slot duration");
    assert.ok(rows[0]?.evidence?.includes("attendance:calendar-only"));
  }
});

test("one confirmed conference is credited to at most one calendar slot", () => {
  // A standing Meet link on two occurrences of the same day: my present time from
  // that ONE conference must not be logged twice.
  const confirmed = readMeetAttendanceEvidence([
    meetFact("std-ingl-ink", {
      attended: true,
      data: {
        attendedSeconds: 30 * 60,
        selfStart: "2026-07-28T13:00:00.000Z", // 15:00 Berlin — the second slot
        selfEnd: "2026-07-28T13:30:00.000Z",
      },
    }),
  ]);
  const rows = deriveTempoProposals(
    [
      meeting(
        "morning",
        "Weekly Sync",
        "2026-07-28T09:00:00+02:00",
        "2026-07-28T10:00:00+02:00",
        { meetingUrl: "https://meet.google.com/std-ingl-ink" },
      ),
      meeting(
        "afternoon",
        "Weekly Sync",
        "2026-07-28T15:00:00+02:00",
        "2026-07-28T15:30:00+02:00",
        { meetingUrl: "https://meet.google.com/std-ingl-ink" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    confirmed,
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.durationSeconds]),
    [["tempo:2026-07-28:afternoon", 30 * 60]],
    "the slot my session actually overlaps gets it; the other proposes nothing",
  );
});

test("overlapping confirmed attendance is matched per conference, never shared", () => {
  const confirmed = readMeetAttendanceEvidence([
    meetFact("ddd-eeee-fff", {
      attended: true,
      data: {
        attendedSeconds: 142 * 60,
        selfStart: "2026-07-28T08:02:00.000Z",
        selfEnd: "2026-07-28T10:24:00.000Z",
      },
    }),
    meetFact("aaa-bbbb-ccc", { data: { conferenceSeconds: 34 * 60 } }),
  ]);
  const rows = deriveTempoProposals(
    [
      meeting(
        "wm",
        "Weekly Sync",
        "2026-07-28T10:02:00+02:00",
        "2026-07-28T12:24:00+02:00",
        { meetingUrl: "https://meet.google.com/ddd-eeee-fff" },
      ),
      // Overlaps the confirmed one, but its own conference has no session of mine.
      meeting(
        "aaa-bbbb-ccc",
        "1:1 with Chris",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T10:34:00+02:00",
        { meetingUrl: "https://meet.google.com/aaa-bbbb-ccc" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    confirmed,
  );
  assert.deepEqual(
    rows.map((r) => [r.issueKey, r.durationSeconds]),
    [["WEB-1", 142 * 60]],
    "the confirmed meeting only, with my own duration",
  );
});

test("an unidentified conference of mine is never credited to a meeting its own conference shows I skipped", () => {
  // Task-224 review 2: an ad-hoc call of mine (space read failed, so `meetingCode`
  // is null) overlapping the sprint planning I skipped. The sprint planning's OWN
  // conference record — found without a session of mine — is the evidence that
  // forbids crediting my 2h22m to it.
  const evidence = readMeetAttendanceEvidence([
    {
      id: "meet:2026-07-28T08:02:00.000Z",
      kind: "meet-call",
      observedAt: "2026-07-28T20:00:00.000Z",
      title: "Meet call with Jordan",
      data: {
        meetingCode: null,
        attendanceBasis: "self-matched",
        attendedSeconds: 142 * 60,
        selfStart: "2026-07-28T08:02:00.000Z",
        selfEnd: "2026-07-28T10:24:00.000Z",
      },
      tags: ["own", "attended", "meet"],
    },
    meetFact("jjj-kkkk-lll", { data: { conferenceSeconds: 34 * 60 } }),
  ]);
  const productPlanning = meeting(
    "aaa-bbbb-ccc",
    "Weekly Sync",
    "2026-07-28T10:00:00+02:00",
    "2026-07-28T11:00:00+02:00",
    { meetingUrl: "https://meet.google.com/jjj-kkkk-lll" },
  );
  assert.deepEqual(
    deriveTempoProposals(
      [productPlanning],
      profile,
      "2026-07-28",
      new Map(),
      evidence,
    ),
    [],
    "2h22m of another meeting is never logged onto the one I skipped",
  );

  // Same conference of mine, but now the only Meet slot has NO conference record of
  // its own: the unidentified conference plausibly IS that meeting, so it counts.
  const rows = deriveTempoProposals(
    [
      meeting(
        "wm",
        "Weekly Sync",
        "2026-07-28T10:02:00+02:00",
        "2026-07-28T12:24:00+02:00",
        { meetingUrl: "https://meet.google.com/ddd-eeee-fff" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    readMeetAttendanceEvidence([
      {
        id: "meet:2026-07-28T08:02:00.000Z",
        kind: "meet-call",
        observedAt: "2026-07-28T20:00:00.000Z",
        title: "Meet call with Jordan",
        data: {
          meetingCode: null,
          attendanceBasis: "self-matched",
          attendedSeconds: 142 * 60,
          selfStart: "2026-07-28T08:02:00.000Z",
          selfEnd: "2026-07-28T10:24:00.000Z",
        },
        tags: ["own", "attended", "meet"],
      },
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.durationSeconds),
    [142 * 60],
  );
});

test("a CODE-LESS Meet slot is protected by its own conference record just like a coded one", () => {
  // Task-224 review 3: the skipped meeting's link is a nickname link, so its slot has
  // no code and the code-keyed guard could not fire. The record's WINDOW is the same
  // evidence, and it is already in the snapshot.
  const productPlanning = meeting(
    "aaa-bbbb-ccc",
    "Weekly Sync", // routes to WEB-1 through the profile
    "2026-07-28T10:00:00+02:00",
    "2026-07-28T11:00:00+02:00",
    { meetingUrl: "https://g.co/meet/productplanning" },
  );
  const skippedRecord: DaySourceFact = {
    id: "meet:ggg-hhhh-iii",
    kind: "meet-call",
    observedAt: "2026-07-28T20:00:00.000Z",
    title: "Meet conference",
    data: {
      meetingCode: "ggg-hhhh-iii",
      start: "2026-07-28T08:00:00.000Z",
      end: "2026-07-28T08:34:00.000Z",
      attendanceBasis: "unconfirmed-no-self-session",
      conferenceSeconds: 34 * 60,
    },
    tags: ["meet", "unconfirmed-attendance"],
  };
  const myAdHocCall: DaySourceFact = {
    id: "meet:ddd-eeee-fff",
    kind: "meet-call",
    observedAt: "2026-07-28T20:00:00.000Z",
    title: "Meet call with Jordan Lee",
    data: {
      meetingCode: "ddd-eeee-fff", // identified, but no calendar event carries it
      attendanceBasis: "self-matched",
      attendedSeconds: 8520,
      selfStart: "2026-07-28T08:02:00.000Z",
      selfEnd: "2026-07-28T10:24:00.000Z",
    },
    tags: ["own", "attended", "meet"],
  };
  assert.deepEqual(
    deriveTempoProposals(
      [productPlanning],
      profile,
      "2026-07-28",
      new Map(),
      readMeetAttendanceEvidence([myAdHocCall, skippedRecord]),
    ),
    [],
    "2h22m of my other call is never logged onto the nickname meeting I skipped",
  );

  // The collector's correlated title is a second usable key: same shape, but the
  // record's window is missing.
  assert.deepEqual(
    deriveTempoProposals(
      [productPlanning],
      profile,
      "2026-07-28",
      new Map(),
      readMeetAttendanceEvidence([
        myAdHocCall,
        {
          ...skippedRecord,
          title: "Weekly Sync",
          data: {
            meetingCode: null,
            calendarTitle: "Weekly Sync",
            attendanceBasis: "unconfirmed-no-self-session",
          },
        },
      ]),
    ),
    [],
  );

  // Without any record for that meeting, the unidentified-by-slot conference of mine
  // plausibly IS it, so my time still counts (unchanged behaviour).
  assert.deepEqual(
    deriveTempoProposals(
      [productPlanning],
      profile,
      "2026-07-28",
      new Map(),
      readMeetAttendanceEvidence([myAdHocCall]),
    ).map((r) => [r.issueKey, r.durationSeconds, r.evidence?.at(-1)]),
    [["WEB-1", 8520, "attendance:self-session"]],
  );
});

test("two conferences of mine that could each claim the same slot credit neither", () => {
  const call = (
    code: string | null,
    start: string,
    end: string,
    seconds: number,
  ) =>
    ({
      id: `meet:${code ?? start}`,
      kind: "meet-call",
      observedAt: "2026-07-28T20:00:00.000Z",
      title: "Meet call",
      data: {
        meetingCode: code,
        attendanceBasis: "self-matched",
        attendedSeconds: seconds,
        selfStart: start,
        selfEnd: end,
      },
      tags: ["own", "attended", "meet"],
    }) satisfies DaySourceFact;
  const rows = deriveTempoProposals(
    [
      meeting(
        "nickname",
        "Weekly Sync",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T11:00:00+02:00",
        { meetingUrl: "https://g.co/meet/weeklysync" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    readMeetAttendanceEvidence([
      call(null, "2026-07-28T08:00:00.000Z", "2026-07-28T08:30:00.000Z", 1800),
      call(
        "oth-erca-llx",
        "2026-07-28T08:30:00.000Z",
        "2026-07-28T09:00:00.000Z",
        1800,
      ),
    ]),
  );
  assert.deepEqual(rows, [], "we cannot tell which call was that meeting");
});

test("an ambiguous window credits neither meeting", () => {
  // My unidentified conference overlaps two Meet meetings; nothing says which one I
  // was in, so neither may claim my time.
  const evidence = readMeetAttendanceEvidence([
    {
      id: "meet:adhoc",
      kind: "meet-call",
      observedAt: "2026-07-28T20:00:00.000Z",
      title: "Meet call",
      data: {
        meetingCode: null,
        attendanceBasis: "self-matched",
        attendedSeconds: 45 * 60,
        selfStart: "2026-07-28T08:00:00.000Z",
        selfEnd: "2026-07-28T08:45:00.000Z",
      },
      tags: ["own", "attended", "meet"],
    },
  ]);
  const rows = deriveTempoProposals(
    [
      meeting(
        "one",
        "Weekly Sync",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T11:00:00+02:00",
        { meetingUrl: "https://meet.google.com/one-abcd-efg" },
      ),
      meeting(
        "two",
        "1:1 with Chris",
        "2026-07-28T10:15:00+02:00",
        "2026-07-28T10:45:00+02:00",
        { meetingUrl: "https://meet.google.com/two-abcd-efg" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    evidence,
  );
  assert.deepEqual(rows, []);
});

test("a Meet link with no code in it (nickname/lookup) is matched by time, not dropped", () => {
  // Task-224 review 2, finding 1: `meet.google.com/lookup/<name>` and
  // `g.co/meet/<nickname>` carry no code. Slicing letters out of the path invented a
  // code that matched nothing, so a meeting I DID attend proposed no time at all.
  for (const meetingUrl of [
    "https://meet.google.com/lookup/kickoffmeeting",
    "https://g.co/meet/teamstandup",
  ]) {
    const rows = deriveTempoProposals(
      [
        meeting(
          "kickoff",
          "Weekly Sync",
          "2026-07-28T10:00:00+02:00",
          "2026-07-28T11:00:00+02:00",
          { meetingUrl },
        ),
      ],
      profile,
      "2026-07-28",
      new Map(),
      readMeetAttendanceEvidence([
        meetFact("kic-koff-mtg", {
          attended: true,
          data: {
            attendedSeconds: 55 * 60,
            selfStart: "2026-07-28T08:03:00.000Z",
            selfEnd: "2026-07-28T08:58:00.000Z",
          },
        }),
      ]),
    );
    assert.deepEqual(
      rows.map((r) => [r.durationSeconds, r.evidence?.at(-1)]),
      [[55 * 60, "attendance:self-session"]],
      `${meetingUrl}: my present time, correlated by time`,
    );
  }

  // Not attended: it is still Meet-gated, so it proposes nothing (never the slot).
  assert.deepEqual(
    deriveTempoProposals(
      [
        meeting(
          "kickoff",
          "Weekly Sync",
          "2026-07-28T10:00:00+02:00",
          "2026-07-28T11:00:00+02:00",
          { meetingUrl: "https://g.co/meet/teamstandup" },
        ),
      ],
      profile,
      "2026-07-28",
    ),
    [],
  );
});

test("a conference code committed dash-less still identifies its meeting", () => {
  // Task-224 review 2, finding 3: the collector's code and the read side must agree.
  const evidence = readMeetAttendanceEvidence([
    meetFact("abcdefghij", {
      attended: true,
      data: {
        attendedSeconds: 20 * 60,
        selfStart: "2026-07-28T08:00:00.000Z",
        selfEnd: "2026-07-28T08:20:00.000Z",
      },
    }),
  ]);
  assert.deepEqual(
    evidence.confirmed.map((c) => c.code),
    ["abc-defg-hij"],
    "a dash-less stored code is canonicalized, not demoted to 'unknown'",
  );
  const rows = deriveTempoProposals(
    [
      meeting(
        "sync",
        "Weekly Sync",
        "2026-07-28T10:00:00+02:00",
        "2026-07-28T11:00:00+02:00",
        { meetingUrl: "https://meet.google.com/abc-defg-hij" },
      ),
    ],
    profile,
    "2026-07-28",
    new Map(),
    evidence,
  );
  assert.deepEqual(
    rows.map((r) => r.durationSeconds),
    [20 * 60],
    "matched by identity, never by time",
  );
});

test("routing ladder: explicit key → title mapping → participant area", () => {
  const routingProfile: TempoProfile = {
    ...emptyTempoProfile(),
    defaultActivityKey: "MEET",
    mappings: [
      { titleMatch: "Weekly Sync", issueKey: "WEB-1", activityKey: "DEV" },
    ],
    areas: [
      {
        area: "resources",
        issueKey: "OPS-9",
        activityKey: "ADM",
        profitCenter: "Engineering",
      },
    ],
    ticketDefaults: { "WEB-5": "DEV" },
  };

  // 1. explicit key in the title wins, with the per-ticket default activity.
  const explicit = routeMeeting("Design review WEB-5", routingProfile, []);
  assert.deepEqual(explicit, {
    issueKey: "WEB-5",
    activityKey: "DEV",
    basis: "explicit-key",
  });

  // 2. title mapping when no explicit key.
  assert.equal(
    routeMeeting("Weekly Sync", routingProfile, [])?.basis,
    "title-mapping",
  );

  // 3. participant area routes an otherwise-unmapped meeting.
  const byArea = routeMeeting("Catch-up", routingProfile, ["resources"]);
  assert.deepEqual(byArea, {
    issueKey: "OPS-9",
    activityKey: "ADM",
    basis: "participant-area",
    profitCenter: "Engineering",
  });

  // Nothing matches → null (safe).
  assert.equal(routeMeeting("Random", routingProfile, ["unknown-area"]), null);
});

test("parseIssueKey extracts the first KEY-123 token", () => {
  assert.equal(parseIssueKey("Sync about web-5 and NEB-1338"), "NEB-1338");
  assert.equal(parseIssueKey("NEB-1338 kickoff"), "NEB-1338");
  assert.equal(parseIssueKey("no key here"), null);
});

test("areasByMeetingTitle resolves participants to contact areas", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.ASSISTANT_CWD = mkdtempSync(
    join(tmpdir(), "tempo-derive-areas-"),
  );
  const { upsertContact } = await import("../contacts.ts");
  const { contactStore } = await import("../db/contactStore.ts");
  contactStore.resetForTests();
  upsertContact({ name: "Sam Rivera", areas: ["resources"] });

  const fact: DaySourceFact = {
    id: "meet:1",
    kind: "meet-conference",
    observedAt: "2026-07-13T10:00:00.000Z",
    title: "Catch-up",
    data: {
      meetParticipants: [
        { displayName: "Sam Rivera", presentSeconds: 1800 },
        { displayName: "Unknown Person" },
      ],
    },
  };
  const map = areasByMeetingTitle([fact]);
  assert.deepEqual(map.get("catch-up"), ["resources"]);

  // The collector's own shape (`name` + `seconds`) resolves the same way, and it
  // only exists for conferences I attended — an unconfirmed meeting commits no
  // names, so other people's attendance never routes my time.
  const collectorShape = areasByMeetingTitle([
    {
      ...fact,
      title: "Second catch-up",
      data: { meetParticipants: [{ name: "Sam Rivera", seconds: 1800 }] },
    },
  ]);
  assert.deepEqual(collectorShape.get("second catch-up"), ["resources"]);
});

test("an empty profile proposes nothing (safe default)", () => {
  const rows = deriveTempoProposals(
    [
      meeting(
        "a",
        "Weekly Sync",
        "2026-07-13T09:00:00+02:00",
        "2026-07-13T10:00:00+02:00",
      ),
    ],
    emptyTempoProfile(),
    "2026-07-13",
  );
  assert.deepEqual(rows, []);
});

test("profile matching, rounding, and learning", () => {
  assert.equal(
    matchTempoProfile(profile, "Weekly Sync — Eng")?.issueKey,
    "WEB-1",
  );
  assert.equal(matchTempoProfile(profile, "unrelated"), null);
  assert.equal(
    roundDuration({ ...emptyTempoProfile(), roundToMinutes: 15 }, 50 * 60),
    45 * 60,
  );
  const learned = upsertProfileMapping(emptyTempoProfile(), {
    titleMatch: "Standup",
    issueKey: "web-9",
    activityKey: "dev",
  });
  assert.deepEqual(learned.mappings[0], {
    titleMatch: "Standup",
    issueKey: "WEB-9",
    activityKey: "DEV",
  });
  // A correction replaces the same titleMatch rather than duplicating.
  const corrected = upsertProfileMapping(learned, {
    titleMatch: "standup",
    issueKey: "WEB-10",
  });
  assert.equal(corrected.mappings.length, 1);
  assert.equal(corrected.mappings[0]?.issueKey, "WEB-10");
});
