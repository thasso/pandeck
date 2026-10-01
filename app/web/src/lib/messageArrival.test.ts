import { beforeEach, expect, it } from "vitest";

import {
  arrivalHasHome,
  arrivalMessage,
  type FailureHomes,
  objectFailureFrom,
  readFailureHomes,
  resetFailureHomes,
  sessionFailureFrom,
  setFailureHomes,
} from "./messageArrival.ts";

/**
 * `docs/messaging.md`: an announcement is an EVENT, decided when the message
 * lands. Everything here was once read back off a global slot in reducer state,
 * and every bug in this area was the same shape — a persistent store asked to
 * name the current event.
 */

const nowhere = { viewedSessionId: null, revealRequestId: null };
const NO_OBJECTS = { project: [], task: [], knowledge: [] };

/** Claim only what a case is about; everything else is off screen. */
function claim(homes: Partial<FailureHomes>): void {
  setFailureHomes({
    viewedSessionId: null,
    stagedSend: null,
    openObjects: NO_OBJECTS,
    ...homes,
  });
}

beforeEach(() => resetFailureHomes());

it("reads what an arrival says, from the message and nothing else", () => {
  expect(
    arrivalMessage(
      { type: "error", message: "Failed to send prompt: gone" },
      nowhere,
    ),
  ).toEqual({ severity: "error", message: "Failed to send prompt: gone" });

  expect(
    arrivalMessage(
      {
        type: "notice",
        severity: "warning",
        message: "heads up",
        target: { type: "worktree", id: "w1" },
      },
      nowhere,
    ),
  ).toEqual({
    severity: "warning",
    message: "heads up",
    target: { type: "worktree", id: "w1" },
  });

  // A message with nothing to say to the user says nothing.
  expect(arrivalMessage({ type: "taskProjectsAssigned" }, nowhere)).toBeNull();
});

// Correlation, not ownership: an answer to a jump the reader has already
// navigated past, or a run in a chat this client is not looking at, is not
// this client's message at all.
it("ignores an arrival that is not about what this client is doing", () => {
  const missed = {
    type: "timelineAnchor" as const,
    requestId: "r1",
  };
  expect(arrivalMessage(missed, nowhere)).toBeNull();
  expect(
    arrivalMessage(missed, { viewedSessionId: null, revealRequestId: "r1" }),
  ).toEqual({
    severity: "info",
    message: "That message is no longer in the other session.",
  });

  const failedRun = {
    type: "event" as const,
    sessionId: "s2",
    event: { type: "runStatus" as const, status: "error" as const },
  };
  expect(
    arrivalMessage(failedRun, { viewedSessionId: "s1", revealRequestId: null }),
  ).toBeNull();
  expect(
    arrivalMessage(failedRun, { viewedSessionId: "s2", revealRequestId: null }),
  ).toEqual({ severity: "error", message: "Run failed." });
});

// Identity is the arrival, never the words: the SAME sentence arriving again is
// a new event the user has to be told about, and each answer is computed from
// its own message with nothing carried between them.
it("answers each arrival on its own, including a repeat of the same words", () => {
  const again = {
    type: "error" as const,
    message: "Failed to send prompt: connection lost",
    target: { type: "session" as const, id: "b" },
  };
  expect(arrivalMessage(again, nowhere)).toEqual(
    arrivalMessage(again, nowhere),
  );
  expect(arrivalMessage(again, nowhere)).not.toBeNull();
});

// `queued` and `working` are states the message IS in until the next one
// replaces them, so they are rendered on that prompt's row and say nothing
// here. They used to be info notices, which is a condition on the announcement
// channel — the divergence this closed.
it("says nothing about a queued prompt's conditions", () => {
  const queued = {
    type: "permanentAssistantQueue" as const,
    sessionId: "pa",
    clientRequestId: "c1",
  };
  for (const state of ["queued", "working", "completed"] as const)
    expect(arrivalMessage({ ...queued, state }, nowhere)).toBeNull();

  // The one genuine failure names the session it happened in, like every other
  // session failure — so it is shown in place, or announced naming it, but only
  // ever one of the two.
  expect(
    arrivalMessage({ ...queued, state: "failed", error: "no model" }, nowhere),
  ).toEqual({
    severity: "error",
    message: "no model",
    target: { type: "session", id: "pa" },
  });
  expect(
    sessionFailureFrom({ ...queued, state: "failed", error: "no model" }),
  ).toEqual({ sessionId: "pa", message: "no model" });
  expect(sessionFailureFrom({ ...queued, state: "working" })).toBeNull();
});

