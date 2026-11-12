/**
 * The catalog's gateway Jira tools in client mode (Task-1398): one
 * `AgentTool` per read Jira tool the gateway listed this boot
 * (`remoteTools.ts`). A call goes from this server to the gateway as
 * `tools.call`; the gateway runs it with the user's own credential.
 *
 * A name stays for the boot, so a pi engine that registered it keeps a
 * binding; before any call `execute` checks the connection, the Jira toggle
 * and that the latest listing still offers it as a read tool. Only the
 * gateway's `tool_error` and `invalid_params` texts reach the agent; every
 * other failure is fixed text here.
 */
import { getJiraSettings } from "../../jiraSettings.ts";
import type { AgentTool } from "../../mcp/tool.ts";
import {
  RemoteToolRefusal,
  knownRemoteTools,
  remoteToolDispatchable,
  remoteToolPort,
  remoteToolsConnected,
  type RemoteToolAnswer,
  type RemoteToolDescriptor,
} from "../../remoteTools.ts";

const UNREACHABLE = "The credential gateway is unreachable; try again shortly.";
const JIRA_DISABLED =
  "Jira tools are disabled. Enable them in Settings → Jira.";
const MESSAGE_MAX = 500;

type RemoteAgentTool = AgentTool & { sideEffects: "none" };

const noLongerOffered = (name: string): string =>
  `The gateway no longer offers ${name}.`;

function failureText(
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

function remoteTool(descriptor: RemoteToolDescriptor): RemoteAgentTool {
  // The name from the accepted listing, never from an answer.
  const { name } = descriptor;
  return {
    name,
    label: name,
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    sideEffects: "none",
    async execute(params, ctx) {
      const port = remoteToolPort();
      if (!port || !remoteToolsConnected()) throw new Error(UNREACHABLE);
      if (!getJiraSettings().enabled) throw new Error(JIRA_DISABLED);
      if (!remoteToolDispatchable(name)) throw new Error(noLongerOffered(name));
      let answer: RemoteToolAnswer;
      try {
        answer = await port.call(
          name,
          params,
          ctx.signal ?? new AbortController().signal,
        );
      } catch (err) {
        if (
          err instanceof RemoteToolRefusal &&
          err.code === "tools_unavailable"
        )
          throw new Error("The credential gateway runs no tools.");
        throw new Error(UNREACHABLE);
      }
      if (!answer.ok) throw new Error(failureText(name, answer));
      return { content: [{ type: "text", text: answer.text }] };
    },
  };
}

const built = new Map<
  string,
  { descriptor: RemoteToolDescriptor; tool: RemoteAgentTool }
>();

/**
 * The gateway's read Jira tools known this boot, in first-listed order; a
 * tool is rebuilt only when its descriptor changes.
 */
export function remoteJiraTools(): RemoteAgentTool[] {
  return knownRemoteTools("jira").map((descriptor) => {
    const cached = built.get(descriptor.name);
    if (cached?.descriptor === descriptor) return cached.tool;
    const tool = remoteTool(descriptor);
    built.set(descriptor.name, { descriptor, tool });
    return tool;
  });
}
