/**
 * The catalog's gateway tools in client mode (Task-1398): one `AgentTool`
 * per read tool of a mapped product (Jira, Slack, Confluence) the gateway
 * listed this boot (`remoteTools.ts`). A call goes from this server to the gateway as
 * `tools.call`; the gateway runs it with the user's own credential. An
 * accepted gateway write is the local write tool behind the approval card
 * (`remoteWrites.ts`, Task-1463 P6b), and an accepted file tool the local
 * tool whose answer this server stages (`remoteFiles.ts`, Task-1441 P7a).
 *
 * A name stays for the boot, so a pi engine that registered it keeps a
 * binding; before any call `execute` checks the connection, the product's
 * toggle and that the latest listing still offers it as a read tool. Only the
 * gateway's `tool_error` and `invalid_params` texts reach the agent; every
 * other failure is fixed text (`remoteReadRules.ts`). A byte stream on a
 * read's answer is refused as an unexpected file: nothing is kept.
 */
import type { AgentTool } from "../../mcp/tool.ts";
import {
  RemoteToolRefusal,
  knownRemoteTools,
  remoteProductEnabled,
  remoteToolDispatchable,
  remoteToolPort,
  remoteToolsConnected,
  type RemoteToolAnswer,
  type RemoteProduct,
  type RemoteReadDescriptor,
  type RemoteToolDescriptor,
} from "../../remoteTools.ts";
import { remoteFileTool, type RemoteFileAgentTool } from "./remoteFiles.ts";
import {
  DISABLED,
  NO_TOOLS,
  UNEXPECTED_FILE_ANSWER,
  UNREACHABLE,
  failureText,
  noLongerOffered,
} from "./remoteReadRules.ts";
import { remoteWriteTool, type RemoteWriteAgentTool } from "./remoteWrites.ts";

type RemoteReadAgentTool = AgentTool & { sideEffects: "none" };
type RemoteAgentTool =
  RemoteReadAgentTool | RemoteWriteAgentTool | RemoteFileAgentTool;

function remoteTool(descriptor: RemoteReadDescriptor): RemoteReadAgentTool {
  // The name from the accepted listing, never from an answer.
  const { name, product } = descriptor;
  return {
    name,
    label: name,
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    sideEffects: "none",
    async execute(params, ctx) {
      const port = remoteToolPort();
      if (!port || !remoteToolsConnected()) throw new Error(UNREACHABLE);
      if (!remoteProductEnabled(product)) throw new Error(DISABLED[product]);
      if (!remoteToolDispatchable(name)) throw new Error(noLongerOffered(name));
      let answer: RemoteToolAnswer;
      try {
        answer = await port.call(
          name,
          params,
          ctx.signal ?? new AbortController().signal,
        );
      } catch (err) {
        if (err instanceof RemoteToolRefusal) {
          if (err.code === "tools_unavailable") throw new Error(NO_TOOLS);
          if (err.code === "unexpected_file")
            throw new Error(UNEXPECTED_FILE_ANSWER);
        }
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
 * The gateway's tools of `product` known this boot, reads and writes, in
 * first-listed order; a tool is rebuilt only when its descriptor changes.
 */
export function remoteToolsFor(product: RemoteProduct): RemoteAgentTool[] {
  return knownRemoteTools(product).map((descriptor) => {
    const cached = built.get(descriptor.name);
    if (cached?.descriptor === descriptor) return cached.tool;
    const tool =
      descriptor.effect === "write"
        ? remoteWriteTool(descriptor)
        : "file" in descriptor
          ? remoteFileTool(descriptor)
          : remoteTool(descriptor);
    built.set(descriptor.name, { descriptor, tool });
    return tool;
  });
}
