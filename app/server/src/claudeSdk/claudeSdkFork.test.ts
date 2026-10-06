/**
 * Forking a claude-sdk session: the anchor capture that makes it possible, and
 * the branch itself.
 *
 * The SDK can only cut a transcript at a native message uuid, so every assistant
 * turn must carry the uuid it ENDED on — one of our entries aggregates several
 * native messages (thinking, text, each tool_use), and cutting at anything but
 * the last one would drop part of the turn the user chose to keep. That uuid
 * rides the turn's `messageCompleted` into the app log as `providerMessageId`,
 * which is what the fork later resolves.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/claudeSdkFork.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "claude-sdk-fork-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

/**
 * An isolated Claude profile, registered the way the app does. A session bound
 * to one keeps its transcripts under the profile's own config root, which is
 * what the fork/delete routing has to follow.
 */
const ISOLATED_PROFILE = "cp_isolated";
mkdirSync(join(tmp, "data", "credential-profiles"), { recursive: true });
writeFileSync(
  join(tmp, "data", "credential-profiles", "profiles.json"),
  JSON.stringify([
    {
      id: ISOLATED_PROFILE,
      name: "Isolated",
      provider: "claude",
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
);

/** Worktree edges are a DB concern; drive them directly instead. */
const worktreeCwds = new Map<string, string>();
vi.mock("../worktrees/sessionCwd.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  worktreeCwdForSession: (sessionId: string) => worktreeCwds.get(sessionId),
}));

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const { claudeSdkStore } = await import("./claudeSdkStore.ts");
const { readClaudeSdkRecord } = await import("./claudeSdkRecords.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { claudeProfileSessionStore } = await import("./profileSessionStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
type ClaudeSdkMessage = import("./sdkSeam.ts").ClaudeSdkMessage;
type ClaudeSdkSeam = import("./sdkSeam.ts").ClaudeSdkSeam;
type ClaudeQueryParams = import("./sdkSeam.ts").ClaudeQueryParams;
type AdapterEvent = import("../session/adapters/contract.ts").AdapterEvent;

const PROVIDER_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const stream = (event: unknown): ClaudeSdkMessage =>
  ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: `evt-${Math.random()}`,
    session_id: PROVIDER_SESSION,
  }) as unknown as ClaudeSdkMessage;

/**
 * Two assistant sub-messages in ONE turn, as the CLI emits them: the visible
 * text streams first (that is what opens the live turn), then each committed
 * `assistant` message arrives with its own transcript uuid.
 */
function turnMessages(
  lastUuid = "native-last",
  sessionId = PROVIDER_SESSION,
): ClaudeSdkMessage[] {
  return [
    stream({ type: "message_start", message: { id: "msg_1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "the answer" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      session_id: sessionId,
      uuid: "native-first",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "thinking out loud" }],
      },
    },
    {
      type: "assistant",
      session_id: sessionId,
      uuid: lastUuid,
      message: {
        id: "msg_2",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "the answer" }],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      uuid: "result-uuid",
      is_error: false,
      result: "the answer",
      num_turns: 1,
      total_cost_usd: 0.01,
      modelUsage: {},
    },
  ] as unknown as ClaudeSdkMessage[];
}

/** One turn that calls a tool and receives its result, as the CLI emits it. */
function toolTurnMessages(
  lastUuid: string,
  sessionId = PROVIDER_SESSION,
): ClaudeSdkMessage[] {
  return [
    stream({ type: "message_start", message: { id: "msg_t" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "reading it" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      session_id: PROVIDER_SESSION,
      uuid: "native-tool-call",
      message: {
        id: "msg_t",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "reading it" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { p: "x" } },
        ],
      },
    },
    {
      type: "user",
      session_id: PROVIDER_SESSION,
      uuid: "native-tool-result",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file body" },
        ],
      },
    },
    {
      type: "assistant",
      session_id: sessionId,
      uuid: lastUuid,
      message: {
        id: "msg_t2",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "done" }],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: PROVIDER_SESSION,
      uuid: "result-uuid",
      is_error: false,
      result: "done",
      num_turns: 1,
      total_cost_usd: 0.01,
      modelUsage: {},
    },
  ] as unknown as ClaudeSdkMessage[];
}

