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
  encodeAtlassianCredential,
  parseAtlassianCredential,
  type AtlassianCheck,
} from "./atlassian.ts";
import { createToolHost, type ToolHost, type ToolHostOptions } from "./host.ts";
import {
  createMcpHandler,
  type McpCaller,
  type McpHandlerOptions,
} from "./mcp.ts";
import { EDGE_TOOLS } from "./tools.ts";

interface AtlassianIntegration {
  parse(
    input: unknown,
  ):
    | { ok: true; credential: string; site: string; email: string }
    | { ok: false };
  check(credential: string, signal: AbortSignal): Promise<AtlassianCheck>;
  describe(credential: string): { site: string; email: string } | undefined;
}

export interface EdgeToolSet {
  handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): void;
  /** The same host, for gateway client 1.0's `tools.*` (Task-1398). */
  host: ToolHost;
  integrations: { atlassian: AtlassianIntegration };
}

export function createEdgeTools(
  options: ToolHostOptions & McpHandlerOptions = {},
): EdgeToolSet {
  const log = options.log ?? ((line: string) => console.log(`[tools] ${line}`));
  const host = createToolHost(EDGE_TOOLS, { ...options, log });
  return {
    handleMcp: createMcpHandler(host, log, {
      ...(options.deadlineMs !== undefined
        ? { deadlineMs: options.deadlineMs }
        : {}),
      ...(options.lifecycleMs !== undefined
        ? { lifecycleMs: options.lifecycleMs }
        : {}),
    }),
    host,
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
            ? { site: credential.site, email: credential.email }
            : undefined;
        },
      },
    },
  };
}