it("puts an error that names a session onto that session", () => {
  expect(
    sessionFailureFrom({
      type: "error",
      message: "Failed to fork session: no anchor",
      target: { type: "session", id: "s1" },
    }),
  ).toEqual({ sessionId: "s1", message: "Failed to fork session: no anchor" });

  // A warning is not a failure, a collection is not a member, and a message
  // about something else is not the session's.
  expect(
    sessionFailureFrom({
      type: "notice",
      severity: "warning",
      message: "heads up",
      target: { type: "session", id: "s1" },
    }),
  ).toBeNull();
  expect(
    sessionFailureFrom({
      type: "error",
      message: "x",
      target: { type: "session" },
    }),
  ).toBeNull();
  expect(
    sessionFailureFrom({
      type: "error",
      message: "Failed to remove worktree: busy",
      target: { type: "worktree", id: "w1" },
    }),
  ).toBeNull();
});

// The model's first question, made concrete. Getting it wrong in either
// direction is silent: a failure shown twice, or one shown nowhere.
it("consumes an error the viewed session already renders, and only that one", () => {
  claim({ viewedSessionId: "s1" });
  const about = (id: string) => ({
    severity: "error" as const,
    message: "Failed to send prompt: gone",
    target: { type: "session" as const, id },
  });
  expect(arrivalHasHome(about("s1"))).toBe(true);
  expect(arrivalHasHome(about("s2"))).toBe(false);
  // An untargeted failure names no object, so nothing on screen owns it.
  expect(
    arrivalHasHome({ severity: "error", message: "Failed to save settings" }),
  ).toBe(false);
});

// The in-place note under the composer exists for a FAILURE. A warning naming
// the very session in view still has nowhere to go, and must still be said.
it("never consumes anything that is not an error", () => {
  claim({ viewedSessionId: "s1", stagedSend: { sessionId: null } });
  expect(
    arrivalHasHome({
      severity: "warning",
      message: "heads up",
      target: { type: "session", id: "s1" },
    }),
  ).toBe(false);
  expect(
    arrivalHasHome({
      severity: "info",
      message: "Message queued.",
      target: { type: "project" },
    }),
  ).toBe(false);
});

// A list that could not be read is a CONDITION on its collection: it is kept
// there and rendered by the pane whenever the user goes to it, on screen or
// not, so it is never also said in passing.
it("consumes a collection's load failure wherever the user is", () => {
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to list projects: disk full",
      target: { type: "project" },
    }),
  ).toBe(true);
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to list worktrees: git exploded",
      target: { type: "worktree" },
    }),
  ).toBe(true);
  // One project failing is an event about that project, not the pane's state.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to save project: disk full",
      target: { type: "project", id: "p1" },
    }),
  ).toBe(false);
  // The Task list keeps one too, now that the Backlog renders it.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to list tasks: disk full",
      target: { type: "task" },
    }),
  ).toBe(true);
  // A Knowledge entry has no COLLECTION condition — the tree loads over HTTP and
  // reports itself — so a targetless Knowledge failure is still said.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to read the Knowledge Base",
      target: { type: "knowledge" },
    }),
  ).toBe(false);
});

// A staged first send is CREATING the session it is about, so the blockers it
// narrates — the server's pre-creation refusals — name nothing. The surface
// claims those, and only while the send is out.
it("consumes the untargeted blockers a staged first send narrates", () => {
  const blocker = {
    severity: "error" as const,
    message: "Model openai/gpt-5 is not available.",
  };
  claim({ stagedSend: { sessionId: null } });
  expect(arrivalHasHome(blocker)).toBe(true);
  claim({});
  expect(arrivalHasHome(blocker)).toBe(false);
});

