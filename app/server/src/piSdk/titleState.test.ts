import assert from "node:assert/strict";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import {
  piSessionHasUserPrompt,
  restorePiLiveTitle,
  shouldAutoNamePiSession,
} from "./titleState.ts";

describe("pi session title state", () => {
  it("hydrates live titles from native session names before metadata", () => {
    assert.equal(
      restorePiLiveTitle("Native Session Title", "Stored Title"),
      "Native Session Title",
    );
  });

  it("falls back to stored metadata titles", () => {
    assert.equal(
      restorePiLiveTitle(undefined, "Stored Metadata Title"),
      "Stored Metadata Title",
    );
  });

  it("drops provider placeholders but preserves the app's unlabeled state", () => {
    assert.equal(restorePiLiveTitle(undefined, "New chat"), undefined);
    assert.equal(restorePiLiveTitle("New session", "New chat"), undefined);
    assert.equal(
      restorePiLiveTitle(undefined, "Unlabeled Session"),
      "Unlabeled Session",
    );
  });

  it("only auto-names sessions with no durable user prompt or title", () => {
    assert.equal(
      shouldAutoNamePiSession({ sessionManager: managerWithBranch([]) }),
      true,
    );
    assert.equal(
      shouldAutoNamePiSession({
        sessionManager: managerWithBranch([{ type: "model_change" }]),
      }),
      true,
    );
    assert.equal(
      shouldAutoNamePiSession({
        sessionManager: managerWithBranch([]),
        storedTitle: "Unlabeled Session",
      }),
      true,
    );
    assert.equal(
      shouldAutoNamePiSession({
        sessionManager: managerWithBranch([]),
        storedTitle: "Existing Title",
      }),
      false,
    );
    assert.equal(
      shouldAutoNamePiSession({
        sessionManager: managerWithBranch(userBranch()),
      }),
      false,
    );
  });

  it("detects user prompts from durable branch state", () => {
    assert.equal(
      piSessionHasUserPrompt(
        managerWithBranch([
          { type: "message", message: { role: "assistant" } },
        ]),
      ),
      false,
    );
    assert.equal(piSessionHasUserPrompt(managerWithBranch(userBranch())), true);
  });
});

function userBranch(): unknown[] {
  return [{ type: "message", message: { role: "user" } }];
}

function managerWithBranch(
  branch: unknown[],
): Pick<SessionManager, "getBranch"> {
  return { getBranch: () => branch } as Pick<SessionManager, "getBranch">;
}
