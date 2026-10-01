import { applyPatch, type Patch } from "@assistant/shared";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  auditSession as runAudit,
  CHARS_PER_TOKEN,
  type SessionAuditOptions,
  type SessionAuditSource,
} from "./sessionAudit.ts";
import { catalogAuditInventory } from "./tools/catalog.ts";

/**
 * Every audit here measures against the real catalog, the way the
 * `session_audit` tool does — the catalog hands the inventory in, so a test
 * that omitted it would exercise a shape production never uses.
 */
function auditSession(
  source: SessionAuditSource,
  options: SessionAuditOptions = {},
) {
  return runAudit(source, { inventory: catalogAuditInventory, ...options });
}

/**
 * The regression is pinned to the committed fixture (see its README): every
 * number derived from the LOG or the provider transcript is asserted exactly,
 * while catalog-derived rows (tool definition sizes, the persona prompt) are
 * asserted structurally — those move with the product, and pinning them here
 * would turn a prompt edit into a failing session-audit test.
 */
const FIXTURE = fileURLToPath(
  new URL("./test/fixtures/sessionAudit/", import.meta.url),
);

function fixtureSource(
  overrides: Patch<SessionAuditSource> = {},
): SessionAuditSource {
  return applyPatch(
    {
      sessionId: "fixture-session",
      meta: {
        title: "Fixture session",
        harness: "pi",
        agentType: "developer",
        createdAtMs: Date.parse("2026-07-01T10:00:00.000Z"),
        updatedAtMs: Date.parse("2026-07-01T10:03:07.000Z"),
        model: "fixture-model",
      },
      logPath: `${FIXTURE}log.jsonl`,
      callTranscript: { source: "pi-native", path: `${FIXTURE}native.jsonl` },
      persistedUsage: {
        inputTokens: 150,
        outputTokens: 180,
        cacheReadTokens: 3400,
        cacheWriteTokens: 250,
        reasoningTokens: 0,
        totalTokens: 3980,
        costMicros: 16000,
        usageTurns: 3,
        assistantTurns: 3,
        contextTokens: 2100,
        contextWindow: 200000,
      },
    },
    overrides,
  );
}

