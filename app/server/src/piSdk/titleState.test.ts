import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "@assistant/shared";
import { afterAll, describe, it } from "vitest";
import {
  piSessionHasUserPrompt,
  restorePiLiveTitle,
  shouldAutoNamePiSession,
} from "./titleState.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-title-state-test-"));
process.env.ASSISTANT_CWD = tmp;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { localPiEngine } = await import("./piEngine.ts");
const { closeDb } = await import("../db/index.ts");
const { getSettings, updateSettings } = await import("../settings.ts");
const { fallbackSessionTitle } = await import("../sessionNaming.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

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

describe("pi skill command naming", () => {
  it("names and shows a skill turn as typed, never as the native command", async () => {
    // No naming model runs here: the fallback title is the whole check.
    updateSettings({
      sessionNaming: { ...getSettings().sessionNaming, enabled: false },
    });
    const sent: string[] = [];
    const seen: ServerMessage[] = [];
    const live = new PiLiveSession(
      "coding" as never,
      localPiEngine({
        sessionId: "pi-skill-title",
        sessionName: undefined,
        isStreaming: false,
        sessionManager: { getBranch: () => [] },
        subscribe: () => () => {},
        getSessionStats: () => ({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          contextSize: 0,
        }),
        prompt: (text: string) => {
          sent.push(text);
          return Promise.resolve();
        },
      } as never),
      {
        sessionRowsChanged: () => {},
        noteRunStarted: () => {},
        checkPendingReload: () => {},
        isReloadQueued: () => false,
        buildSessionState: () => ({}) as never,
      } as never,
      () => {},
    );
    live.addViewer({ send: (m: ServerMessage) => seen.push(m) });
    void live.createRuntimeAdapter().prompt("/skill:alpha the parser", {
      turnContext: "<memory>m</memory>",
      titleText: "/alpha the parser",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(sent, ["/skill:alpha the parser\n\n<memory>m</memory>"]);
    assert.equal(live.title, fallbackSessionTitle("/alpha the parser", []));
    const shown = JSON.stringify(
      seen.filter((m) => (m as { type: string }).type === "userMessage"),
    );
    assert.ok(shown.includes("/alpha the parser"));
    assert.ok(!shown.includes("/skill:") && !shown.includes("<memory>"));
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
