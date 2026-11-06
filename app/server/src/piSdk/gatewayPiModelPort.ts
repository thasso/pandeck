/**
 * A leased pi engine's model port (`docs/workers.md` "pi engines use the
 * lease"): one in-memory pi runtime per engine open, holding only the
 * engine's lease, so every request goes to the credential gateway and
 * nothing is written to disk or fetched from a catalog.
 *
 * A port serves exactly one account, the one its lease is for, and its kind
 * follows from the account's id. An OpenAI account's port registers only
 * Codex, and every Codex model it hands out is rebased onto the gateway's
 * `/chatgpt`. An OpenAI-compatible account's port registers only that
 * account's own provider, under its id, at the gateway's `/compat<base path>`
 * with the lease as its key: the gateway adds that account's own key. Neither
 * finds or offers a model of another account or kind.
 *
 * pi sends a request to the model object's own `baseUrl` and adds the key its
 * runtime holds for that provider. The runtime's `getAuth` is guarded per
 * request (`credentialPairing.ts`): a credential is paired only with the
 * exact `baseUrl` of the configuration it belongs to. Any other object, such
 * as a catalog model still at `chatgpt.com`, a built-in model, or an
 * OpenAI-compatible model from a base path the settings have since replaced,
 * gets no auth, and pi refuses it before it connects ("Provider is not
 * configured"). A change of origin under the same base path keeps the
 * registration: the gateway follows the push. A base URL the gateway would
 * refuse structurally registers nothing, so the account offers no model.
 *
 * The OpenAI-compatible configuration arrives key-less through an injected
 * {@link CompatProviderFeed}; the catalog through the server's own port. This
 * module imports neither.
 */
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  isOpenAiCompatibleModelProvider,
  piAccountServesModel,
} from "@assistant/shared";
import type { EngineGatewayAccess } from "../workerProtocol/engineMethods.ts";
import {
  guardCredentialPairing,
  type CredentialPairing,
} from "./credentialPairing.ts";
import type { PiEngineModel } from "./piEngine.ts";
import type { PiModelPort } from "./piEngineHost.ts";

const CODEX_PROVIDER_ID = "openai-codex";

/** The OpenAI-compatible provider as pi's registry takes it. */
type CompatProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1] & {
  baseUrl: string;
};

/**
 * The OpenAI-compatible provider as an engine sees it: no key, which only
 * the gateway holds. `apiKey` cannot be set, so no caller adds one unnoticed.
 */
export type EngineCompatConfig = Omit<CompatProviderConfig, "apiKey"> & {
  apiKey?: never;
};

/** Each OpenAI-compatible account's configuration and its changes, as the server has them. */
export interface CompatProviderFeed {
  /**
   * The account's configuration to register now; undefined for an account
   * that is not OpenAI-compatible, not ready to run or cannot be read.
   */
  current(profileId: string): EngineCompatConfig | undefined;
  /**
   * Calls `listener` after every change of that account; answers the
   * unsubscribe.
   */
  subscribe(profileId: string, listener: () => void): () => void;
}

/**
 * The base URL's path as the gateway's `/compat` takes it, without trailing
 * slashes; undefined for one the gateway refuses (`gateway/compatUpstream.ts`).
 */
function compatBasePath(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url.pathname.replace(/\/+$/, "");
}

export type GatewayPiModelPort = PiModelPort & {
  readonly routing: "gateway";
  /** Ends the feed subscription; idempotent. */
  dispose(): void;
};

export function gatewayPiModelPort(
  access: EngineGatewayAccess,
  /** The account the lease is for: the only one this port serves. */
  profileId: string,
  deps: { server: PiModelPort; compat: CompatProviderFeed },
): GatewayPiModelPort {
  const compatible = isOpenAiCompatibleModelProvider(profileId);
  const codexBase = `${access.baseUrl}/chatgpt/backend-api`;
  /** The registered compatible `baseUrl`, and which registration it was. */
  let compatBase: string | undefined;
  let compatGeneration = 0;
  let compatSignature: string | undefined;
  let registry: ModelRegistry | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const syncCompat = (into: ModelRegistry): void => {
    const config = deps.compat.current(profileId);
    const basePath = config && compatBasePath(config.baseUrl);
    // On the gateway: a new origin at the same base path keeps the signature.
    const registered =
      config && basePath !== undefined
        ? { ...config, baseUrl: `${access.baseUrl}/compat${basePath}` }
        : undefined;
    const signature = registered ? JSON.stringify(registered) : "disabled";
    if (signature === compatSignature) return;
    if (registered) {
      into.registerProvider(profileId, {
        ...registered,
        apiKey: access.leaseToken,
      });
      compatBase = registered.baseUrl;
    } else {
      if (compatSignature !== undefined) into.unregisterProvider(profileId);
      compatBase = undefined;
    }
    compatSignature = signature;
    compatGeneration += 1;
  };

  /**
   * Auth only for a model of this port's own provider, at the base its
   * credential was configured for, and only if the registration did not
   * change while the key was resolved.
   */
  const pairingFor = (
    provider: string,
  ): CredentialPairing | undefined | null => {
    const expected = compatible
      ? provider === profileId
        ? compatBase
        : undefined
      : provider === CODEX_PROVIDER_ID
        ? codexBase
        : isOpenAiCompatibleModelProvider(provider)
          ? undefined
          : null;
    if (expected === null || expected === undefined) return expected;
    return {
      admits: (baseUrl) => baseUrl === expected,
      stamp: compatGeneration,
    };
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
    guardCredentialPairing(runtime, pairingFor);
    const into = new ModelRegistry(runtime);
    if (compatible) {
      syncCompat(into);
      if (!disposed)
        unsubscribe = deps.compat.subscribe(profileId, () => syncCompat(into));
    } else
      into.registerProvider(CODEX_PROVIDER_ID, {
        baseUrl: codexBase,
        apiKey: access.leaseToken,
      });
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
    async findForProfile(id, provider, modelId) {
      // Only this port's own account, and only a model that account serves.
      if (id !== profileId || !piAccountServesModel(profileId, provider))
        return undefined;
      if (compatible) {
        await created;
        return registry?.find(provider, modelId);
      }
      if (provider !== CODEX_PROVIDER_ID) return undefined;
      const model = await deps.server.findForProfile(id, provider, modelId);
      await created;
      return rebased(model, modelId, registry);
    },
    // A start model is chosen here only for a compatible account
    // (`piEngineHost.ts`): its own provider's models, nothing built in.
    async availableForProfile(id) {
      if (!compatible || id !== profileId) return [];
      await created;
      return (registry?.getAvailable() ?? []).filter(
        (model) => model.provider === profileId,
      );
    },
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
