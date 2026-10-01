/**
 * The chat projection: normalized timeline + in-flight streams → `DisplayMessage[]`.
 *
 * Two things are pinned here. First the SHAPE rules — which entry becomes which
 * message, and how a tool result and a live stream fold into the assistant
 * message that declared the call. Second, and the reason the cache exists at
 * all, IDENTITY: re-projecting an unchanged timeline must hand back the very
 * same objects, or every memoized row in the transcript re-renders on every
 * frame of a streaming turn.
 */
import { describe, expect, it } from "vitest";
import {
  createDisplayProjectionCache,
  displayMessageCount,
  entriesToDisplayMessages,
} from "./displayMapping.ts";
import type { ClientTimelineEntry } from "./runtimeEvents.ts";
import type { StreamingEntry } from "./session/index.ts";

let seq = 0;

function user(
  id: string,
  text: string,
  patch: Record<string, unknown> = {},
): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: "2026-07-28T00:00:00.000Z",
    type: "message",
    role: "user",
    content: [{ type: "text", text }],
    ...patch,
  } as ClientTimelineEntry;
}

function assistant(
  id: string,
  text: string,
  toolCalls: Array<{ toolCallId: string; name: string }> = [],
  patch: Record<string, unknown> = {},
): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: "2026-07-28T00:00:00.000Z",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text },
      ...toolCalls.map((c) => ({
        type: "toolCall" as const,
        toolCallId: c.toolCallId,
        name: c.name,
        input: {},
      })),
    ],
    ...patch,
  } as ClientTimelineEntry;
}

function toolResult(
  id: string,
  toolCallId: string,
  text: string,
  patch: Record<string, unknown> = {},
): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: "2026-07-28T00:00:00.000Z",
    type: "message",
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text }],
    ...patch,
  } as ClientTimelineEntry;
}

function toolStream(
  toolCallId: string,
  patch: Partial<Extract<StreamingEntry, { kind: "tool" }>> = {},
): StreamingEntry {
  return {
    streamId: `st-${toolCallId}`,
    kind: "tool",
    toolCallId,
    name: "bash",
    input: {},
    ...patch,
  } as StreamingEntry;
}

function toolBlockOf(
  message: { blocks: Array<Record<string, unknown>> },
  toolId: string,
) {
  return message.blocks.find(
    (b) => b.kind === "tool" && b.toolId === toolId,
  ) as Record<string, unknown> | undefined;
}

