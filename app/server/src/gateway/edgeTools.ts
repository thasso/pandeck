/**
 * What the edge takes from its tools (Task-1397, ADR-0005): the MCP handler
 * behind the `/mcp` gate, the tool host gateway client 1.x's `tools.*` call
 * (Task-1398; `tools.prepare` and `tools.apply` in 1.1, Task-1463 P6a;
 * file answers in 1.2, Task-1441 P7a; uploads in 1.3, Task-1441 P8a), and
 * the integrations' credential checks. The edge's entry
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
  /**
   * Runs `fn` once the call's answer has left the edge or can no longer be
   * written (Task-1441 P7a, H1); a file tool runs only with it.
   */
  onSettled?: (fn: () => void) => void;
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
  /** File-capable (Task-1441 P7a): its limit argument, default and cap. */
  file?: { limitParam: string; defaultBytes: number; maxBytes: number };
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

/**
 * The host's answer to one call; it never throws. A file tool's answer may
 * carry one file with its size and SHA-256 (Task-1441 P7a).
 */
export type ToolAnswer =
  | {
      ok: true;
      text: string;
      file?: {
        name: string;
        mimeType: string;
        size: number;
        sha256: string;
        bytes: Uint8Array;
      };
    }
  | ToolFailure;

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

/**
 * `tools.apply`'s answer: one result record per item, or a failure; one
 * after the apply started keeps the records its working copy shows.
 */
export type ApplyAnswer =
  | { ok: true; results: object[]; effects: Effects; trimmed?: true }
  | (ToolFailure & {
      effects: Effects;
      itemEffects?: Effects[];
      results?: object[];
      trimmed?: true;
    });

/** One upload source a client's `tools.prepare` declared (1.3). */
interface UploadMeta {
  stagedAttachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: string;
}

type UploadRefusal = { ok: false; code: "tool_error"; message: string };

/**
 * One client connection's view of the edge's upload store (Task-1441 P8a):
 * opaque, made once per connection, never named on the wire. `consume` is
 * the host's; the listener only passes the scope on.
 */
export interface UploadScope {
  open(request: {
    streams: { stagedAttachmentId: string; size: number; sha256: string }[];
    work: number;
  }): { ok: true; uploadId: string } | UploadRefusal;
  put(
    request: { uploadId: string; stagedAttachmentId: string; offset: number },
    chunk: Uint8Array | readonly Uint8Array[],
  ):
    | { ok: true; received: number; streamComplete: boolean; sealed: boolean }
    | UploadRefusal;
  release(uploadId: string): { ok: true } | UploadRefusal;
  /** An undecodable request: the named unattached upload is discarded. */
  invalid(uploadId?: string): UploadRefusal;
  /** The connection ended. */
  end(): void;
  consume(uploadId: string, items: readonly unknown[]): unknown;
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
  /** The host `/mcp` runs on, for gateway client 1.x's `tools.*`; never throws. */
  host: {
    list(): ListedTool[];
    /** A client's `tools.call`: a write tool is refused before any read. */
    callForClient(
      name: string,
      args: unknown,
      caller: ToolCaller,
    ): Promise<ToolAnswer>;
    /** `uploads`: the sources a 1.3 prepare declared, never an argument. */
    prepare(
      name: string,
      args: unknown,
      caller: ToolCaller,
      options?: { uploads?: readonly UploadMeta[] },
    ): Promise<PrepareAnswer>;
    /**
     * `upload`: the connection's upload a 1.3 apply names, consumed by the
     * host; it needs `caller.onSettled`.
     */
    apply(
      name: string,
      request: ApplyRequest,
      caller: ToolCaller,
      options?: { upload?: { id: string; scope: UploadScope } },
    ): Promise<ApplyAnswer>;
  };
  /** The upload store (1.3); absent, the upload methods are unavailable. */
  uploads?: { scope(userId: string): UploadScope };
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
