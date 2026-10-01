/**
 * The live `timelineDelta` projection: one appended entry, lazily projected
 * like a reconnect snapshot, plus the declaring row a rich-card result changes.
 *
 *   pnpm --filter @assistant/server test src/session/log/timelineDelta.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { LogEntryDraft } from "./store.ts";

const tmp = mkdtempSync(join(tmpdir(), "timeline-delta-test-"));
process.env.ASSISTANT_CWD = tmp;

const { SessionLog } = await import("./store.ts");
const { createMemoryLogPersistence } = await import("./persistence.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function log() {
  return new SessionLog("sess-1", createMemoryLogPersistence());
}

const bigInput = {
  operations: Array.from({ length: 12 }, (_, i) => ({
    operation: "update",
    id: String(i),
    title: "t".repeat(80),
  })),
};

describe("timelineDelta projection", () => {
  test("projects an appended entry with the same lazy policy as the snapshot", () => {
    const l = log();
    const assistant = l.append({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", text: "x".repeat(1000) },
        {
          type: "toolCall",
          toolCallId: "t1",
          name: "bash",
          input: { command: "ls" },
        },
      ],
    } as LogEntryDraft);
    const delta = l.clientTimelineDelta(assistant.id);
    expect(delta).toEqual(
      l
        .clientTimeline({ lazyBodies: true })
        .filter((e) => e.id === assistant.id),
    );
    const entry = delta[0];
    if (entry?.type !== "message" || entry.role !== "assistant")
      throw new Error("no assistant entry");
    expect(entry.content[0]).toMatchObject({
      type: "thinking",
      lazy: { fullLength: 1000 },
    });
    expect(l.clientTimelineDelta("nope")).toEqual([]);
  });

  test("a registered rich-card result re-sends its declaring row with the input un-summarized", () => {
    const l = log();
    const assistant = l.append({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "t1",
          name: "task_manage",
          input: { render: true, ...bigInput },
        },
      ],
    } as LogEntryDraft);
    const before = l.clientTimelineDelta(assistant.id)[0];
    if (before?.type !== "message" || before.role !== "assistant")
      throw new Error("no assistant entry");
    expect(before.content[0]).toMatchObject({
      type: "toolCall",
      inputLazy: { kind: "toolInput" },
    });

    const result = l.append({
      type: "message",
      role: "toolResult",
      toolCallId: "t1",
      toolName: "task_manage",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            renderKind: "taskManage",
            changed: Array.from({ length: 30 }, (_, i) => ({
              id: String(i),
              title: `Task ${i}`,
              status: "todo",
            })),
          }),
        },
      ],
    } as LogEntryDraft);
    const delta = l.clientTimelineDelta(result.id);
    expect(delta.map((e) => e.id)).toEqual([assistant.id, result.id]);
    const declarer = delta[0];
    if (declarer?.type !== "message" || declarer.role !== "assistant")
      throw new Error("no declarer");
    expect(declarer.content[0]).toEqual({
      type: "toolCall",
      toolCallId: "t1",
      name: "task_manage",
      input: { render: true, ...bigInput },
    });
    expect(delta).toEqual(l.clientTimeline({ lazyBodies: true }));
  });

  test("a generic result touches only itself, even with a summarized call", () => {
    const l = log();
    l.append({
      type: "message",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "t1",
          name: "Write",
          input: { file_path: "/x", content: "c".repeat(2000) },
        },
      ],
    } as LogEntryDraft);
    const result = l.append({
      type: "message",
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "ok" }],
    } as LogEntryDraft);
    expect(l.clientTimelineDelta(result.id).map((e) => e.id)).toEqual([
      result.id,
    ]);
  });

  /**
   * Input retention is decided by what each CARD reads, never by the payload
   * qualifying: a card that renders from its result alone leaves a large call
   * input summarized, the question card keeps its input and nothing else, and
   * a payload no card would render stays bounded. Checked on both the durable
   * delta and the full lazy projection a reconnect sends.
   */
  function cardTurn(
    name: string,
    input: unknown,
    output: string,
    isError = false,
  ) {
    const l = log();
    const assistant = l.append({
      type: "message",
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "t1", name, input }],
    } as LogEntryDraft);
    const result = l.append({
      type: "message",
      role: "toolResult",
      toolCallId: "t1",
      toolName: name,
      content: [{ type: "text", text: output }],
      ...(isError ? { isError: true } : {}),
    } as LogEntryDraft);
    const delta = l.clientTimelineDelta(result.id);
    const reconnect = l.clientTimeline({ lazyBodies: true });
    const callOf = (entries: typeof reconnect) => {
      const entry = entries.find((e) => e.id === assistant.id);
      const block =
        entry?.type === "message" && entry.role === "assistant"
          ? entry.content[0]
          : undefined;
      if (block?.type !== "toolCall") throw new Error("no call");
      return block;
    };
    const resultOf = (entries: typeof reconnect) => {
      const entry = entries.find((e) => e.id === result.id);
      const block =
        entry?.type === "message" && entry.role === "toolResult"
          ? entry.content[0]
          : undefined;
      if (block?.type !== "text") throw new Error("no result");
      return block;
    };
    return {
      deltaIds: delta.map((e) => e.id),
      assistantId: assistant.id,
      resultId: result.id,
      reconnectCall: callOf(reconnect),
      reconnectResult: resultOf(reconnect),
      deltaResult: resultOf(delta),
    };
  }

  const bigPrompt = "p".repeat(3_000);

  test("payload-only cards keep the payload whole and the large input summarized", () => {
    const peer = JSON.stringify({
      renderKind: "sessionPeerPrompt",
      version: 1,
      card: {
        direction: "sent",
        messageKey: "k1",
        senderTitle: "Reviewer",
        message: bigPrompt,
        responseRequested: true,
        state: "queued",
      },
    });
    const files = JSON.stringify({
      renderKind: "showFiles",
      version: 1,
      card: {
        files: Array.from({ length: 10 }, (_unused, index) => ({
          url: `/api/files/tmp/example/long/path/plot-${index}.png`,
          name: `plot-${index}.png`,
          label: `plot-${index}.png`,
          size: 2048,
        })),
      },
    });
    const workshop = JSON.stringify({
      renderKind: "workshopDraftHandoff",
      draft: "d".repeat(3_000),
    });
    const commit = JSON.stringify({
      status: "committed",
      dryRun: false,
      forced: false,
      commitHash: "123456789abc",
      commitMessage: "m",
      blockers: [],
      warnings: [],
      files: Array.from({ length: 40 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        status: "modified",
        additions: 10,
        deletions: 2,
      })),
      totals: { files: 40, additions: 400, deletions: 80 },
    });
    const cases: Array<[string, unknown, string]> = [
      [
        "mcp__pa__session_send_prompt",
        { targetSessionId: "s2", prompt: bigPrompt },
        peer,
      ],
      [
        "show_files",
        {
          paths: Array.from(
            { length: 30 },
            (_, i) => `/tmp/example/${"x".repeat(40)}/${i}.png`,
          ),
        },
        files,
      ],
      ["workshop_draft_handoff", { draft: "d".repeat(3_000) }, workshop],
      ["worktree_commit", { message: "m".repeat(3_000) }, commit],
    ];
    for (const [name, input, output] of cases) {
      const turn = cardTurn(name, input, output);
      expect(turn.deltaIds, name).toEqual([turn.resultId]);
      expect(turn.reconnectResult, name).toEqual({
        type: "text",
        text: output,
      });
      expect(turn.deltaResult, name).toEqual({ type: "text", text: output });
      expect(turn.reconnectCall.inputLazy, name).toMatchObject({
        kind: "toolInput",
      });
      expect(
        JSON.stringify(turn.reconnectCall.input).length,
        name,
      ).toBeLessThan(600);
    }
  });

  test("Google and Jira cards accept what the web accepts and keep the render marker through a summary", () => {
    const rows = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({
        id: `e${i}`,
        title: "t".repeat(40),
      })),
    );
    const longQuery = { render: true, query: "q".repeat(700) };
    for (const [name, input, output] of [
      [
        "google_calendar_list_events",
        { render: true, day: "2026-09-20" },
        rows,
      ],
      [
        "mcp__pa__jira_search_issues",
        { render: true, jql: "j".repeat(700) },
        rows,
      ],
      [
        "jira_search_issues",
        { render: true, jql: "x" },
        JSON.stringify("s".repeat(2_000)),
      ],
      [
        "google_drive_get_file",
        longQuery,
        JSON.stringify({ file: "f".repeat(2_000) }),
      ],
    ] as const) {
      const turn = cardTurn(name, input, output);
      expect(turn.reconnectResult, name).toEqual({
        type: "text",
        text: output,
      });
      expect(turn.deltaResult, name).toEqual({ type: "text", text: output });
      // A large input is summarized, but the one argument the card reads stays.
      if (JSON.stringify(input).length > 512) {
        expect(turn.reconnectCall.inputLazy, name).toBeDefined();
        expect(turn.reconnectCall.input, name).toMatchObject({ render: true });
      }
    }
    // Without the render marker, or with an unrenderable lookup kind, the
    // web draws no card, and the payload is bounded.
    for (const [name, input, output] of [
      ["google_calendar_list_events", { render: false }, rows],
      [
        "jira_lookup",
        { render: true },
        JSON.stringify({ kind: "fields", fields: "f".repeat(2_000) }),
      ],
      ["jira_search_issues", { render: true }, "not json ".repeat(300)],
    ] as const) {
      const turn = cardTurn(name, input, output);
      expect(turn.reconnectResult.lazy, name).toMatchObject({
        kind: "toolOutput",
      });
      expect(turn.deltaResult.lazy, name).toMatchObject({ kind: "toolOutput" });
    }
  });

  test("the question card keeps its input, never its output; an error keeps neither", () => {
    const questions = {
      title: "A few things",
      questions: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i}`,
        title: `Question ${i}`,
        prompt: "p".repeat(150),
      })),
    };
    const output = JSON.stringify({ answers: "a".repeat(3_000) });
    const answered = cardTurn("mcp__pa__ask_questions", questions, output);
    expect(answered.reconnectCall).toEqual({
      type: "toolCall",
      toolCallId: "t1",
      name: "mcp__pa__ask_questions",
      input: questions,
    });
    expect(answered.reconnectResult.lazy).toMatchObject({ kind: "toolOutput" });
    expect(answered.deltaResult.lazy).toMatchObject({ kind: "toolOutput" });
    expect(answered.deltaIds).toEqual([answered.resultId]);

    const failed = cardTurn("ask_questions", questions, output, true);
    expect(failed.reconnectCall.inputLazy).toMatchObject({ kind: "toolInput" });
    expect(failed.reconnectResult.lazy).toMatchObject({ kind: "toolOutput" });
  });

  test("a task_manage payload that changed nothing renders no card and stays bounded", () => {
    const empty = JSON.stringify({
      renderKind: "taskManage",
      changed: [],
      deletedIds: [],
      comments: [],
      warnings: Array.from({ length: 40 }, () => "w".repeat(60)),
    });
    const turn = cardTurn("task_manage", { render: true, ...bigInput }, empty);
    expect(turn.deltaIds).toEqual([turn.resultId]);
    expect(turn.reconnectResult.lazy).toMatchObject({ kind: "toolOutput" });
    expect(turn.reconnectCall.inputLazy).toMatchObject({ kind: "toolInput" });

    const deleted = JSON.stringify({
      renderKind: "taskManage",
      changed: [],
      deletedIds: ["7"],
      warnings: Array.from({ length: 40 }, () => "w".repeat(60)),
    });
    const rendered = cardTurn(
      "task_manage",
      { render: true, ...bigInput },
      deleted,
    );
    expect(rendered.deltaIds).toEqual([
      rendered.assistantId,
      rendered.resultId,
    ]);
    expect(rendered.reconnectResult).toEqual({ type: "text", text: deleted });
    expect(rendered.reconnectCall.input).toEqual({ render: true, ...bigInput });
  });
});
