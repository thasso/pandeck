/**
 * The OpenAI-compatible provider's configuration as leased pi engines follow
 * it ({@link CompatProviderFeed}): what the settings hold now, and a
 * notification after every write. The composition root calls
 * {@link notifyCompatProviderChanged} from the model-provider sync that each
 * OpenAI-compatible settings write and discovery runs (`index.ts`).
 *
 * Key-less: the key travels only server → gateway (`gatewayLink.ts`), so a key
 * rotation notifies with an unchanged value.
 */
import { getOpenAiCompatibleProviderConfigForRegistry } from "../openAiCompatibleSettings.ts";
import type { CompatProviderFeed } from "./gatewayPiModelPort.ts";

const listeners = new Set<() => void>();

export const compatProviderFeed: CompatProviderFeed = {
  current() {
    const config = getOpenAiCompatibleProviderConfigForRegistry();
    if (!config) return undefined;
    const { apiKey: _key, ...engineConfig } = config;
    return engineConfig;
  },
  subscribe(listener) {
    // Wrapped, so subscribing one function twice needs two unsubscribes.
    const entry = () => listener();
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
    };
  },
};

/** Tells every subscriber the configuration may have changed. */
export function notifyCompatProviderChanged(): void {
  for (const listener of [...listeners]) listener();
}
