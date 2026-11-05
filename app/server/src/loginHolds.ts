/**
 * The server's side of a login hold (`docs/workers.md` "Credentials"). With
 * the switch on, a login flow takes the gateway's hold on its profile before
 * it starts its writer and releases it only once that writer has ended; with
 * it off, there is no hold and nothing here is ever stuck.
 *
 * Only an account whose kind holds a login (`ACCOUNT_KINDS`) takes a hold or
 * shows the login-stuck state. A profile is login-stuck while the gateway's
 * latest `profiles.status` says so, or while its last acquire was refused as
 * `login_stuck` for a known hold (the mark). The mark clears on a status that
 * ends that hold, a Clear, a held acquire or the profile's deletion.
 *
 * Clear is the operator's assertion that no login runs: it force-releases a
 * hold whose writer is not this boot's; this boot's own live login is
 * abandoned through its flow instead (DQ2), which releases on its own end.
 * Every change of the state is announced once.
 */
import {
  ACCOUNT_KINDS,
  type CredentialProfileProvider,
} from "@assistant/shared";
import {
  credentialProfileById,
  setCredentialProfileLoginStuckReader,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import {
  installedGatewayLink,
  LoginHeldError,
  type GatewayLink,
  type LoginStatus,
} from "./gatewayLink.ts";

// What an `unavailable` answer shows. pi's login flow names it from here: no
// `piSdk/` module imports the link itself (`workerBoundary.test.ts`).
export { GATEWAY_LOGIN_UNAVAILABLE_TEXT } from "./gatewayLink.ts";

/** What a login flow needs of the link; tests inject a fake. */
type HoldLink = Pick<
  GatewayLink,
  | "acquireLoginHold"
  | "registerLoginWriter"
  | "releaseLoginHold"
  | "forceReleaseLoginHold"
  | "loginStatus"
  | "onLoginStatus"
>;

/** A held login: the flow names its writer, then releases once it ended. */
export interface LoginHold {
  /** Names the login's writer process; rejects with U7's login text. */
  registerWriter(pid: number): Promise<void>;
  /** Ends the hold; only the first call does anything. */
  release(): void;
}

/**
 * `off`: no link, so the login runs unheld. `stuck`: an unfinished login
 * holds the profile; nothing may start. `unavailable`: the gateway cannot
 * hold for it now (U7's login text).
 */
export type LoginHoldTaken =
  | { kind: "off" }
  | { kind: "held"; hold: LoginHold }
  | { kind: "stuck" }
  | { kind: "unavailable" };

/** Undefined: the installed link. */
let injected: { link: HoldLink | undefined } | undefined;
let announce: () => void = () => {};
/** This boot's holds whose writer has not ended, by hold id. */
const live = new Map<string, () => void>();
/** The `login_stuck` refusal's hold, by profile. */
const marks = new Map<string, string>();
/** The status last heard per profile, so a repeated one announces nothing. */
const heard = new Map<string, LoginStatus>();
const followed = new WeakSet<HoldLink>();

function onLoginStatus(profileId: string, status: LoginStatus): void {
  const before = heard.get(profileId);
  heard.set(profileId, status);
  const unmarked =
    !status.loginStuck &&
    marks.get(profileId) === status.holdId &&
    marks.delete(profileId);
  if (
    unmarked ||
    before?.loginStuck !== status.loginStuck ||
    before.holdId !== status.holdId
  )
    announce();
}

/** The link now, following its statuses from the first look on. */
function currentLink(): HoldLink | undefined {
  const link = injected ? injected.link : installedGatewayLink();
  if (link && !followed.has(link)) {
    followed.add(link);
    link.onLoginStatus(onLoginStatus);
  }
  return link;
}

const holdsLogin = (provider: CredentialProfileProvider): boolean =>
  ACCOUNT_KINDS[provider].credential === "login";

function mark(profileId: string, holdId: string): void {
  if (marks.get(profileId) === holdId) return;
  marks.set(profileId, holdId);
  announce();
}

function unmark(profileId: string): void {
  if (marks.delete(profileId)) announce();
}

subscribeCredentialProfileDeleted(unmark);
setCredentialProfileLoginStuckReader(loginStuckOf);

/** Follows the installed link's login statuses from its start (`index.ts`). */
export function followLoginHoldStatuses(): void {
  currentLink();
}

/** Who hears of every login-stuck change; `hub.ts` sets it. */
export function setLoginHoldAnnouncer(value: () => void): void {
  announce = value;
}

/**
 * Takes the profile's hold before a login starts its writer. Without a link,
 * or for a kind that holds no login, it answers `off` at once, not as a
 * promise. `abandon` ends this login when the operator clears it while it
 * runs; it may throw to refuse that instead.
 */
export function takeLoginHold(
  profile: { id: string; provider: CredentialProfileProvider },
  abandon: () => void,
): LoginHoldTaken | Promise<LoginHoldTaken> {
  const link = currentLink();
  if (!link || !holdsLogin(profile.provider)) return { kind: "off" };
  return acquire(link, profile.id, abandon);
}

async function acquire(
  link: HoldLink,
  profileId: string,
  abandon: () => void,
): Promise<LoginHoldTaken> {
  let holdId: string;
  try {
    holdId = await link.acquireLoginHold(profileId);
  } catch (err) {
    if (
      err instanceof LoginHeldError &&
      err.refusal === "login_stuck" &&
      err.holdId !== undefined
    ) {
      mark(profileId, err.holdId);
      return { kind: "stuck" };
    }
    return { kind: "unavailable" };
  }
  unmark(profileId);
  live.set(holdId, abandon);
  let released = false;
  return {
    kind: "held",
    hold: {
      registerWriter: (pid) => link.registerLoginWriter(holdId, pid),
      release() {
        if (released) return;
        released = true;
        live.delete(holdId);
        void link.releaseLoginHold(holdId);
      },
    },
  };
}

/** Whether the profile shows the login-stuck state. */
export function loginStuckOf(profile: {
  id: string;
  provider: CredentialProfileProvider;
}): boolean {
  if (!holdsLogin(profile.provider)) return false;
  const link = currentLink();
  if (!link) return false;
  return (
    link.loginStatus(profile.id)?.loginStuck === true || marks.has(profile.id)
  );
}

/**
 * The operator's Clear. Without a stuck hold it does nothing. This boot's
 * live login is abandoned, and releases once its writer ended; any other hold
 * is force-released. Rejects with U7's login text, or what `abandon` threw.
 */
export async function clearUnfinishedLogin(profile: {
  id: string;
  provider: CredentialProfileProvider;
}): Promise<void> {
  if (!holdsLogin(profile.provider)) return;
  const link = currentLink();
  if (!link) return;
  const status = link.loginStatus(profile.id);
  const holdId = status?.loginStuck ? status.holdId : marks.get(profile.id);
  if (holdId === undefined) return;
  const abandon = live.get(holdId);
  if (abandon) {
    abandon();
    return;
  }
  await link.forceReleaseLoginHold(holdId);
  if (marks.get(profile.id) === holdId) marks.delete(profile.id);
  announce();
}

/** Clear for `POST /api/credential-profiles/:id/login/clear`. */
export async function clearUnfinishedProfileLogin(
  profileId: string,
): Promise<void> {
  const profile = credentialProfileById(profileId);
  if (!profile) throw new Error("Credential profile not found.");
  await clearUnfinishedLogin(profile);
}

/** Test seam: the link to use (undefined: none), or null for the installed one; resets the state. */
export function setLoginHoldLinkForTests(
  link: HoldLink | undefined | null,
): void {
  injected = link === null ? undefined : { link };
  live.clear();
  marks.clear();
  heard.clear();
}