describe("session audit totals", () => {
  it("sums the log's per-turn usage and separates occupancy from processed input", () => {
    const report = auditSession(fixtureSource());
    assert.equal(report.totals.turns, 3);
    assert.equal(report.totals.assistantRuns, 3);
    assert.equal(report.totals.toolCalls, 3);
    assert.equal(report.totals.toolResults, 3);
    assert.equal(report.totals.failedToolResults, 1);
    assert.equal(report.totals.failedRuns, 1);
    assert.equal(report.totals.compactions, 1);
    assert.equal(report.totals.uncachedInputTokens, 150);
    assert.equal(report.totals.cacheReadTokens, 3400);
    assert.equal(report.totals.cacheWriteTokens, 250);
    assert.equal(report.totals.processedInputTokens, 3800);
    assert.equal(report.totals.outputTokens, 180);
    assert.equal(report.totals.costUSD, 0.016);
    // Occupancy is the LAST reported snapshot, never the sum above.
    assert.deepEqual(report.totals.latestContext, {
      tokens: 2100,
      window: 200000,
      percent: 1.05,
      basis: "reported",
    });
    assert.equal(report.totals.generationMs, 17_000);
    assert.equal(report.totals.toolResultBytes, 8242);
  });

  it("reconciles exactly with the persisted session stats", () => {
    const report = auditSession(fixtureSource());
    assert.equal(report.persisted?.agrees, true);
    assert.deepEqual(report.persisted?.differences, []);
  });

  it("reports a disagreement with the persisted stats instead of hiding it", () => {
    const source = fixtureSource();
    const report = auditSession({
      ...source,
      persistedUsage: { ...source.persistedUsage!, outputTokens: 999 },
    });
    assert.equal(report.persisted?.agrees, false);
    assert.deepEqual(report.persisted?.differences, [
      { field: "outputTokens", report: 180, persisted: 999, delta: -819 },
    ]);
  });

  it("labels occupancy as reported when the harness reports it", () => {
    const report = auditSession(fixtureSource());
    assert.equal(report.totals.latestContext.basis, "reported");
    assert.equal(report.turns[0]?.contextAfter, 1500);
  });

  it("falls back to the prompt-token sum for occupancy, and says so", () => {
    // A log whose runs report NO contextTokens: the report must fall back to
    // the store's own prompt-token sum (which over-counts a tool loop) and
    // label it, rather than passing it off as a harness snapshot.
    const report = auditSession(
      fixtureSource({
        logPath: `${FIXTURE}log-no-context-tokens.jsonl`,
        callTranscript: undefined,
        persistedUsage: undefined,
      }),
    );
    assert.equal(report.totals.latestContext.basis, "prompt-token-sum");
    // Turn 2's own prompt tokens: 50 + 1200 + 0.
    assert.equal(report.totals.latestContext.tokens, 1250);
    assert.equal(report.totals.latestContext.window, undefined);
    assert.deepEqual(
      report.turns.map((turn) => turn.contextAfter),
      [1100, 1250],
    );
  });

  it("accumulates cost under both regimes and reconciles against either", () => {
    // pi stores Σ round(cost); the Claude SDK store rounds Σ cost ONCE. The
    // report computes both from the log and names the one that reconciled, so
    // the comparison stays exact for both harnesses without branching on one.
    const report = auditSession(fixtureSource());
    assert.equal(report.totals.costMicros, 16_000);
    assert.equal(report.totals.costMicrosSingleRounding, 16_000);
    assert.equal(report.totals.usageBearingRuns, 3);
    assert.equal(report.persisted?.agrees, true);
    assert.equal(report.persisted?.costAccumulation, "per-entry");
  });

  it("reconciles a single-rounding total where the two regimes differ", () => {
    // Three entries at $0.0000005: per-entry rounding yields 3 micros, one
    // rounding of the sum yields 2. A Claude session persists the latter.
    const costSource = (costMicros: number): SessionAuditSource =>
      fixtureSource({
        logPath: `${FIXTURE}log-cost-rounding.jsonl`,
        callTranscript: undefined,
        persistedUsage: {
          inputTokens: 30,
          outputTokens: 15,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 45,
          costMicros,
          usageTurns: 3,
          assistantTurns: 3,
          contextTokens: 10,
        },
      });
    const perEntry = auditSession(costSource(3));
    assert.equal(perEntry.totals.costMicros, 3);
    assert.equal(perEntry.totals.costMicrosSingleRounding, 2);
    assert.equal(perEntry.persisted?.agrees, true);
    assert.equal(perEntry.persisted?.costAccumulation, "per-entry");

    const single = auditSession(costSource(2));
    assert.equal(single.persisted?.agrees, true);
    assert.equal(single.persisted?.costAccumulation, "single-rounding");
    assert.deepEqual(single.persisted?.differences, []);
  });

  it("reports a cost that matches neither accumulation, with both values", () => {
    const source = fixtureSource();
    const report = auditSession({
      ...source,
      persistedUsage: { ...source.persistedUsage!, costMicros: 20_000 },
    });
    assert.equal(report.persisted?.agrees, false);
    assert.equal(report.persisted?.costAccumulation, undefined);
    assert.deepEqual(report.persisted?.differences, [
      {
        field: "costMicros",
        report: 16_000,
        persisted: 20_000,
        delta: -4_000,
        alternative: 16_000,
      },
    ]);
  });

  it("compares a named field set with the persisted stats", () => {
    const report = auditSession(fixtureSource());
    assert.deepEqual(report.persisted?.comparedFields, [
      "uncachedInputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costMicros",
      "contextTokens",
    ]);
  });
});

