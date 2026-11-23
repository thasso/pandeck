/**
 * A Claude account's model listing through the credential gateway: one
 * `GET /anthropic/v1/models?limit=1000` on the profile's server lease. The
 * gateway puts the profile's access token on it; the server never reads one.
 * The listing is filtered by the subscription's entitlement, so it is what this
 * account can run (`docs/account-routing.md`).
 */
import { gatewayRefusalText } from "../providerErrors.ts";
import type { EngineGatewayAccess } from "../workerProtocol/engineMethods.ts";

/** Injectable so tests never touch the network. */
export interface ClaudeGatewayModelsDeps {
  fetch: typeof fetch;
}

const DEFAULT_DEPS: ClaudeGatewayModelsDeps = {
  // Looked up per call, so a test's stubbed global is the one used.
  fetch: (input, init) => fetch(input, init),
};

export const CLAUDE_MODELS_TIMEOUT_TEXT = "Claude model listing timed out.";
export const CLAUDE_MODELS_MALFORMED_TEXT =
  "Claude model listing was not recognised.";
export const CLAUDE_MODELS_INCOMPLETE_TEXT =
  "Claude model listing was incomplete.";

/** A non-2xx the gateway did not answer itself; never the upstream's prose. */
function modelsFailureText(status: number): string {
  return status === 401
    ? "Claude did not accept the model listing request."
    : `Claude model listing failed (HTTP ${status}).`;
}

/**
 * The model ids the profile's account lists. A refusal the gateway answered
 * itself throws its text whatever the status; any other non-2xx throws a fixed
 * text. A body without a `data` array, or one saying more pages follow
 * (`has_more: true`), throws too: a partial listing must never shrink what an
 * account offers. Nothing is retried.
 */
export async function fetchClaudeModelIdsViaGateway(
  access: EngineGatewayAccess,
  timeoutMs: number,
  deps: Partial<ClaudeGatewayModelsDeps> = {},
): Promise<string[]> {
  const { fetch } = { ...DEFAULT_DEPS, ...deps };
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number;
  let body: unknown;
  try {
    const res = await fetch(
      `${access.baseUrl}/anthropic/v1/models?limit=1000`,
      {
        headers: {
          Authorization: `Bearer ${access.leaseToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal,
      },
    );
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (err) {
    // The signal is the timeout's alone, whatever error a runtime raises.
    if (signal.aborted) throw new Error(CLAUDE_MODELS_TIMEOUT_TEXT);
    throw err instanceof Error ? err : new Error(String(err));
  }
  const refusal = gatewayRefusalText(body);
  if (refusal !== undefined) throw new Error(refusal);
  if (status < 200 || status > 299) throw new Error(modelsFailureText(status));
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new Error(CLAUDE_MODELS_MALFORMED_TEXT);
  const { data, has_more: hasMore } = body as {
    data?: unknown;
    has_more?: unknown;
  };
  if (!Array.isArray(data)) throw new Error(CLAUDE_MODELS_MALFORMED_TEXT);
  if (hasMore === true) throw new Error(CLAUDE_MODELS_INCOMPLETE_TEXT);
  return data.flatMap((entry: unknown) => {
    const id =
      entry !== null && typeof entry === "object"
        ? (entry as { id?: unknown }).id
        : undefined;
    return typeof id === "string" ? [id] : [];
  });
}
