/**
 * Session identity for the app-owned log. Our {@link SessionId} is primary and
 * stable for the session's whole life (including native-id changes / forks); the
 * native id is opaque, referenced only via the {@link ProviderBinding}.
 */

/** Branded string so our id can't be silently mixed with a native/provider id. */
export type SessionId = string & { readonly __sessionId: unique symbol };

export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

/**
 * The link from our session to the provider's native session. Updated on
 * fork/resume; never used as the application key. A deferred native id is stored
 * as the clearly-invalid sentinel `pending:<SessionId>` until the provider
 * assigns one.
 */
export interface ProviderBinding {
  provider: string;
  /** Native session id (pi session id / SDK providerSessionId), or a `pending:` sentinel. */
  nativeId?: string;
  /** Provider-native restore detail (e.g. pi session-file path + cwd), opaque to us. */
  providerMeta?: Record<string, unknown>;
}
