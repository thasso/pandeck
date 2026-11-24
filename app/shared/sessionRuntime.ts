/**
 * A started session's pending runtime selection (`docs/session-runtime-switching.md`):
 * the model, effort and account its NEXT turn starts on. It is one complete
 * target, stored on the session row and applied when the next turn is admitted;
 * until then nothing about the engine changes.
 *
 * A leaf module for the same reason as `thinkingLevels.ts`: the parser is a
 * value the server's row mapping and the shared tests both need.
 */
import { isThinkingLevel, type ThinkingLevel } from "./thinkingLevels.ts";

/** Which account runs the target: a specific one, or Automatic (the router). */
export type SessionRuntimeAccount =
  { kind: "automatic" } | { kind: "account"; id: string };

/** The model, effort and account a session's next turn starts on. */
export interface SessionPendingRuntime {
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  account: SessionRuntimeAccount;
  /**
   * Who made the latest change: the user, or the session's owning coordinator
   * (`session_control`). Names the chooser on the account-move marker.
   */
  setBy: SessionRuntimeChooser;
}

/** Who chose a pending selection. */
export type SessionRuntimeChooser = "user" | "coordinator";

/**
 * A change to the pending selection: any of the three parts. The server
 * completes it from the current pending selection, else the session's current
 * runtime, and clamps the effort to the target model.
 */
export interface SessionRuntimeChange {
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  account?: SessionRuntimeAccount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** An untrusted `{ provider, id }`, or undefined. */
export function parseRuntimeModel(
  value: unknown,
): { provider: string; id: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, id } = value;
  return nonEmptyString(provider) && nonEmptyString(id)
    ? { provider, id }
    : undefined;
}

/** An untrusted account choice, or undefined. */
export function parseRuntimeAccount(
  value: unknown,
): SessionRuntimeAccount | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "automatic") return { kind: "automatic" };
  if (value.kind === "account" && nonEmptyString(value.id))
    return { kind: "account", id: value.id };
  return undefined;
}

/**
 * A stored or received pending selection, or undefined when any part is
 * missing or malformed. A row that cannot be read is treated as having none,
 * so a damaged value never stops a session from opening or running.
 */
export function parsePendingRuntime(
  value: unknown,
): SessionPendingRuntime | undefined {
  if (!isRecord(value)) return undefined;
  const model = parseRuntimeModel(value.model);
  const account = parseRuntimeAccount(value.account);
  if (!model || !account || !isThinkingLevel(value.thinkingLevel))
    return undefined;
  return {
    model,
    thinkingLevel: value.thinkingLevel,
    account,
    setBy: value.setBy === "coordinator" ? "coordinator" : "user",
  };
}

/** Whether two account choices are the same. */
function sameRuntimeAccount(
  a: SessionRuntimeAccount,
  b: SessionRuntimeAccount,
): boolean {
  return a.kind === "automatic"
    ? b.kind === "automatic"
    : b.kind === "account" && a.id === b.id;
}

/** Whether two pending selections are the same target, whoever chose it. */
export function samePendingRuntime(
  a: SessionPendingRuntime | undefined,
  b: SessionPendingRuntime | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.model.provider === b.model.provider &&
    a.model.id === b.model.id &&
    a.thinkingLevel === b.thinkingLevel &&
    sameRuntimeAccount(a.account, b.account)
  );
}
