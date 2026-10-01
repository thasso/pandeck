import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  addArtifactNotice,
  boundNativeOutput,
  persistOutputArtifact,
  prepareReadWindow,
  textFromUnknownToolOutput,
  type ReadWindowDecision,
} from "../outputPolicy.ts";

const POLICY_TOOLS = new Set(["read", "bash", "grep", "find"]);

/** Inline pi extension that bounds native results before they enter history. */
export function createPiOutputPolicyExtension(): ExtensionFactory {
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
        const artifact = await persistOutputArtifact({
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
