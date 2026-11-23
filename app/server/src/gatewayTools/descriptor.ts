/**
 * One edge tool (Task-1397): its name, schema, effect and action key, the
 * integration whose credential it uses, and what it does. A tool is one
 * module exporting a `ToolDescriptor`, plus its line in `tools.ts`.
 *
 * Only `ToolError` text reaches a caller, and it must be fixed text this
 * module tree owns: never a credential, an upstream body, a request string or
 * any other error's message. `ToolError` exists only inside `gatewayTools/`.
 * Two exceptions (ADR-0005), both vetted by `upstreamText.ts`, never shown
 * with credential material, sanitized and capped:
 *
 * - D4 (Task-1439): Jira's own `errorMessages` and `errors` reasons for a
 *   `jira_search_issues` HTTP 400 (`jiraSearchIssues.ts`). They may quote the
 *   user's JQL, field names or a URL Jira chose to mention.
 * - D-W2 (Task-1463, 2026-11-21): for `jira_mutate_issue` and
 *   `confluence_mutate_page`, the shared prepare/apply code's own messages,
 *   and the product's reasons for a 4xx on a write call (`writeFailure.ts`).
 *   401/403 keep the fixed credential text; 5xx, network errors and timeouts
 *   stay fixed.
 */
import type { SlackAccessView } from "./slack.ts";

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

/*
 * What the closed schema checker (`schema.ts`) understands (Task-1439,
 * Task-1463). Readonly, so a local tool's `as const` schema is the edge's
 * schema too.
 *
 * The branches are mutually exclusive: each forbids, with an optional `never`
 * member, every keyword another branch relies on. The opaque object forbids
 * `properties`, `required` and `additionalProperties`; every branch with a
 * `type` forbids `anyOf`; the string-or-null branch forbids `type`. Under
 * `exactOptionalPropertyTypes` an optional `never` refuses an explicit
 * `undefined` too, so this holds for a plain `as const` variable assigned
 * later, not only for a literal. A `default` is allowed only on a root
 * property. An unknown keyword (`oneOf`, `format`, …) is refused only by a
 * literal's excess-property check (`{…} satisfies ObjectSchema`): ordinary
 * assignment is not exact-object typing.
 */
interface Doc {
  readonly description?: string;
}

type StringProp = Doc & {
  readonly type: "string";
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly anyOf?: never;
};

/** A string or `null`, written only as this exact `anyOf`. */
type NullableStringProp = Doc & {
  readonly anyOf: readonly [
    { readonly type: "string" },
    { readonly type: "null" },
  ];
  readonly type?: never;
};

type NumberProp = Doc & { readonly type: "number"; readonly anyOf?: never };

type BooleanProp = Doc & { readonly type: "boolean"; readonly anyOf?: never };
type RootBooleanProp = BooleanProp & { readonly default?: boolean };
type NestedBooleanProp = BooleanProp & { readonly default?: never };

type IntegerProp = Doc & {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly anyOf?: never;
};
type RootIntegerProp = IntegerProp & { readonly default?: number };
type NestedIntegerProp = IntegerProp & { readonly default?: never };

interface StringItem {
  readonly type: "string";
  readonly enum?: readonly string[];
}

type StringArrayProp = Doc & {
  readonly type: "array";
  readonly items: StringItem;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly anyOf?: never;
};

type ObjectArrayProp = Doc & {
  readonly type: "array";
  readonly items: ClosedObjectProp;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly anyOf?: never;
};

/** Any JSON object, passed to the tool as given and never descended into. */
type OpaqueObjectProp = Doc & {
  readonly type: "object";
  readonly properties?: never;
  readonly required?: never;
  readonly additionalProperties?: never;
  readonly anyOf?: never;
};

type ClosedObjectProp = Doc & {
  readonly type: "object";
  readonly properties: Readonly<Record<string, NestedProp>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
  readonly anyOf?: never;
};

type NestedProp =
  | StringProp
  | NullableStringProp
  | NestedBooleanProp
  | NestedIntegerProp
  | NumberProp
  | StringArrayProp
  | ObjectArrayProp
  | OpaqueObjectProp
  | ClosedObjectProp;

type RootProp =
  | StringProp
  | NullableStringProp
  | RootBooleanProp
  | RootIntegerProp
  | NumberProp
  | StringArrayProp
  | ObjectArrayProp
  | OpaqueObjectProp
  | ClosedObjectProp;

export interface ObjectSchema {
  type: "object";
  properties: Readonly<Record<string, RootProp>>;
  required?: readonly string[];
  additionalProperties: false;
}

interface ToolContext<C> {
  /** The calling user's credential, read from the vault for this call. */
  credential(): Promise<C>;
  /** Aborts at the host's deadline or when the caller goes away. */
  signal: AbortSignal;
  /**
   * The epoch ms at which the host's deadline fires, fixed when its timer is
   * armed, before the credential read.
   */
  deadlineAt: number;
}

interface ToolDescriptorBase {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  effect: "read" | "write";
  /** The approval key a later gateway-side policy decides by (G5). */
  actionKey: string;
  /** The JSON result's limit; 60,000 characters unless given. */
  maxResultChars?: number;
  /** The call's own deadline; the host's (30 s by default) unless given. */
  deadlineMs?: number;
}

/** A tool run with the user's Atlassian credential. */
export type AtlassianToolDescriptor = ToolDescriptorBase & {
  integration: "atlassian";
  /** Answers a JSON-serializable result; params passed the schema. */
  execute(
    params: Record<string, unknown>,
    ctx: ToolContext<AtlassianCredential>,
  ): Promise<unknown>;
};

/** A tool run with the user's Slack access view (Task-1454). */
export type SlackToolDescriptor = ToolDescriptorBase & {
  integration: "slack";
  /** Answers a JSON-serializable result; params passed the schema. */
  execute(
    params: Record<string, unknown>,
    ctx: ToolContext<SlackAccessView>,
  ): Promise<unknown>;
};

/**
 * One edge tool. `integration` selects the credential its `execute` gets, so
 * the host's dispatch is typed per integration without casts.
 */
export type ToolDescriptor = AtlassianToolDescriptor | SlackToolDescriptor;

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
