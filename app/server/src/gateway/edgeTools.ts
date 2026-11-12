/**
 * What the edge takes from its tools (Task-1397, ADR-0005): the MCP handler
 * behind the `/mcp` gate, the tool host gateway client 1.0's `tools.*` call
 * (Task-1398), and the integrations' credential checks. The edge's entry
 * injects them (`gatewayTools/index.ts`); `gateway/` holds no tool code or
 * package. The gateway hands tools typed credential outcomes and never
 * builds a tool error. Types only (`workerBoundary.test.ts`).
 */
import type http from "node:http";

/** One vault read of a user's integration credential, for one call. */
export type CredentialOutcome =
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

interface McpCaller {
  clientId: string;
  /** Asks the vault on every call and keeps nothing; never rejects. */
  credential(
    integration: "atlassian",
    signal: AbortSignal,
  ): Promise<CredentialOutcome>;
}

type ToolCaller = McpCaller & {
  /** Aborts when the client cancels the call or its connection ends. */
  signal?: AbortSignal;
};

/** One tool as the host lists it. */
interface ListedTool {
  name: string;
  description: string;
  inputSchema: object;
  effect: "read" | "write";
  actionKey: string;
}

export type ToolFailureCode =
  | "unknown_tool"
  | "invalid_params"
  | "tool_error"
  | "result_too_large"
  | "timeout"
  | "cancelled"
  | "failed";

/** The host's answer to one call; it never throws. */
export type ToolAnswer =
  | { ok: true; text: string }
  | { ok: false; code: ToolFailureCode; message: string };

export type IntegrationCheck =
  | { ok: true; displayName?: string; accountId?: string }
  | { ok: false; problem: "rejected" | "unreachable" | "failed" };

export interface EdgeTools {
  handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): void;
  /** The host `/mcp` runs on, for gateway client 1.0's `tools.*`. */
  host: {
    list(): ListedTool[];
    call(name: string, args: unknown, caller: ToolCaller): Promise<ToolAnswer>;
  };
  integrations: {
    atlassian: {
      /** The checked credential as the opaque text the vault stores. */
      parse(
        input: unknown,
      ):
        | { ok: true; credential: string; site: string; email: string }
        | { ok: false };
      /** Asks Atlassian whether the stored credential works. */
      check(credential: string, signal: AbortSignal): Promise<IntegrationCheck>;
      /** The site and email of a stored credential; never its token. */
      describe(credential: string): { site: string; email: string } | undefined;
    };
  };
}
