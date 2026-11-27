/**
 * The canonical admission reader (`docs/schedules.md`, "Admission and crash
 * safety"): only a parsed, complete user message with exactly the key is
 * evidence of admission; keyed bytes that cannot be read as one make the
 * answer unknown.
 *   pnpm --filter @assistant/server test src/session/log/admittedUserEntry.test.ts
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { findAdmittedUserEntry } from "./admittedUserEntry.ts";

const KEY = "schedule:occ_7";
const HEADER = JSON.stringify({ v: 1, sessionId: "s", createdAt: "x" });

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admitted-user-entry-"));
  path = join(dir, "log.jsonl");
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function user(seq: number, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    role: "user",
    seq,
    id: `e${seq}`,
    origin: { kind: "human" },
    content: [{ type: "text", text: "hello" }],
    ...patch,
  });
}

function write(...lines: string[]): void {
  writeFileSync(path, lines.join("\n"));
}

const find = (key = KEY) => findAdmittedUserEntry("s", key, path);

describe("findAdmittedUserEntry", () => {
  it("T5.1 a complete keyed user entry is present", () => {
    write(HEADER, user(1), user(2, { clientRequestId: KEY }), "");
    assert.equal(find(), "present");
  });

  it("T5.2 the key anywhere but a user entry's clientRequestId is absent", () => {
    write(
      HEADER,
      user(1, { content: [{ type: "text", text: `see ${KEY}` }] }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        seq: 2,
        clientRequestId: KEY,
        content: [],
      }),
      user(3, { peerMessageIds: [KEY], clientRequestId: "peer:1" }),
      user(4, { clientRequestId: `${KEY}0` }),
      user(5, { clientRequestId: KEY.slice(0, -1) }),
      // No numeric seq: not an entry the log loads.
      user(6, { clientRequestId: KEY, seq: "6" }),
      "",
    );
    assert.equal(find(), "absent");
  });

  it("T5.3 a torn final keyed record is unknown; a torn unkeyed one is not", () => {
    write(HEADER, user(1), user(2, { clientRequestId: KEY }).slice(0, -2));
    assert.equal(find(), "unknown");
    write(HEADER, user(1), user(2).slice(0, -3));
    assert.equal(find(), "absent");
    // A complete keyed line with no newline after it was never finished either.
    write(HEADER, user(1, { clientRequestId: KEY }));
    assert.equal(find(), "unknown");
  });

  it("T5.4 a malformed complete keyed line is unknown, unless a valid keyed entry exists", () => {
    write(HEADER, `{"type":"message","clientRequestId":"${KEY}"`, user(2), "");
    assert.equal(find(), "unknown");
    write(HEADER, JSON.stringify([KEY]), "");
    assert.equal(find(), "unknown");
    write(
      HEADER,
      `{"type":"message","clientRequestId":"${KEY}"`,
      user(2, { clientRequestId: KEY }),
      "",
    );
    assert.equal(find(), "present");
    // Malformed lines without the key prove nothing either way.
    write(HEADER, "{not json", user(2), "");
    assert.equal(find(), "absent");
  });

  it("T5.5 a missing file is absent; an unreadable one is unknown", () => {
    assert.equal(find(), "absent");
    mkdirSync(path);
    assert.equal(find(), "unknown");
    rmSync(path, { recursive: true });
    write(HEADER, user(1, { clientRequestId: KEY }), "");
    // Root reads through mode 000, so the permission case needs a non-root run.
    if (process.getuid?.() !== 0) {
      chmodSync(path, 0o000);
      assert.equal(find(), "unknown");
      chmodSync(path, 0o600);
    }
    assert.equal(find(), "present");
  });

  it("reads the canonical path for the session by default", () => {
    assert.equal(findAdmittedUserEntry("no-such-session", KEY), "absent");
  });
});
