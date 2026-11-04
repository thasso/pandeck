/**
 * The credential guard on the server's own pi runtimes (`models.ts`): the
 * ones engines with the gateway switch off run on, and every one-shot under
 * either switch (`docs/workers.md`).
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import { OPENAI_COMPATIBLE_KEYLESS } from "../openAiCompatibleSettings.ts";
import { sameOrigin } from "../urlOrigin.ts";
import { guardCredentialPairing } from "./credentialPairing.ts";

/**
 * The OpenAI-compatible key goes only to its endpoint's origin. A path change
 * on the same origin keeps it, as the settings do (`docs/settings.md`); a
 * key-less endpoint pairs no credential, so nothing is refused. Every other
 * provider is untouched.
 */
export function guardServerRuntime(runtime: ModelRuntime): ModelRuntime {
  guardCredentialPairing(runtime, (provider) => {
    if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return null;
    const config = runtime.getRegisteredProviderConfig(provider);
    const base = config?.baseUrl;
    if (!base) return undefined;
    if (config.apiKey === OPENAI_COMPATIBLE_KEYLESS)
      return { admits: () => true };
    return { admits: (baseUrl) => sameOrigin(baseUrl, base) };
  });
  return runtime;
}
