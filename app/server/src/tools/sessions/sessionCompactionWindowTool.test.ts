/**
 * `session_compaction_window`: the caller lowers only its own window through
 * the setter's agent rules; refusals throw and change nothing; the result
 * says when the value applies.
 *   pnpm --filter @assistant/server test src/tools/sessions/sessionCompactionWindowTool.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { CompactionWindowPendingReason } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "session-compaction-window-tool-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionCompactionWindowTools } =
  await import("./sessionCompactionWindowTool.ts");
const { hub } = await import("../../hub.ts");
const { sessionStore } = await import("../../db/sessionStore.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const tool = () => sessionCompactionWindowTools()[0]!;
const context = (sessionId: string) => ({
  toolCallId: "tool-call",
  session: {
    sessionId,
    harness: "claude-sdk" as const,
    agentType: "developer" as const,
    title: "Driver",
  },
});

let serial = 0;
function stored(): string {
  serial += 1;
  const id = `window-tool-${serial}`;
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "developer",
    model: "opus",
  });
  return id;
}

type LowerOutcome =
  | {
      ok: true;
      previous: number | null;
      pendingReason?: CompactionWindowPendingReason;
    }
  | { ok: false; message: string; largestAcceptable?: number };

/** Resident sessions whose harness lowers as `outcome` says, recording calls. */
function resident(
  ids: string[],
  outcome: (tokens: number) => LowerOutcome = () => ({
    ok: true,
    previous: null,
    pendingReason: "process-restart",
  }),
) {
  const calls: Array<{ id: string; tokens: number }> = [];
  const lives = new Map(
    ids.map((id) => [
      id,
      {
        live: true,
        sessionId: id,
        broadcastState: () => {},
        lowerCompactionWindow: async (
          tokens: number,
          persist: (value: number) => void,
        ) => {
          calls.push({ id, tokens });
          const result = outcome(tokens);
          if (!result.ok) return result;
          persist(tokens);
          return { ...result, applied: tokens };
        },
      },
    ]),
  );
  vi.spyOn(hub, "getLiveById").mockImplementation(
    (wanted: string) => lives.get(wanted) as never,
  );
  return calls;
}

function resultText(
  result: Awaited<ReturnType<ReturnType<typeof tool>["execute"]>>,
) {
  return (result.content[0] as { type: "text"; text: string }).text;
}

test("takes one required integer and no session id", () => {
  const schema = tool().parameters as {
    required: string[];
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.required, ["tokens"]);
  assert.deepEqual(Object.keys(schema.properties), ["tokens"]);
  assert.equal(schema.additionalProperties, false);
});

test("lowers the caller's window, never another resident session's", async () => {
  const caller = stored();
  const other = stored();
  sessionStore.setCompactionWindow(other, 500_000);
  const calls = resident([caller, other]);
  const result = await tool().execute({ tokens: 150_000 }, context(caller));
  assert.deepEqual(calls, [{ id: caller, tokens: 150_000 }]);
  assert.equal(sessionStore.get(caller)?.compactionWindow, 150_000);
  assert.equal(sessionStore.get(other)?.compactionWindow, 500_000);
  assert.match(resultText(result), /from the provider default to 150,000/);
});

test("bad input throws before anything runs", async () => {
  const caller = stored();
  const other = stored();
  const calls = resident([caller, other]);
  for (const params of [
    { tokens: 150_000, targetSessionId: other },
    {},
    { tokens: null },
    { tokens: 150_000.5 },
    { tokens: "150000" },
    { tokens: -150_000 },
  ])
    await assert.rejects(
      tool().execute(params as never, context(caller)),
      Error,
      JSON.stringify(params),
    );
  assert.deepEqual(calls, []);
  assert.equal(sessionStore.get(caller)?.compactionWindow, undefined);
  assert.equal(sessionStore.get(other)?.compactionWindow, undefined);
});

test("a refusal is thrown verbatim and leaves the row unchanged", async () => {
  const caller = stored();
  sessionStore.setCompactionWindow(caller, 200_000);
  resident([caller], () => ({
    ok: false,
    message:
      "That would not lower the window: the largest window an agent can set now is 199,999.",
    largestAcceptable: 199_999,
  }));
  await assert.rejects(tool().execute({ tokens: 300_000 }, context(caller)), {
    message:
      "That would not lower the window: the largest window an agent can set now is 199,999.",
  });
  assert.equal(sessionStore.get(caller)?.compactionWindow, 200_000);
});

test("a session with no running harness is refused", async () => {
  const caller = stored();
  resident([]);
  await assert.rejects(tool().execute({ tokens: 150_000 }, context(caller)), {
    message: "Only a running session can lower its own compaction window.",
  });
  assert.equal(sessionStore.get(caller)?.compactionWindow, undefined);
});

test("the result says when the value applies", async () => {
  const cases: Array<[CompactionWindowPendingReason | undefined, RegExp]> = [
    [undefined, /It is in effect now\.$/],
    ["next-turn", /takes effect when this session's next turn starts\.$/],
    [
      "process-restart",
      /This process keeps its current window; the new one takes effect when the session's next process starts/,
    ],
  ];
  for (const [pendingReason, expected] of cases) {
    const caller = stored();
    resident([caller], () => ({
      ok: true,
      previous: 300_000,
      ...(pendingReason !== undefined ? { pendingReason } : {}),
    }));
    const text = resultText(
      await tool().execute({ tokens: 200_000 }, context(caller)),
    );
    assert.match(
      text,
      /^Lowered this session's compaction window from 300,000 to 200,000 tokens\./,
    );
    assert.match(text, expected, String(pendingReason));
  }
});