describe("session audit provider calls", () => {
  it("resolves per-request usage, reasoning tokens and context jumps", () => {
    const report = auditSession(fixtureSource());
    assert.equal(report.totals.providerCalls, 5);
    assert.equal(report.providerCallTotals?.calls, 5);
    assert.equal(report.providerCallTotals?.processedInputTokens, 6410);
    // Reasoning exists only in the provider transcript; the session total
    // carries it with its origin stated in `assumptions`.
    assert.equal(report.providerCallTotals?.reasoningTokens, 40);
    assert.equal(report.totals.reasoningTokens, 40);
    assert.ok(
      report.assumptions.some((line) =>
        line.startsWith("totals.reasoningTokens comes from the PROVIDER"),
      ),
    );
    const jump = report.contextJumps[0]!;
    assert.equal(jump.scope, "provider-call");
    assert.equal(jump.at, 5);
    assert.deepEqual(
      { from: jump.fromTokens, to: jump.toTokens, delta: jump.deltaTokens },
      { from: 980, to: 2010, delta: 1030 },
    );
    assert.deepEqual(jump.precededBy, ["slack_search"]);
    // Every resolved request lands in a turn row: the per-turn counts sum to
    // the session total, with nothing dropped into a turn that is not rendered.
    assert.equal(
      report.turns.reduce((n, turn) => n + (turn.providerCalls ?? 0), 0),
      report.totals.providerCalls,
    );
    assert.equal(report.totals.providerCallsUnattributed, undefined);
  });

  it("warns when the log and the transcript disagree by more than 5%", () => {
    const report = auditSession(fixtureSource());
    assert.ok(
      report.warnings.some((warning) =>
        warning.includes("disagree by more than 5%"),
      ),
      report.warnings.join("\n"),
    );
  });

  it("reads a Claude CLI transcript per request, skipping subagent lines", () => {
    const report = auditSession(
      fixtureSource({
        meta: {
          title: "Fixture session",
          harness: "claude-sdk",
          agentType: "developer",
          createdAtMs: Date.parse("2026-07-01T10:00:00.000Z"),
          updatedAtMs: Date.parse("2026-07-01T10:03:07.000Z"),
        },
        callTranscript: {
          source: "claude-transcript",
          path: `${FIXTURE}claude-transcript.jsonl`,
        },
      }),
    );
    // Three requests: the split response counts once, the sidechain never.
    assert.equal(report.totals.providerCalls, 3);
    assert.equal(report.providerCallTotals?.uncachedInputTokens, 65);
    assert.equal(report.providerCallTotals?.cacheWriteTokens, 250);
    assert.equal(report.providerCallTotals?.cacheReadTokens, 2400);
    assert.equal(report.providerCallTotals?.outputTokens, 170);
    // The CLI transcript records no cost, which the report says rather than
    // reporting a confident $0.
    assert.equal(report.providerCallTotals?.costReported, false);
    assert.ok(report.unavailable.some((line) => line.startsWith("costUSD")));
    assert.deepEqual(report.contextJumps[0]?.precededBy, ["Read", "Bash"]);
  });

  it("degrades to turn-scoped jumps when no per-request transcript exists", () => {
    const source = fixtureSource();
    delete source.callTranscript;
    const report = auditSession(source);
    assert.equal(report.totals.providerCalls, undefined);
    assert.equal(report.providerCallTotals, undefined);
    assert.ok(
      report.unavailable.some((line) => line.startsWith("providerCalls")),
    );
    assert.deepEqual(
      report.contextJumps.map((jump) => [
        jump.scope,
        jump.turn,
        jump.deltaTokens,
      ]),
      [
        ["turn", 3, 500],
        ["turn", 2, 100],
      ],
    );
  });
});

describe("session audit contributors", () => {
  it("attributes measured content by category and keeps the basis explicit", () => {
    const report = auditSession(fixtureSource());
    const by = new Map(report.contributors.map((row) => [row.category, row]));
    assert.equal(by.get("user-content")?.chars, 1650); // 400 + 250 prompt text + 1000-byte text upload
    assert.equal(by.get("context-attachments")?.chars, 4000);
    assert.equal(by.get("context-attachments")?.basis, "attachment-bytes");
    // A PNG's bytes are reported but never tokenized: they would otherwise
    // dominate the table and every share on a screenshot-heavy session.
    assert.equal(by.get("binary-attachments")?.chars, 250_000);
    assert.equal(by.get("binary-attachments")?.estTokens, 0);
    assert.equal(by.get("binary-attachments")?.share, 0);
    assert.equal(by.get("binary-attachments")?.items, 1);
    assert.equal(by.get("injected-context")?.chars, 600);
    assert.equal(by.get("tool-results")?.chars, 8242);
    assert.equal(by.get("reasoning")?.chars, 200);
    assert.equal(by.get("assistant-text")?.chars, 400);
    assert.equal(by.get("tool-call-arguments")?.items, 3);
    // The static rows are measured against this checkout, and say so.
    assert.equal(by.get("system-prompt")?.basis, "current-checkout");
    assert.ok((by.get("tool-definitions")?.chars ?? 0) > 0);
    // estTokens is exactly chars / CHARS_PER_TOKEN, rounded.
    assert.equal(
      by.get("tool-results")?.estTokens,
      Math.round(8242 / CHARS_PER_TOKEN),
    );
    const shares = report.contributors.reduce((n, row) => n + row.share, 0);
    assert.ok(Math.abs(shares - 1) < 0.01, `shares summed to ${shares}`);
  });

  it("ranks the largest tool results by size and never returns their bodies", () => {
    const report = auditSession(fixtureSource(), { topToolResults: 2 });
    assert.deepEqual(
      report.largestToolResults.map((row) => [
        row.toolName,
        row.bytes,
        row.isError,
      ]),
      [
        ["bash", 8000, false],
        ["find_tools", 122, false],
      ],
    );
    assert.ok(
      !JSON.stringify(report).includes("BBBB"),
      "tool result bodies must never reach the report",
    );
  });
});

