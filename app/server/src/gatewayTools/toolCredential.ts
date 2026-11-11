/**
 * The one place a gateway credential outcome becomes a tool's credential
 * (Task-1397). The gateway hands typed outcomes and never builds a tool
 * error; this module turns each into a fixed `ToolError` text or the decoded
 * credential. The wait is raced against the call's signal: a credential that
 * arrives after the abort is dropped unread, before any upstream request.
 */
import { decodeAtlassianCredential } from "./atlassian.ts";
import {
  ToolError,
  abortError,
  raceAbort,
  type AtlassianCredential,
} from "./descriptor.ts";

/** Structurally `gateway/edgeTools.ts`'s; nothing here imports `gateway/`. */
export type CredentialOutcome =
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

export interface CredentialSource {
  /** Asks the vault once; never rejects. */
  credential(
    integration: "atlassian",
    signal: AbortSignal,
  ): Promise<CredentialOutcome>;
}

export async function credentialFor(
  source: CredentialSource,
  integration: "atlassian",
  signal: AbortSignal,
): Promise<AtlassianCredential> {
  if (signal.aborted) throw abortError();
  const outcome = await raceAbort(
    source.credential(integration, signal),
    signal,
  );
  if (signal.aborted) throw abortError();
  if (outcome.ok) {
    const credential = decodeAtlassianCredential(outcome.credential);
    if (!credential)
      throw new ToolError(
        "The stored Jira credential is invalid; reconnect Jira in Pandeck's Settings.",
      );
    return credential;
  }
  if ("absent" in outcome)
    throw new ToolError(
      "Jira is not connected for this user; connect it in Pandeck's Settings.",
    );
  if ("locked" in outcome) throw new ToolError("The vault is locked.");
  throw new ToolError("The vault did not answer; try again.");
}
