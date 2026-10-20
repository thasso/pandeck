/**
 * `session_send_prompt` (Task 90, rows Task-942): one open, safe API to send
 * peer prompts to other app sessions and to close the requests sent to this
 * one. Works for ordinary and Task-attached sessions alike; a Task id is audit
 * context only and never authorizes participants or changes delivery. No
 * target kind, role, interrupt/priority, or thread parameter is exposed. A
 * reply names the requests it answers with `inReplyTo` (their reply keys, never
 * raw ids); without it correlation stays server-owned and automatic.
 *
 * Rows are independent: each runs on its own, in order, and reports its own
 * result, so one bad row never fails the others. Only invalid top-level input,
 * or a call whose every row failed, throws.
 */
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";
import {
  MAX_PEER_PROMPT_CHARS,
  MAX_SEND_ROWS,
  MAX_SETTLE_REASON_CHARS,
  sendPeerPrompt,
  settlePeerRequests,
} from "../../peerPrompt.ts";
import type { PeerPromptToolRow } from "@assistant/shared";

const MESSAGE_FIELDS = new Set([
  "targetSessionId",
  "prompt",
  "responseRequested",
  "inReplyTo",
  "taskId",
]);

type SendRow =
  | {
      kind: "message";
      targetSessionId: string;
      prompt: string;
      responseRequested: boolean;
      inReplyTo?: string[];
      taskId?: string;
    }
  | { kind: "settle"; inReplyTo: string[]; reason: string };

const ROWS_SHAPE =
  'Pass rows: [{ "targetSessionId": "…", "prompt": "…" }] — one object per message, or { "inReplyTo": ["k…"], "settle": "reason" } to settle.';

export function sessionSendPromptTools(): AgentTool[] {
  return [makeSessionSendPromptTool()];
}

/*
 * The row schema is deliberately TYPELESS: no `type`, `required`,
 * `additionalProperties` or bounds on a row or its fields. pi validates and
 * coerces a call against the schema before `execute` runs, and a schema
 * failure there refuses the WHOLE call, so one malformed row would fail its
 * siblings. A constraint-free node passes pi's validator unchanged (nothing to
 * coerce, nothing to reject), and `execute` is the one row validator on both
 * harnesses. The types live in the descriptions instead.
 * `piSdk/sessionSendPromptBoundary.test.ts` holds this against pi's validator.
 */
const ROW = {
  description: `One object, of one of two shapes. A message: { targetSessionId, prompt, responseRequested?, inReplyTo?, taskId? }. A settle: { inReplyTo, settle } — closes requests sent to you without sending anything, when acting answered them or they are superseded; the requester's card shows the reason.`,
  properties: {
    targetSessionId: {
      description:
        "string — copied id of the session to prompt (see session_lookup).",
    },
    prompt: {
      description: `string — the message to deliver. Max ${MAX_PEER_PROMPT_CHARS} characters.`,
    },
    responseRequested: {
      description:
        "boolean — record that you are awaiting a reply; set it only when you actually need an answer. Defaults to false.",
    },
    inReplyTo: {
      description:
        "array of request keys — the reply keys of requests sent to you, as each delivered request shows them. In a message row: the requests it answers, all from that row's target; this links them whatever turn you answer from. Without it a reply links only when sent in the turn that delivered the request, or when that session has exactly one open request to you. In a settle row: the requests to close.",
    },
    taskId: {
      description: "string — optional related Task id for audit context only.",
    },
    settle: {
      description: `string — a settle row's short reason, max ${MAX_SETTLE_REASON_CHARS} characters (e.g. "applied the PR body").`,
    },
  },
} as const;

