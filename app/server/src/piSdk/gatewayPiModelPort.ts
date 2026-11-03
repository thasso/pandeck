/**
 * A leased pi engine's model port (`docs/workers.md` "pi engines use the
 * lease"): one in-memory pi runtime per engine open, holding only the
 * engine's lease, so every `openai-codex` request goes to the credential
 * gateway and nothing is written to disk or fetched from a catalog.
 *
 * pi sends a request to the model object's own `baseUrl` and adds the key
 * its runtime holds for that provider. So every Codex model this port hands
 * out is rebased onto the gateway, and the runtime's `getAuth` is guarded per
 * request: a credential is paired only with the `baseUrl` of the
 * configuration it belongs to. Any other object, such as a catalog model
 * still at `chatgpt.com`, or an OpenAI-compatible model from an endpoint the
 * settings have since replaced, gets no auth, and pi refuses it before it
 * connects ("Provider is not configured").
 *
 * The OpenAI-compatible provider still goes direct, with the configured key,
 * until the gateway carries that key too (G3b-2). Its configuration arrives
 * through an injected {@link CompatProviderFeed}; the catalog through the
 * server's own port. This module imports neither.
 */
import {
  ModelRegistry,
  ModelRuntime,
  type ModelRuntimeAuthOverrides,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import type { EngineGatewayAccess } from "../workerProtocol/engineMethods.ts";
import type { PiEngineModel } from "./piEngine.ts";
import type { PiModelPort } from "./piEngineHost.ts";

const CODEX_PROVIDER_ID = "openai-codex";

/** The OpenAI-compatible provider as pi's registry takes it. */
export type CompatProviderConfig = Parameters<
  ModelRegistry["registerProvider"]
>[1] & { baseUrl: string };

/** The OpenAI-compatible configuration and its changes, as the server has them. */
export interface CompatProviderFeed {
  /** The configuration to register now; undefined when there is none. */
  current(): CompatProviderConfig | undefined;
  /** Calls `listener` after every settings change; answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export type GatewayPiModelPort = PiModelPort & {
  readonly routing: "gateway";
  /** Ends the feed subscription; idempotent. */
  dispose(): void;
};

export function gatewayPiModelPort(
  access: EngineGatewayAccess,
  deps: { server: PiModelPort; compat: CompatProviderFeed },
): GatewayPiModelPort {
  const codexBase = `${access.baseUrl}/chatgpt/backend-api`;
  /** The registered compatible `baseUrl`, and which registration it was. */
  let compatBase: string | undefined;
  let compatGeneration = 0;
  let compatSignature: string | undefined;
  let registry: ModelRegistry | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const syncCompat = (into: ModelRegistry): void => {
    const config = deps.compat.current();
    const signature = config ? JSON.stringify(config) : "disabled";
    if (signature === compatSignature) return;
    if (config) {
      into.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, config);
      compatBase = config.baseUrl;
    } else {
      if (compatSignature !== undefined)
        into.unregisterProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
      compatBase = undefined;
    }
    compatSignature = signature;
    compatGeneration += 1;
  };

  /** Auth only for a model at the base its credential was configured for. */
  const guard = (runtime: ModelRuntime): void => {
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
      const generation = compatGeneration;
      const expected =
        provider === CODEX_PROVIDER_ID
          ? codexBase
          : provider === OPENAI_COMPATIBLE_PROVIDER_ID
            ? compatBase
            : null;
      // Any other provider resolves as pi resolves it today.
      if (expected === null) return getAuth(providerOrModel, overrides);
      if (expected === undefined || baseUrl !== expected) return undefined;
      const resolution = await getAuth(providerOrModel, overrides);
      // The registration may have changed while the key was resolved.
      if (generation !== compatGeneration) return undefined;
      const authBase = resolution?.auth.baseUrl;
      if (authBase && authBase !== expected) return undefined;
      return resolution;
    }) as ModelRuntime["getAuth"];
  };

  const created = (async () => {
    // In memory only: no auth.json, models.json or models-store.json, and no
    // catalog refresh, so no network.
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    guard(runtime);
    const into = new ModelRegistry(runtime);
    into.registerProvider(CODEX_PROVIDER_ID, {
      baseUrl: codexBase,
      apiKey: access.leaseToken,
    });
    syncCompat(into);
    if (!disposed) unsubscribe = deps.compat.subscribe(() => syncCompat(into));
    registry = into;
    return runtime;
  })();
  // A rejection reaches whoever awaits the runtime, not the process.
  created.catch(() => {});

  /** A Codex catalog model on the gateway, else the gateway's built-in. */
  const rebased = (
    model: PiEngineModel | undefined,
    id: string,
    from: ModelRegistry | undefined,
  ): PiEngineModel | undefined =>
    model
      ? { ...model, baseUrl: codexBase }
      : from?.find(CODEX_PROVIDER_ID, id);

  return {
    routing: "gateway",
    runtime: () => created,
    async findForProfile(profileId, provider, id) {
      if (provider === CODEX_PROVIDER_ID) {
        const model = await deps.server.findForProfile(profileId, provider, id);
        await created;
        return rebased(model, id, registry);
      }
      if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
      await created;
      return registry?.find(provider, id);
    },
    find(provider, id) {
      if (provider === CODEX_PROVIDER_ID)
        return rebased(deps.server.find(provider, id), id, registry);
      if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) return undefined;
      return registry?.find(provider, id);
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
