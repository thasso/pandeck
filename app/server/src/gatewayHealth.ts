/**
 * Account health from the credential gateway (C16, `docs/account-routing.md`):
 * with a link that reports the gateway's renewal, a Claude or Codex account's
 * needs-login comes only from the gateway's `profiles.credential`, never from
 * a 401.
 *
 * Health hears every status the link records. Once each link connection is
 * ready, it sets the baseline: a saved needs-login the gateway does not
 * report becomes unknown, since nothing else would clear it. A socket link's
 * reconnect sets it again, because a change the gateway sent while no
 * connection was up never arrived. The login-stuck state stays separate
 * (`loginHolds.ts`). `accountHealth.ts` cannot import the link, so it is
 * wired here.
 */
import {
  reportAccountGatewayBaseline,
  reportAccountGatewayCredential,
  setAccountHealthGatewayServed,
} from "./accountHealth.ts";
import { credentialProfileById } from "./credentialProfiles.ts";
import {
  gatewayServesProfile,
  installedGatewayLink,
  type GatewayLink,
} from "./gatewayLink.ts";

/** What health needs of the link; tests inject a fake. */
type CredentialLink = Pick<
  GatewayLink,
  | "reportsCredentialStatus"
  | "onCredentialStatus"
  | "needsLoginProfiles"
  | "connectionState"
  | "onConnectionState"
>;

/** Whether the gateway serves the account now. */
function served(id: string): boolean {
  const profile = credentialProfileById(id);
  return profile !== undefined && gatewayServesProfile(profile);
}

/**
 * Follows the installed link's credential statuses into account health, if it
 * reports them; answers the unfollow. Call once, after the link starts.
 */
export function followGatewayCredentialStatuses(
  link: CredentialLink | undefined = installedGatewayLink(),
): () => void {
  if (!link?.reportsCredentialStatus) return () => {};
  setAccountHealthGatewayServed(served);
  const offCredential = link.onCredentialStatus((id, needsLogin) =>
    reportAccountGatewayCredential(id, needsLogin),
  );
  const baseline = (): void =>
    reportAccountGatewayBaseline(link.needsLoginProfiles());
  const offState = link.onConnectionState((state) => {
    if (state === "connected") baseline();
  });
  if (link.connectionState() === "connected") baseline();
  return () => {
    offCredential();
    offState();
    setAccountHealthGatewayServed(() => false);
  };
}
