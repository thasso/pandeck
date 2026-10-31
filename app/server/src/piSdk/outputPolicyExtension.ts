import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  addArtifactNotice,
  boundNativeOutput,
  prepareReadWindow,
  textFromUnknownToolOutput,
  type OutputArtifact,
  type ReadWindowDecision,
} from "../outputPolicy.ts";

const POLICY_TOOLS = new Set(["read", "bash", "grep", "find"]);

/**
 * Inline pi extension that bounds native results before they enter history.
 * The read window and bounding are the engine's own; an elided result's full
 * output is persisted by the server through the session's Worker
 * (`persistOutput`, `persistSessionOutput`).
 */
export function createPiOutputPolicyExtension(hooks: {
  persistOutput(input: {
    sessionId: string;
    toolName: string;
    raw: string;
    sourcePath?: string;
  }): Promise<OutputArtifact>;
}): ExtensionFactory {
  return (pi) => {
    const reads = new Map<string, ReadWindowDecision>();

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "read") return;
      const decision = await prepareReadWindow(event.input, ctx.cwd);
      Object.assign(event.input, decision.input);
      reads.set(event.toolCallId, decision);
    });

    pi.on("tool_result", async (event, ctx) => {
      if (!POLICY_TOOLS.has(event.toolName)) return;
      const raw = textFromUnknownToolOutput(event.content);
      if (!raw) return;
      const exitCode = raw.match(/Command exited with code (\d+)/)?.[1];
      const readDecisionValue = reads.get(event.toolCallId);
      let bounded = boundNativeOutput({
        toolName: event.toolName,
        toolInput: event.input,
        raw,
        isError: event.isError,
        ...(exitCode
          ? { exitCode: Number(exitCode) }
          : event.toolName === "bash" && !event.isError
            ? { exitCode: 0 }
            : {}),
        ...(event.toolName === "read"
          ? {
              ...(readDecisionValue !== undefined
                ? { readDecision: readDecisionValue }
                : {}),
            }
          : {}),
      });
      reads.delete(event.toolCallId);
      if (bounded.elided) {
        const details = event.details as
          { fullOutputPath?: unknown } | undefined;
        const artifact = await hooks.persistOutput({
          sessionId: ctx.sessionManager.getSessionId(),
          toolName: event.toolName,
          raw,
          ...(typeof details?.fullOutputPath === "string"
            ? { sourcePath: details.fullOutputPath }
            : {}),
        });
        bounded = addArtifactNotice(bounded, artifact);
      }
      if (bounded.text === raw) return;
      const images = event.content.filter((item) => item.type === "image");
      return {
        content: [{ type: "text" as const, text: bounded.text }, ...images],
      };
    });
  };
}
