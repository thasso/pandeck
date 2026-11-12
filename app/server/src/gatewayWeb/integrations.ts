/**
 * What the gateway UI needs of the user's integration credentials (Task-1405),
 * defined here as `accounts.ts` defines accounts: the edge's composition
 * adapts its user-scoped operations (`gateway/userOperations.ts`) to it.
 *
 * The user always comes from the session. The API token is write-only: it
 * reaches `set` and nothing answers it. A refusal is an `IntegrationsRefusal`
 * with a fixed code; anything else thrown means the gateway is unavailable.
 */
import type {
  GatewayUiAtlassian,
  GatewayUiAtlassianSetRequest,
} from "@assistant/shared/gatewayUi";
import { isRecord } from "./accounts.ts";

export type IntegrationsRefusalCode =
  | "integration_invalid"
  | "integration_rejected"
  | "integration_unreachable"
  | "vault_locked"
  | "vault_unavailable"
  | "tools_unavailable";

export class IntegrationsRefusal extends Error {
  constructor(readonly code: IntegrationsRefusalCode) {
    super(code);
  }
}

export interface GatewayWebIntegrations {
  /** The stored credential's site and email; no live check. */
  status(userId: string): Promise<GatewayUiAtlassian>;
  /** Checks the credential with Atlassian, then stores it. */
  set(
    userId: string,
    input: GatewayUiAtlassianSetRequest,
  ): Promise<GatewayUiAtlassian>;
  clear(userId: string): Promise<void>;
}

/** Above the parser's own bounds, so it, not this, decides validity. */
const MAX_SITE_CHARS = 300;
const MAX_EMAIL_CHARS = 300;
const MAX_TOKEN_CHARS = 600;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/** `{site, email, token}`; any other field (a `userId`) is ignored. */
export function decodeAtlassianSet(
  value: unknown,
): GatewayUiAtlassianSetRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { site, email, token } = value;
  return text(site, MAX_SITE_CHARS) &&
    text(email, MAX_EMAIL_CHARS) &&
    text(token, MAX_TOKEN_CHARS)
    ? { site, email, token }
    : undefined;
}
