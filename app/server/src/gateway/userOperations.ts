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
import {
  ENROLLMENT_CODE_TTL_MS,
  EnrollmentLimitError,
  type ClientRegistry,
  type EnrollmentKind,
  type EnrollmentLimits,
  type GatewayClient,
} from "./clientRegistry.ts";
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
import type {
  Integration,
  IntegrationConnect,
  IntegrationWrite,
  VaultPort,
} from "./vaultPort.ts";

/** An account of a user, as logins and tests create it. */
export type UserAccountRecord = LoginProfile & { userId: string };

/** A refused user operation: a fixed code, never request or upstream text. */
export class UserOperationRefusal extends Error {
  constructor(
    readonly code:
      | IntegrationFailure
      | AtlassianConnectFailure
      | SlackConnectFailure
      | "unknown_client"
      | "limit_reached"
      | "unknown_request",
  ) {
    super(code);
  }
}

/**
 * The bounds on codes the page issues (the admin CLI's are unbounded): four
 * unused codes, and sixteen active clients counting those codes. An approved
 * enrollment request not yet collected counts as an unused code, both where
 * a code is issued and where a request is approved (Task-1410).
 */
export const PAGE_ENROLLMENT_LIMITS: EnrollmentLimits = {
  maxPendingCodes: 4,
  maxClients: 16,
};

/** One of the user's active clients; whether it has an MCP token, not it. */
interface UserClient {
  id: string;
  label: string;
  createdAt: number;
  mcpToken: boolean;
}

