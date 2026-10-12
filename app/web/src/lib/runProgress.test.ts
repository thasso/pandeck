import { describe, expect, it } from "vitest";
import type { RunProgress } from "@assistant/shared/session";
import {
  runProgressView,
  toolActivityLabel,
  toolDisplayName,
  type LiveRunProgress,
} from "./runProgress.ts";

const NONE = { peers: 0, background: 0 };

/** Server clock 10_000_000; the browser's clock is an hour off on purpose. */
const SERVER = 10_000_000;
const LOCAL = SERVER + 3_600_000;

function live(progress: Partial<RunProgress>): LiveRunProgress {
  return {
    progress: {
      startedAt: SERVER - 60_000,
      observedAt: SERVER,
      lastActivityAt: SERVER - 60_000,
      runningTools: [],
      ...progress,
    },
    receivedAt: LOCAL,
  };
}

describe("runProgressView", () => {
  it("ages against the server's clock, whatever the browser's says", () => {
    const view = runProgressView(
      live({ awaitingModelSince: SERVER - 30_000 }),
      LOCAL + 5_000,
      { queues: NONE },
    );
    expect(view.label).toBe("Waiting for model");
    expect(view.elapsed).toBe("35s");
    expect(view.tone).toBe("default");
    expect(view.description).toContain("Run started 1m ago");
  });

  it("states a long silence plainly and never alarms on duration alone", () => {
    const view = runProgressView(
      live({ awaitingModelSince: SERVER - 40 * 60_000 }),
      LOCAL,
      { queues: NONE },
    );
    expect(view.label).toBe("Waiting for model");
    expect(view.elapsed).toBe("40m");
    expect(view.tone).toBe("default");
    expect(view.description).not.toMatch(/stall|stuck|deadlock/i);
  });

  it("names the oldest running tool and counts the rest", () => {
    const view = runProgressView(
      live({
        runningTools: [
          { toolCallId: "a", name: "Bash", startedAt: SERVER - 12_000 },
          { toolCallId: "b", name: "mcp__pa__session_read", startedAt: SERVER },
        ],
      }),
      LOCAL,
      { queues: NONE },
    );
    expect(view.label).toBe("Running command");
    expect(view.elapsed).toBe("12s");
    expect(view.details).toEqual(["2 tools running"]);
    expect(view.description).toContain("Also running: session_read.");
  });

  it("shows a reported retry with its attempt and status, as the only warning", () => {
    const view = runProgressView(
      live({
        awaitingModelSince: SERVER - 125_000,
        retry: { attempt: 3, maxAttempts: 10, status: 529, at: SERVER - 1_000 },
      }),
      LOCAL,
      { queues: NONE },
    );
    expect(view.label).toBe("Retrying request");
    expect(view.elapsed).toBe("2m");
    expect(view.details).toEqual(["attempt 3 of 10", "HTTP 529"]);
    expect(view.tone).toBe("warning");
  });

  it("tells thinking from answering, and ages output only once it goes quiet", () => {
    const arriving = live({ lastModelOutputAt: SERVER - 2_000 });
    expect(
      runProgressView(arriving, LOCAL, { lastBlock: "thinking", queues: NONE }),
    ).toMatchObject({ label: "Thinking", details: [] });
    expect(
      runProgressView(arriving, LOCAL, { lastBlock: "text", queues: NONE })
        .label,
    ).toBe("Responding");
    expect(
      runProgressView(arriving, LOCAL + 20_000, {
        lastBlock: "text",
        queues: NONE,
      }).details,
    ).toEqual(["last output 22s ago"]);
  });

  it("says what the model is answering while it waits, and what queues behind", () => {
    const view = runProgressView(
      live({
        awaitingModelSince: SERVER - 4_000,
        lastTool: { name: "Edit", state: "failed", at: SERVER - 4_000 },
      }),
      LOCAL,
      { queues: { peers: 2, background: 1 } },
    );
    expect(view.details).toEqual([
      "Edit failed 4s ago",
      "2 peer messages waiting",
      "1 background update waiting",
    ]);
  });
});

describe("tool names", () => {
  it("drops the MCP prefix and maps known tools to the transcript's verbs", () => {
    expect(toolDisplayName("mcp__pa__session_read")).toBe("session_read");
    expect(toolDisplayName("mcp__my_server__do")).toBe("do");
    expect(toolActivityLabel("Read")).toBe("Reading files");
    expect(toolActivityLabel("grep")).toBe("Searching");
    expect(toolActivityLabel("mcp__pa__kb_search")).toBe("Running kb_search");
  });
});
