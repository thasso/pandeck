import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildAttendanceSlices,
  renderDayBriefingPrompt,
  renderLogMyTimePrompt,
  renderSynthesisPrompt,
  type DaySynthesisDigest,
} from "./digest.ts";

const digest: DaySynthesisDigest = {
  date: "2026-07-22",
  health: [],
  changesSinceLastScan: 0,
  buckets: [],
  myWork: [],
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
  attendance: [],
  unconfirmedAttendance: [],
};

test("the synthesis prompt requires links for Jira keys, created Tasks, and meetings", () => {
  const prompt = renderSynthesisPrompt(digest);
  assert.match(
    prompt,
    /\/browse\/WEB-8514/,
    "gives a concrete Jira browse-link example",
  );
  assert.match(
    prompt,
    /pa:\/\/task\/<taskId>/,
    "instructs linking created Tasks",
  );
  assert.match(
    prompt,
    /pa:\/\/knowledge\/<entryId>/,
    "instructs linking meeting entries",
  );
  // The linkable references travel in the serialized digest.
  assert.match(prompt, /meeting-abc/);
  assert.match(prompt, /"taskId": "145"/);
  assert.match(prompt, /baseRevision: 3/);
  assert.match(
    prompt,
    /CONTINUES that existing work/,
    "instructs noticing already-started work",
  );
  assert.match(
    prompt,
    /license-service-drm-session-binding-overview/,
    "related entry travels in the digest",
  );
});

test("the day-briefing prompt reuses the digest but asks for a human briefing (not JSON)", () => {
  const prompt = renderDayBriefingPrompt(digest);
  assert.match(prompt, /Brief me on my day for 2026-07-22/);
  assert.match(
    prompt,
    /"taskId": "145"/,
    "the same digest travels in the briefing turn",
  );
  assert.match(prompt, /\/browse\/<KEY>/, "keeps the Jira linking contract");
  assert.doesNotMatch(
    prompt,
    /Required JSON shape/,
    "does not demand the machine JSON schema",
  );
});

test("the log-my-time prompt carries own work + attendance and demands confirmation before writing", () => {
  const withWork: DaySynthesisDigest = {
    ...digest,
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
  };
  const prompt = renderLogMyTimePrompt(withWork);
  assert.match(prompt, /log MY time/i);
  assert.match(prompt, /ONLY for my OWN work/);
  assert.match(prompt, /MOB-202 General Time Tracking/, "own work travels");
  assert.match(prompt, /WM eng sync/, "attendance travels");
  assert.match(prompt, /Alice/, "who attended travels");
  assert.match(prompt, /WAIT for my confirmation/, "no silent writes");
  assert.match(
    prompt,
    /tempo_list_worklogs/,
    "pushes verification against Tempo",
  );
});

test("the log-my-time prompt forbids logging unconfirmed attendance", () => {
  const prompt = renderLogMyTimePrompt({
    ...digest,
    unconfirmedAttendance: [
      {
        title: "Product Planning",
        basis: "no-self-session",
        response: "accepted",
        conferenceMinutes: 34,
        conflicts: ["Weekly Engineering Sync"],
      },
    ],
  });
  assert.match(prompt, /NEVER log time from `unconfirmedAttendance`/);
  assert.match(prompt, /UNCONFIRMED ATTENDANCE/);
  assert.match(prompt, /Product Planning/, "the meeting travels…");
  assert.match(prompt, /no-self-session/, "…with why it is not attendance");
});

test("the narrative prompts separate calendar acceptance from confirmed attendance", () => {
  const withUnconfirmed: DaySynthesisDigest = {
    ...digest,
    attendance: [
      {
        title: "Weekly Engineering Sync",
        kind: "meeting",
        minutes: 142,
        basis: "self-matched",
        participants: [{ name: "Jordan", minutes: 140 }],
      },
    ],
    unconfirmedAttendance: [
      {
        title: "Product Planning",
        basis: "no-self-session",
        response: "accepted",
        conferenceMinutes: 34,
        conflicts: ["Weekly Engineering Sync"],
      },
    ],
  };
  for (const prompt of [
    renderSynthesisPrompt(withUnconfirmed),
    renderDayBriefingPrompt(withUnconfirmed),
  ]) {
    assert.match(
      prompt,
      /unconfirmedAttendance/,
      "names the unconfirmed slice",
    );
    assert.match(
      prompt,
      /not attendance|NOT attendance/,
      "states that those are not attendance",
    );
    assert.match(
      prompt,
      /conferenceMinutes/,
      "warns the conference duration is not mine",
    );
    assert.match(prompt, /Product Planning/, "the item travels");
  }
});

test("both prompts teach the own-work discipline so 'Your work' excludes inbound/attention items", () => {
  const withWork: DaySynthesisDigest = {
    ...digest,
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
  };
  for (const prompt of [
    renderSynthesisPrompt(withWork),
    renderDayBriefingPrompt(withWork),
  ]) {
    assert.match(prompt, /OWNERSHIP/, "states the ownership rule");
    assert.match(
      prompt,
      /ONLY my own work/,
      "restricts 'Your work' to own items",
    );
    assert.match(
      prompt,
      /"myWork"/,
      "the own-work slice travels in the digest",
    );
    assert.match(
      prompt,
      /MOB-202 General Time Tracking/,
      "the own item is present",
    );
  }
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
