/**
 * The edge's user-scoped operations (Task-1402 B2, M12): one implementation
 * behind both renderers. Gateway client 1.0's account and login methods
 * (`clientListener.ts`) and the gateway page's routes (`gatewayWeb/`, through
 * `gatewayEdge.ts`) both call it, with the user and the actor taken from the
 * caller's certificate or session, never from a request.
 *
 * This is the only place that turns a user id into registry, profile and
 * vault calls for accounts, logins and integration credentials; further user
 * operations are added here, not as a second path. Account and login
 * refusals are `LoginRefusal`s with the client protocol's codes; the others
 * are `UserOperationRefusal`s, whose codes carry no request or upstream text.
 */
import {
  UNKNOWN_ACCOUNT,
  type ClientAccount,
  type IntegrationFailure,
} from "./clientMethods.ts";
import type { EdgeTools, IntegrationCheck } from "./edgeTools.ts";
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
import type { IntegrationWrite, VaultPort } from "./vaultPort.ts";

/** An account of a user, as logins and tests create it. */
export type UserAccountRecord = LoginProfile & { userId: string };

/** A refused user operation: a fixed code, never request or upstream text. */
export class UserOperationRefusal extends Error {
  constructor(readonly code: IntegrationFailure) {
    super(code);
  }
}

/** What Atlassian said about a credential that works. */
interface AtlassianIdentity {
  displayName?: string;
  accountId?: string;
}

/** A credential stored and checked: site and email, never the token. */
export type AtlassianSet = {
  connected: true;
  site: string;
  email: string;
} & AtlassianIdentity;

/** Why a stored credential is not usable now. */
type AtlassianProblem =
  | "vault_locked"
  | "vault_unavailable"
  | "invalid"
  | Extract<IntegrationCheck, { ok: false }>["problem"];

export type AtlassianStatus =
  | AtlassianSet
  | {
      connected: false;
      site?: string;
      email?: string;
      problem?: AtlassianProblem;
    };

interface UserOperationsDeps {
  vault: Pick<
    VaultPort,
    | "login"
    | "newTokenFile"
    | "discardCredential"
    | "integrationPut"
    | "integrationGet"
    | "integrationClear"
  >;
  /** The edge's integration tools, if it runs any. */
  integrations(): EdgeTools["integrations"] | undefined;
  /** A fresh deadline for one Atlassian check, created as the check starts. */
  checkSignal(): AbortSignal;
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
  /**
   * The user's Atlassian credential: site and email when stored and
   * readable; with `check`, whether Atlassian accepts it, a failed check
   * being an answer, not a refusal.
   */
  atlassianStatus(
    userId: string,
    options: { check: boolean },
  ): Promise<AtlassianStatus>;
  /** Checks the credential with Atlassian, then stores it for the user. */
  setAtlassian(userId: string, input: unknown): Promise<AtlassianSet>;
  clearAtlassian(userId: string): Promise<void>;
  close(): void;
}

/** The check's own details, only those it gave. */
const identityOf = (checked: AtlassianIdentity): AtlassianIdentity => ({
  ...(checked.displayName !== undefined
    ? { displayName: checked.displayName }
    : {}),
  ...(checked.accountId !== undefined ? { accountId: checked.accountId } : {}),
});

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

  /** The Atlassian tools, or the fixed refusal. */
  const atlassian = (): EdgeTools["integrations"]["atlassian"] => {
    const tools = deps.integrations();
    if (!tools) throw new UserOperationRefusal("tools_unavailable");
    return tools.atlassian;
  };
  const wrote = (outcome: IntegrationWrite): void => {
    if (outcome.ok) return;
    throw new UserOperationRefusal(
      "locked" in outcome ? "vault_locked" : "vault_unavailable",
    );
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
      // Only a token file the vault made for the account goes with it, after
      // any ingest already in the vault's writer lane.
      void Promise.resolve(deps.vault.discardCredential(profile.id)).catch(() =>
        deps.log(`account ${profile.id}: discard failed`),
      );
    },
    startLogin: (actor, start) => logins.start(actor, start),
    inputLogin: (actor, loginId, text) => logins.input(actor, loginId, text),
    cancelLogin: (actor, loginId) => logins.cancel(actor, loginId),
    readLogin: (actor, loginId, cursor) => logins.read(actor, loginId, cursor),
    endActor: (actor) => logins.endActor(actor),
    async atlassianStatus(userId, { check }) {
      const tools = atlassian();
      const record = await deps.vault.integrationGet(userId, "atlassian", {});
      if (!record.ok)
        return "absent" in record
          ? { connected: false }
          : {
              connected: false,
              problem:
                "locked" in record ? "vault_locked" : "vault_unavailable",
            };
      const described = tools.describe(record.credential);
      if (!described) return { connected: false, problem: "invalid" };
      if (!check) return { connected: true, ...described };
      // The deadline starts here, at the check, not before the read.
      const checked = await tools.check(record.credential, deps.checkSignal());
      return checked.ok
        ? { connected: true, ...described, ...identityOf(checked) }
        : { connected: false, ...described, problem: checked.problem };
    },
    async setAtlassian(userId, input) {
      const tools = atlassian();
      const parsed = tools.parse(input);
      if (!parsed.ok) throw new UserOperationRefusal("integration_invalid");
      const checked = await tools.check(parsed.credential, deps.checkSignal());
      if (!checked.ok)
        throw new UserOperationRefusal(
          checked.problem === "rejected"
            ? "integration_rejected"
            : "integration_unreachable",
        );
      wrote(
        await deps.vault.integrationPut(userId, "atlassian", parsed.credential),
      );
      return {
        connected: true,
        site: parsed.site,
        email: parsed.email,
        ...identityOf(checked),
      };
    },
    async clearAtlassian(userId) {
      atlassian();
      wrote(await deps.vault.integrationClear(userId, "atlassian"));
    },
    close: () => logins.close(),
  };
}