function seamOf(messages: ClaudeSdkMessage[]): ClaudeSdkSeam {
  return {
    query: () => ({
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
    }),
  };
}

test("a turn's LAST native uuid becomes its fork anchor", async () => {
  const session = new ClaudeSdkSession("anchor-capture", {
    seam: () => Promise.resolve(seamOf(turnMessages())),
    providerSessionId: PROVIDER_SESSION,
    agentType: "workshop",
  });
  const completed: AdapterEvent[] = [];
  session.subscribeAdapterEvents((event) => {
    if (event.type === "messageCompleted") completed.push(event);
  });

  await session.createRuntimeAdapter().prompt("a question");

  assert.equal(completed.length, 1, "one durable assistant turn");
  const event = completed[0] as Extract<
    AdapterEvent,
    { type: "messageCompleted" }
  >;
  assert.equal(
    event.providerMessageId,
    "native-last",
    "the anchor is the turn's LAST native message, not the first",
  );
});

/** The message WITHOUT its uuid — absent, not present-and-undefined. */
function dropUuid(message: ClaudeSdkMessage): Omit<ClaudeSdkMessage, "uuid"> {
  const { uuid: _dropped, ...rest } = message as ClaudeSdkMessage & {
    uuid?: string;
  };
  return rest;
}

test("an anchor is not carried across turns", async () => {
  // A turn the provider never identified must stay unanchored rather than
  // inherit the previous turn's uuid, which would fork at the wrong place.
  const anonymous = turnMessages().map((message) =>
    (message as { type: string }).type === "assistant"
      ? (dropUuid(message) as ClaudeSdkMessage)
      : message,
  );
  const session = new ClaudeSdkSession("anchor-reset", {
    seam: () => Promise.resolve(seamOf(anonymous)),
    providerSessionId: PROVIDER_SESSION,
    agentType: "workshop",
  });
  const completed: AdapterEvent[] = [];
  session.subscribeAdapterEvents((event) => {
    if (event.type === "messageCompleted") completed.push(event);
  });

  await session.createRuntimeAdapter().prompt("a question");

  const event = completed[0] as Extract<
    AdapterEvent,
    { type: "messageCompleted" }
  >;
  assert.equal(
    event.providerMessageId,
    undefined,
    "no uuid reported means no anchor claimed",
  );
});

/**
 * Drive a parent the way the connection does: the session's adapter registered
 * with the runtime, prompts through the runtime, so the app-owned LOG (not the
 * session's legacy record) is what carries the conversation and its ids.
 */
async function runtimeParent(
  id: string,
  turns: string[],
  opts: { cwd?: string; credentialProfileId?: string } = {},
): Promise<{
  parent: import("./ClaudeSdkSession.ts").ClaudeSdkSession;
  forkCalls: Array<{
    sessionId: string;
    options: { upToMessageId?: string; dir?: string; storeRoot?: string };
  }>;
}> {
  installSeam();
  const parent = claudeSdkStore.acquire(id, {
    agentType: "workshop",
    modelId: "sonnet",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.credentialProfileId
      ? { credentialProfileId: opts.credentialProfileId }
      : {}),
  });
  sessionRuntime.createSession(id, parent.createRuntimeAdapter());
  for (const turn of turns) await sessionRuntime.prompt(id, turn);
  return { parent, forkCalls: seamCalls.fork };
}

/**
 * The store owns ONE seam for every session, so the turn a query replays is
 * swapped here between prompts — that is how a child's own turn can report a
 * different transcript uuid from the parent's.
 */
const seamCalls = {
  queries: [] as ClaudeQueryParams[],
  fork: [] as Array<{
    sessionId: string;
    options: { upToMessageId?: string; dir?: string; storeRoot?: string };
  }>,
  deletes: [] as Array<{ sessionId: string; storeRoot?: string }>,
  nextTurn: () => turnMessages(),
};

