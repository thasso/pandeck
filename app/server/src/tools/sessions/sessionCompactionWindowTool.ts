/**
 * `session_compaction_window`: the calling session lowers its own compaction
 * window (`docs/compaction-window.md`). It writes only through the setter's
 * `agent` actor, which holds every rule: lower only, the agent floor, no
 * clearing. The result says when the stored value takes effect.
 */
import type { CompactionWindowPendingReason } from "@assistant/shared";
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";

type SessionCompactionWindowParams = { tokens?: unknown };

export function sessionCompactionWindowTools(): AgentTool[] {
  return [makeSessionCompactionWindowTool()];
}

function makeSessionCompactionWindowTool() {
  return defineAgentTool<SessionCompactionWindowParams>({
    name: "session_compaction_window",
    label: "Lower Compaction Window",
    description:
      "Lower THIS session's compaction window: the context size at which it compacts. Call it during a turn. An agent may only lower it, never below 100000 tokens, and cannot clear it; raising or clearing is the user's, in the session inspector. On Claude the new value takes effect when the session's next process starts (normally its next turn); on pi before its next model call.",
    searchHint: "compaction window context size lower compact sooner",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["tokens"],
      properties: {
        tokens: {
          type: "integer",
          description:
            "The new window in tokens: below the current one, at least 100000.",
        },
      },
    } as const,
    async execute(params, ctx) {
      for (const key of Object.keys(params))
        if (key !== "tokens")
          throw new Error(
            `session_compaction_window does not accept "${key}".`,
          );
      const { tokens } = params;
      if (
        typeof tokens !== "number" ||
        !Number.isSafeInteger(tokens) ||
        tokens <= 0
      )
        throw new Error("tokens must be a positive whole number of tokens.");
      // Lazy: the setter reaches `hub.ts`, which reaches the catalog back.
      const { setSessionCompactionWindow } =
        await import("../../sessionCompactionWindow.ts");
      const result = await setSessionCompactionWindow(
        ctx.session.sessionId,
        tokens,
        "agent",
      );
      if (!result.ok) throw new Error(result.message);
      const previous =
        result.previous === undefined || result.previous === null
          ? "the provider default"
          : format(result.previous);
      return textResult(
        `Lowered this session's compaction window from ${previous} to ${format(tokens)} tokens. ${whenItApplies(result.pendingReason)}`,
      );
    },
  });
}

function whenItApplies(
  reason: CompactionWindowPendingReason | undefined,
): string {
  switch (reason) {
    case undefined:
      return "It is in effect now.";
    case "next-turn":
      return "It takes effect when this session's next turn starts.";
    case "process-restart":
      return "This process keeps its current window; the new one takes effect when the session's next process starts: its next turn, or, while background work keeps this process open, when it restarts.";
  }
}

function format(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
