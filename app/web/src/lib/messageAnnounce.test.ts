import { expect, it } from "vitest";

import {
  announceMessage,
  failureOnViewedSession,
  targetName,
} from "./messageAnnounce.ts";
import { TOAST_BRIEF_MS, TOAST_DWELL_MS } from "./toast.ts";

/**
 * `docs/messaging.md`: an event whose surface is gone takes the ephemeral
 * channel and NAMES its object. The failure this guards is the one that started
 * the whole model — "Failed to send prompt" with nothing saying which of twenty
 * sessions it came from, so the user could not act on it even if they wanted to.
 */

// The model's first question: a failure whose object is ON SCREEN is rendered
// there, and must not also be said in passing. Getting this wrong in either
// direction is silent — a failure shown twice, or one shown nowhere. WHICH
// failures become a session's own is the reducer's decision; this is only the
// match against the session in view.
it("claims a failure about the session in view, and only that one", () => {
  // Two sessions failing at once: each keeps its OWN condition.
  const failures = {
    s1: "Failed to fork session: no anchor",
    s2: "Failed to rename session: session not found.",
  };
  expect(failureOnViewedSession(failures, "s1")).toBe(
    "Failed to fork session: no anchor",
  );
  expect(failureOnViewedSession(failures, "s2")).toBe(
    "Failed to rename session: session not found.",
  );
  // A session with nothing wrong, no session in view, and nothing failing.
  expect(failureOnViewedSession(failures, "s3")).toBeNull();
  expect(failureOnViewedSession(failures, null)).toBeNull();
  expect(failureOnViewedSession({}, "s1")).toBeNull();
});

it("names the object a targeted message is about", () => {
  const announced = announceMessage({
    severity: "error",
    message: "Failed to send prompt: connection lost.",
    target: { type: "session", id: "abc" },
    resolvedName: "Design review",
  });
  expect(announced.message).toBe(
    "Design review — Failed to send prompt: connection lost.",
  );
});

// A bare id is not a name, but it is attribution, and attribution is the whole
// point: without it the user cannot tell which object failed.
it("falls back to the object's type and id when no title is known", () => {
  expect(targetName({ type: "session", id: "abc" })).toBe("Session abc");
  expect(targetName({ type: "worktree", id: "w1" }, "  ")).toBe("Worktree w1");
  expect(targetName({ type: "task", id: "7" }, "Ship it")).toBe("Ship it");
});

it("leaves an untargeted message exactly as the server phrased it", () => {
  const announced = announceMessage({
    severity: "warning",
    message: "That timeline block is no longer available.",
  });
  expect(announced.message).toBe("That timeline block is no longer available.");
  expect(announced.key).toBeUndefined();
});

// Duration follows what the message asks of the reader, not the call site.
it("lets a failure dwell and keeps a remark brief", () => {
  expect(announceMessage({ severity: "error", message: "x" }).durationMs).toBe(
    TOAST_DWELL_MS,
  );
  expect(announceMessage({ severity: "info", message: "x" }).durationMs).toBe(
    TOAST_BRIEF_MS,
  );
  expect(announceMessage({ severity: "error", message: "x" }).tone).toBe(
    "error",
  );
});

// A second failure about the same object REPLACES the first: a pile of toasts
// about one broken thing is a pile the user has to dismiss.
it("keys a targeted message by its object so repeats replace", () => {
  const first = announceMessage({
    severity: "error",
    message: "one",
    target: { type: "session", id: "abc" },
  });
  const second = announceMessage({
    severity: "error",
    message: "two",
    target: { type: "session", id: "abc" },
  });
  const other = announceMessage({
    severity: "error",
    message: "three",
    target: { type: "session", id: "def" },
  });
  expect(first.key).toBe(second.key);
  expect(other.key).not.toBe(first.key);
});
