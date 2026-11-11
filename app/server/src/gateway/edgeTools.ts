/**
 * What the edge takes from its tools (Task-1397, ADR-0005): the MCP handler
 * behind the `/mcp` gate and the integrations' credential checks. The edge's
 * entry injects them (`gatewayTools/index.ts`); `gateway/` holds no tool code
 * or package. The gateway hands tools typed credential outcomes and never
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

export type IntegrationCheck =
  | { ok: true; displayName?: string; accountId?: string }
  | { ok: false; problem: "rejected" | "unreachable" | "failed" };

export interface EdgeTools {
  handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    caller: McpCaller,
  ): void;
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
