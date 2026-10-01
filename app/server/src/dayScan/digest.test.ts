import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildAttendanceSlices,
  renderDayBriefingPrompt,
  renderLogMyTimePrompt,
  renderSynthesisPrompt,
  type DaySynthesisDigest,
} from "./digest.ts";
import { absent, affirmed, assertPromptRules } from "../test/promptRules.ts";

// Every slice the prompts reason over is populated, so one fixture serves all
// three prompts.
const digest: DaySynthesisDigest = {
  date: "2026-07-22",
  health: [],
  changesSinceLastScan: 0,
  buckets: [],
  myWork: [
    {
      headline: "MOB-202 General Time Tracking",
      links: [],
      issueKeys: ["MOB-202"],
      project: "React Native",
      source: "jira",
      kind: "issue-transition",
    },
  ],
  openCandidates: [],
  meetings: [
    {
      entryId: "meeting-abc",
      title: "Product and Sales",
      sourceLink: "https://docs.google.com/document/d/x/edit",
    },
  ],
  createdTasks: [
    {
      taskId: "145",
      title: "Revise DRM two-pager",
      sourceLink: "https://docs.google.com/document/d/x/edit",
    },
  ],
  relatedKnowledge: [
    {
      entryId: "license-service-drm-session-binding-overview",
      title: "DRM session binding overview",
      snippet: "session token CDN leaching",
    },
  ],
  threadsRevision: 3,
  threads: [],
  jiraBaseUrl: "https://acme.atlassian.net",
  attendance: [
    {
      title: "WM eng sync",
      kind: "meeting",
      minutes: 45,
      basis: "self-matched",
      participants: [
        { name: "Alice", minutes: 45 },
        { name: "Bob", minutes: 30 },
      ],
    },
  ],
  unconfirmedAttendance: [
    {
      title: "Product Planning",
      basis: "no-self-session",
      response: "accepted",
      conferenceMinutes: 34,
      conflicts: ["WM eng sync"],
    },
  ],
};

