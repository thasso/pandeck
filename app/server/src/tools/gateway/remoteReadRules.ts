/**
 * What the gateway's read tools share (Task-1398, Task-1441 P7a): the read
 * group's tools (`remoteToolGroup.ts`) and the file tool (`remoteFiles.ts`)
 * say the same thing for the same failure. A leaf: it imports only
 * `remoteTools.ts` types.
 *
 * Only the edge's `tool_error` and `invalid_params` texts reach the agent;
 * every other failure is fixed text here. The file texts are this server's
 * own: the edge never words a refusal of its answer.
 */
import type { RemoteProduct, RemoteToolAnswer } from "../../remoteTools.ts";

export const UNREACHABLE =
  "The credential gateway is unreachable; try again shortly.";
export const NO_TOOLS = "The credential gateway runs no tools.";

/** A product's toggle is off; every mapped product needs its text. */
export const DISABLED: Record<RemoteProduct, string> = {
  jira: "Jira tools are disabled. Enable them in Settings → Jira.",
  slack: "Slack tools are disabled. Enable them in Settings → Slack.",
  confluence:
    "Confluence tools are disabled. Enable them in Settings → Confluence.",
};

/** The gateway sent a file this call can't take (`UNEXPECTED_FILE_ANSWER`). */
export const UNEXPECTED_FILE_ANSWER =
  "The gateway sent a file this server can't accept; nothing was saved.";
/** The file's digest does not match (`FILE_CORRUPTED`). */
export const FILE_CORRUPTED =
  "The file arrived damaged; nothing was saved. Try again.";
/** This server's one file call is still running (G2). */
export const FILE_BUSY_HERE =
  "A gateway download is already running; try again when it finishes.";

const MESSAGE_MAX = 500;

export const noLongerOffered = (name: string): string =>
  `The gateway no longer offers ${name}.`;

/** The agent's text for the edge's failure answer. */
export function failureText(
  name: string,
  failure: Extract<RemoteToolAnswer, { ok: false }>,
): string {
  switch (failure.code) {
    case "tool_error":
    case "invalid_params":
      return failure.message.slice(0, MESSAGE_MAX);
    case "unknown_tool":
      return noLongerOffered(name);
    case "result_too_large":
      return "The gateway tool's result is too large.";
    case "timeout":
      return "The gateway tool timed out.";
    case "cancelled":
      return "The call was cancelled.";
    case "failed":
      return `${name} failed on the gateway.`;
  }
}
