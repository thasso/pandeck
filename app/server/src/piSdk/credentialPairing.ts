/**
 * A per-request guard on a pi runtime's `getAuth`: a provider's credential
 * goes only to a model whose `baseUrl` it is paired with.
 *
 * pi sends a request to the model object's own `baseUrl` with the key its
 * runtime holds for that provider now. A model object held across a settings
 * change, by an open session or a one-shot, would carry the new key to the
 * old URL. The guard answers no auth instead, and pi refuses the request
 * before it connects ("Provider is not configured").
 *
 * The leased engine's port pairs exactly with the gateway's bases
 * (`gatewayPiModelPort.ts`); the server's own runtimes pair the
 * OpenAI-compatible key with its endpoint's origin
 * (`serverCredentialPairing.ts`). This module imports no settings, so the
 * leased port does not either.
 */
import type {
  ModelRuntime,
  ModelRuntimeAuthOverrides,
} from "@earendil-works/pi-coding-agent";
import type { PiEngineModel } from "./piEngine.ts";

/** What a provider's credential is paired with right now. */
export interface CredentialPairing {
  /** Whether a request to this base URL may carry the credential. */
  admits(baseUrl: string): boolean;
  /**
   * When present, the resolution is refused unless a second lookup after it
   * answers an equal stamp. Absent: the resolution is pi's for the
   * registration read with it.
   */
  readonly stamp?: unknown;
}

/**
 * Guard `runtime.getAuth` with `pairingFor`, which answers a provider's
 * pairing: `null` leaves the provider as pi resolves it, `undefined` gives no
 * auth.
 *
 * The lookup and the start of pi's own resolution happen in one synchronous
 * step. pi 1.5.0 captures the provider and its configured key in that same
 * step (`model-runtime.js` `getAuth`, pi-ai `models.js` `getAuth`), so the
 * pairing checked is the registration whose key is resolved, whatever is
 * registered while it resolves.
 */
export function guardCredentialPairing(
  runtime: ModelRuntime,
  pairingFor: (provider: string) => CredentialPairing | undefined | null,
): void {
  const getAuth = runtime.getAuth.bind(runtime) as (
    providerOrModel: string | PiEngineModel,
    overrides?: ModelRuntimeAuthOverrides,
  ) => ReturnType<ModelRuntime["getAuth"]>;
  runtime.getAuth = (async (
    providerOrModel: string | PiEngineModel,
    overrides?: ModelRuntimeAuthOverrides,
  ) => {
    if (typeof providerOrModel === "string")
      return getAuth(providerOrModel, overrides);
    const { provider, baseUrl } = providerOrModel;
    const pairing = pairingFor(provider);
    // Any other provider resolves as pi resolves it today.
    if (pairing === null) return getAuth(providerOrModel, overrides);
    if (pairing === undefined || !pairing.admits(baseUrl)) return undefined;
    const resolution = await getAuth(providerOrModel, overrides);
    // The registration may have changed while the key was resolved.
    if ("stamp" in pairing && pairingFor(provider)?.stamp !== pairing.stamp)
      return undefined;
    const authBase = resolution?.auth.baseUrl;
    if (authBase && !pairing.admits(authBase)) return undefined;
    return resolution;
  }) as ModelRuntime["getAuth"];
}