function installSeam(): void {
  seamCalls.queries.length = 0;
  seamCalls.fork.length = 0;
  seamCalls.deletes.length = 0;
  seamCalls.nextTurn = () => turnMessages();
  claudeSdkStore.setSeam(() =>
    Promise.resolve({
      query: (params) => {
        seamCalls.queries.push(params);
        return {
          async *[Symbol.asyncIterator]() {
            for (const message of seamCalls.nextTurn()) yield message;
          },
        };
      },
      forkSession: (sessionId, options) => {
        const { sessionStore, ...rest } = options;
        const storeRoot = (sessionStore as { root?: string } | undefined)?.root;
        seamCalls.fork.push({
          sessionId,
          options: {
            ...rest,
            ...(storeRoot !== undefined ? { storeRoot } : {}),
          },
        });
        // A provider fork REMAPS every uuid it copies, so the child transcript
        // shares no ids with its parent — which is exactly why a copied app-log
        // prefix must not carry the parent's anchors.
        return Promise.resolve({ sessionId: "forked-provider-session" });
      },
      deleteSession: (sessionId, options) => {
        const storeRootValue = (
          options.sessionStore as { root?: string } | undefined
        )?.root;
        seamCalls.deletes.push({
          sessionId,
          ...(storeRootValue !== undefined
            ? { storeRoot: storeRootValue }
            : {}),
        });
        return Promise.resolve();
      },
    } satisfies ClaudeSdkSeam),
  );
}

test("forking cuts the native transcript, the runtime log and the record alike", async () => {
  const skillDir = join(tmp, "data", "skills", "parent-skill-source");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: parent-skill\ndescription: Fork inheritance fixture\n---\n",
  );
  sessionStore.freezeSkills("fork-parent", '["parent-skill"]');
  const { parent, forkCalls } = await runtimeParent("fork-parent", [
    "first",
    "second",
  ]);

  // The id the CLIENT holds is a runtime log entry id — never the session
  // record's own `csa-*` id. Forking must accept exactly that.
  const timeline = sessionRuntime.get("fork-parent")!.clientTimeline();
  const firstAssistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  assert.ok(
    !parent.toRecord().entries.some((entry) => entry.id === firstAssistant.id),
    "precondition: runtime ids and record ids are different id spaces",
  );

  const child = await claudeSdkStore.forkSession("fork-parent", {
    anchor: "native-last",
    keepThroughEntryId: firstAssistant.id,
    forkOrigin: {
      harness: "claude-sdk",
      parentSessionId: "fork-parent",
      parentEntryId: firstAssistant.id,
      position: "at",
    },
  });

  assert.deepEqual(
    forkCalls,
    [
      {
        sessionId: PROVIDER_SESSION,
        options: {
          upToMessageId: "native-last",
          dir: tmp,
          storeRoot: claudeProfileSessionStore(
            parent.toRecord().credentialProfileId,
          ).root,
        },
      },
    ],
    "the native transcript is cut at the anchor, in the parent's project dir",
  );

  // What the transport would send on attach: the child opens on the branched
  // conversation, not on an empty transcript beside a populated provider session.
  const childTimeline = sessionRuntime.forkAnchors(child.id, firstAssistant.id);
  // `connection.view()` brings the child live exactly like this; the runtime
  // rehydrates its log from disk, which is where the fork wrote the prefix.
  sessionRuntime.createSession(child.id, child.createRuntimeAdapter());
  const stream = sessionRuntime.openSessionStream(child.id, () => {});
  const childEntries = sessionRuntime.get(child.id)!.clientTimeline();
  stream.unsubscribe();
  assert.deepEqual(
    childEntries.map((entry) => entry.id),
    timeline.slice(0, timeline.indexOf(firstAssistant) + 1).map((e) => e.id),
    "the child's runtime log holds the parent's prefix, through the cut",
  );
  assert.equal(
    stream.snapshot.entries.length > 0,
    true,
    "and the attach snapshot carries it, so the chat is not empty",
  );
  // The provider fork remapped every uuid, so the parent's anchors name nothing
  // in the child's transcript. The copied prefix must therefore be UNANCHORED —
  // carrying `native-last` over would hand a second-generation fork an id the
  // provider cannot resolve.
  assert.equal(
    childTimeline.own,
    undefined,
    "the copied prefix carries no parent anchor",
  );
  assert.ok(
    childEntries.every((entry) => !("forkable" in entry && entry.forkable)),
    "and offers no fork point until the child anchors turns of its own",
  );

  const record = child.toRecord();
  assert.equal(
    record.providerSessionId,
    "forked-provider-session",
    "the child resumes the NEW native transcript, never the parent's",
  );
  assert.deepEqual(
    record.entries.map((entry) => entry.id),
    childEntries.map((entry) => entry.id),
    "the record is derived from the forked log, so the two cannot drift",
  );
  assert.deepEqual(
    readClaudeSdkRecord(join(process.env.DATA_DIR!, "claude-sdk"), child.id)
      ?.record.entries,
    record.entries,
    "the child's record is written whole on creation, inherited prefix included",
  );
  assert.equal(
    record.forkOrigin?.parentSessionId,
    "fork-parent",
    "the child records where it came from",
  );
  assert.notEqual(child.id, parent.id, "a fork is a NEW session");
  assert.equal(
    sessionStore.getSkills(child.id),
    '["parent-skill"]',
    "the child persists the parent's exact frozen skills without re-resolution",
  );
  assert.deepEqual(
    sessionRuntime
      .get("fork-parent")!
      .clientTimeline()
      .map((e) => e.id),
    timeline.map((e) => e.id),
    "the parent's own transcript is left untouched",
  );

  await sessionRuntime.prompt(child.id, "continue the fork");
  const forkQuery = seamCalls.queries.at(-1)!;
  assert.equal(forkQuery.options?.resume, "forked-provider-session");
  assert.match(
    (forkQuery.options?.plugins as Array<{ path: string }> | undefined)?.[0]
      ?.path ?? "",
    /skills-runtime\/[0-9a-f]{64}$/,
    "the actual forked query mounts the inherited frozen skill plugin",
  );
});

