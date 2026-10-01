/**
 * The mutable model/reasoning selection for a session, plus the provider's
 * available-model catalog. Served alongside the timeline by the runtime; the
 * catalog travels only on the initial config, not on change events.
 */

export interface SessionConfigModel {
  provider: string;
  id: string;
}

export interface SessionConfig {
  model?: SessionConfigModel;
  /** Reasoning/thinking level id (provider-neutral string, e.g. "off".."xhigh"). */
  reasoning?: string;
  /** Available models for the picker (initial config only). */
  availableModels?: SessionConfigModel[];
}
