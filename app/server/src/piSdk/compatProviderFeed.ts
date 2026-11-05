/**
 * The OpenAI-compatible provider's configuration as leased pi engines follow
 * it ({@link CompatProviderFeed}). Until the gateway serves each
 * OpenAI-compatible account (Task-1373's second PR, `docs/workers.md`), a
 * compatible account never gets a lease, so the feed holds nothing and never
 * changes: leased OpenAI engines register no compatible provider.
 */
import type { CompatProviderFeed } from "./gatewayPiModelPort.ts";

export const compatProviderFeed: CompatProviderFeed = {
  current: () => undefined,
  subscribe: () => () => {},
};