test("a second-generation fork uses the CHILD's own uuid, never the parent's", async () => {
  const { forkCalls } = await runtimeParent("gen1", ["first"]);
  const gen1Timeline = sessionRuntime.get("gen1")!.clientTimeline();
  const gen1Assistant = gen1Timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  const child = await claudeSdkStore.forkSession("gen1", {
    anchor: "native-last",
    keepThroughEntryId: gen1Assistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "gen1" },
  });

  // The child runs a turn of its own; its transcript reports ITS uuid.
  sessionRuntime.createSession(child.id, child.createRuntimeAdapter());
  seamCalls.nextTurn = () =>
    turnMessages("native-child", "forked-provider-session");
  await sessionRuntime.prompt(child.id, "carry on");

  const childTimeline = sessionRuntime.get(child.id)!.clientTimeline();
  const inherited = childTimeline.filter((entry) =>
    gen1Timeline.some((parentEntry) => parentEntry.id === entry.id),
  );
  const own = childTimeline.filter(
    (entry) => !gen1Timeline.some((p) => p.id === entry.id),
  );
  assert.ok(
    inherited.every((entry) => !("forkable" in entry && entry.forkable)),
    "inherited entries stay unforkable — their uuids died with the remap",
  );
  const ownAssistant = own.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  assert.equal(
    "forkable" in ownAssistant && ownAssistant.forkable,
    true,
    "the child's OWN turn is anchored, so it can be forked",
  );

  await claudeSdkStore.forkSession(child.id, {
    anchor: sessionRuntime.forkAnchors(child.id, ownAssistant.id).own!,
    keepThroughEntryId: ownAssistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: child.id },
  });
  assert.deepEqual(
    forkCalls.at(-1),
    {
      sessionId: "forked-provider-session",
      options: {
        upToMessageId: "native-child",
        dir: tmp,
        storeRoot: claudeProfileSessionStore(
          child.toRecord().credentialProfileId,
        ).root,
      },
    },
    "the grandchild is cut from the CHILD's transcript at the CHILD's uuid",
  );
});

