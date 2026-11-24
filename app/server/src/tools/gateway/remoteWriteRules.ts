/**
 * What the gateway write tool (`remoteWrites.ts`) and its apply
 * (`remoteApply.ts`) share (Task-1463 P6b): the Atlassian site pattern and
 * the client's own "nothing was written" claim. A leaf: it imports only
 * `remoteTools.ts` types.
 *
 * The claim is the client's, never the edge's wording, which the link may
 * have cut (P6a L-a): a prepare refusal always earns it, since prepare never
 * writes; an apply failure only when the edge certifies `effects: "none"`
 * (D6(i)).
 */
import type { RemoteProduct } from "../../remoteTools.ts";

/**
 * The edge's SSRF site pattern, a copy: `gatewayTools/atlassian.ts` `SITE_RE`
 * is edge code this server may not import (`workerBoundary.test.ts`), and
 * `remoteWrites.test.ts` fails when the two texts differ (D3).
 */
export const ATLASSIAN_SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;

/** The route of a card the gateway prepared (`pendingApprovals.ts` routes). */
export const GATEWAY_ROUTE = "gateway";

/**
 * The approval context of a card the gateway prepared: its kind's executor
 * applies it with `tools.apply` (`remoteApply.ts`), never locally.
 */
export const GATEWAY_CONTEXT = { via: GATEWAY_ROUTE } as const;

export const NOTHING_WRITTEN = "Nothing was written.";
/** The link's decoder cuts an edge message here; a cut one gets "…". */
const EDGE_MESSAGE_MAX = 500;

export const NOT_OFFERED = `The gateway no longer offers this change. ${NOTHING_WRITTEN}`;

/** A product's toggle is off. */
export const DISABLED: Record<RemoteProduct, string> = {
  jira: `Jira tools are disabled. Enable them in Settings → Jira. ${NOTHING_WRITTEN}`,
  slack: `Slack tools are disabled. Enable them in Settings → Slack. ${NOTHING_WRITTEN}`,
  confluence: `Confluence tools are disabled. Enable them in Settings → Confluence. ${NOTHING_WRITTEN}`,
};

/**
 * An edge message with the client's own claim: "…" where the link cut it,
 * then "Nothing was written." unless it already ends so. Only for a case
 * where nothing was written: a prepare refusal, or an apply the edge
 * certified `effects: "none"`.
 */
export function withNothingWritten(message: string): string {
  const shown =
    message.length >= EDGE_MESSAGE_MAX ? `${message}…` : message.trimEnd();
  return /nothing was written\.$/i.test(shown)
    ? shown
    : `${shown} ${NOTHING_WRITTEN}`;
}
