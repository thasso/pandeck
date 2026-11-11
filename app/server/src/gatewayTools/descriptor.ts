/**
 * One edge tool (Task-1397): its name, schema, effect and action key, the
 * integration whose credential it uses, and what it does. A tool is one
 * module exporting a `ToolDescriptor`, plus its line in `tools.ts`.
 *
 * Only `ToolError` text reaches a caller, and it must be fixed text this
 * module tree owns: never a credential, an upstream body, a request string or
 * any other error's message. `ToolError` exists only inside `gatewayTools/`.
 */

/** The user's Atlassian credential, decoded for one tool call. */
export interface AtlassianCredential {
  /** A bare `<name>.atlassian.net` host. */
  site: string;
  email: string;
  token: string;
}

/** What the closed schema checker (`schema.ts`) understands. */
type PropertySchema =
  | {
      type: "string";
      description?: string;
      pattern?: string;
      maxLength?: number;
    }
  | { type: "boolean"; description?: string; default?: boolean }
  | {
      type: "integer";
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    };

export interface ObjectSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
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