test("a fork that cannot be completed leaves no orphan transcript", async () => {
  // The provider cut is not undoable and PA pinned retention to a decade, so a
  // native transcript nothing references would sit on disk for ten years. The
  // app-side cut is validated FIRST, and anything that still fails afterwards is
  // compensated.
  const { forkCalls } = await runtimeParent("fork-orphan", ["first"]);

  await assert.rejects(
    () =>
      claudeSdkStore.forkSession("fork-orphan", {
        anchor: "native-last",
        keepThroughEntryId: "e999-deadbeef",
        forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-orphan" },
      }),
    /no longer available/,
  );
  assert.deepEqual(
    forkCalls,
    [],
    "an unusable app-side cut is refused BEFORE the provider transcript is cut",
  );

  // And when the failure lands after the provider cut, the transcript is taken
  // back out rather than left behind.
  const timeline = sessionRuntime.get("fork-orphan")!.clientTimeline();
  const assistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  const boom = new Error("persist failed");
  const sessionsBefore = claudeSdkStore.list().map((session) => session.id);
  const originalPersist = claudeSdkStore.persist.bind(claudeSdkStore);
  claudeSdkStore.persist = () => {
    throw boom;
  };
  try {
    await assert.rejects(
      () =>
        claudeSdkStore.forkSession("fork-orphan", {
          anchor: "native-last",
          keepThroughEntryId: assistant.id,
          forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-orphan" },
        }),
      /persist failed/,
      "the original failure is what surfaces",
    );
  } finally {
    claudeSdkStore.persist = originalPersist;
  }
  assert.deepEqual(
    seamCalls.deletes.map((call) => call.sessionId),
    ["forked-provider-session"],
    "the now-unreferenced native transcript is deleted",
  );
  assert.deepEqual(
    claudeSdkStore
      .list()
      .map((session) => session.id)
      .filter((id) => !sessionsBefore.includes(id)),
    [],
    "and the half-registered session is unwound, not left in the store",
  );
});

test("a fork keeps the parent's title but still names itself", async () => {
  // A title alone marks a session as already named, which would leave two
  // identically-titled rows forever — and strand the child on the default title
  // when the parent never got a real one.
  const { parent } = await runtimeParent("fork-naming", ["first"]);
  parent.setTitle("Parent title");
  const timeline = sessionRuntime.get("fork-naming")!.clientTimeline();
  const assistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;

  const child = await claudeSdkStore.forkSession("fork-naming", {
    anchor: "native-last",
    keepThroughEntryId: assistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-naming" },
  });

  assert.equal(
    child.toRecord().title,
    "Parent title",
    "the fork is recognizable in the list straight away",
  );
  assert.equal(
    child.listItem(0).forkAutoRenamePending,
    true,
    "but it is flagged as still awaiting its own name",
  );
  child.setTitle("Child's own title");
  assert.equal(
    child.listItem(0).forkAutoRenamePending,
    undefined,
    "and naming it clears the pending flag",
  );
});

