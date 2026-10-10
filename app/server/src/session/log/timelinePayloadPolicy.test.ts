import { describe, expect, test } from "vitest";
import type { AssistantRawEntry, ToolResultRawEntry } from "./rawEntry.ts";
import {
  compactToolInput,
  lazyAssistantContent,
  lazyToolResultContent,
  toolInputExceedsInline,
} from "./timelinePayloadPolicy.ts";

function toolResult(text: string): ToolResultRawEntry {
  return {
    sessionId: "s1",
    id: "e2",
    seq: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "toolResult",
    toolCallId: "tc1",
    content: [{ type: "text", text }],
  };
}

describe("timeline payload policy", () => {
  test("bounds a huge single-line tool result by characters as well as lines", () => {
    const output = JSON.stringify({
      type: "image",
      source: { type: "base64", data: "a".repeat(300_000) },
    });
    const projected = lazyToolResultContent(toolResult(output), {
      entryId: "e1",
      blockIndex: 0,
      name: "Read",
      input: {},
    });
    const block = projected[0];
    expect(block?.type).toBe("text");
    if (block?.type !== "text") throw new Error("expected text block");
    expect(block.text.length).toBeLessThanOrEqual(1_200);
    expect(block.lazy).toMatchObject({
      entryId: "e2",
      blockIndex: 0,
      kind: "toolOutput",
      fullLength: output.length,
    });
  });
  // The web card parses the payload out of the tool's TEXT output, so a reloaded
  // snapshot that clipped it would silently lose the card — and its `changed`
  // verbs come from the call's own operations, which must survive with it.
  test("keeps a task_manage mutation's payload and input whole for its card", () => {
    const output = JSON.stringify({
      renderKind: "taskManage",
      version: 1,
      changedCount: 1,
      changed: [
        {
          id: "297",
          title: "Render Task mutations as a card",
          status: "todo",
          descriptionEditsApplied: 1,
        },
      ],
    });
    const call = {
      entryId: "e1",
      blockIndex: 0,
      name: "mcp__pa__task_manage",
      input: {
        operations: [
          {
            operation: "update",
            id: "297",
            descriptionEdits: [
              { oldText: "x".repeat(4_000), newText: "y".repeat(4_000) },
            ],
          },
        ],
      },
    };

    const projected = lazyToolResultContent(toolResult(output), call);
    expect(projected[0]).toEqual({ type: "text", text: output });
    // Both harnesses' names for the same tool (pi registers the bare name, the
    // Claude MCP bridge prefixes it), or the card survives a reload in one of
    // them only.
    expect(
      lazyToolResultContent(toolResult(output), {
        ...call,
        name: "task_manage",
      })[0],
    ).toEqual({ type: "text", text: output });

    const assistant: AssistantRawEntry = {
      sessionId: "s1",
      id: "e1",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "tc1",
          name: call.name,
          input: call.input,
        },
      ],
    };
    const [block] = lazyAssistantContent(assistant, new Set(["tc1"]));
    expect(block).toEqual(assistant.content[0]);
  });

  test("keeps large worktree card payloads whole in both tool spellings", () => {
    const commitOutput = JSON.stringify({
      status: "committed",
      dryRun: false,
      forced: false,
      commitHash: "123456789abc",
      commitMessage: "Add checked commit tool",
      blockers: [],
      warnings: [],
      files: Array.from({ length: 40 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        status: "modified",
        additions: 10,
        deletions: 2,
        details: "x".repeat(80),
      })),
      totals: { files: 40, additions: 400, deletions: 80 },
    });
    expect(commitOutput.length).toBeGreaterThan(1_200);
    for (const toolName of ["worktree_commit", "mcp__pa__worktree_commit"])
      expect(
        lazyToolResultContent(
          { ...toolResult(commitOutput), toolName },
          undefined,
        )[0],
      ).toEqual({ type: "text", text: commitOutput });

    const pushOutput = JSON.stringify({
      status: "pushed",
      remote: "origin",
      branch: "feature",
      forced: false,
      setUpstream: true,
      localHead: "123456789abcdef",
      output: "x".repeat(2_000),
    });
    expect(pushOutput.length).toBeGreaterThan(1_200);
    for (const toolName of ["worktree_push", "mcp__pa__worktree_push"])
      expect(
        lazyToolResultContent(
          { ...toolResult(pushOutput), toolName },
          undefined,
        )[0],
      ).toEqual({ type: "text", text: pushOutput });
  });

  // A peer prompt routinely runs past the inline budget, and the sender's whole
  // half of the conversation is this card: clipped, the sent side of the
  // exchange renders nothing (the tool block itself is hidden with tools off).
  test("keeps a sent peer prompt's card payload whole in both harnesses' spellings", () => {
    const output = JSON.stringify({
      renderKind: "sessionPeerPrompt",
      version: 1,
      card: {
        direction: "sent",
        messageKey: "k1",
        senderTitle: "Reviewer",
        recipientTitle: "Implementer",
        peerSessionId: "11111111-2222-3333-4444-555555555555",
        message: "x".repeat(4_000),
        responseRequested: true,
        state: "queued",
      },
    });
    const call = {
      entryId: "e1",
      blockIndex: 0,
      name: "session_send_prompt",
      input: { targetSessionId: "s2", prompt: "x".repeat(4_000) },
    };
    expect(lazyToolResultContent(toolResult(output), call)[0]).toEqual({
      type: "text",
      text: output,
    });
    expect(
      lazyToolResultContent(toolResult(output), {
        ...call,
        name: "mcp__pa__session_send_prompt",
      })[0],
    ).toEqual({ type: "text", text: output });
  });

  // The files a `show_files` call put in the chat ARE its cards: a clipped
  // payload replays as neither a card nor a usable snippet.
  test("keeps a show_files payload whole in both harnesses' spellings", () => {
    const output = JSON.stringify({
      renderKind: "showFiles",
      version: 1,
      card: {
        files: Array.from({ length: 10 }, (_unused, index) => ({
          url: `/api/files/tmp/example/very/long/path/plot-${index}.png`,
          name: `plot-${index}.png`,
          label: `plot-${index}.png`,
          size: 2048,
          mimeType: "image/png",
          snippet: `![plot-${index}.png](/api/files/tmp/example/very/long/path/plot-${index}.png)`,
        })),
      },
    });
    const call = {
      entryId: "e1",
      blockIndex: 0,
      name: "show_files",
      input: { paths: ["/tmp/example/very/long/path/plot-0.png"] },
    };
    expect(lazyToolResultContent(toolResult(output), call)[0]).toEqual({
      type: "text",
      text: output,
    });
    expect(
      lazyToolResultContent(toolResult(output), {
        ...call,
        name: "mcp__pa__show_files",
      })[0],
    ).toEqual({ type: "text", text: output });
  });

  test("still bounds a task_read result, which has no card", () => {
    const output = JSON.stringify({
      count: 1,
      items: [{ id: "297", description: "x".repeat(40_000) }],
    });
    const projected = lazyToolResultContent(toolResult(output), {
      entryId: "e1",
      blockIndex: 0,
      name: "mcp__pa__task_read",
      input: { id: "297" },
    });
    const block = projected[0];
    if (block?.type !== "text") throw new Error("expected text block");
    expect(block.text.length).toBeLessThan(output.length);
    expect(block.lazy?.kind).toBe("toolOutput");
  });

  test("compacts a large generic input to a summary and its size", () => {
    const input = { file_path: "/tmp/a.ts", content: "x".repeat(2000) };
    expect(toolInputExceedsInline(input)).toBe(true);
    expect(compactToolInput("Write", input)).toEqual({
      input: { file_path: "/tmp/a.ts" },
      inputSummary: "/tmp/a.ts",
      fullBytes: Buffer.byteLength(JSON.stringify(input)),
    });
    const small = { command: "ls" };
    expect(toolInputExceedsInline(small)).toBe(false);
    expect(compactToolInput("bash", small)).toEqual({ input: small });
  });

  test("keeps large card inputs compact until a valid result authorizes them", () => {
    const input = {
      questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i}`,
        title: "t".repeat(200),
      })),
    };
    expect(toolInputExceedsInline(input)).toBe(true);
    for (const name of [
      "ask_questions",
      "mcp__pa__ask_questions",
      "task_manage",
    ])
      expect(compactToolInput(name, input).fullBytes).toBeGreaterThan(512);
  });

  test("clips oversized malformed cards and unsupported mutation results", () => {
    const oversized = (value: unknown) => JSON.stringify(value);
    const jiraFields = oversized({ kind: "fields", fields: "x".repeat(4_000) });
    const mutation = oversized({
      renderKind: "jiraIssueMutation",
      output: "x".repeat(4_000),
    });
    const malformedPeer = oversized({
      renderKind: "sessionPeerPrompt",
      card: { direction: "sent", message: 42, state: "queued" },
      padding: "x".repeat(4_000),
    });
    const malformedFiles = oversized({
      renderKind: "showFiles",
      card: { files: [{ url: "https://foreign.example/file" }] },
      padding: "x".repeat(4_000),
    });
    for (const [toolName, output, input] of [
      ["jira_lookup", jiraFields, { render: true }],
      ["jira_mutate_issue", mutation, {}],
      ["session_send_prompt", malformedPeer, {}],
      ["show_files", malformedFiles, {}],
    ] as const) {
      const projected = lazyToolResultContent(
        { ...toolResult(output), toolName, isError: false },
        { entryId: "e1", blockIndex: 0, name: toolName, input },
      )[0];
      expect(projected).toMatchObject({ lazy: { kind: "toolOutput" } });
      expect(projected).not.toEqual({ type: "text", text: output });
    }
  });

  // The web registry renders neither card when the payload REFUSES rendering
  // (`renderRequested: false`), whatever its shape; a payload no card will read
  // is a generic result and stays bounded like any other.
  test("clips valid-shaped peer prompt and show_files payloads that refuse rendering", () => {
    const peer = JSON.stringify({
      renderKind: "sessionPeerPrompt",
      renderRequested: false,
      version: 1,
      card: {
        direction: "sent",
        messageKey: "k1",
        senderTitle: "Reviewer",
        message: "x".repeat(4_200),
        responseRequested: true,
        state: "queued",
      },
    });
    const files = JSON.stringify({
      renderKind: "showFiles",
      renderRequested: false,
      version: 1,
      card: {
        files: Array.from({ length: 10 }, (_unused, index) => ({
          url: `/api/files/tmp/example/very/long/path/plot-${index}.png`,
          name: `plot-${index}.png`,
          label: `plot-${index}.png`,
          size: 2048,
          snippet: `![plot-${index}.png](/api/files/tmp/example/very/long/path/plot-${index}.png)`,
        })),
      },
    });
    expect(peer.length).toBeGreaterThan(4_100);
    expect(files.length).toBeGreaterThan(1_200);
    for (const [toolName, output] of [
      ["session_send_prompt", peer],
      ["mcp__pa__session_send_prompt", peer],
      ["show_files", files],
      ["mcp__pa__show_files", files],
    ] as const) {
      const projected = lazyToolResultContent(
        { ...toolResult(output), toolName, isError: false },
        { entryId: "e1", blockIndex: 0, name: toolName, input: {} },
      )[0];
      expect(projected).toMatchObject({ lazy: { kind: "toolOutput" } });
      if (projected?.type !== "text") throw new Error("expected text block");
      expect(projected.text.length).toBeLessThanOrEqual(1_200);
    }
  });
});