describe("projection shape", () => {
  it("carries provider-initiated origin onto the assistant display message", () => {
    const messages = entriesToDisplayMessages([
      assistant("provider-turn", "unsolicited update", [], {
        origin: {
          kind: "system",
          source: "claude-background:item-1",
        },
      }),
    ]);
    expect(messages[0]?.promptOrigin).toEqual({
      kind: "system",
      source: "claude-background:item-1",
    });
  });

  it("folds a tool result into the declaring assistant message", () => {
    const messages = entriesToDisplayMessages([
      user("u1", "go"),
      assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }]),
      toolResult("r1", "t1", "output here"),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    const block = toolBlockOf(messages[1] as never, "t1");
    expect(block).toMatchObject({
      output: "output here",
      done: true,
      isError: false,
    });
    expect(messages[1]!.streaming).toBe(false);
  });

  it("skips hidden user entries", () => {
    const messages = entriesToDisplayMessages([
      user("u1", "shown"),
      user("u2", "hidden", { hidden: true }),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("gives a result to the assistant that most recently declared the call", () => {
    // Redeclared before the result lands: the later declarer owns it.
    const messages = entriesToDisplayMessages([
      assistant("a1", "first", [{ toolCallId: "t1", name: "bash" }]),
      assistant("a2", "second", [{ toolCallId: "t1", name: "bash" }]),
      toolResult("r1", "t1", "late"),
    ]);
    expect(toolBlockOf(messages[0] as never, "t1")).toMatchObject({
      output: "",
      done: false,
    });
    expect(toolBlockOf(messages[1] as never, "t1")).toMatchObject({
      output: "late",
      done: true,
    });
  });

  it("renders a host-command card as its own assistant message", () => {
    // The worktree-provisioning genesis card precedes the first prompt, because
    // the checkout precedes the session (Task 240).
    const messages = entriesToDisplayMessages([
      {
        id: "c1",
        seq: seq++,
        createdAt: "2026-07-28T00:00:00.000Z",
        type: "command.result",
        name: "worktree",
        card: {
          kind: "worktreeProvision",
          id: "a0",
          provision: {
            state: "created",
            projectId: "proj",
            branch: "t240-card",
            baseBranch: "main",
            worktreeId: "wt1",
          },
        },
      } as ClientTimelineEntry,
      user("u1", "go"),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["c1", "u1"]);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.blocks).toEqual([
      {
        kind: "worktreeProvision",
        provision: {
          state: "created",
          projectId: "proj",
          branch: "t240-card",
          baseBranch: "main",
          worktreeId: "wt1",
        },
      },
    ]);
  });

  it("projects a /clear card as a context boundary message", () => {
    // A clear keeps no summary, so the card carries only what it dropped —
    // and `tokensBefore` is optional, because a harness that never measured a
    // context size must not be given an invented zero.
    const cleared = (
      contextClear: Record<string, unknown>,
    ): ClientTimelineEntry =>
      ({
        id: "clear-1",
        seq: seq++,
        createdAt: "2026-09-07T00:00:00.000Z",
        type: "command.result",
        name: "contextClear",
        card: { kind: "contextClear", id: "a-clear", contextClear },
      }) as ClientTimelineEntry;

    const messages = entriesToDisplayMessages([
      user("u1", "before the clear"),
      cleared({ tokensBefore: 51_000 }),
      user("u2", "after the clear"),
    ]);
    // The messages either side survive: a clear drops the model's context, not
    // the transcript the user reads.
    expect(messages.map((m) => m.id)).toEqual(["u1", "clear-1", "u2"]);
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.blocks).toEqual([
      { kind: "contextClear", contextClear: { tokensBefore: 51_000 } },
    ]);

    const unmeasured = entriesToDisplayMessages([cleared({})]);
    expect(unmeasured[0]!.blocks).toEqual([
      { kind: "contextClear", contextClear: {} },
    ]);
  });

  it("re-projects an unchanged /clear card to the same object", () => {
    const cache = createDisplayProjectionCache();
    const timeline = [
      user("u1", "go"),
      {
        id: "clear-2",
        seq: seq++,
        createdAt: "2026-09-07T00:00:00.000Z",
        type: "command.result",
        name: "contextClear",
        card: {
          kind: "contextClear",
          id: "a-clear",
          contextClear: { tokensBefore: 12_000 },
        },
      } as ClientTimelineEntry,
    ];
    const first = entriesToDisplayMessages(timeline, [], cache);
    const second = entriesToDisplayMessages(timeline, [], cache);
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
  });

  it("drops a legacy command.result card of an unrecognized kind instead of crashing", () => {
    // A real disk record can predate a `HostCommandCard` kind being removed
    // (the stage-1 `pullRequest` terminal card, superseded by the store-driven
    // live card) — the union no longer has that member, but the JSON on disk
    // still says `kind: "pullRequest"`.
    const legacy = {
      id: "pr-card",
      seq: seq++,
      createdAt: "2026-08-04T00:00:00.000Z",
      type: "command.result",
      name: "pr",
      card: {
        kind: "pullRequest",
        id: "a-pr",
        pullRequest: {
          status: "created",
          provider: "github",
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "Task-322: Add /pr",
          state: "open",
          headBranch: "feature",
          baseBranch: "main",
          warnings: [],
        },
      },
    } as unknown as ClientTimelineEntry;

    expect(() => entriesToDisplayMessages([legacy])).not.toThrow();
    expect(entriesToDisplayMessages([legacy])).toEqual([]);

    // Surrounding entries still project normally.
    const messages = entriesToDisplayMessages([
      legacy,
      user("u1", "still works"),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["u1"]);
  });

  it("keeps a result with the declarer that owned the call when it arrived", () => {
    // Result lands BEFORE the redeclare, so it stays with the first message.
    const messages = entriesToDisplayMessages([
      assistant("a1", "first", [{ toolCallId: "t1", name: "bash" }]),
      toolResult("r1", "t1", "early"),
      assistant("a2", "second", [{ toolCallId: "t1", name: "bash" }]),
    ]);
    expect(toolBlockOf(messages[0] as never, "t1")).toMatchObject({
      output: "early",
      done: true,
    });
    expect(toolBlockOf(messages[1] as never, "t1")).toMatchObject({
      output: "",
      done: false,
    });
  });

  // The fork action addresses a message by OUR entry id and never by a native
  // one, so every side of it must be projected from `entry.id` alone: the
  // server resolves that to the harness's own anchor when the fork is taken.
  it("anchors forking on our own entry ids, per side", () => {
    const messages = entriesToDisplayMessages(
      [
        user("u1", "first", { forkable: true }),
        assistant("a1", "answer", [], { forkable: true }),
      ],
      [],
      undefined,
      { harness: "pi" },
    );
    expect(messages[0]).toMatchObject({
      role: "user",
      forkBeforeEntryId: "u1",
    });
    expect(messages[0]).not.toHaveProperty("forkAtEntryId");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      forkAtEntryId: "a1",
    });
    expect(messages[1]).not.toHaveProperty("forkBeforeEntryId");
  });

  // Entries recorded before their harness bound native ids carry no anchor, so
  // offering the action on them would only produce an error on click.
  it("offers no fork where nothing is anchored", () => {
    const messages = entriesToDisplayMessages([
      user("u1", "first"),
      assistant("a1", "answer"),
    ]);
    expect(messages[0]).not.toHaveProperty("forkBeforeEntryId");
    expect(messages[1]).not.toHaveProperty("forkAtEntryId");
  });

  // Cutting BEFORE a prompt cuts at what precedes it, so an unanchored prompt is
  // still offerable once an earlier entry is anchored — which is the claude-sdk
  // shape, where only assistant turns carry a uuid.
  it("offers fork-before once anything earlier is anchored", () => {
    const messages = entriesToDisplayMessages([
      user("u1", "first"),
      assistant("a1", "answer", [], { forkable: true }),
      user("u2", "second"),
    ]);
    expect(messages[0]).not.toHaveProperty("forkBeforeEntryId");
    expect(messages[1]).toMatchObject({ forkAtEntryId: "a1" });
    expect(messages[2]).toMatchObject({ forkBeforeEntryId: "u2" });
  });

  // pi does NOT cut at what precedes the prompt: it branches from the prompt
  // itself and walks to the parent. An earlier anchor therefore says nothing
  // about this prompt, and offering the action on it produces a server refusal
  // instead of a fork.
  it("requires a prompt's OWN anchor to offer fork-before on pi", () => {
    const entries = [
      user("u1", "first", { forkable: true }),
      assistant("a1", "answer", [], { forkable: true }),
      user("u2", "second"), // still in flight: no native id recovered yet
    ];
    const pi = entriesToDisplayMessages(entries, [], undefined, {
      harness: "pi",
    });
    expect(pi[0]).toMatchObject({ forkBeforeEntryId: "u1" });
    expect(pi[1]).toMatchObject({ forkAtEntryId: "a1" });
    expect(pi[2]).not.toHaveProperty("forkBeforeEntryId");
    // The same transcript under the Claude SDK rule keeps the earlier-anchor
    // affordance, which is valid there.
    const sdk = entriesToDisplayMessages(entries, [], undefined, {
      harness: "claude-sdk",
    });
    expect(sdk[2]).toMatchObject({ forkBeforeEntryId: "u2" });
  });

  // The first prompt of a session is where the two rules visibly disagree, and
  // each side of it is what its server branch will actually accept.
  it("offers fork-before on pi's first prompt but never on the SDK's", () => {
    // pi branches FROM the prompt and walks to its parent, so its own anchor is
    // exactly what the fork needs.
    const pi = entriesToDisplayMessages(
      [user("u1", "first", { forkable: true })],
      [],
      undefined,
      { harness: "pi" },
    );
    expect(pi[0]).toMatchObject({ forkBeforeEntryId: "u1" });

    // The SDK cuts at the turn PRECEDING the prompt. The first prompt has none,
    // so its own anchor buys nothing and the server refuses with "there is
    // nothing before this prompt to branch from" — the action must not appear.
    const sdk = entriesToDisplayMessages(
      [
        user("u1", "first", { forkable: true }),
        assistant("a1", "answer", [], { forkable: true }),
        user("u2", "second", { forkable: true }),
      ],
      [],
      undefined,
      { harness: "claude-sdk" },
    );
    expect(sdk[0]).not.toHaveProperty("forkBeforeEntryId");
    // The second prompt has that earlier turn to cut at, so it is offered.
    expect(sdk[2]).toMatchObject({ forkBeforeEntryId: "u2" });
  });

  // The transcript draws ONE fork-boundary marker, after the last inherited
  // row, so provenance has to survive the projection on every row kind a copied
  // prefix can end on — a host-command card included, or the marker would land
  // above a card the parent wrote.
  it("carries inherited-prefix provenance onto every row kind", () => {
    const origin = { sessionId: "parent", entryId: "u1" };
    const messages = entriesToDisplayMessages([
      user("u1", "first", { inheritedFrom: origin }),
      assistant("a1", "answer", [], {
        inheritedFrom: { sessionId: "parent", entryId: "a1" },
      }),
      {
        id: "c1",
        seq: seq++,
        createdAt: "2026-07-28T00:00:00.000Z",
        type: "command.result",
        name: "worktree",
        card: {
          kind: "worktreeProvision",
          id: "a0",
          provision: {
            state: "created",
            projectId: "proj",
            branch: "t510-fork",
            baseBranch: "main",
            worktreeId: "wt1",
          },
        },
        inheritedFrom: { sessionId: "parent", entryId: "c1" },
      } as ClientTimelineEntry,
      user("u2", "own prompt"),
    ]);
    expect(messages[0]).toMatchObject({ inheritedFrom: origin });
    expect(messages[1]).toMatchObject({
      inheritedFrom: { sessionId: "parent", entryId: "a1" },
    });
    expect(messages[2]).toMatchObject({
      inheritedFrom: { sessionId: "parent", entryId: "c1" },
    });
    expect(messages[3]).not.toHaveProperty("inheritedFrom");
  });
});

describe("displayMessageCount", () => {
  it("matches the projection's length and adds up over any split", () => {
    const timeline = [
      user("u1", "first"),
      assistant("a1", "calling", [{ toolCallId: "t1", name: "bash" }]),
      toolResult("r1", "t1", "ok"),
      toolResult("r-orphan", "missing", "no declarer"),
      user("u-hidden", "resume", { hidden: true }),
      {
        id: "cmd-clear",
        seq: seq++,
        createdAt: "2026-07-28T00:00:00.000Z",
        type: "command.result",
        name: "clear",
        card: { kind: "contextClear", id: "c1", contextClear: {} },
      } as unknown as ClientTimelineEntry,
      {
        id: "cmd-legacy",
        seq: seq++,
        createdAt: "2026-07-28T00:00:00.000Z",
        type: "command.result",
        name: "pr",
        card: { kind: "pullRequest", id: "p1" },
      } as unknown as ClientTimelineEntry,
      assistant("a2", "done"),
    ];
    const total = entriesToDisplayMessages(timeline).length;
    expect(total).toBe(4);
    expect(displayMessageCount(timeline)).toBe(total);
    for (let cut = 0; cut <= timeline.length; cut++)
      expect(
        displayMessageCount(timeline.slice(0, cut)) +
          displayMessageCount(timeline.slice(cut)),
      ).toBe(total);
  });
});

describe("in-flight overlay", () => {
  it("merges a live stream into the live message's own block", () => {
    const messages = entriesToDisplayMessages(
      [],
      [
        {
          streamId: "m1",
          kind: "message",
          role: "assistant",
          content: [
            { type: "toolCall", toolCallId: "t1", name: "bash", input: {} },
          ],
        } as StreamingEntry,
        toolStream("t1", { output: "partial" }),
      ],
    );
    expect(messages.map((m) => m.id)).toEqual(["live"]);
    expect(toolBlockOf(messages[0] as never, "t1")).toMatchObject({
      output: "partial",
      done: false,
    });
  });

  it("updates the durable block when the live message has no block for that call", () => {
    const messages = entriesToDisplayMessages(
      [
        assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }]),
        toolResult("r1", "t1", "durable output"),
      ],
      [toolStream("t1", { output: "live output" })],
    );
    // Live status wins over the durable result during the handoff.
    expect(toolBlockOf(messages[0] as never, "t1")).toMatchObject({
      output: "live output",
      done: false,
    });
    expect(messages[0]!.streaming).toBe(true);
  });

  it("appends a stream with no live block and no durable owner as a fallback", () => {
    const messages = entriesToDisplayMessages(
      [],
      [toolStream("orphan", { output: "x" })],
    );
    expect(messages.map((m) => m.id)).toEqual(["live"]);
    expect(toolBlockOf(messages[0] as never, "orphan")).toMatchObject({
      output: "x",
    });
  });

  it("does not append a stream that already updated a durable block", () => {
    const messages = entriesToDisplayMessages(
      [assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }])],
      [toolStream("t1", { output: "live" })],
    );
    expect(messages.map((m) => m.id)).toEqual(["a1"]);
  });
});