test("the app-log cut keeps the whole turn, tool results included", async () => {
  // Tool results are appended AFTER the assistant row that declared the calls,
  // while the provider transcript carries them BEFORE the anchored message.
  // Cutting at the assistant row alone would render tool calls with no output.
  installSeam();
  const parent = claudeSdkStore.acquire("fork-tools", {
    agentType: "workshop",
    modelId: "sonnet",
  });
  sessionRuntime.createSession("fork-tools", parent.createRuntimeAdapter());
  seamCalls.nextTurn = () => toolTurnMessages("native-last");
  await sessionRuntime.prompt("fork-tools", "read the file");
  seamCalls.nextTurn = () => turnMessages("native-second");
  await sessionRuntime.prompt("fork-tools", "and again");

  const timeline = sessionRuntime.get("fork-tools")!.clientTimeline();
  const toolTurn = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  const child = await claudeSdkStore.forkSession("fork-tools", {
    anchor: "native-last",
    keepThroughEntryId: toolTurn.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-tools" },
  });

  const childEntries = child.toRecord().entries;
  const results = childEntries.filter(
    (entry) => entry.type === "message" && entry.role === "toolResult",
  );
  assert.equal(
    results.length,
    1,
    "the retained turn's tool result came along with its call",
  );
  assert.equal(
    childEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.role === "user" &&
        entry.content.some(
          (block) => block.type === "text" && block.text === "and again",
        ),
    ),
    false,
    "but the cut still stops before the next prompt",
  );
});

test("forking refuses an entry that is not in the parent's log", async () => {
  await runtimeParent("fork-missing-entry", ["only turn"]);
  await assert.rejects(
    () =>
      claudeSdkStore.forkSession("fork-missing-entry", {
        anchor: "native-last",
        keepThroughEntryId: "e999-deadbeef",
        forkOrigin: {
          harness: "claude-sdk",
          parentSessionId: "fork-missing-entry",
        },
      }),
    /no longer available/,
    "an unknown entry fails loudly instead of copying the whole conversation",
  );
});

test("forking a named-profile session cuts inside THAT profile's root", async () => {
  // Isolated profiles keep their transcripts under a private CLAUDE_CONFIG_DIR.
  // The mutation runs in-process with no env, so without an explicit store it
  // reads the default root and reports "Session not found" — for most sessions
  // on a machine that uses profiles at all.
  const { forkCalls } = await runtimeParent("fork-profiled", ["first"], {
    credentialProfileId: ISOLATED_PROFILE,
  });
  const timeline = sessionRuntime.get("fork-profiled")!.clientTimeline();
  const assistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;

  await claudeSdkStore.forkSession("fork-profiled", {
    anchor: "native-last",
    keepThroughEntryId: assistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-profiled" },
  });

  assert.equal(
    forkCalls.at(-1)?.options.storeRoot,
    claudeProfileSessionStore(ISOLATED_PROFILE).root,
    "the cut is bound to the session's own profile root",
  );
  assert.notEqual(
    forkCalls.at(-1)?.options.storeRoot,
    claudeProfileSessionStore("cp_other").root,
    "and not to another account's root, where that transcript is absent",
  );
});

test("deleting a session takes its native transcript with it", async () => {
  // PA pinned `cleanupPeriodDays` to a decade so forks always have something to
  // cut from; that makes PA responsible for removal, or every deleted session
  // orphans a transcript for ten years.
  await runtimeParent("fork-doomed", ["first"], {
    credentialProfileId: ISOLATED_PROFILE,
  });

  claudeSdkStore.remove("fork-doomed");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    seamCalls.deletes,
    [
      {
        sessionId: PROVIDER_SESSION,
        storeRoot: claudeProfileSessionStore(ISOLATED_PROFILE).root,
      },
    ],
    "the native transcript is deleted from the session's own profile root",
  );
});

