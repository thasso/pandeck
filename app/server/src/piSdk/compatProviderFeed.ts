/**
 * The OpenAI-compatible provider's configuration as leased pi engines follow
 * it ({@link CompatProviderFeed}): what the settings hold now, and a
 * notification after every write. The composition root calls
 * {@link notifyCompatProviderChanged} from the model-provider sync that each
 * OpenAI-compatible settings write and discovery runs (`index.ts`).
 */
import { getOpenAiCompatibleProviderConfigForRegistry } from "../openAiCompatibleSettings.ts";
import type { CompatProviderFeed } from "./gatewayPiModelPort.ts";

const listeners = new Set<() => void>();

export const compatProviderFeed: CompatProviderFeed = {
  current: () => getOpenAiCompatibleProviderConfigForRegistry(),
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
