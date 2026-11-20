/**
 * The one place a gateway credential outcome becomes a tool's credential
 * (Task-1397), per integration (Task-1454). The gateway hands typed outcomes and never builds a tool
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
import { decodeSlackAccessView, type SlackAccessView } from "./slack.ts";

/** Structurally `gateway/edgeTools.ts`'s; nothing here imports `gateway/`. */
export type CredentialOutcome =
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; rejected: true }
  | { ok: false; locked: true }
  | { ok: false; unavailable: true };

export interface CredentialSource {
  /** Asks the vault once; never rejects. */
  credential(
    integration: "atlassian" | "slack",
    signal: AbortSignal,
  ): Promise<CredentialOutcome>;
}

/**
 * The vault's outcome for `integration`, raced against `signal`; the shared
 * `locked`/`unavailable` texts are thrown here, the integration's own
 * outcomes are left to the caller.
 */
async function outcomeFor(
  source: CredentialSource,
  integration: "atlassian" | "slack",
  signal: AbortSignal,
): Promise<
  | { ok: true; credential: string }
  | { ok: false; absent: true }
  | { ok: false; rejected: true }
> {
  if (signal.aborted) throw abortError();
  const outcome = await raceAbort(
    source.credential(integration, signal),
    signal,
  );
  if (signal.aborted) throw abortError();
  if (outcome.ok || "absent" in outcome || "rejected" in outcome)
    return outcome;
  if ("locked" in outcome) throw new ToolError("The vault is locked.");
  throw new ToolError("The vault did not answer; try again.");
}

export async function atlassianCredentialFor(
  source: CredentialSource,
  signal: AbortSignal,
): Promise<AtlassianCredential> {
  const outcome = await outcomeFor(source, "atlassian", signal);
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
  throw new ToolError(
    "Atlassian rejected the credential; reconnect Jira on the gateway's page.",
  );
}

/** Slack's `rejected` text; the Slack tools also answer it for a dead token. */
export const SLACK_REJECTED_TEXT =
  "Slack rejected the credential; reconnect Slack on the gateway's page.";

export async function slackCredentialFor(
  source: CredentialSource,
  signal: AbortSignal,
): Promise<SlackAccessView> {
  const outcome = await outcomeFor(source, "slack", signal);
  if (outcome.ok) {
    const view = decodeSlackAccessView(outcome.credential);
    if (!view)
      throw new ToolError(
        "The stored Slack credential is invalid; reconnect Slack on the gateway's page.",
      );
    return view;
  }
  if ("absent" in outcome)
    throw new ToolError(
      "Slack is not connected for this user; connect it on the gateway's page.",
    );
  throw new ToolError(SLACK_REJECTED_TEXT);
}