describe("projection cache", () => {
  it("returns the identical objects when nothing changed", () => {
    const cache = createDisplayProjectionCache();
    const timeline = [
      user("u1", "go"),
      assistant("a1", "done", [{ toolCallId: "t1", name: "bash" }]),
      toolResult("r1", "t1", "out"),
    ];
    const first = entriesToDisplayMessages(timeline, [], cache);
    const second = entriesToDisplayMessages(timeline, [], cache);
    expect(second).not.toBe(first);
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]);
  });

  it("rebuilds only the entries whose inputs moved", () => {
    const cache = createDisplayProjectionCache();
    const u1 = user("u1", "go");
    const a1 = assistant("a1", "first");
    const first = entriesToDisplayMessages([u1, a1], [], cache);
    // The reducer replaces the entry it touches and keeps the rest, which is
    // exactly the identity pattern this cache depends on.
    const a1Updated = assistant("a1", "first, revised");
    const second = entriesToDisplayMessages([u1, a1Updated], [], cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect((second[1]!.blocks[0] as { text: string }).text).toBe(
      "first, revised",
    );
  });

  it("rebuilds an assistant message when a tool result is added to it", () => {
    const cache = createDisplayProjectionCache();
    const a1 = assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }]);
    const before = entriesToDisplayMessages([a1], [], cache);
    const after = entriesToDisplayMessages(
      [a1, toolResult("r1", "t1", "out")],
      [],
      cache,
    );
    expect(after[0]).not.toBe(before[0]);
    expect(toolBlockOf(after[0] as never, "t1")).toMatchObject({
      output: "out",
      done: true,
    });
  });

  it("rebuilds an assistant message when a live stream on it advances", () => {
    const cache = createDisplayProjectionCache();
    const a1 = assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }]);
    const before = entriesToDisplayMessages(
      [a1],
      [toolStream("t1", { output: "a" })],
      cache,
    );
    const after = entriesToDisplayMessages(
      [a1],
      [toolStream("t1", { output: "ab" })],
      cache,
    );
    expect(after[0]).not.toBe(before[0]);
    expect(toolBlockOf(after[0] as never, "t1")).toMatchObject({
      output: "ab",
    });
  });

  it("keeps earlier messages stable while a turn streams", () => {
    const cache = createDisplayProjectionCache();
    const history = [user("u1", "go"), assistant("a1", "answered")];
    const first = entriesToDisplayMessages(
      history,
      [
        {
          streamId: "m1",
          kind: "message",
          role: "assistant",
          content: [{ type: "text", text: "th" }],
        } as StreamingEntry,
      ],
      cache,
    );
    const second = entriesToDisplayMessages(
      history,
      [
        {
          streamId: "m1",
          kind: "message",
          role: "assistant",
          content: [{ type: "text", text: "think" }],
        } as StreamingEntry,
      ],
      cache,
    );
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // Only the live row is rebuilt.
    expect(second[2]).not.toBe(first[2]);
    expect(second[2]!.id).toBe("live");
  });

  it("drops entries that left the timeline", () => {
    const cache = createDisplayProjectionCache();
    const u1 = user("u1", "go");
    entriesToDisplayMessages([u1, user("u2", "second")], [], cache);
    expect(cache.messages.size).toBe(2);
    entriesToDisplayMessages([u1], [], cache);
    expect(cache.messages.size).toBe(1);
  });

  it("projects identically with and without a cache", () => {
    const timeline = [
      user("u1", "go"),
      assistant("a1", "working", [
        { toolCallId: "t1", name: "bash" },
        { toolCallId: "t2", name: "read" },
      ]),
      toolResult("r1", "t1", "one", { isError: true }),
      assistant("a2", "more", [{ toolCallId: "t3", name: "bash" }]),
      toolResult("r2", "t3", "three"),
    ];
    const streams = [toolStream("t2", { output: "still going" })];
    expect(
      entriesToDisplayMessages(
        timeline,
        streams,
        createDisplayProjectionCache(),
      ),
    ).toEqual(entriesToDisplayMessages(timeline, streams));
  });

  it("carries live-body refs through, and a durable block follows its stream's ref", () => {
    const outputLive = {
      streamId: "st-t1",
      blockIndex: 0,
      kind: "toolOutput" as const,
      length: 12,
    };
    const timeline = [
      user("u1", "go"),
      assistant("a1", "working", [{ toolCallId: "t1", name: "bash" }]),
    ];
    const live: StreamingEntry[] = [
      {
        streamId: "m1",
        kind: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            text: "",
            live: {
              streamId: "m1",
              blockIndex: 0,
              kind: "thinking",
              length: 9,
            },
          },
          {
            type: "toolCall",
            toolCallId: "t2",
            name: "write",
            input: { file_path: "/x" },
            inputSummary: "/x",
            inputLive: {
              streamId: "t2",
              blockIndex: 0,
              kind: "toolInput",
              length: 900,
            },
          },
        ],
      },
      toolStream("t1", { output: "", outputLive }),
    ];
    const messages = entriesToDisplayMessages(timeline, live);
    expect(toolBlockOf(messages[1]!, "t1")).toMatchObject({
      output: "",
      outputLive,
      done: false,
    });
    const overlay = messages.at(-1)!;
    expect(overlay.blocks[0]).toEqual({
      kind: "thinking",
      text: "",
      live: { streamId: "m1", blockIndex: 0, kind: "thinking", length: 9 },
    });
    expect(overlay.blocks[1]).toMatchObject({
      kind: "tool",
      args: { file_path: "/x" },
      argsSummary: "/x",
      argsLive: { kind: "toolInput", length: 900 },
    });
    // Once the durable result folds in, the live ref is gone with the stream.
    const settled = entriesToDisplayMessages([
      ...timeline,
      toolResult("r1", "t1", "final output"),
    ]);
    const block = toolBlockOf(settled[1]!, "t1");
    expect(block).toMatchObject({ output: "final output", done: true });
    expect(block?.outputLive).toBeUndefined();
  });

  it("takes a completed stream's whole input onto a declaring block that only has a summary", () => {
    const operations = Array.from({ length: 12 }, (_, i) => ({
      operation: "update",
      id: String(i),
      title: "t".repeat(80),
    }));
    const inputLive = {
      streamId: "t1",
      blockIndex: 0,
      kind: "toolInput" as const,
      length: 1_500,
    };
    const live: StreamingEntry[] = [
      {
        streamId: "m1",
        kind: "message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCallId: "t1",
            name: "mcp__pa__task_manage",
            input: { summary: "Object(operations)" },
            inputSummary: "Object(operations)",
            inputLive,
          },
        ],
      },
      // A completed card that reads its input: the transport put the exact
      // arguments on the tool stream and dropped its refs.
      {
        streamId: "t1",
        kind: "tool",
        toolCallId: "t1",
        name: "mcp__pa__task_manage",
        input: { operations },
        output: JSON.stringify({
          renderKind: "taskManage",
          changed: [{ id: "1", title: "Task 1", status: "todo" }],
        }),
        done: true,
      },
    ];
    const block = entriesToDisplayMessages([], live).at(-1)!.blocks[0]!;
    expect(block).toMatchObject({
      kind: "tool",
      args: { operations },
      done: true,
    });
    expect("argsLive" in block).toBe(false);
    expect("argsSummary" in block).toBe(false);

    // A stream still holding only a ref leaves the block's summary alone.
    const pending = entriesToDisplayMessages(
      [],
      [
        live[0]!,
        {
          streamId: "t1",
          kind: "tool",
          toolCallId: "t1",
          name: "mcp__pa__task_manage",
          input: { summary: "Object(operations)" },
          inputSummary: "Object(operations)",
          inputLive,
          output: "",
        },
      ],
    ).at(-1)!.blocks[0]!;
    expect(pending).toMatchObject({
      kind: "tool",
      args: { summary: "Object(operations)" },
      argsLive: inputLive,
    });
  });
});
