import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { sessionStore } from "../../db/sessionStore.ts";
import { canonicalSessionLogPath } from "../../sessionStorage.ts";
import { catalogAuditInventory } from "../catalog.ts";
import {
  sessionAuditTools,
  SESSION_AUDIT_MAX_CHARS,
} from "./sessionAuditTool.ts";

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/sessionAudit/log.jsonl", import.meta.url),
);

let counter = 0;
let sessionId = "";
let logPath = "";

const ctx = {
  toolCallId: "test-call",
  session: {
    sessionId: "caller",
    harness: "pi" as const,
    agentType: "developer" as const,
  },
};

const tool = () => sessionAuditTools(catalogAuditInventory)[0]!;

beforeEach(() => {
  sessionId = `audited-session-${counter++}`;
  logPath = canonicalSessionLogPath(sessionId);
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "developer",
    title: "Audited session",
  });
  mkdirSync(dirname(logPath), { recursive: true });
  copyFileSync(FIXTURE, logPath);
});

afterEach(() => {
  rmSync(dirname(logPath), { recursive: true, force: true });
});

describe("session_audit", () => {
  it("returns a compact summary with no optional sections by default", async () => {
    const result = await tool().execute({ sessionId }, ctx);
    const details = result.details as Record<string, any>;
    assert.equal(details.sessionId, sessionId);
    assert.equal(details.totals.turns, 3);
    assert.equal(details.totals.toolCalls, 3);
    assert.equal(details.totals.processedInputTokens, 3800);
    assert.equal(details.totals.latestContext.tokens, 2100);
    assert.equal(details.turns, undefined);
    assert.equal(details.contributors, undefined);
    assert.equal(details.tools, undefined);
    assert.deepEqual(details.availableSections, [
      "turns",
      "contributors",
      "tools",
      "toolResults",
      "contextJumps",
      "events",
    ]);
    const text = (result.content[0] as { text: string }).text;
    assert.ok(
      text.length < 3_000,
      `default response should stay small, was ${text.length}`,
    );
  });

  it("adds only the requested sections", async () => {
    const result = await tool().execute(
      { sessionId, sections: ["turns", "tools"], maxTurns: 2 },
      ctx,
    );
    const details = result.details as Record<string, any>;
    assert.deepEqual(
      details.turns.map((turn: { turn: number }) => turn.turn),
      [2, 3],
    );
    assert.equal(details.turnsOmitted, 1);
    assert.ok(details.tools.eagerCount > 0);
    assert.equal(details.contributors, undefined);
    assert.deepEqual(details.availableSections, [
      "contributors",
      "toolResults",
      "contextJumps",
      "events",
    ]);
  });

  it("keeps every section under the response cap and returns no message bodies", async () => {
    const result = await tool().execute(
      {
        sessionId,
        sections: [
          "turns",
          "contributors",
          "tools",
          "toolResults",
          "contextJumps",
          "events",
        ],
        maxTurns: 60,
        top: 20,
      },
      ctx,
    );
    const text = (result.content[0] as { text: string }).text;
    assert.ok(
      text.length <= SESSION_AUDIT_MAX_CHARS,
      `response was ${text.length} chars`,
    );
    // The fixture's bodies are filler runs; none of them may appear.
    assert.ok(!text.includes("BBBB"));
    assert.ok(!text.includes("AAAA"));
    assert.ok(!text.includes("TTTT"));
  });

  it("drills down on one entry id without returning its text", async () => {
    const result = await tool().execute(
      { sessionId, entryId: "e2-assistant" },
      ctx,
    );
    const details = result.details as Record<string, any>;
    assert.equal(details.drilldown.found, true);
    assert.equal(details.drilldown.role, "assistant");
    assert.deepEqual(details.drilldown.toolCalls, ["find_tools", "bash"]);
    assert.ok(!JSON.stringify(details.drilldown).includes("TTTT"));
  });

  it("ignores unknown section names rather than failing the call", async () => {
    const result = await tool().execute(
      { sessionId, sections: ["turns", "nonsense"] },
      ctx,
    );
    const details = result.details as Record<string, any>;
    assert.ok(Array.isArray(details.turns));
  });

  it("rejects an empty or path-like session id", async () => {
    await assert.rejects(
      () => tool().execute({ sessionId: "" }, ctx),
      /required/,
    );
    await assert.rejects(
      () => tool().execute({ sessionId: "../etc/passwd" }, ctx),
      /single session identifier/,
    );
  });

  it("refuses a session outside the user's scope", async () => {
    for (const scope of ["internal", "subagent"] as const) {
      const id = `${scope}-audited-${counter++}`;
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "developer",
        title: `A ${scope} session`,
        scope,
      });
      await assert.rejects(
        () => tool().execute({ sessionId: id }, ctx),
        new RegExp(`not a user session \\(${scope}\\)`),
      );
    }
  });

  it("reports a session whose log is missing instead of failing", async () => {
    rmSync(logPath, { force: true });
    const result = await tool().execute({ sessionId }, ctx);
    const details = result.details as Record<string, any>;
    assert.equal(details.totals.turns, 0);
    assert.ok(
      (details.warnings as string[]).some((warning) =>
        warning.includes("no conversation log"),
      ),
      JSON.stringify(details.warnings),
    );
  });
});