// The claim covers the send's OWN failure, not everything that lands during it.
// Suppressing every error for the length of a bootstrap loses a background
// session's failure entirely when it names nothing to be found by later — the
// same shape as the suppression that once swallowed every notice naming the
// viewed session.
it("keeps a staged send's claim to its own failure", () => {
  claim({ stagedSend: { sessionId: "c1" } });
  // A claude-sdk first send supplies the id the server names it by, so its own
  // prompt failure IS targeted, and is still narrated in place.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to send prompt: engine did not start",
      target: { type: "session", id: "c1" },
    }),
  ).toBe(true);
  // Another session failing in the background is not this bootstrap's business.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to rename session: session not found.",
      target: { type: "session", id: "other" },
    }),
  ).toBe(false);
  // Nor is a failure about any other kind of object.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to remove worktree: busy",
      target: { type: "worktree", id: "w1" },
    }),
  ).toBe(false);
  // A pi first send has no id of its own to match, so a targeted failure is
  // never claimed by the staged surface — only its untargeted blockers are.
  claim({ stagedSend: { sessionId: null } });
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to send prompt: engine did not start",
      target: { type: "session", id: "pi-minted" },
    }),
  ).toBe(false);
});

it("claims nothing until a surface says so", () => {
  expect(readFailureHomes()).toEqual({
    viewedSessionId: null,
    stagedSend: null,
    openObjects: NO_OBJECTS,
  });
});

// A project, Task or Knowledge entry answers the same first question as a
// session, and the answer is per OBJECT: one open Task says nothing about the
// rest of the list.
it("consumes a failure the open project, Task or entry renders", () => {
  claim({ openObjects: { project: ["p1"], task: ["t1"], knowledge: ["k1"] } });
  const about = (type: "project" | "task" | "knowledge", id: string) => ({
    severity: "error" as const,
    message: "Failed to save: nope",
    target: { type, id },
  });
  expect(arrivalHasHome(about("project", "p1"))).toBe(true);
  expect(arrivalHasHome(about("task", "t1"))).toBe(true);
  expect(arrivalHasHome(about("knowledge", "k1"))).toBe(true);
  // Another member of the same type is a row at best, and has no home.
  expect(arrivalHasHome(about("project", "p2"))).toBe(false);
  expect(arrivalHasHome(about("task", "t2"))).toBe(false);
  expect(arrivalHasHome(about("knowledge", "k2"))).toBe(false);
  // A worktree keeps no such store: its writes narrate themselves where they
  // were issued, so a failure naming one is announced.
  expect(
    arrivalHasHome({
      severity: "error",
      message: "Failed to remove worktree: busy",
      target: { type: "worktree", id: "w1" },
    }),
  ).toBe(false);
});

// One derivation, so the store that keeps a failure and the announcer that
// therefore stays quiet can never disagree about which object it was.
it("puts an error that names a project, Task or entry onto that object", () => {
  expect(
    objectFailureFrom({
      type: "error",
      message: "Failed to archive task: locked",
      target: { type: "task", id: "t1" },
    }),
  ).toEqual({
    type: "task",
    id: "t1",
    message: "Failed to archive task: locked",
  });
  expect(
    objectFailureFrom({
      type: "error",
      message: "Failed to add comment: EIO",
      target: { type: "knowledge", id: "k1" },
    }),
  ).toEqual({
    type: "knowledge",
    id: "k1",
    message: "Failed to add comment: EIO",
  });
  // A warning, a collection, a session and a worktree are all somebody else's.
  expect(
    objectFailureFrom({
      type: "notice",
      severity: "warning",
      message: "heads up",
      target: { type: "task", id: "t1" },
    }),
  ).toBeNull();
  expect(
    objectFailureFrom({
      type: "error",
      message: "Failed to list tasks: disk full",
      target: { type: "task" },
    }),
  ).toBeNull();
  expect(
    objectFailureFrom({
      type: "error",
      message: "Failed to send prompt: gone",
      target: { type: "session", id: "s1" },
    }),
  ).toBeNull();
  expect(
    objectFailureFrom({
      type: "error",
      message: "Failed to remove worktree: busy",
      target: { type: "worktree", id: "w1" },
    }),
  ).toBeNull();
});
