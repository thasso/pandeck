import assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import { FORK_ORIGIN_CUSTOM_TYPE, readForkOrigin } from "./forkOrigin.ts";

describe("session fork origins", () => {
  it("round-trips fresh harness/agentType fork markers", () => {
    const origin = readForkOrigin(
      "workshop",
      managerWithEntries([
        {
          type: "custom",
          customType: FORK_ORIGIN_CUSTOM_TYPE,
          data: {
            harness: "pi",
            agentType: "workshop",
            parentSessionFile: "/tmp/parent.jsonl",
            parentSessionId: "parent-id",
            parentEntryId: "entry-id",
            position: "at",
            createdAt: 42,
          },
        },
      ]),
    );

    assert.deepEqual(origin, {
      harness: "pi",
      agentType: "workshop",
      parentSessionFile: "/tmp/parent.jsonl",
      parentSessionId: "parent-id",
      parentEntryId: "entry-id",
      position: "at",
      createdAt: 42,
    });
  });

  it("does not decode single-kind fork markers", () => {
    const origin = readForkOrigin(
      "assistant",
      managerWithEntries([
        {
          type: "custom",
          customType: FORK_ORIGIN_CUSTOM_TYPE,
          data: {
            kind: "workshop",
            parentSessionFile: "/tmp/legacy.jsonl",
            parentSessionId: "legacy-id",
          },
        },
      ]),
    );

    assert.equal(origin, undefined);
  });
});

/**
 * `readForkOrigin` scans every entry rather than the current branch (a `/clear`
 * resets the leaf and would otherwise hide the marker), so both readers answer
 * with the same list here.
 */
function managerWithEntries(entries: unknown[]): SessionManager {
  return {
    getEntries: () => entries,
    getBranch: () => entries,
    getHeader: () => undefined,
  } as unknown as SessionManager;
}