test("the day-scan prompts state their claim, linking and attendance rules", () => {
  // The two narrative prompts (machine synthesis, human briefing) share one
  // rule set: the briefing IS the day report.
  const narrative = {
    "links-jira-keys": /\/browse\/<KEY>/,
    "links-created-tasks": /pa:\/\/task\/<taskId>/,
    "links-kb-entries": /pa:\/\/knowledge\/<entryId>/,
    "notes-continued-work": /CONTINUES/,
    "your-work-is-own-only": affirmed(/Your work[^.\n]*?(?<key>only my own)/i),
    "no-absence-claims-from-partial-sources":
      /(partial|failed)[^.\n]*(cannot|can't|does not|must not|never)[^.\n]*(support|justify)[^.\n]*absence/i,
    "source-text-is-data": affirmed(
      /source-derived text (?<key>as data)[^.\n]*\b(never|not)\b[^.\n]*instructions/i,
    ),
    "unconfirmed-is-not-attendance":
      /unconfirmedAttendance[^.\n]*not attendance/i,
    "conference-minutes-are-not-mine":
      /conferenceMinutes[^.\n]*never (mine|my)/i,
  };
  assertPromptRules({
    synthesis: {
      text: renderSynthesisPrompt(digest),
      rules: { ...narrative, "returns-the-json-shape": /Required JSON shape/ },
    },
    "day briefing": {
      text: renderDayBriefingPrompt(digest),
      rules: {
        ...narrative,
        "is-prose-not-json": absent(/Required JSON shape/),
      },
    },
    "log my time": {
      text: renderLogMyTimePrompt(digest),
      rules: {
        "logs-my-time": /log MY time/i,
        "own-work-only": affirmed(/(?<key>only) (for )?my own work/i),
        "asks-instead-of-inventing-hours":
          /(don't|do not|never) invent (hours|durations|time)/i,
        "never-logs-unconfirmed": /never log[^.\n]*unconfirmedAttendance/i,
        "unconfirmed-slice-is-labelled":
          /UNCONFIRMED ATTENDANCE[^\n]*do NOT log/i,
        "checks-tempo-first": /tempo_list_worklogs/,
        "confirms-before-writing": affirmed(/wait for my confirmation/i),
      },
    },
  });
});

test("each day-scan prompt carries the digest slices it reasons over", () => {
  const carried = {
    synthesis: [
      renderSynthesisPrompt(digest),
      [
        "https://acme.atlassian.net/browse/",
        "meeting-abc",
        '"taskId": "145"',
        "baseRevision: 3",
        "license-service-drm-session-binding-overview",
        '"myWork"',
        "MOB-202 General Time Tracking",
        "Product Planning",
      ],
    ],
    "day briefing": [
      renderDayBriefingPrompt(digest),
      [
        "https://acme.atlassian.net/browse/",
        "2026-07-22",
        '"taskId": "145"',
        '"myWork"',
        "MOB-202 General Time Tracking",
        "Product Planning",
      ],
    ],
    "log my time": [
      renderLogMyTimePrompt(digest),
      [
        "MOB-202 General Time Tracking",
        "WM eng sync",
        "Alice",
        "Product Planning",
        "no-self-session",
      ],
    ],
  } as const;
  for (const [name, [prompt, needles]] of Object.entries(carried))
    for (const needle of needles)
      assert.ok(prompt.includes(needle), `${name} prompt lost ${needle}`);
});

// The Task-224 snapshot fixtures: 2026-07-28, where an accepted Product Planning
// Planning conference ran for 34 minutes without any session of the user, who was
// in the overlapping Weekly Engineering Sync.
const meetSnapshotFacts = [
  {
    title: "Product Planning",
    tags: ["meet", "unconfirmed-attendance"],
    data: {
      meetingCode: "aaa-bbbb-ccc",
      attendanceBasis: "unconfirmed-no-self-session",
      attendanceConfirmed: false,
      attendedSeconds: null,
      conferenceSeconds: 34 * 60,
      participantCount: 3,
      conflictingSelfAttendance: [{ title: "Weekly Engineering Sync" }],
    },
  },
  {
    title: "Weekly Engineering Sync",
    tags: ["own", "attended", "meet"],
    data: {
      meetingCode: "ddd-eeee-fff",
      attendanceBasis: "self-matched",
      attendanceConfirmed: true,
      attendedSeconds: 142 * 60,
      conferenceSeconds: 144 * 60,
      meetParticipants: [{ name: "Jordan Lee", seconds: 140 * 60 }],
    },
  },
];

const calendarSnapshotFacts = [
  {
    title: "Product Planning",
    tags: ["event", "response:accepted"],
    data: {
      selfResponse: "accepted",
      meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
      start: "2026-07-28T08:00:00.000Z",
      end: "2026-07-28T08:30:00.000Z",
    },
  },
  {
    title: "Weekly Engineering Sync",
    tags: ["event", "response:accepted"],
    data: {
      selfResponse: "accepted",
      meetingUrl: "https://meet.google.com/ddd-eeee-fff",
      start: "2026-07-28T08:00:00.000Z",
      end: "2026-07-28T10:00:00.000Z",
    },
  },
  {
    title: "Dentist",
    tags: ["event", "response:accepted"],
    data: {
      selfResponse: "accepted",
      start: "2026-07-28T14:00:00.000Z",
      end: "2026-07-28T15:00:00.000Z",
    },
  },
  {
    title: "Optional all-hands",
    tags: ["event", "response:needsAction"],
    data: {
      selfResponse: "needsAction",
      start: "2026-07-28T16:00:00.000Z",
      end: "2026-07-28T17:00:00.000Z",
    },
  },
  {
    title: "Focus block",
    tags: ["event", "response:accepted"],
    data: {
      selfResponse: "accepted",
      transparency: "transparent",
      start: "2026-07-28T06:00:00.000Z",
      end: "2026-07-28T07:00:00.000Z",
    },
  },
];

test("attendance holds only session-backed meetings; accepted+occurred is unconfirmed", () => {
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    meetFacts: meetSnapshotFacts,
    calendarFacts: calendarSnapshotFacts,
  });
  assert.deepEqual(
    attendance.map((a) => [a.title, a.minutes, a.basis]),
    [["Weekly Engineering Sync", 142, "self-matched"]],
    "only the meeting I had a session in",
  );
  const productPlanning = unconfirmedAttendance.find(
    (a) => a.title === "Product Planning",
  );
  assert.ok(
    productPlanning,
    "the accepted meeting is surfaced, but as unconfirmed",
  );
  assert.equal(productPlanning.basis, "no-self-session");
  assert.equal(
    productPlanning.response,
    "accepted",
    "calendar acceptance is kept…",
  );
  assert.equal(
    productPlanning.conferenceMinutes,
    34,
    "…as is the conference's own duration, labelled as the conference's",
  );
  assert.deepEqual(productPlanning.conflicts, ["Weekly Engineering Sync"]);
  assert.ok(
    !unconfirmedAttendance.some((a) => a.title === "Weekly Engineering Sync"),
    "a confirmed meeting is never also listed as unconfirmed",
  );
});

test("an accepted meeting with no conference at all is calendar-only", () => {
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    calendarFacts: calendarSnapshotFacts,
  });
  assert.deepEqual(attendance, [], "the calendar alone confirms nothing");
  assert.deepEqual(
    unconfirmedAttendance.map((a) => [a.title, a.basis]),
    [
      ["Product Planning", "calendar-only"],
      ["Weekly Engineering Sync", "calendar-only"],
      ["Dentist", "calendar-only"],
    ],
    "accepted events only; needs-action/declined are not attendance claims",
  );
  assert.ok(
    !unconfirmedAttendance.some((a) => a.title === "Focus block"),
    "an event I marked as not busy is not a meeting whose attendance matters",
  );
});