/** What the page shows of a machine's pending enrollment request. */
interface PendingEnrollment {
  name: string;
  kind: EnrollmentKind;
  from: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * A connect's refusals that only the page's callback sees (`gateway-client`
 * has no connect method), beside the shared vault and busy codes.
 */
type AtlassianConnectFailure =
  | "integration_site_missing"
  | "integration_site_ambiguous"
  | "integration_not_configured";

/**
 * A Slack connect's refusals that only the page's callback sees (Task-1453):
 * the vault's `team: "mismatch"`, or a vault without Slack's OAuth client.
 */
type SlackConnectFailure =
  "integration_team_mismatch" | "integration_not_configured";

/** How an Atlassian credential was made, or how a new one is made. */
type AtlassianKind = "token" | "oauth";

/**
 * On every status, set and connect answer: how this gateway makes a new
 * Atlassian connection, `oauth` with the `atlassianSignIn` start option.
 */
interface AtlassianConnectWith {
  connectWith: AtlassianKind;
}

/** What Atlassian said about a credential that works. */
interface AtlassianIdentity {
  displayName?: string;
  accountId?: string;
}

/** A credential stored and checked: site and email, never the token. */
type AtlassianSet = {
  connected: true;
  kind: "token";
  site: string;
  email: string;
} & AtlassianIdentity &
  AtlassianConnectWith;

/** An OAuth record the vault just stored from a connect (Task-1411). */
type AtlassianConnected = {
  connected: true;
  kind: "oauth";
  site: string;
} & AtlassianConnectWith;

/** Why a stored credential is not usable now. */
type AtlassianProblem =
  | "vault_locked"
  | "vault_unavailable"
  | "invalid"
  | Extract<IntegrationCheck, { ok: false }>["problem"];

/**
 * `kind` whenever a record was read, and `oauth` on a refused refresh (only
 * OAuth records refresh); `connectWith` always.
 */
export type AtlassianStatus =
  | AtlassianSet
  | AtlassianConnected
  /** A stored record as read: an OAuth one has its site, no email. */
  | ({
      connected: true;
      kind: AtlassianKind;
      site: string;
      email?: string;
    } & AtlassianIdentity &
      AtlassianConnectWith)
  | ({
      connected: false;
      kind?: AtlassianKind;
      site?: string;
      email?: string;
      problem?: AtlassianProblem;
    } & AtlassianConnectWith);

/** Why a stored Slack record is not usable now. */
type SlackProblem =
  "vault_locked" | "vault_unavailable" | "invalid" | "rejected";

/**
 * The user's Slack record (Task-1453): connected with the workspace's name
 * as the vault holds it, or not, with why a stored one cannot be used.
 */
export type SlackStatus =
  | { connected: true; teamName?: string }
  | { connected: false; problem?: SlackProblem };

interface UserOperationsDeps {
  vault: Pick<
    VaultPort,
    | "login"
    | "newTokenFile"
    | "discardCredential"
    | "integrationPut"
    | "integrationGet"
    | "integrationClear"
    | "integrationConnect"
  >;
  /**
   * The gateway page offers "Sign in with Atlassian" (the edge's UI config
   * names `atlassian.clientId`, Task-1411 D2): a new API token is refused
   * `integration_sign_in_required`; stored ones keep being read and used.
   */
  atlassianSignIn: boolean;
  /** The edge's integration tools, if it runs any. */
  integrations(): EdgeTools["integrations"] | undefined;
  /** A fresh deadline for one Atlassian check, created as the check starts. */
  checkSignal(): AbortSignal;
  registry: Pick<
    ClientRegistry,
    | "clients"
    | "createCode"
    | "revoke"
    | "setMcpToken"
    | "clearMcpToken"
    | "enrollmentRequest"
    | "decide"
  >;
  /**
   * A client was revoked: its connections end and its logins and leases go
   * now, not at the next poll.
   */
  clientRevoked(clientId: string): void;
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
  /**
   * Checks the credential with Atlassian, then stores it for the user. While
   * one set, clear or connect of the user runs, another is refused
   * `integration_busy`. With `atlassianSignIn` every set is refused
   * `integration_sign_in_required` before anything is read or checked.
   */
  setAtlassian(userId: string, input: unknown): Promise<AtlassianSet>;
  clearAtlassian(userId: string): Promise<void>;
  /**
   * Hands an authorization code from the page's Atlassian callback to the
   * vault, which exchanges it, picks the site and stores the user's OAuth
   * record (`VaultPort.integrationConnect`); one at a time with set and
   * clear. Answers the new record's status.
   */
  connectAtlassian(
    userId: string,
    request: { code: string; redirectUri: string; site?: string },
  ): Promise<AtlassianConnected>;
  /**
   * The user's Slack record as the vault reads it (a read may refresh it
   * there); never a token.
   */
  slackStatus(userId: string): Promise<SlackStatus>;
  /**
   * Hands an authorization code from the page's Slack callback to the vault,
   * which exchanges it, checks the workspace against `team` and stores the
   * user's record; one at a time with the user's Slack clear.
   */
  connectSlack(
    userId: string,
    request: { code: string; redirectUri: string; team?: string },
  ): Promise<{ connected: true; teamName?: string }>;
  clearSlack(userId: string): Promise<void>;
  /** The user's clients that are not revoked. */
  clients(userId: string): UserClient[];
  /**
   * A one-time code for the user's next client, within the page's limits
   * (`limit_reached`); the only time the code exists outside its hash.
   */
  createEnrollmentCode(
    userId: string,
    label: string,
  ): { code: string; validForSeconds: number };
  /**
   * The undecided, unexpired enrollment request with this user code, for the
   * user to decide (`unknown_request` otherwise). Read-only.
   */
  enrollmentRequest(userId: string, userCode: string): PendingEnrollment;
  /**
   * Approves the request for the user, within the page's limits
   * (`limit_reached`), or denies it; the first decision wins
   * (`unknown_request` for a decided, expired or unknown one).
   */
  decideEnrollment(userId: string, userCode: string, approve: boolean): void;
  /** Revokes the user's client (`unknown_client` if not theirs or active). */
  revokeClient(userId: string, clientId: string): void;
  /** Mints the client's MCP token, replacing any earlier one; shown once. */
  mintMcpToken(userId: string, clientId: string): string;
  /** Removes the client's MCP token, if it has one. */
  revokeMcpToken(userId: string, clientId: string): void;
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

  /** The user's active client by id, or the unknown-client refusal. */
  const ownedClient = (userId: string, clientId: string): GatewayClient => {
    const client = deps.registry
      .clients()
      .find((c) => c.id === clientId && c.userId === userId);
    if (!client || client.revokedAt !== undefined)
      throw new UserOperationRefusal("unknown_client");
    return client;
  };

