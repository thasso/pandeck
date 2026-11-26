/**
 * The edge's tools as the gateway takes them (Task-1397): structurally
 * `gateway/edgeTools.ts`'s `EdgeTools`, which this tree never imports. Only
 * the edge's entry (`gatewayDevMain.ts`) loads this module; the vault process
 * and `gateway/` never do (`workerBoundary.test.ts`).
 */
import type http from "node:http";
import {
  checkAtlassian,
  decodeAtlassianCredential,
  describeAtlassianCredential,
  encodeAtlassianCredential,
  parseAtlassianCredential,
  type AtlassianCheck,
} from "./atlassian.ts";
import {
  createFileBudget,
  createToolHost,
  mcpDeadlineMs,
  type ToolHost,
  type ToolHostOptions,
} from "./host.ts";
import {
  createMcpHandler,
  type McpCaller,
  type McpHandlerOptions,
} from "./mcp.ts";
import { confluenceDeleteSwitchFor } from "./confluenceMutatePage.ts";
import { describeSlackAccessView } from "./slack.ts";
import { edgeTools } from "./tools.ts";
import { createUploadStore, type UploadStore } from "./uploads.ts";

interface AtlassianIntegration {
  parse(
    input: unknown,
  ):
    | { ok: true; credential: string; site: string; email: string }
    | { ok: false };
  check(credential: string, signal: AbortSignal): Promise<AtlassianCheck>;
  describe(
    credential: string,
  ): { site: string; email?: string; kind: "token" | "oauth" } | undefined;
}

export interface EdgeToolSet {
  handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): void;
  /** The same host, for gateway client 1.x's `tools.*` (Task-1398, Task-1463). */
  host: ToolHost;
  /**
   * The client connections' upload store (1.3, Task-1441 P8a), on the
   * host's own file budget.
   */
  uploads: UploadStore;
  integrations: {
    atlassian: AtlassianIntegration;
    /** The vault's Slack access view, for the page's status (Task-1453). */
    slack: { describe(credential: string): { teamName?: string } | undefined };
  };
}

export interface EdgeToolOptions extends ToolHostOptions, McpHandlerOptions {
  /**
   * The Atlassian scopes the gateway requests (`ui.json` or its default),
   * read once at start. Absent, Confluence deletes are off (fail closed).
   */
  atlassianScopes?: readonly string[];
}

export function createEdgeTools(options: EdgeToolOptions = {}): EdgeToolSet {
  const log = options.log ?? ((line: string) => console.log(`[tools] ${line}`));
  const tools = edgeTools({
    confluenceDeletes: confluenceDeleteSwitchFor(options.atlassianScopes),
  });
  // One file permit for the process: a download and an upload never overlap
  // (Task-1441 P8a, v10 S2).
  const fileBudget = options.fileBudget ?? createFileBudget();
  const host = createToolHost(tools, { ...options, log, fileBudget });
  return {
    handleMcp: createMcpHandler(host, log, {
      // A write tool's own deadline can outlast the host's (Task-1463), and
      // so can a file tool's that `/mcp` lists (Task-1441 P7b, v09 U2).
      deadlineMs: mcpDeadlineMs(tools, options.deadlineMs),
      ...(options.lifecycleMs !== undefined
        ? { lifecycleMs: options.lifecycleMs }
        : {}),
    }),
    host,
    uploads: createUploadStore({ fileBudget }),
    integrations: {
      atlassian: {
        parse(input) {
          const credential = parseAtlassianCredential(input);
          return credential
            ? {
                ok: true,
                credential: encodeAtlassianCredential(credential),
                site: credential.site,
                email: credential.email,
              }
            : { ok: false };
        },
        async check(text, signal) {
          const credential = decodeAtlassianCredential(text);
          return credential
            ? checkAtlassian(credential, signal)
            : { ok: false, problem: "failed" };
        },
        describe(text) {
          const credential = decodeAtlassianCredential(text);
          return credential
            ? describeAtlassianCredential(credential)
            : undefined;
        },
      },
      slack: { describe: describeSlackAccessView },
    },
  };
}
