/**
 * One edge tool (Task-1397): its name, schema, effect and action key, the
 * integration whose credential it uses, and what it does. A tool is one
 * module exporting a `ToolDescriptor`, plus its line in `tools.ts`.
 *
 * Only `ToolError` text reaches a caller, and it must be fixed text this
 * module tree owns: never a credential, an upstream body, a request string or
 * any other error's message. `ToolError` exists only inside `gatewayTools/`.
 * The single exception (Task-1439 D4, ADR-0005): Jira's own `errorMessages`
 * and `errors` reasons for a `jira_search_issues` HTTP 400
 * (`jiraSearchIssues.ts`). They are never shown with credential material,
 * and are sanitized and capped. They may quote the user's JQL, field names or
 * a URL Jira chose to mention.
 */

/** An API token the user set for their site. */
export interface AtlassianTokenCredential {
  /** A bare `<name>.atlassian.net` host. */
  site: string;
  email: string;
  token: string;
}

/**
 * The vault's OAuth access view (Task-1411): a short-lived access token for
 * the site's cloud id. The edge keeps it for one call only.
 */
interface AtlassianOAuthCredential {
  /** A bare `<name>.atlassian.net` host; browse URLs only. */
  site: string;
  /** A lowercase UUID. */
  cloudId: string;
  accessToken: string;
}

/** The user's Atlassian credential, decoded for one tool call. */
export type AtlassianCredential =
  AtlassianTokenCredential | AtlassianOAuthCredential;

/**
 * What the closed schema checker (`schema.ts`) understands. Readonly, so a
 * local tool's `as const` schema is the edge's schema too (Task-1439).
 */
type PropertySchema =
  | {
      readonly type: "string";
      readonly description?: string;
      readonly pattern?: string;
      readonly maxLength?: number;
      readonly enum?: readonly string[];
    }
  | {
      readonly type: "boolean";
      readonly description?: string;
      readonly default?: boolean;
    }
  | {
      readonly type: "integer";
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    }
  | { readonly type: "number"; readonly description?: string }
  | {
      readonly type: "array";
      readonly description?: string;
      readonly items: {
        readonly type: "string";
        readonly enum?: readonly string[];
      };
    };

export interface ObjectSchema {
  type: "object";
  properties: Readonly<Record<string, PropertySchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

interface ToolContext {
  /** The calling user's credential, read from the vault for this call. */
  credential(): Promise<AtlassianCredential>;
  /** Aborts at the host's deadline or when the caller goes away. */
  signal: AbortSignal;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  effect: "read" | "write";
  /** The approval key a later gateway-side policy decides by (G5). */
  actionKey: string;
  integration: "atlassian";
  /** The JSON result's limit; 60,000 characters unless given. */
  maxResultChars?: number;
  /** Answers a JSON-serializable result; params passed the schema. */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** A failure whose fixed, edge-owned text the caller sees. */
export class ToolError extends Error {}

/** The error a raced wait throws when its signal aborts. */
export function abortError(): Error {
  const error = new Error("The call was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Settles with `pending` or rejects with an abort error once `signal`
 * aborts, whichever is first. A late settlement of `pending` is caught and
 * dropped unread.
 */
export function raceAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  pending.catch(() => {});
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([pending, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}