function makeSessionSendPromptTool() {
  return defineAgentTool<{ rows?: unknown }>({
    name: "session_send_prompt",
    label: "Send Session Prompt",
    description: `Send prompts to other app sessions — ask one to review your work, answer a question, or coordinate — and answer or settle requests sent to you. Pass rows (1 to ${MAX_SEND_ROWS}); each row is its own message with its own result, and a bad row fails only itself. Delivery is durable and never interrupts a running target: a busy session receives it when it next goes idle. Keep each prompt concise and self-contained; the recipient sees it as a peer message, not as a new user task. A reply reaches you the same way: later, as a new incoming peer message that starts a fresh turn. So after sending, end your turn and go idle — waiting, sleeping, or polling for the reply only delays it. Each message row spends one hop of its conversation's limit; a settle row sends nothing and spends none. You cannot prompt your own session or an archived, deleted, or internal one.`,
    parameters: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          description: `The rows, run in order, 1 to ${MAX_SEND_ROWS}.`,
          items: ROW,
        },
      },
    } as const,
    async execute(params, ctx) {
      const rawRows = topLevelRows(params);
      const rows: PeerPromptToolRow[] = [];
      for (const [index, raw] of rawRows.entries()) {
        try {
          rows.push(await runRow(parseRow(raw), ctx.session));
        } catch (err) {
          rows.push({
            kind: "error",
            index,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (rows.every((r) => r.kind === "error")) {
        throw new Error(
          rows
            .map((r) =>
              r.kind === "error" ? `rows[${r.index}]: ${r.error}` : "",
            )
            .join("\n"),
        );
      }
      const payload = {
        renderKind: "sessionPeerPrompt" as const,
        version: 2 as const,
        rows,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });
}

/** The call's rows, or a throw for anything wrong above them. */
function topLevelRows(params: Record<string, unknown>): unknown[] {
  const stray = Object.keys(params).filter(
    (key) => key !== "rows" && params[key] !== undefined,
  );
  if (stray.length > 0)
    throw new Error(
      `session_send_prompt takes only rows; got ${stray.join(", ")}. ${ROWS_SHAPE}`,
    );
  const rows = params.rows;
  if (!Array.isArray(rows)) throw new Error(`rows is required. ${ROWS_SHAPE}`);
  if (rows.length === 0 || rows.length > MAX_SEND_ROWS)
    throw new Error(
      `rows takes 1 to ${MAX_SEND_ROWS} rows; got ${rows.length}.`,
    );
  return rows;
}

async function runRow(
  row: SendRow,
  session: { sessionId: string; title?: string },
): Promise<PeerPromptToolRow> {
  if (row.kind === "settle") {
    const settled = settlePeerRequests({
      settlerSessionId: session.sessionId,
      keys: row.inReplyTo,
      reason: row.reason,
    });
    return { kind: "settle", reason: row.reason, settled };
  }
  const { card } = await sendPeerPrompt({
    senderSessionId: session.sessionId,
    ...(session.title ? { senderTitle: session.title } : {}),
    targetSessionId: row.targetSessionId,
    prompt: row.prompt,
    responseRequested: row.responseRequested,
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
    ...(row.taskId ? { taskId: row.taskId } : {}),
  });
  return { kind: "message", card };
}

/**
 * One raw row, checked field by field. A stated field of the wrong type is an
 * error naming it, never coerced or dropped; `undefined` reads as absent.
 */
function parseRow(raw: unknown): SendRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`A row must be an object. ${ROWS_SHAPE}`);
  const row = raw as Record<string, unknown>;
  const present = Object.keys(row).filter((key) => row[key] !== undefined);
  if (row.settle !== undefined) {
    const extra = present.filter((k) => k !== "settle" && k !== "inReplyTo");
    if (extra.length > 0)
      throw new Error(
        `A settle row takes only inReplyTo and settle; got ${extra.join(", ")}.`,
      );
    const reason = requiredString(row.settle, "settle");
    if (row.inReplyTo === undefined)
      throw new Error("A settle row needs inReplyTo: the requests to close.");
    return { kind: "settle", inReplyTo: requestKeys(row.inReplyTo), reason };
  }
  const unknown = present.filter((k) => !MESSAGE_FIELDS.has(k));
  if (unknown.length > 0)
    throw new Error(
      `Unknown row field(s) ${unknown.join(", ")}. ${ROWS_SHAPE}`,
    );
  if (row.targetSessionId === undefined)
    throw new Error("A message row needs targetSessionId.");
  const targetSessionId = requireSessionId(
    requiredString(row.targetSessionId, "targetSessionId"),
  );
  const prompt = requiredString(row.prompt, "prompt");
  if (
    row.responseRequested !== undefined &&
    typeof row.responseRequested !== "boolean"
  )
    throw new Error("responseRequested must be a boolean (true or false).");
  const taskId =
    row.taskId === undefined ? undefined : requiredString(row.taskId, "taskId");
  return {
    kind: "message",
    targetSessionId,
    prompt,
    responseRequested: row.responseRequested === true,
    ...(row.inReplyTo !== undefined
      ? { inReplyTo: requestKeys(row.inReplyTo) }
      : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const text = value.trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function requestKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((k) => typeof k === "string" && k.trim())
  )
    throw new Error(
      'inReplyTo must be a non-empty array of request keys, e.g. ["k1x2y3z"].',
    );
  return value.map((k: string) => k.trim());
}

function requireSessionId(value: string): string {
  try {
    return cleanSessionId(value, "targetSessionId");
  } catch (err) {
    if (err instanceof SessionInspectionError) throw new Error(err.message);
    throw err;
  }
}
