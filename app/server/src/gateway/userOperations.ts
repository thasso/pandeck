/**
 * The edge's user-scoped operations (Task-1402 B2, M12): one implementation
 * behind both renderers. Gateway client 1.0's account and login methods
 * (`clientListener.ts`) and the gateway page's routes (`gatewayWeb/`, through
 * `gatewayEdge.ts`) both call it, with the user and the actor taken from the
 * caller's certificate or session, never from a request.
 *
 * This is the only place that turns a user id into registry, profile and
 * vault calls for accounts and logins; further user operations are added
 * here, not as a second path. Refusals are `LoginRefusal`s with the client
 * protocol's codes.
 */
import { UNKNOWN_ACCOUNT, type ClientAccount } from "./clientMethods.ts";
import {
  createLoginManager,
  LoginRefusal,
  type LoginActor,
  type LoginEvent,
  type LoginStart,
  type LoginView,
} from "./logins.ts";
import {
  isLoginProfile,
  type LoginProfile,
  type ProfileRegistry,
} from "./profiles.ts";
import type { VaultPort } from "./vaultPort.ts";

/** An account of a user, as logins and tests create it. */
export type UserAccountRecord = LoginProfile & { userId: string };

interface UserOperationsDeps {
  vault: Pick<VaultPort, "login" | "newTokenFile" | "discardCredential">;
  profiles: Pick<ProfileRegistry, "get">;
  /** The registry's account ownership; either may throw when unavailable. */
  ownerOf(profileId: string): string | undefined;
  accountsOf(userId: string): string[];
  /** The profiles renewal found needing a login. */
  needsLogin(): string[];
  /** Adds or replaces a user's account and tells its clients. */
  putAccount(account: UserAccountRecord): void;
  /** Removes an account, revokes its leases and tells its clients. */
  removeAccount(profileId: string): void;
  /** A login event for a client actor's connections. */
  send(
    actor: LoginActor,
    loginId: string,
    accountId: string,
    event: LoginEvent,
  ): void;
  log(line: string): void;
  /** Test seam: a shorter successor wait (`logins.ts`). */
  successorWaitMs?: number;
}

export interface UserOperations {
  /** The user's Claude and Codex accounts. */
  accounts(userId: string): ClientAccount[];
  /**
   * Removes the user's account: its login, profile, ownership and leases,
   * and a token file the vault made for it.
   */
  removeAccount(userId: string, accountId: string): void;
  startLogin(
    actor: LoginActor,
    start: LoginStart,
  ): { loginId: string; accountId: string };
  inputLogin(actor: LoginActor, loginId: string, text: string): void;
  cancelLogin(actor: LoginActor, loginId: string): void;
  readLogin(actor: LoginActor, loginId: string, cursor: number): LoginView;
  /** The actor ended (revoked, signed out, expired): its logins cancelled. */
  endActor(actor: Pick<LoginActor, "kind" | "id">): void;
  close(): void;
}

export function createUserOperations(deps: UserOperationsDeps): UserOperations {
  const { profiles } = deps;
  const logins = createLoginManager({
    vault: deps.vault,
    profiles,
    ownerOf: deps.ownerOf,
    putAccount: deps.putAccount,
    removeAccount: deps.removeAccount,
    send: deps.send,
    log: deps.log,
    ...(deps.successorWaitMs !== undefined
      ? { successorWaitMs: deps.successorWaitMs }
      : {}),
  });

  /** The user's login account by id, or the unknown-account refusal. */
  const ownedAccount = (userId: string, accountId: string): LoginProfile => {
    const profile = profiles.get(accountId);
    if (
      !profile ||
      !isLoginProfile(profile) ||
      deps.ownerOf(accountId) !== userId
    )
      throw new LoginRefusal(
        UNKNOWN_ACCOUNT,
        "The gateway holds no such account for this user.",
      );
    return profile;
  };

  return {
    accounts(userId) {
      const needing = new Set(deps.needsLogin());
      for (const id of logins.pendingAccounts()) needing.add(id);
      return deps.accountsOf(userId).flatMap((id): ClientAccount[] => {
        const profile = profiles.get(id);
        return profile && isLoginProfile(profile)
          ? [
              {
                id,
                provider: profile.provider,
                name: profile.name,
                enabled: profile.enabled,
                needsLogin: needing.has(id),
              },
            ]
          : [];
      });
    },
    removeAccount(userId, accountId) {
      const profile = ownedAccount(userId, accountId);
      logins.forget(profile.id);
      deps.removeAccount(profile.id);
      // Only a token file the vault made for the account goes with it.
      deps.vault.discardCredential(profile.id);
    },
    startLogin: (actor, start) => logins.start(actor, start),
    inputLogin: (actor, loginId, text) => logins.input(actor, loginId, text),
    cancelLogin: (actor, loginId) => logins.cancel(actor, loginId),
    readLogin: (actor, loginId, cursor) => logins.read(actor, loginId, cursor),
    endActor: (actor) => logins.endActor(actor),
    close: () => logins.close(),
  };
}