  /** The Atlassian tools, or the fixed refusal. */
  const atlassian = (): EdgeTools["integrations"]["atlassian"] => {
    const tools = deps.integrations();
    if (!tools) throw new UserOperationRefusal("tools_unavailable");
    return tools.atlassian;
  };
  /** The Slack tools, or the fixed refusal. */
  const slack = (): EdgeTools["integrations"]["slack"] => {
    const tools = deps.integrations();
    if (!tools) throw new UserOperationRefusal("tools_unavailable");
    return tools.slack;
  };
  /**
   * Per integration, the users with a set, clear or connect of that record
   * running. One runs per user and integration at a time and another
   * meanwhile is refused `integration_busy` at once, so an earlier set's
   * check can never land its write after a later clear, and no request waits
   * for another. Reads are never refused; another integration's record is
   * another slot.
   */
  const writing: Record<Integration, Set<string>> = {
    atlassian: new Set(),
    slack: new Set(),
    github: new Set(),
  };
  const alone = async <T>(
    integration: Integration,
    userId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const users = writing[integration];
    if (users.has(userId)) throw new UserOperationRefusal("integration_busy");
    users.add(userId);
    try {
      return await run();
    } finally {
      users.delete(userId);
    }
  };
  const connectWith: AtlassianKind = deps.atlassianSignIn ? "oauth" : "token";
  /** A connect's refusal as its fixed code, every outcome named. */
  const connectRefusal = (
    outcome: Exclude<IntegrationConnect<"atlassian">, { ok: true }>,
  ): UserOperationRefusal =>
    new UserOperationRefusal(
      "rejected" in outcome
        ? "integration_rejected"
        : "unreachable" in outcome
          ? "integration_unreachable"
          : "site" in outcome
            ? outcome.site === "missing"
              ? "integration_site_missing"
              : "integration_site_ambiguous"
            : "notConfigured" in outcome
              ? "integration_not_configured"
              : "locked" in outcome
                ? "vault_locked"
                : "vault_unavailable",
    );
  /** A Slack connect's refusal as its fixed code, every outcome named. */
  const slackConnectRefusal = (
    outcome: Exclude<IntegrationConnect<"slack">, { ok: true }>,
  ): UserOperationRefusal =>
    new UserOperationRefusal(
      "rejected" in outcome
        ? "integration_rejected"
        : "unreachable" in outcome
          ? "integration_unreachable"
          : "team" in outcome
            ? "integration_team_mismatch"
            : "notConfigured" in outcome
              ? "integration_not_configured"
              : "locked" in outcome
                ? "vault_locked"
                : "vault_unavailable",
    );
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
      if (!record.ok) {
        if ("absent" in record) return { connected: false, connectWith };
        // The vault's refresh of an OAuth record was refused: reconnect.
        if ("rejected" in record)
          return {
            connected: false,
            kind: "oauth",
            problem: "rejected",
            connectWith,
          };
        return {
          connected: false,
          problem: "locked" in record ? "vault_locked" : "vault_unavailable",
          connectWith,
        };
      }
      const described = tools.describe(record.credential);
      if (!described)
        return { connected: false, problem: "invalid", connectWith };
      if (!check) return { connected: true, ...described, connectWith };
      // The deadline starts here, at the check, not before the read.
      const checked = await tools.check(record.credential, deps.checkSignal());
      return checked.ok
        ? { connected: true, ...described, ...identityOf(checked), connectWith }
        : {
            connected: false,
            ...described,
            problem: checked.problem,
            connectWith,
          };
    },
    async setAtlassian(userId, input) {
      // D2: where the page signs in with Atlassian, no new API token at all.
      if (deps.atlassianSignIn)
        throw new UserOperationRefusal("integration_sign_in_required");
      const tools = atlassian();
      const parsed = tools.parse(input);
      if (!parsed.ok) throw new UserOperationRefusal("integration_invalid");
      return alone("atlassian", userId, async (): Promise<AtlassianSet> => {
        const checked = await tools.check(
          parsed.credential,
          deps.checkSignal(),
        );
        if (!checked.ok)
          throw new UserOperationRefusal(
            checked.problem === "rejected"
              ? "integration_rejected"
              : "integration_unreachable",
          );
        wrote(
          await deps.vault.integrationPut(
            userId,
            "atlassian",
            parsed.credential,
          ),
        );
        return {
          connected: true,
          kind: "token",
          site: parsed.site,
          email: parsed.email,
          ...identityOf(checked),
          connectWith,
        };
      });
    },
    async clearAtlassian(userId) {
      atlassian();
      await alone("atlassian", userId, async () =>
        wrote(await deps.vault.integrationClear(userId, "atlassian")),
      );
    },
    async connectAtlassian(userId, { code, redirectUri, site }) {
      atlassian();
      return alone(
        "atlassian",
        userId,
        async (): Promise<AtlassianConnected> => {
          const outcome = await deps.vault.integrationConnect(
            userId,
            "atlassian",
            { code, redirectUri, ...(site !== undefined ? { site } : {}) },
          );
          if (!outcome.ok) throw connectRefusal(outcome);
          return {
            connected: true,
            kind: "oauth",
            site: outcome.site,
            connectWith,
          };
        },
      );
    },
    async slackStatus(userId) {
      const tools = slack();
      const record = await deps.vault.integrationGet(userId, "slack", {});
      if (!record.ok) {
        if ("absent" in record) return { connected: false };
        // The vault's refresh was refused: sign in with Slack again.
        if ("rejected" in record)
          return { connected: false, problem: "rejected" };
        return {
          connected: false,
          problem: "locked" in record ? "vault_locked" : "vault_unavailable",
        };
      }
      const described = tools.describe(record.credential);
      if (!described) return { connected: false, problem: "invalid" };
      return {
        connected: true,
        ...(described.teamName !== undefined
          ? { teamName: described.teamName }
          : {}),
      };
    },
    async connectSlack(userId, { code, redirectUri, team }) {
      slack();
      return alone("slack", userId, async () => {
        const outcome = await deps.vault.integrationConnect(userId, "slack", {
          code,
          redirectUri,
          ...(team !== undefined ? { team } : {}),
        });
        if (!outcome.ok) throw slackConnectRefusal(outcome);
        return {
          connected: true as const,
          ...(outcome.teamName !== undefined
            ? { teamName: outcome.teamName }
            : {}),
        };
      });
    },
    async clearSlack(userId) {
      slack();
      await alone("slack", userId, async () =>
        wrote(await deps.vault.integrationClear(userId, "slack")),
      );
    },
    clients: (userId) =>
      deps.registry
        .clients()
        .filter((c) => c.userId === userId && c.revokedAt === undefined)
        .map((c) => ({
          id: c.id,
          label: c.label,
          createdAt: c.createdAt,
          mcpToken: c.mcpTokenHash !== undefined,
        })),
    createEnrollmentCode(userId, label) {
      try {
        return {
          code: deps.registry.createCode(userId, label, PAGE_ENROLLMENT_LIMITS),
          validForSeconds: ENROLLMENT_CODE_TTL_MS / 1000,
        };
      } catch (err) {
        if (err instanceof EnrollmentLimitError)
          throw new UserOperationRefusal("limit_reached");
        throw err;
      }
    },
    enrollmentRequest(_userId, userCode) {
      const request = deps.registry.enrollmentRequest(userCode);
      if (!request) throw new UserOperationRefusal("unknown_request");
      return request;
    },
    decideEnrollment(userId, userCode, approve) {
      const outcome = deps.registry.decide(
        userCode,
        userId,
        approve,
        PAGE_ENROLLMENT_LIMITS,
      );
      if (outcome === "unknown")
        throw new UserOperationRefusal("unknown_request");
      if (outcome === "limit") throw new UserOperationRefusal("limit_reached");
    },
    revokeClient(userId, clientId) {
      const client = ownedClient(userId, clientId);
      deps.registry.revoke(client.id);
      deps.clientRevoked(client.id);
    },
    mintMcpToken: (userId, clientId) =>
      deps.registry.setMcpToken(ownedClient(userId, clientId).id),
    revokeMcpToken(userId, clientId) {
      deps.registry.clearMcpToken(ownedClient(userId, clientId).id);
    },
    close: () => logins.close(),
  };
}
