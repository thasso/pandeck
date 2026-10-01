/**
 * `session_send_prompt` (Task 90): one open, safe API to send a peer prompt to
 * another app session. Works for ordinary and Task-attached sessions alike; a
 * Task id is audit context only and never authorizes participants or changes
 * delivery. No target kind, role, interrupt/priority, or thread/correlation
 * parameter is exposed — reply correlation is server-owned and automatic.
 */
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";
import { MAX_PEER_PROMPT_CHARS, sendPeerPrompt } from "../../peerPrompt.ts";

type SendPromptParams = {
  targetSessionId?: string;
  prompt?: string;
  responseRequested?: boolean;
  taskId?: string;
};

export function sessionSendPromptTools(): AgentTool[] {
  return [makeSessionSendPromptTool()];
}

function makeSessionSendPromptTool() {
  return defineAgentTool<SendPromptParams>({
    name: "session_send_prompt",
    label: "Send Session Prompt",
    description:
      "Send a prompt to another app session — ask it to review your work, answer a question, or coordinate. Delivery is durable and never interrupts a running target: a busy session receives it when it next goes idle. Keep the prompt concise and self-contained; the recipient sees it as a peer message, not as a new user task. A reply reaches you the same way: later, as a new incoming peer message that starts a fresh turn. So after sending, end your turn and go idle — waiting, sleeping, or polling for the reply only delays it. You cannot prompt your own session or an archived, deleted, or internal one.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["targetSessionId", "prompt"],
      properties: {
        targetSessionId: {
          type: "string",
          description:
            "Copied id of the session to prompt (see session_lookup).",
        },
        prompt: {
          type: "string",
          description: `The message to deliver. Max ${MAX_PEER_PROMPT_CHARS} characters.`,
        },
        responseRequested: {
          type: "boolean",
          description:
            "Record that you are awaiting a reply; set it only when you actually need an answer. The recipient's reply correlates automatically. Defaults to false.",
        },
        taskId: {
          type: "string",
          description: "Optional related Task id for audit context only.",
        },
      },
    } as const,
    async execute(params, ctx) {
      const targetSessionId = requireSessionId(
        params.targetSessionId,
        "targetSessionId",
      );
      const prompt = requireString(params.prompt, "prompt");
      const taskId = optionalString(params.taskId);
      const { card } = await sendPeerPrompt({
        senderSessionId: ctx.session.sessionId,
        ...(ctx.session.title ? { senderTitle: ctx.session.title } : {}),
        targetSessionId,
        prompt,
        responseRequested: params.responseRequested === true,
        ...(taskId ? { taskId } : {}),
      });
      const payload = {
        renderKind: "sessionPeerPrompt" as const,
        version: 1 as const,
        card,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });
}

function requireSessionId(value: unknown, name: string): string {
  try {
    return cleanSessionId(value, name);
  } catch (err) {
    if (err instanceof SessionInspectionError) throw new Error(err.message);
    throw err;
  }
}

function requireString(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
