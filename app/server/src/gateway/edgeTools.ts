/**
 * What the edge takes from its tools (Task-1397, ADR-0005): the MCP handler
 * behind the `/mcp` gate, the tool host gateway client 1.x's `tools.*` call
 * (Task-1398; `tools.prepare` and `tools.apply` in 1.1, Task-1463 P6a), and the integrations' credential checks. The edge's entry
 * injects them (`gatewayTools/index.ts`); `gateway/` holds no tool code or
 * package. The gateway hands tools typed credential outcomes and never
 * builds a tool error. Types only (`workerBoundary.test.ts`).
 */
import type http from "node:http";

/** One vault read of a user's integration credential, for one call. */
export type CredentialOutcome =
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; rejected: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

interface McpCaller {
  clientId: string;
  /** Asks the vault on every call and keeps nothing; never rejects. */
  credential(
    integration: "atlassian" | "slack",
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
  /** Runs as `tools.prepare` and `tools.apply` on a client connection. */
  twoPhase?: true;
}

export type ToolFailureCode =
  | "unknown_tool"
  | "invalid_params"
  | "tool_error"
  | "result_too_large"
  | "timeout"
  | "cancelled"
  | "failed";

type ToolFailure = { ok: false; code: ToolFailureCode; message: string };

/** The host's answer to one call; it never throws. */
export type ToolAnswer = { ok: true; text: string } | ToolFailure;

/** Whether any write request left the edge. */
export type Effects = "none" | "possible";

/** `tools.prepare`'s answer: the proposal for the credential's site. */
export type PrepareAnswer =
  | { ok: true; site: string; items: unknown[]; warnings: string[] }
  | ToolFailure;

/** `tools.apply`'s request: the approved items, for the site they were prepared for. */
export interface ApplyRequest {
  site: string;
  items: unknown[];
}

/** `tools.apply`'s answer: one result record per item, or a failure. */
export type ApplyAnswer =
  | { ok: true; results: object[]; effects: Effects; trimmed?: true }
  | (ToolFailure & { effects: Effects; itemEffects?: Effects[] });

export type IntegrationCheck =
  | { ok: true; displayName?: string; accountId?: string }
  | { ok: false; problem: "rejected" | "unreachable" | "failed" };

export interface EdgeTools {
  handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): void;
  /** The host `/mcp` runs on, for gateway client 1.x's `tools.*`; never throws. */
  host: {
    list(): ListedTool[];
    /** A client's `tools.call`: a write tool is refused before any read. */
    callForClient(
      name: string,
      args: unknown,
      caller: ToolCaller,
    ): Promise<ToolAnswer>;
    prepare(
      name: string,
      args: unknown,
      caller: ToolCaller,
    ): Promise<PrepareAnswer>;
    apply(
      name: string,
      request: ApplyRequest,
      caller: ToolCaller,
    ): Promise<ApplyAnswer>;
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
      /**
       * The kind and site of a stored credential, and the email of an API
       * token; never a token.
       */
      describe(
        credential: string,
      ): { site: string; email?: string; kind: "token" | "oauth" } | undefined;
    };
    slack: {
      /**
       * The workspace's name of the vault's Slack access view (Task-1453),
       * undefined when the view does not decode; never a token.
       */
      describe(credential: string): { teamName?: string } | undefined;
    };
  };
}