describe("session audit turns and tools", () => {
  it("reports each turn's origin, usage, occupancy delta and activations", () => {
    const report = auditSession(fixtureSource());
    assert.deepEqual(
      report.turns.map((turn) => [
        turn.index,
        turn.origin,
        turn.toolCalls,
        turn.contextAfter,
        turn.contextDelta,
      ]),
      [
        [1, "human", 2, 1500, undefined],
        [2, "system", 0, 1600, 100],
        [3, "agent", 1, 2100, 500],
      ],
    );
    assert.equal(report.turns[1]?.hiddenPrompt, true);
    assert.equal(report.turns[1]?.compacted, true);
    assert.equal(
      report.turns[1]?.failure,
      "Provider error (fixture): rate limited",
    );
    assert.deepEqual(report.turns[0]?.toolsActivated, ["slack_search"]);
    assert.equal(report.turns[2]?.failedToolResults, 1);
  });

  it("bounds the turn rows from the oldest end", () => {
    const report = auditSession(fixtureSource(), { maxTurns: 2 });
    assert.deepEqual(
      report.turns.map((turn) => turn.index),
      [2, 3],
    );
    assert.equal(report.bounds.turnsOmitted, 1);
  });

  it("separates tools loaded at start, activated later, used and never used", () => {
    const report = auditSession(fixtureSource());
    const slack = report.tools.rows.find((row) => row.name === "slack_search");
    assert.equal(slack?.loaded, "activated");
    assert.equal(slack?.activatedInTurn, 1);
    assert.equal(slack?.calls, 1);
    assert.ok(slack!.defChars > 0);
    assert.equal(report.tools.activatedCount, 1);
    assert.ok(report.tools.eagerCount > 0);
    // An eager definition the session never called is the reduction target.
    assert.ok(report.tools.unusedCount > 0);
    assert.ok(report.tools.unusedDefChars > 0);
    // Calls to names this checkout's catalog does not have (harness builtins,
    // and retired app tools on an older session) are counted apart.
    assert.deepEqual(report.tools.callsNotInThisCatalog, { bash: 1 });
  });

  it("lists compaction, activation and failure events in order", () => {
    const report = auditSession(fixtureSource());
    assert.deepEqual(
      report.events.map((event) => [event.kind, event.turn, event.detail]),
      [
        ["tool-activation", 1, "slack_search"],
        ["run-failure", 2, "Provider error (fixture): rate limited"],
        ["compaction", 2, "context 1600 → 700 tokens"],
      ],
    );
  });
});

describe("session audit drill-down", () => {
  it("returns one entry's block structure and sizes, never its text", () => {
    const report = auditSession(fixtureSource(), {
      drilldown: { entryId: "e2-assistant" },
    });
    assert.equal(report.drilldown?.found, true);
    assert.equal(report.drilldown?.role, "assistant");
    assert.equal(report.drilldown?.turn, 1);
    assert.deepEqual(
      report.drilldown?.blocks?.map((block) => [block.kind, block.chars]),
      [
        ["thinking", 200],
        ["toolCall", 34],
        ["toolCall", 24],
      ],
    );
    assert.deepEqual(report.drilldown?.toolCalls, ["find_tools", "bash"]);
    assert.ok(!JSON.stringify(report.drilldown).includes("TTTT"));
  });

  it("reports a missing entry id as not found rather than throwing", () => {
    const report = auditSession(fixtureSource(), {
      drilldown: { entryId: "no-such-entry" },
    });
    assert.deepEqual(report.drilldown, {
      target: "no-such-entry",
      found: false,
    });
  });

  it("drills into one provider request", () => {
    const report = auditSession(fixtureSource(), {
      drilldown: { providerRun: 4 },
    });
    assert.equal(report.drilldown?.found, true);
    assert.equal(report.drilldown?.usage?.processedInputTokens, 980);
    assert.deepEqual(report.drilldown?.toolCalls, ["slack_search"]);
  });
});

describe("session audit degradation", () => {
  it("reports a missing log as a warning and still returns a shaped report", () => {
    const report = auditSession(
      fixtureSource({ logPath: `${FIXTURE}does-not-exist.jsonl` }),
    );
    assert.equal(report.sources.log.available, false);
    assert.equal(report.totals.turns, 0);
    assert.deepEqual(report.warnings, [
      "This session has no conversation log file.",
    ]);
    // The DATA_DIR path an ENOENT message carries never reaches the payload.
    assert.ok(!JSON.stringify(report.warnings).includes(FIXTURE));
    assert.ok(report.assumptions.length > 0);
  });
});
