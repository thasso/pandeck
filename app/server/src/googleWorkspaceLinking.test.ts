import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalMeetCode,
  normalizeMeetCode,
  participantPresence,
  readMeetLink,
} from "./googleWorkspaceLinking.ts";

test("participantPresence unions a participant's sessions (a rejoin is not double time)", () => {
  const presence = participantPresence({
    participantSessions: [
      { startTime: "2026-07-28T10:02:00Z", endTime: "2026-07-28T10:30:00Z" },
      { startTime: "2026-07-28T10:35:00Z", endTime: "2026-07-28T11:05:00Z" },
    ],
  });
  assert.equal(presence.sessions, 2);
  assert.equal(presence.seconds, (28 + 30) * 60, "disjoint sessions add up");
  assert.equal(presence.start, "2026-07-28T10:02:00.000Z");
  assert.equal(presence.end, "2026-07-28T11:05:00.000Z");
});

test("participantPresence never double-counts a second device (overlapping sessions)", () => {
  // Laptop 10:00–11:00 with the phone joined 10:15–10:45 inside it: still one hour.
  const presence = participantPresence({
    participantSessions: [
      { startTime: "2026-07-28T10:00:00Z", endTime: "2026-07-28T11:00:00Z" },
      { startTime: "2026-07-28T10:15:00Z", endTime: "2026-07-28T10:45:00Z" },
    ],
  });
  assert.equal(presence.sessions, 2);
  assert.equal(presence.seconds, 3600);
  assert.equal(presence.start, "2026-07-28T10:00:00.000Z");
  assert.equal(presence.end, "2026-07-28T11:00:00.000Z");

  // Partially overlapping devices merge into one span, too.
  const straddling = participantPresence({
    participantSessions: [
      { startTime: "2026-07-28T10:00:00Z", endTime: "2026-07-28T10:40:00Z" },
      { startTime: "2026-07-28T10:30:00Z", endTime: "2026-07-28T11:00:00Z" },
    ],
  });
  assert.equal(straddling.seconds, 3600);
});

test("participantPresence reports session evidence even when a session is still open", () => {
  const presence = participantPresence({
    participantSessions: [{ startTime: "2026-07-28T10:02:00Z" }],
  });
  assert.equal(presence.sessions, 1, "the session IS attendance evidence");
  assert.equal(
    presence.seconds,
    null,
    "but its duration is not measurable yet",
  );
  assert.equal(presence.start, "2026-07-28T10:02:00.000Z");
});

test("participantPresence has no sessions when Meet returned none", () => {
  assert.deepEqual(participantPresence({}), {
    seconds: null,
    start: null,
    end: null,
    sessions: 0,
  });
  assert.equal(
    participantPresence({
      participantSessions: [{ endTime: "2026-07-28T10:30:00Z" }],
    }).sessions,
    0,
    "a session without a start carries no evidence",
  );
});

test("normalizeMeetCode extracts the code from a Meet URL", () => {
  assert.equal(
    normalizeMeetCode("https://meet.google.com/abc-defg-hij"),
    "abc-defg-hij",
  );
  assert.equal(normalizeMeetCode(null), null);
});

test("canonicalMeetCode accepts every form a code is reported in", () => {
  assert.equal(canonicalMeetCode("abc-defg-hij"), "abc-defg-hij");
  assert.equal(
    canonicalMeetCode("abcdefghij"),
    "abc-defg-hij",
    "dash-less too",
  );
  assert.equal(canonicalMeetCode("ABC-DEFG-HIJ"), "abc-defg-hij");
  // Not a code: a URL or a space resource name never travels on as an id.
  assert.equal(canonicalMeetCode("https://meet.google.com/abc-defg-hij"), null);
  assert.equal(canonicalMeetCode("spaces/AAAA1234"), null);
  assert.equal(canonicalMeetCode(null), null);
});

test("readMeetLink takes a code only from a whole dashed path segment", () => {
  assert.deepEqual(readMeetLink("https://meet.google.com/abc-defg-hij"), {
    isMeet: true,
    code: "abc-defg-hij",
  });
  assert.deepEqual(readMeetLink("https://meet.google.com/abc-defg-hij?hs=1"), {
    isMeet: true,
    code: "abc-defg-hij",
  });
  assert.deepEqual(readMeetLink("abc-defg-hij"), {
    isMeet: true,
    code: "abc-defg-hij",
  });
});

test("readMeetLink reports a Meet link with NO derivable code as its own state", () => {
  // Nickname/lookup links carry no code. Slicing ten letters out of the path used to
  // invent one ("kickoffmee") that no conference record can ever match.
  for (const url of [
    "https://meet.google.com/lookup/kickoffmeeting",
    "https://g.co/meet/teamstandup",
    "https://meet.google.com/room/standupdaily",
  ]) {
    assert.deepEqual(
      readMeetLink(url),
      { isMeet: true, code: null },
      `${url}: a Meet meeting, code unknown`,
    );
  }
});

test("readMeetLink rejects other providers (no Meet record can ever match them)", () => {
  // A Zoom passcode is a code-shaped letter run — this is why the URL reader exists.
  const zoom = "https://us02web.zoom.us/j/85512345678?pwd=abcdefghij";
  assert.equal(normalizeMeetCode(zoom), "abcdefghij");
  assert.deepEqual(readMeetLink(zoom), { isMeet: false, code: null });
  assert.deepEqual(
    readMeetLink(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcdefghij",
    ),
    { isMeet: false, code: null },
  );
  assert.deepEqual(readMeetLink("https://example.com/rooms/standup"), {
    isMeet: false,
    code: null,
  });
  // A look-alike host must not pass the Meet check.
  assert.deepEqual(
    readMeetLink("https://meet.google.com.evil.test/abc-defg-hij"),
    {
      isMeet: false,
      code: null,
    },
  );
  assert.deepEqual(readMeetLink(null), { isMeet: false, code: null });
  assert.deepEqual(readMeetLink(""), { isMeet: false, code: null });
});
