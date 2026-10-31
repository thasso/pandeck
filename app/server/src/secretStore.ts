/**
 * The secret store: a secret is read only for the destination it may be sent
 * to, and the store, not the caller or a settings file, holds that
 * destination (`docs/workers.md` §"Isolation boundary and secrets"). A read
 * for any other origin is refused before the secret is loaded.
 *
 * Phase 1 has the server-host implementation: the secret stays in its file
 * under `DATA_DIR`, as the server's own account. Phase 3 moves storage and
 * widens {@link SecretId}; a platform key store (phase 6) is another
 * implementation, which is why reads are asynchronous.
 */
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";
import { sameOrigin } from "./urlOrigin.ts";

export type SecretId = "context7.apiKey";

export interface SecretStore {
  /**
   * The secret, or `undefined` when none is set. Rejects with
   * {@link SecretDestinationError} unless `destination` has the secret's
   * stored origin.
   */
  read(id: SecretId, destination: string | URL): Promise<string | undefined>;
}

/** A secret was read for a destination it may not be sent to. */
export class SecretDestinationError extends Error {
  constructor(id: SecretId, allowed: string, destination: string | URL) {
    super(
      `The secret ${id} may be sent only to ${allowed}, not to ${originOf(destination)}.`,
    );
    this.name = "SecretDestinationError";
  }
}

/** Only the origin: a destination's path or query is not the store's to echo. */
function originOf(destination: string | URL): string {
  try {
    return new URL(destination).origin;
  } catch {
    return "an unparsable URL";
  }
}

interface StoredSecret {
  origin: string;
  load(): string | undefined;
}

/** A trimmed key; a blank one counts as absent. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// `context7Settings.ts` writes this file and imports this store, so the path
// is named here too rather than imported back.
const context7File = createPrivateJsonFile(
  join(DATA_DIR, "settings", "context7.json"),
  "Context7 config",
);

const SECRETS: Record<SecretId, StoredSecret> = {
  "context7.apiKey": {
    origin: "https://context7.com",
    load: () =>
      context7File.read((parsed: { apiKey?: unknown } | undefined) =>
        nonBlank(parsed?.apiKey),
      ),
  },
};

/** The secrets in their files under `DATA_DIR`, read as the server's account. */
const serverHostSecretStore: SecretStore = {
  async read(id, destination) {
    const secret = SECRETS[id];
    if (!sameOrigin(secret.origin, String(destination)))
      throw new SecretDestinationError(id, secret.origin, destination);
    return secret.load();
  },
};

/** The store this server reads its secrets from. */
export const secretStore: SecretStore = serverHostSecretStore;
