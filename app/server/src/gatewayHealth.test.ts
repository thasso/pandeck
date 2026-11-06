/**
 * Task-1368 AC12 (e): the link's credential statuses reach account health, and
 * each ready connection sets the baseline, a socket reconnect included. A fake
 * link; real profiles and health store; no gateway.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import {
  initializeAccountHealth,
  readAccountHealth,
  reportAccountRunFailure,
} from "./accountHealth.ts";
import {
  createCredentialProfile,
  credentialProfileHasCredential,
  listCredentialProfiles,
  piAgentDir,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import { followGatewayCredentialStatuses } from "./gatewayHealth.ts";
import {
  installGatewayLink,
  type GatewayConnectionState,
  type GatewayLink,
} from "./gatewayLink.ts";
import { loginStuckOf } from "./loginHolds.ts";

const push = vi.fn();
initializeAccountHealth({
  broadcast: () => {},
  push,
  profiles: listCredentialProfiles,
  hasCredential: credentialProfileHasCredential,
  subscribeChanges: subscribeCredentialProfileChanges,
  subscribeDeleted: subscribeCredentialProfileDeleted,
});

/** A link that reports statuses as the real one records them. */
function fakeLink() {
  let state: GatewayConnectionState = "connecting";
  const statuses = new Map<string, boolean>();
  const credential = new Set<(id: string, needsLogin: boolean) => void>();
  const states = new Set<(state: GatewayConnectionState) => void>();
  const link = {
    reportsCredentialStatus: true,
    onCredentialStatus(listener: (id: string, needsLogin: boolean) => void) {
      credential.add(listener);
      return () => credential.delete(listener);
    },
    loginStatus: () => undefined,
    needsLoginProfiles: () =>
      [...statuses].filter(([, needs]) => needs).map(([id]) => id),
    connectionState: () => state,
    onConnectionState(listener: (state: GatewayConnectionState) => void) {
      states.add(listener);
      return () => states.delete(listener);
    },
  };
  return {
    link,
    report(id: string, needsLogin: boolean) {
      statuses.set(id, needsLogin);
      for (const listener of credential) listener(id, needsLogin);
    },
    /** A new connection: statuses start over, as the link clears them. */
    reconnect() {
      statuses.clear();
      state = "connecting";
      for (const listener of states) listener(state);
    },
    connected() {
      state = "connected";
      for (const listener of states) listener(state);
    },
  };
}

const fake = fakeLink();
const uninstall = installGatewayLink(fake.link as unknown as GatewayLink);
const unfollow = followGatewayCredentialStatuses(fake.link);
afterAll(() => {
  unfollow();
  uninstall();
});

const served = createCredentialProfile({
  name: "Served",
  provider: "openai-codex",
});
writeFileSync(
  join(piAgentDir(served.id), "auth.json"),
  JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 1,
    },
  }),
);
const health = (id: string) => readAccountHealth(id, true).state;

test("1368 AC12e: the gateway's status reaches health, a 401 does not, and the hold flag is untouched", () => {
  fake.connected();
  reportAccountRunFailure(
    served.id,
    { kind: "auth", loginDeath: true },
    "openai-codex",
  );
  assert.equal(health(served.id), "unknown", "a served 401 is not evidence");
  fake.report(served.id, true);
  assert.equal(health(served.id), "needs-login");
  assert.equal(push.mock.calls.length, 1);
  assert.equal(loginStuckOf(served), false, "needs-login is not login-stuck");
  fake.report(served.id, false);
  assert.equal(health(served.id), "ok");
});

test("1368 AC12e: a reconnect's baseline drops a needs-login cleared during the outage, and a replayed one does not push", () => {
  push.mockClear();
  fake.report(served.id, true);
  assert.equal(push.mock.calls.length, 1);
  // The gateway cleared it while no connection was up; that report was lost.
  fake.reconnect();
  assert.equal(health(served.id), "needs-login", "no baseline before ready");
  fake.connected();
  assert.equal(health(served.id), "unknown");
  // A gateway that still needs it replays the true on the next connection.
  fake.reconnect();
  fake.report(served.id, true);
  fake.connected();
  assert.equal(health(served.id), "needs-login");
  assert.equal(push.mock.calls.length, 1, "a kept needs-login never re-pushes");
});

test("1368 AC12e: a link that does not report statuses leaves health alone", () => {
  const silent = { ...fake.link, reportsCredentialStatus: false };
  const off = followGatewayCredentialStatuses(silent);
  off();
  assert.equal(followGatewayCredentialStatuses(undefined)(), undefined);
});
