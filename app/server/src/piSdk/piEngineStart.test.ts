/**
 * A client-mode pi open waits for the boot's first gateway tool listing
 * (Task-1398): pi registers its tool universe at open, so the gateway's
 * tools must be in the catalog before it.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AGENT_TYPES } from "../agentTypes.ts";
import { GatewayUnavailableError } from "../gatewayLink.ts";
import {
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
} from "../remoteTools.ts";
import { resolvePiEngineStart } from "./piEngineStart.ts";

const JIRA_GET_ISSUE = {
  name: "jira_get_issue",
  description: "Fetch one Jira issue.",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  actionKey: "jira:read",
};

const start = () =>
  resolvePiEngineStart({ kind: "assistant", credentialProfileId: "claude" });

let uninstall: () => void = () => {};
afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

const clientMode = () => {
  uninstall = installRemoteToolPort({
    call: () => Promise.reject(new Error("unused")),
  });
};

test("outside client mode an open does not wait", async () => {
  const started = await start();
  assert.equal(started.integrationGates.gatewayJira, false);
});

test("an open before the first listing waits for it, and then sees its tools", async () => {
  clientMode();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let opened = false;
  const pending = start().then(() => (opened = true));
  await vi.advanceTimersByTimeAsync(9_000);
  assert.equal(opened, false);
  applyListing(acceptRemoteTools([JIRA_GET_ISSUE]));
  await pending;
  assert.ok(
    AGENT_TYPES.assistant
      .tools()
      .some((tool) => tool.name === "jira_get_issue"),
  );
  // A listing arriving later only adds names.
  applyListing(acceptRemoteTools([{ ...JIRA_GET_ISSUE, name: "jira_other" }]));
  assert.deepEqual(
    AGENT_TYPES.assistant
      .tools()
      .filter((tool) => tool.name.startsWith("jira_"))
      .map((tool) => tool.name),
    ["jira_get_issue", "jira_other"],
  );
});

test("an open is refused when no listing arrives within 10 s", async () => {
  clientMode();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const refused = assert.rejects(start(), GatewayUnavailableError);
  await vi.advanceTimersByTimeAsync(10_000);
  await refused;
});
