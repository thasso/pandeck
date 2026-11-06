/**
 * The credential guard on the server's own pi runtimes (`models.ts`): the
 * ones engines with the gateway switch off run on, and every one-shot under
 * either switch (`docs/workers.md`).
 *
 * With the gateway on, those runtimes hold only placeholders for a Codex login
 * (`presenceCredentialStore.ts`): a Codex model gets no auth, so pi refuses
 * before it connects and a placeholder never leaves the process. Leased runs
 * reach Codex through the gateway port instead.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isOpenAiCompatibleModelProvider } from "@assistant/shared";
import { GATEWAY_ENABLED } from "../config.ts";
import { OPENAI_COMPATIBLE_KEYLESS } from "../openAiCompatibleAccounts.ts";
import { sameOrigin } from "../urlOrigin.ts";
import { guardCredentialPairing } from "./credentialPairing.ts";

/**
 * An OpenAI-compatible account's key goes only to its own endpoint's origin.
 * A path change on the same origin keeps it, as the account does
 * (`docs/settings.md`); a key-less endpoint pairs no credential, so nothing is
 * refused. Every other provider is untouched, except Codex with the gateway on.
 */
export function guardServerRuntime(runtime: ModelRuntime): ModelRuntime {
  guardCredentialPairing(runtime, (provider) => {
    if (GATEWAY_ENABLED && provider === "openai-codex") return undefined;
    if (!isOpenAiCompatibleModelProvider(provider)) return null;
    const config = runtime.getRegisteredProviderConfig(provider);
    const base = config?.baseUrl;
    if (!base) return undefined;
    if (config.apiKey === OPENAI_COMPATIBLE_KEYLESS)
      return { admits: () => true };
    return { admits: (baseUrl) => sameOrigin(baseUrl, base) };
  });
  return runtime;
}