test("the cut stops at the turn's own tool results, not at later cards", async () => {
  // Rows after a turn can be app-only — a `/commit` card, a provider notice —
  // with no message in the provider transcript, and a synthetic host-command
  // turn has no user row to stop at. Walking to the next prompt would copy them
  // past the native cut and show the child history the model never saw.
  installSeam();
  const parent = claudeSdkStore.acquire("fork-cards", {
    agentType: "workshop",
    modelId: "sonnet",
  });
  sessionRuntime.createSession("fork-cards", parent.createRuntimeAdapter());
  seamCalls.nextTurn = () => toolTurnMessages("native-last");
  await sessionRuntime.prompt("fork-cards", "read the file");
  // A host-command card lands after the turn, with no further prompt.
  parent.beginSyntheticTool("commit", {});
  parent.finishSyntheticCard({
    kind: "commit",
    commit: {
      subject: "a commit",
      body: "",
      sha: "abc1234",
      files: [],
    } as never,
  });

  const timeline = sessionRuntime.get("fork-cards")!.clientTimeline();
  const assistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  const child = await claudeSdkStore.forkSession("fork-cards", {
    anchor: "native-last",
    keepThroughEntryId: assistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-cards" },
  });

  const entries = child.toRecord().entries;
  assert.equal(
    entries.filter(
      (entry) => entry.type === "message" && entry.role === "toolResult",
    ).length,
    1,
    "the retained turn keeps its own tool result",
  );
  assert.equal(
    entries.some((entry) => entry.type === "command.result"),
    false,
    "but the later host-command card stays behind the cut",
  );
});

test("forking follows the worktree EDGE, not a stale persisted cwd", async () => {
  // A session linked or handed off after creation keeps its original cwd on the
  // record AND on the live instance; the edge is the source of truth. Getting
  // this wrong looks for the native transcript in the wrong project dir and
  // leaves the child running in the wrong checkout.
  const edgeCwd = join(tmp, "moved-worktree");
  const { forkCalls } = await runtimeParent("fork-moved", ["first"], {
    cwd: join(tmp, "original"),
  });
  worktreeCwds.set("fork-moved", edgeCwd);

  const timeline = sessionRuntime.get("fork-moved")!.clientTimeline();
  const assistant = timeline.find(
    (entry) => entry.type === "message" && entry.role === "assistant",
  )!;
  const child = await claudeSdkStore.forkSession("fork-moved", {
    anchor: "native-last",
    keepThroughEntryId: assistant.id,
    forkOrigin: { harness: "claude-sdk", parentSessionId: "fork-moved" },
  });

  assert.equal(
    forkCalls[0]?.options.dir,
    edgeCwd,
    "the transcript is looked up in the EDGE's project dir",
  );
  assert.equal(
    child.cwd,
    edgeCwd,
    "and the child executes there, without waiting for its own edge to be copied",
  );
});

test("forking refuses a session that has never run", async () => {
  claudeSdkStore.setSeam(() => Promise.resolve(seamOf([])));
  claudeSdkStore.acquire("never-ran", { agentType: "workshop" });
  await assert.rejects(
    () =>
      claudeSdkStore.forkSession("never-ran", {
        anchor: "native-last",
        keepThroughEntryId: "whatever",
        forkOrigin: { harness: "claude-sdk", parentSessionId: "never-ran" },
      }),
    /never run/,
    "no provider session means there is no transcript to cut",
  );
});

test("a fork inherits its parent's scope instead of landing in the user's", async () => {
  // A subagent parent (Task-492): the child of a session the user's sidebar
  // never shows must not become a session it does.
  installSeam();
  const parent = claudeSdkStore.acquire("fork-scope-parent", {
    agentType: "workshop",
    modelId: "sonnet",
    scope: "subagent",
  });
  sessionRuntime.createSession(
    "fork-scope-parent",
    parent.createRuntimeAdapter(),
  );
  await sessionRuntime.prompt("fork-scope-parent", "first");
  const anchor = sessionRuntime
    .get("fork-scope-parent")!
    .clientTimeline()
    .find((entry) => entry.type === "message" && entry.role === "assistant")!;

  const child = await claudeSdkStore.forkSession("fork-scope-parent", {
    anchor: "native-last",
    keepThroughEntryId: anchor.id,
    forkOrigin: {
      harness: "claude-sdk",
      parentSessionId: "fork-scope-parent",
      parentEntryId: anchor.id,
      position: "at",
    },
  });

  assert.equal(sessionStore.get(child.id)?.scope, "subagent");
  assert.equal(
    sessionStore.liveDefaultScopeGate([child.id])(child.id),
    false,
    "the child is out of the default projection, like its parent",
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
