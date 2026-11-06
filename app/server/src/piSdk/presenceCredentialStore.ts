/**
 * The credential store of the server's own pi runtimes while the gateway is
 * on (`models.ts`, `docs/workers.md` "Credentials"): it answers only which
 * providers have a credential, never the credential.
 *
 * pi refreshes an expired OAuth credential it reads from its store, and
 * writes the result back. With the gateway the only refresher, a server
 * runtime must never see a real expiry or token, so every OAuth entry reads as
 * a placeholder that never expires and every key entry as a placeholder key.
 * Availability, which checks presence only, is kept; the placeholder never
 * reaches a request, because `serverCredentialPairing.ts` gives Codex models
 * no auth.
 *
 * The file is parsed on every call, so a login or renewal is seen at the next
 * read, and only each entry's `type` is read. A missing or unreadable file
 * reads as empty and is never created. Every write rejects: the login
 * runtime, which keeps pi's file store, is the server's only writer.
 */
import { readFileSync } from "node:fs";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/** What every placeholder field holds. */
const PLACEHOLDER = "gateway-served";

/** Each provider's credential type, as the file has it now. */
function readTypes(authPath: string): Map<string, Credential["type"]> {
  const types = new Map<string, Credential["type"]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return types;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return types;
  for (const [providerId, entry] of Object.entries(parsed)) {
    const type = (entry as { type?: unknown } | null)?.type;
    if (type === "oauth" || type === "api_key") types.set(providerId, type);
  }
  return types;
}

export class PresenceCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string) {}

  read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const type = readTypes(this.authPath).get(providerId);
    if (type === "oauth")
      return Promise.resolve({
        type: "oauth",
        access: PLACEHOLDER,
        refresh: PLACEHOLDER,
        expires: Number.MAX_SAFE_INTEGER,
      });
    if (type === "api_key")
      return Promise.resolve({ type: "api_key", key: PLACEHOLDER });
    return Promise.resolve(undefined);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Promise.resolve(
      [...readTypes(this.authPath)].map(([providerId, type]) => ({
        providerId,
        type,
      })),
    );
  }

  modify(): Promise<Credential | undefined> {
    return Promise.reject(
      new Error("A server runtime never writes a credential."),
    );
  }

  delete(): Promise<void> {
    return Promise.reject(
      new Error("A server runtime never deletes a credential."),
    );
  }
}