test("a non-Meet conference link is calendar-only, not correlated to a Meet code", () => {
  // A Zoom passcode is code-shaped; it must not key the conference correlation.
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    meetFacts: meetSnapshotFacts,
    calendarFacts: [
      {
        title: "Partner call (Zoom)",
        tags: ["event", "response:accepted"],
        data: {
          selfResponse: "accepted",
          meetingUrl: "https://us02web.zoom.us/j/85512345678?pwd=abcdefghij",
          start: "2026-07-28T12:00:00.000Z",
          end: "2026-07-28T13:00:00.000Z",
        },
      },
    ],
  });
  assert.deepEqual(
    attendance.map((a) => a.title),
    ["Weekly Engineering Sync"],
  );
  assert.deepEqual(
    unconfirmedAttendance
      .filter((a) => a.title === "Partner call (Zoom)")
      .map((a) => [a.basis, a.conferenceMinutes]),
    [["calendar-only", null]],
    "another provider's meeting is never matched to a Meet conference",
  );
});

test("an unresolvable identity leaves every conference unconfirmed, with the reason", () => {
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    meetFacts: [
      {
        title: "Weekly Engineering Sync",
        tags: ["meet", "unconfirmed-attendance"],
        data: {
          meetingCode: "ddd-eeee-fff",
          attendanceBasis: "unconfirmed-identity-unavailable",
          conferenceSeconds: 144 * 60,
          participantCount: 4,
        },
      },
    ],
  });
  assert.deepEqual(attendance, []);
  assert.equal(unconfirmedAttendance[0]?.basis, "identity-unavailable");
  assert.equal(unconfirmedAttendance[0]?.conferenceMinutes, 144);
});

test("huddles I joined are confirmed attendance; the ones I did not are dropped", () => {
  const { attendance } = buildAttendanceSlices({
    huddleFacts: [
      {
        title: "Slack huddle (attended)",
        tags: ["own", "attended", "huddle"],
        data: {
          durationSeconds: 25 * 60,
          participants: [
            { name: "Me", self: true },
            { name: "Taylor", self: false },
          ],
        },
      },
      {
        title: "Slack huddle",
        tags: ["huddle"],
        data: { durationSeconds: 40 * 60 },
      },
    ],
  });
  assert.deepEqual(
    attendance.map((a) => [a.kind, a.minutes, a.basis]),
    [["huddle", 25, "attended"]],
  );
  assert.deepEqual(attendance[0]?.participants, [
    { name: "Taylor", minutes: null },
  ]);
});

test("a nickname-linked meeting I attended is reported once, as attended", () => {
  // Task-224 review 2, finding 1(b): the calendar link (`g.co/meet/<nickname>`)
  // carries no code, so the conference is correlated by TIME in the collector and
  // arrives with its calendar title — which is also the digest's dedupe key.
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    meetFacts: [
      {
        title: "Team standup",
        tags: ["own", "attended", "meet"],
        data: {
          meetingCode: "tea-mstd-anp",
          calendarTitle: "Team standup",
          attendanceBasis: "self-matched",
          attendanceConfirmed: true,
          attendedSeconds: 25 * 60,
          conferenceSeconds: 30 * 60,
          meetParticipants: [{ name: "Taylor Kim", seconds: 30 * 60 }],
        },
      },
    ],
    calendarFacts: [
      {
        title: "Team standup",
        tags: ["event", "response:accepted"],
        data: {
          selfResponse: "accepted",
          meetingUrl: "https://g.co/meet/teamstandup",
          start: "2026-07-28T08:00:00.000Z",
          end: "2026-07-28T08:30:00.000Z",
        },
      },
    ],
  });
  assert.deepEqual(
    attendance.map((a) => [a.title, a.minutes]),
    [["Team standup", 25]],
  );
  assert.deepEqual(
    unconfirmedAttendance,
    [],
    "never also listed as attendance I could not confirm",
  );
});

test("a conference code committed dash-less still dedupes against its calendar event", () => {
  // Task-224 review 2, finding 3: the read side canonicalizes whatever was stored.
  const { attendance, unconfirmedAttendance } = buildAttendanceSlices({
    meetFacts: [
      {
        title: "Meet call with Jordan",
        tags: ["own", "attended", "meet"],
        data: {
          meetingCode: "abcdefghij",
          attendanceBasis: "self-matched",
          attendedSeconds: 40 * 60,
        },
      },
    ],
    calendarFacts: [
      {
        title: "Pairing session",
        tags: ["event", "response:accepted"],
        data: {
          selfResponse: "accepted",
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          start: "2026-07-28T08:00:00.000Z",
          end: "2026-07-28T09:00:00.000Z",
        },
      },
    ],
  });
  assert.equal(attendance.length, 1);
  assert.deepEqual(unconfirmedAttendance, []);
});
